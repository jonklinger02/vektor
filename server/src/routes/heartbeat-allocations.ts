import { Router } from "express";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyHeartbeatConfigs, schedulerTicks } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo, requireCompanyRole } from "./authz.js";
import { badRequest } from "../errors.js";
import { derivePolicy, reallocate } from "../services/company-heartbeat-policy.js";
import { logActivity } from "../services/index.js";
import { emitAuditEvent } from "../services/audit-events.js";

const reallocationSchema = z.object({
  processors: z.number().int().min(0),
  memory: z.number().int().min(0),
});

const DEFAULT_TICKS_LIMIT = 50;
const MAX_TICKS_LIMIT = 200;

function parseTicksLimit(query: Record<string, unknown>) {
  const raw = Array.isArray(query.limit) ? query.limit[0] : query.limit;
  if (raw == null || raw === "") return DEFAULT_TICKS_LIMIT;
  const limit = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw badRequest("invalid 'limit' value");
  }
  return Math.min(limit, MAX_TICKS_LIMIT);
}

export function heartbeatAllocationRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/heartbeat-allocation", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const row = await db
      .select()
      .from(companyHeartbeatConfigs)
      .where(eq(companyHeartbeatConfigs.companyId, companyId))
      .then((rows) => rows[0] ?? null);

    // No row = the company has not opted in: report the would-be defaults
    // (processors 1 / memory 1 / trust 2) with gating off.
    const config = row ?? { processors: 1, memory: 1, trust: 2, enabled: false };
    res.json({
      unconfigured: !row,
      processors: config.processors,
      memory: config.memory,
      trust: config.trust,
      enabled: config.enabled,
      lastDispatchAt: row?.lastDispatchAt ?? null,
      policy: derivePolicy(config),
    });
  });

  router.put(
    "/companies/:companyId/heartbeat-allocation",
    validate(reallocationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      requireCompanyRole(req, companyId, "admin");

      let policy;
      try {
        policy = await reallocate(db, companyId, {
          processors: req.body.processors,
          memory: req.body.memory,
        });
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Invalid allocation")) {
          throw badRequest(err.message);
        }
        throw err;
      }

      const actor = getActorInfo(req);
      emitAuditEvent(db, {
        companyId,
        actorUserId: actor.actorType === "user" ? actor.actorId : null,
        actorType: actor.actorType,
        action: "company.heartbeat_allocation_updated",
        subjectType: "company",
        subjectId: companyId,
        details: { processors: policy.processors, memory: policy.memory, trust: policy.trust },
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "company.heartbeat_allocation_updated",
        entityType: "company",
        entityId: companyId,
        details: { processors: policy.processors, memory: policy.memory, trust: policy.trust },
      });

      res.json(policy);
    },
  );

  // scheduler_ticks is instance-wide telemetry (no company column); the
  // company prefix is only the access-control scope for reading it.
  router.get("/companies/:companyId/scheduler-ticks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limit = parseTicksLimit(req.query);
    const rows = await db
      .select()
      .from(schedulerTicks)
      .orderBy(desc(schedulerTicks.tickedAt))
      .limit(limit);
    res.json(rows);
  });

  return router;
}
