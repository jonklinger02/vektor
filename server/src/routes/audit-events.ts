import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { listAuditEvents, MAX_AUDIT_EVENTS_LIMIT } from "../services/audit-events.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

function parseLimit(query: Record<string, unknown>) {
  const raw = Array.isArray(query.limit) ? query.limit[0] : query.limit;
  if (raw == null || raw === "") return undefined;
  const limit = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw badRequest("invalid 'limit' value");
  }
  return Math.min(limit, MAX_AUDIT_EVENTS_LIMIT);
}

function parseAction(query: Record<string, unknown>) {
  const raw = Array.isArray(query.action) ? query.action[0] : query.action;
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  return raw.trim();
}

export function auditEventRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/audit-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(
      await listAuditEvents(db, {
        companyId,
        action: parseAction(req.query),
        limit: parseLimit(req.query),
      }),
    );
  });

  // Instance-wide view (includes company-scoped and instance-scoped rows).
  router.get("/audit-events", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(
      await listAuditEvents(db, {
        action: parseAction(req.query),
        limit: parseLimit(req.query),
      }),
    );
  });

  return router;
}
