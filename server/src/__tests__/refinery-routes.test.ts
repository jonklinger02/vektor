import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefineryService = vi.hoisted(() => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  updateSession: vi.fn(),
  listMessages: vi.fn(),
  addMessage: vi.fn(),
  setMessageContextExcluded: vi.fn(),
  getMessage: vi.fn(),
  buildHistory: vi.fn(),
}));

const mockListRefineryModels = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  refineryService: () => mockRefineryService,
}));

vi.mock("../services/refinery-opencode.js", () => ({
  listRefineryModels: mockListRefineryModels,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
  },
) {
  vi.resetModules();
  const [{ errorHandler }, { refineryRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/refinery.js") as Promise<typeof import("../routes/refinery.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", refineryRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

describe.sequential("refinery routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockRefineryService)) mock.mockReset();
    mockListRefineryModels.mockReset();
  });

  it("lists only own sessions", async () => {
    mockRefineryService.listSessions.mockResolvedValue([
      { id: "s-1", ownerUserId: "user-1", title: "New session" },
    ]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/refinery/sessions"));

    expect(res.status).toBe(200);
    expect(mockRefineryService.listSessions).toHaveBeenCalledWith("user-1");
    expect(res.body).toEqual([{ id: "s-1", ownerUserId: "user-1", title: "New session" }]);
  });

  it("creates a session", async () => {
    mockRefineryService.createSession.mockResolvedValue({
      id: "s-2",
      ownerUserId: "user-1",
      title: "Foo",
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/refinery/sessions").send({ title: "Foo" }),
    );

    expect(res.status).toBe(201);
    expect(mockRefineryService.createSession).toHaveBeenCalledWith("user-1", { title: "Foo" });
    expect(res.body).toEqual({ id: "s-2", ownerUserId: "user-1", title: "Foo" });
  });

  it("404s a session owned by someone else", async () => {
    mockRefineryService.getSession.mockResolvedValue({ id: "s-3", ownerUserId: "user-2" });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch("/api/refinery/sessions/s-3").send({ title: "New title" }),
    );

    expect(res.status).toBe(404);
    expect(mockRefineryService.updateSession).not.toHaveBeenCalled();
  });

  it("toggles message context exclusion via its session ownership", async () => {
    mockRefineryService.getMessage.mockResolvedValue({ id: "m-1", sessionId: "s-1" });
    mockRefineryService.getSession.mockResolvedValue({ id: "s-1", ownerUserId: "user-1" });
    mockRefineryService.setMessageContextExcluded.mockResolvedValue({
      id: "m-1",
      sessionId: "s-1",
      contextExcluded: true,
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).patch("/api/refinery/messages/m-1/context").send({ contextExcluded: true }),
    );

    expect(res.status).toBe(200);
    expect(mockRefineryService.getSession).toHaveBeenCalledWith("s-1");
    expect(mockRefineryService.setMessageContextExcluded).toHaveBeenCalledWith("m-1", true);
    expect(res.body).toEqual({ id: "m-1", sessionId: "s-1", contextExcluded: true });
  });

  it("records finalization pointer", async () => {
    mockRefineryService.getSession.mockResolvedValue({ id: "s-1", ownerUserId: "user-1" });
    mockRefineryService.updateSession.mockResolvedValue({
      id: "s-1",
      ownerUserId: "user-1",
      status: "finalized",
      finalizedKind: "task",
      finalizedEntityId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      finalizedCompanyId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/refinery/sessions/s-1/finalized").send({
        kind: "task",
        entityId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        companyId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockRefineryService.updateSession).toHaveBeenCalledWith("s-1", {
      status: "finalized",
      finalizedKind: "task",
      finalizedEntityId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      finalizedCompanyId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    });
  });

  it("returns models from listRefineryModels", async () => {
    mockListRefineryModels.mockReturnValue([{ id: "m1", label: "Model 1", tier: "cheap" }]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/refinery/models"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "m1", label: "Model 1", tier: "cheap" }]);
  });

  it("401s with no actor", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/refinery/sessions"));

    expect(res.status).toBe(401);
    expect(mockRefineryService.listSessions).not.toHaveBeenCalled();
  });
});
