import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createRefinerySessionSchema,
  refineryContextToggleSchema,
  updateRefinerySessionSchema,
  REFINERY_PROPOSAL_KINDS,
} from "@paperclipai/shared";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { refineryService } from "../services/index.js";
import { listRefineryModels } from "../services/refinery-opencode.js";
import { assertAuthenticated } from "./authz.js";
import { notFound, unauthorized } from "../errors.js";

const finalizedSchema = z.object({
  kind: z.enum(REFINERY_PROPOSAL_KINDS),
  entityId: z.string().uuid(),
  companyId: z.string().uuid(),
});

export function refineryRoutes(db: Db) {
  const router = Router();
  const svc = refineryService(db);

  function requireUserId(req: import("express").Request): string {
    assertAuthenticated(req);
    const userId = req.actor.userId;
    if (!userId) throw unauthorized("Refinery requires a signed-in user session");
    return userId;
  }

  /** Load a session and 404 unless it belongs to the caller. */
  async function ownSession(req: import("express").Request, sessionId: string) {
    const userId = requireUserId(req);
    const session = await svc.getSession(sessionId);
    if (!session || session.ownerUserId !== userId) throw notFound("Session not found");
    return session;
  }

  router.get("/refinery/sessions", async (req, res) => {
    const userId = requireUserId(req);
    res.json(await svc.listSessions(userId));
  });

  router.post("/refinery/sessions", validate(createRefinerySessionSchema), async (req, res) => {
    const userId = requireUserId(req);
    res.status(201).json(await svc.createSession(userId, req.body));
  });

  router.patch("/refinery/sessions/:id", validate(updateRefinerySessionSchema), async (req, res) => {
    await ownSession(req, req.params.id as string);
    res.json(await svc.updateSession(req.params.id as string, req.body));
  });

  router.get("/refinery/sessions/:id/messages", async (req, res) => {
    await ownSession(req, req.params.id as string);
    res.json(await svc.listMessages(req.params.id as string));
  });

  router.patch("/refinery/messages/:id/context", validate(refineryContextToggleSchema), async (req, res) => {
    const message = await svc.getMessage(req.params.id as string);
    if (!message) throw notFound("Message not found");
    await ownSession(req, message.sessionId); // 404s on foreign ownership
    res.json(await svc.setMessageContextExcluded(req.params.id as string, req.body.contextExcluded));
  });

  router.post("/refinery/sessions/:id/finalized", validate(finalizedSchema), async (req, res) => {
    await ownSession(req, req.params.id as string);
    res.json(await svc.updateSession(req.params.id as string, {
      status: "finalized",
      finalizedKind: req.body.kind,
      finalizedEntityId: req.body.entityId,
      finalizedCompanyId: req.body.companyId,
    }));
  });

  router.get("/refinery/models", (req, res) => {
    requireUserId(req);
    res.json(listRefineryModels());
  });

  return router;
}
