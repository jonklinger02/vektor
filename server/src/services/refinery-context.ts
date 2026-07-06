import type { Db } from "@paperclipai/db";
import { companyService } from "./companies.js";
import { agentService } from "./agents.js";
import { projectService } from "./projects.js";
import { goalService } from "./goals.js";

const CAP = 30;

type ContextAgent = Awaited<ReturnType<ReturnType<typeof agentService>["list"]>>[number];
type ContextProject = Awaited<ReturnType<ReturnType<typeof projectService>["list"]>>[number];
type ContextGoal = Awaited<ReturnType<ReturnType<typeof goalService>["list"]>>[number];

/**
 * Build a markdown org-context summary for a set of companies, to be
 * appended to the Refinery chat's system prompt. Best-effort: a company
 * that fails to load (bad id, deleted mid-flight, etc.) is skipped rather
 * than failing the whole pack — a partial pack beats a dead chat.
 */
export async function buildRefineryContextPack(db: Db, companyIds: string[]): Promise<string> {
  const sections: string[] = [];
  for (const companyId of companyIds) {
    try {
      const company = await companyService(db).getById(companyId);
      if (!company) continue;
      const [contextAgents, contextProjects, contextGoals] = await Promise.all([
        agentService(db).list(companyId),
        projectService(db).list(companyId),
        goalService(db).list(companyId),
      ]);
      sections.push(
        [
          `## Company: ${company.name} (id: ${companyId})`,
          `Agents: ${contextAgents
            .slice(0, CAP)
            .map((a: ContextAgent) => a.name)
            .join(", ") || "none"}`,
          `Projects: ${contextProjects
            .slice(0, CAP)
            .map((p: ContextProject) => `${p.name} [${p.status}]`)
            .join(", ") || "none"}`,
          `Goals: ${contextGoals
            .slice(0, CAP)
            .map((g: ContextGoal) => `${g.title} [${g.status}]`)
            .join(", ") || "none"}`,
        ].join("\n"),
      );
    } catch {
      // partial pack beats a dead chat — skip this company
    }
  }
  return sections.join("\n\n");
}
