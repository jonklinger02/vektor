import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { HttpError, badRequest, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import { emitAuditEvent } from "../services/audit-events.js";
import {
  freeze,
  listAuditEntries,
  listVersions,
  promoteToActive,
  promoteToCanary,
  propose,
  rollback,
  unfreeze,
} from "../services/routing-config.js";
import {
  assertBoardOrgAccess,
  assertCompanyAccess,
  assertInstanceAdmin,
  getActorInfo,
} from "./authz.js";

const proposeVersionSchema = z.object({
  taskClass: z.string().trim().min(1),
  modelSpecs: z
    .array(
      z.object({
        model: z.string().trim().min(1),
        cost: z.number(),
        capability: z.number(),
      }),
    )
    .min(1),
});

const canarySchema = z.object({
  percent: z.number().int().min(1).max(99),
});

const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 200;

function parseAuditLimit(query: Record<string, unknown>) {
  const raw = Array.isArray(query.limit) ? query.limit[0] : query.limit;
  if (raw == null || raw === "") return DEFAULT_AUDIT_LIMIT;
  const limit = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw badRequest("invalid 'limit' value");
  }
  return Math.min(limit, MAX_AUDIT_LIMIT);
}

/**
 * The routing-config service throws plain Errors for validation problems
 * (unknown task class, malformed modelSpecs, bad percents, illegal lifecycle
 * transitions). Map those to 400 — except missing rows, which are 404.
 */
function mapGovernanceError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof Error) {
    if (/not found/i.test(err.message)) throw notFound(err.message);
    throw badRequest(err.message);
  }
  throw err;
}

export function routingGovernanceRoutes(db: Db) {
  const router = Router();
  const instanceSettings = instanceSettingsService(db);

  // Routing versions are instance-wide (not company-scoped), so mutations
  // are logged to every company's activity feed — the same pattern the
  // instance-settings routes use.
  async function logInstanceActivity(
    req: Request,
    action: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown>,
  ) {
    const actor = getActorInfo(req);
    // Routing governance is instance-scoped, so the immutable audit event is
    // written once with companyId null (unlike the per-company activity feed).
    emitAuditEvent(db, {
      companyId: null,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
      actorType: actor.actorType,
      action,
      subjectType: entityType,
      subjectId: entityId,
      details,
    });
    const companyIds = await instanceSettings.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action,
          entityType,
          entityId,
          details,
        }),
      ),
    );
  }

  router.get("/routing/versions", async (req, res) => {
    assertBoardOrgAccess(req);
    const taskClass =
      typeof req.query.taskClass === "string" && req.query.taskClass.trim().length > 0
        ? req.query.taskClass
        : undefined;
    res.json(await listVersions(db, taskClass));
  });

  router.post("/routing/versions", validate(proposeVersionSchema), async (req, res) => {
    assertInstanceAdmin(req);
    let version;
    try {
      version = await propose(db, {
        taskClass: req.body.taskClass,
        modelSpecs: req.body.modelSpecs,
        createdByUserId: req.actor.type === "board" ? req.actor.userId ?? null : null,
      });
    } catch (err) {
      mapGovernanceError(err);
    }
    await logInstanceActivity(req, "routing.version_proposed", "routing_config_version", version.id, {
      taskClass: version.taskClass,
      version: version.version,
      modelSpecs: version.modelSpecs,
    });
    res.status(201).json(version);
  });

  router.post("/routing/versions/:id/canary", validate(canarySchema), async (req, res) => {
    assertInstanceAdmin(req);
    const versionId = req.params.id as string;
    let version;
    try {
      version = await promoteToCanary(db, versionId, req.body.percent);
    } catch (err) {
      mapGovernanceError(err);
    }
    await logInstanceActivity(req, "routing.version_canaried", "routing_config_version", version.id, {
      taskClass: version.taskClass,
      version: version.version,
      canaryPercent: version.canaryPercent,
    });
    res.json(version);
  });

  router.post("/routing/versions/:id/promote", async (req, res) => {
    assertInstanceAdmin(req);
    const versionId = req.params.id as string;
    let version;
    try {
      version = await promoteToActive(db, versionId);
    } catch (err) {
      mapGovernanceError(err);
    }
    await logInstanceActivity(req, "routing.version_promoted", "routing_config_version", version.id, {
      taskClass: version.taskClass,
      version: version.version,
      previousVersionId: version.previousVersionId,
    });
    res.json(version);
  });

  router.post("/routing/classes/:taskClass/freeze", async (req, res) => {
    assertInstanceAdmin(req);
    const taskClass = req.params.taskClass as string;
    let version;
    try {
      version = await freeze(db, taskClass);
    } catch (err) {
      mapGovernanceError(err);
    }
    await logInstanceActivity(req, "routing.class_frozen", "routing_config_version", version.id, {
      taskClass,
      version: version.version,
    });
    res.json(version);
  });

  router.post("/routing/classes/:taskClass/unfreeze", async (req, res) => {
    assertInstanceAdmin(req);
    const taskClass = req.params.taskClass as string;
    let version;
    try {
      version = await unfreeze(db, taskClass);
    } catch (err) {
      mapGovernanceError(err);
    }
    await logInstanceActivity(req, "routing.class_unfrozen", "routing_config_version", version.id, {
      taskClass,
      version: version.version,
    });
    res.json(version);
  });

  router.post("/routing/classes/:taskClass/rollback", async (req, res) => {
    assertInstanceAdmin(req);
    const taskClass = req.params.taskClass as string;
    let version;
    try {
      version = await rollback(db, taskClass);
    } catch (err) {
      mapGovernanceError(err);
    }
    await logInstanceActivity(req, "routing.class_rolled_back", "routing_config_version", version.id, {
      taskClass,
      restoredVersion: version.version,
    });
    res.json(version);
  });

  // The audit trail is company-scoped (each decision row belongs to the
  // company whose dispatch it explains), so plain company access suffices.
  router.get("/companies/:companyId/routing-audit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const limit = parseAuditLimit(req.query);
    res.json(await listAuditEntries(db, companyId, limit));
  });

  return router;
}
