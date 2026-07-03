import { describe, expect, it } from "vitest";
import {
  assertBoardOrgAccess,
  assertCompanyAccess,
  hasBoardOrgAccess,
  requireCompanyRole,
} from "../routes/authz.js";

function makeReq(input: {
  method?: string;
  actor: Express.Request["actor"];
}) {
  return {
    method: input.method ?? "GET",
    actor: input.actor,
  } as Express.Request;
}

describe("assertCompanyAccess", () => {
  it("allows viewer memberships to read", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [
          { companyId: "company-1", membershipRole: "viewer", status: "active" },
        ],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("rejects viewer memberships for writes", () => {
    const req = makeReq({
      method: "PATCH",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [
          { companyId: "company-1", membershipRole: "viewer", status: "active" },
        ],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow("Viewer access is read-only");
  });

  it("rejects writes when membership details are present but omit the target company", () => {
    const req = makeReq({
      method: "POST",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow("User does not have active company access");
  });

  it("allows legacy board actors that only provide company ids", () => {
    const req = makeReq({
      method: "POST",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("rejects signed-in instance admins without explicit company access", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [],
        memberships: [],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow("User does not have access to this company");
  });

  it("allows local trusted board access without explicit membership", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });
});

describe("assertBoardOrgAccess", () => {
  it("allows signed-in board users with active company access", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
        isInstanceAdmin: false,
      },
    });

    expect(hasBoardOrgAccess(req)).toBe(true);
    expect(() => assertBoardOrgAccess(req)).not.toThrow();
  });

  it("allows instance admins without company memberships", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "admin-1",
        source: "session",
        companyIds: [],
        memberships: [],
        isInstanceAdmin: true,
      },
    });

    expect(hasBoardOrgAccess(req)).toBe(true);
    expect(() => assertBoardOrgAccess(req)).not.toThrow();
  });

  it("rejects signed-in users without company access or instance admin rights", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "outsider-1",
        source: "session",
        companyIds: [],
        memberships: [],
        isInstanceAdmin: false,
      },
    });

    expect(hasBoardOrgAccess(req)).toBe(false);
    expect(() => assertBoardOrgAccess(req)).toThrow("Company membership or instance admin access required");
  });
});

describe("requireCompanyRole", () => {
  function memberReq(membershipRole: string | null, status = "active") {
    return makeReq({
      method: "PUT",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole, status }],
        isInstanceAdmin: false,
      },
    });
  }

  it("rejects non-board actors", () => {
    const req = makeReq({ actor: { type: "agent", agentId: "agent-1", source: "agent_key" } });
    expect(() => requireCompanyRole(req, "company-1", "admin")).toThrow("Board access required");
  });

  it("rejects viewers even for the lowest ladder rung", () => {
    expect(() => requireCompanyRole(memberReq("viewer"), "company-1", "operator")).toThrow(
      "Company role 'operator' or higher required",
    );
  });

  it("allows operators at 'operator' but not at 'admin'", () => {
    expect(() => requireCompanyRole(memberReq("operator"), "company-1", "operator")).not.toThrow();
    expect(() => requireCompanyRole(memberReq("operator"), "company-1", "admin")).toThrow(
      "Company role 'admin' or higher required",
    );
  });

  it("treats the legacy 'member' role (and a missing role) as operator", () => {
    expect(() => requireCompanyRole(memberReq("member"), "company-1", "operator")).not.toThrow();
    expect(() => requireCompanyRole(memberReq(null), "company-1", "operator")).not.toThrow();
    expect(() => requireCompanyRole(memberReq(null), "company-1", "admin")).toThrow(
      "Company role 'admin' or higher required",
    );
  });

  it("allows admins at 'admin' but not at 'owner'", () => {
    expect(() => requireCompanyRole(memberReq("admin"), "company-1", "admin")).not.toThrow();
    expect(() => requireCompanyRole(memberReq("admin"), "company-1", "owner")).toThrow(
      "Company role 'owner' or higher required",
    );
  });

  it("allows owners everywhere on the ladder", () => {
    expect(() => requireCompanyRole(memberReq("owner"), "company-1", "owner")).not.toThrow();
    expect(() => requireCompanyRole(memberReq("owner"), "company-1", "admin")).not.toThrow();
  });

  it("rejects inactive memberships", () => {
    expect(() => requireCompanyRole(memberReq("owner", "archived"), "company-1", "admin")).toThrow(
      "Active company membership required",
    );
  });

  it("rejects members of a different company", () => {
    expect(() => requireCompanyRole(memberReq("owner"), "company-2", "admin")).toThrow(
      "Active company membership required",
    );
  });

  it("bypasses for instance admins and the local implicit board", () => {
    const admin = makeReq({
      actor: { type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true },
    });
    const local = makeReq({
      actor: { type: "board", userId: "local-board", source: "local_implicit" },
    });
    expect(() => requireCompanyRole(admin, "company-1", "owner")).not.toThrow();
    expect(() => requireCompanyRole(local, "company-1", "owner")).not.toThrow();
  });

  it("defers to assertCompanyAccess for key-based board actors without membership details", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "user-1",
        source: "board_key",
        companyIds: ["company-1"],
        isInstanceAdmin: false,
      },
    });
    expect(() => requireCompanyRole(req, "company-1", "owner")).not.toThrow();
  });
});
