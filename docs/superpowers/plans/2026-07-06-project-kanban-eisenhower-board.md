# Project Kanban + Eisenhower Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-project Board tab to the Vektor app with two drag-and-drop layouts over the project's issues — Kanban (by status) and Eisenhower (2×2 urgency×importance).

**Architecture:** Additive, non-breaking data change: keep `priority`, add one nullable `importance` column. Eisenhower quadrant is derived (priority=urgency band, importance=new axis). New `ProjectBoardView` component (own files under `ui/src/components/board/`) wired as a tab in `ProjectDetail`, reusing the existing `issuesApi` + react-query + already-installed `@dnd-kit/*`.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Zod validators, React + react-query + @dnd-kit, Vitest, Storybook.

## Global Constraints

- `priority` (`critical|high|medium|low`) is UNCHANGED. No migration alters it.
- `importance` column is nullable, no default, no backfill. `NULL` = uncategorized.
- Only additive edits to `packages/db` and `packages/shared` (another session may be editing them).
- Kanban columns: `backlog, todo, in_progress, in_review, blocked, done` (exclude `cancelled`).
- Eisenhower urgency band: `critical|high` = Urgent; `medium|low` = Not urgent.
- Horizontal drag mutates priority only when crossing the band: →Urgent sets `high` if currently `medium|low` (keep `critical`); →Not urgent sets `medium` if currently `critical|high` (keep `low`).

---

### Task 1: Shared `importance` constant, type, and validator

**Files:**
- Modify: `packages/shared/src/constants.ts` (near `ISSUE_PRIORITIES`, ~line 200)
- Modify: `packages/shared/src/types/issue.ts` (`Issue` interface, ~line 543 after `priority`)
- Modify: `packages/shared/src/validators/issue.ts` (`createIssueBaseSchema`, ~line 386 after `priority`)

**Produces:** `ISSUE_IMPORTANCE`, `IssueImportance`, `Issue.importance`, base-schema `importance` field.

- [ ] **Step 1:** In `constants.ts` after `ISSUE_PRIORITIES`/`IssuePriority`, add:
```ts
export const ISSUE_IMPORTANCE = ["important", "not_important"] as const;
export type IssueImportance = (typeof ISSUE_IMPORTANCE)[number];
```
- [ ] **Step 2:** In `types/issue.ts`, import `IssueImportance` (extend the existing `constants` import), and add to `Issue` after `priority: IssuePriority;`:
```ts
  importance: IssueImportance | null;
```
- [ ] **Step 3:** In `validators/issue.ts`, add `ISSUE_IMPORTANCE` to the constants import, and in `createIssueBaseSchema` after the `priority` line add:
```ts
  importance: z.enum(ISSUE_IMPORTANCE).optional().nullable(),
```
- [ ] **Step 4:** Build shared: `pnpm --filter @paperclipai/shared build` → Expected: success, no type errors.
- [ ] **Step 5:** Commit: `git add packages/shared && git commit -m "feat(shared): add issue importance axis (Eisenhower)"`

---

### Task 2: DB column + migration

**Files:**
- Modify: `packages/db/src/schema/issues.ts:35` (after `priority`)
- Create: migration SQL under `packages/db/` drizzle migrations dir (generated)

**Consumes:** nothing. **Produces:** `issues.importance` column.

- [ ] **Step 1:** In `schema/issues.ts` after the `priority` column add:
```ts
    importance: text("importance"),
```
- [ ] **Step 2:** Generate migration: `pnpm db:generate`. If `check:migrations` blocks or drizzle-kit needs a DB, fall back to hand-writing a migration file matching the existing numbered format with SQL: `ALTER TABLE "issues" ADD COLUMN "importance" text;` and append its entry to the drizzle journal.
- [ ] **Step 3:** Inspect the generated migration — confirm it ONLY adds the column (no changes to `priority`/other tables).
- [ ] **Step 4:** Build db: `pnpm --filter @paperclipai/db build` → Expected: success.
- [ ] **Step 5:** Commit: `git add packages/db && git commit -m "feat(db): add nullable issues.importance column"`

---

### Task 3: Pure board logic + unit tests (TDD)

**Files:**
- Create: `ui/src/components/board/grouping.ts`
- Create: `ui/src/components/board/grouping.test.ts`

**Produces:**
```ts
type Quadrant = "do" | "schedule" | "delegate" | "eliminate";
type KanbanStatus = "backlog"|"todo"|"in_progress"|"in_review"|"blocked"|"done";
KANBAN_STATUSES: readonly KanbanStatus[]
QUADRANTS: readonly Quadrant[]
isUrgent(priority): boolean
quadrantOf(priority, importance): Quadrant | null   // null when importance == null
groupByStatus(issues): Record<KanbanStatus, Issue[]>
groupByQuadrant(issues): { quadrant: Record<Quadrant, Issue[]>, unsorted: Issue[] }
patchForStatusDrop(status): { status }
patchForQuadrantDrop(quadrant, issue): { importance, priority? }  // priority only on band cross
```

- [ ] **Step 1: Write failing tests** `grouping.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { quadrantOf, groupByQuadrant, groupByStatus, patchForQuadrantDrop, patchForStatusDrop, isUrgent } from "./grouping";

const mk = (p: Issue["priority"], imp: Issue["importance"], status: Issue["status"] = "todo"): Issue =>
  ({ id: `${p}-${imp}-${status}`, priority: p, importance: imp, status } as unknown as Issue);

describe("quadrantOf", () => {
  it("urgent+important => do", () => expect(quadrantOf("critical", "important")).toBe("do"));
  it("not-urgent+important => schedule", () => expect(quadrantOf("medium", "important")).toBe("schedule"));
  it("urgent+not-important => delegate", () => expect(quadrantOf("high", "not_important")).toBe("delegate"));
  it("not-urgent+not-important => eliminate", () => expect(quadrantOf("low", "not_important")).toBe("eliminate"));
  it("null importance => null", () => expect(quadrantOf("high", null)).toBeNull());
});

describe("isUrgent", () => {
  it("critical/high urgent", () => { expect(isUrgent("critical")).toBe(true); expect(isUrgent("high")).toBe(true); });
  it("medium/low not urgent", () => { expect(isUrgent("medium")).toBe(false); expect(isUrgent("low")).toBe(false); });
});

describe("groupByQuadrant", () => {
  it("splits sorted vs unsorted", () => {
    const g = groupByQuadrant([mk("critical", "important"), mk("high", null)]);
    expect(g.quadrant.do).toHaveLength(1);
    expect(g.unsorted).toHaveLength(1);
  });
});

describe("groupByStatus", () => {
  it("buckets by status", () => {
    const g = groupByStatus([mk("low", null, "blocked"), mk("low", null, "done")]);
    expect(g.blocked).toHaveLength(1);
    expect(g.done).toHaveLength(1);
    expect(g.backlog).toHaveLength(0);
  });
});

describe("patchForQuadrantDrop", () => {
  it("do from medium/not_important: bump priority + set importance", () => {
    expect(patchForQuadrantDrop("do", mk("medium", "not_important"))).toEqual({ importance: "important", priority: "high" });
  });
  it("do from critical/not_important: keep critical", () => {
    expect(patchForQuadrantDrop("do", mk("critical", "not_important"))).toEqual({ importance: "important" });
  });
  it("schedule from critical: drop to medium", () => {
    expect(patchForQuadrantDrop("schedule", mk("critical", "important"))).toEqual({ importance: "important", priority: "medium" });
  });
  it("eliminate from low: keep low", () => {
    expect(patchForQuadrantDrop("eliminate", mk("low", "important"))).toEqual({ importance: "not_important" });
  });
});

describe("patchForStatusDrop", () => {
  it("returns status patch", () => expect(patchForStatusDrop("in_progress")).toEqual({ status: "in_progress" }));
});
```
- [ ] **Step 2:** Run: `pnpm --filter paperclip-ui vitest run src/components/board/grouping.test.ts` (or repo's ui test cmd) → Expected: FAIL (module missing).
- [ ] **Step 3:** Write `grouping.ts`:
```ts
import type { Issue, IssuePriority, IssueImportance, IssueStatus } from "@paperclipai/shared";

export type Quadrant = "do" | "schedule" | "delegate" | "eliminate";
export type KanbanStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done";

export const KANBAN_STATUSES: readonly KanbanStatus[] = ["backlog","todo","in_progress","in_review","blocked","done"];
export const QUADRANTS: readonly Quadrant[] = ["do","schedule","delegate","eliminate"];

const URGENT: ReadonlySet<IssuePriority> = new Set(["critical","high"]);
export function isUrgent(p: IssuePriority): boolean { return URGENT.has(p); }

export function quadrantOf(p: IssuePriority, imp: IssueImportance | null): Quadrant | null {
  if (imp == null) return null;
  const urgent = isUrgent(p);
  if (imp === "important") return urgent ? "do" : "schedule";
  return urgent ? "delegate" : "eliminate";
}

export function groupByStatus(issues: Issue[]): Record<KanbanStatus, Issue[]> {
  const out = Object.fromEntries(KANBAN_STATUSES.map((s) => [s, [] as Issue[]])) as Record<KanbanStatus, Issue[]>;
  for (const it of issues) {
    if ((KANBAN_STATUSES as readonly string[]).includes(it.status)) out[it.status as KanbanStatus].push(it);
  }
  return out;
}

export function groupByQuadrant(issues: Issue[]): { quadrant: Record<Quadrant, Issue[]>; unsorted: Issue[] } {
  const quadrant = Object.fromEntries(QUADRANTS.map((q) => [q, [] as Issue[]])) as Record<Quadrant, Issue[]>;
  const unsorted: Issue[] = [];
  for (const it of issues) {
    const q = quadrantOf(it.priority, it.importance);
    if (q) quadrant[q].push(it); else unsorted.push(it);
  }
  return { quadrant, unsorted };
}

export function patchForStatusDrop(status: KanbanStatus): { status: IssueStatus } {
  return { status };
}

const QUAD_META: Record<Quadrant, { urgent: boolean; importance: IssueImportance }> = {
  do: { urgent: true, importance: "important" },
  schedule: { urgent: false, importance: "important" },
  delegate: { urgent: true, importance: "not_important" },
  eliminate: { urgent: false, importance: "not_important" },
};

export function patchForQuadrantDrop(q: Quadrant, issue: Issue): { importance: IssueImportance; priority?: IssuePriority } {
  const meta = QUAD_META[q];
  const patch: { importance: IssueImportance; priority?: IssuePriority } = { importance: meta.importance };
  const currentlyUrgent = isUrgent(issue.priority);
  if (meta.urgent && !currentlyUrgent) patch.priority = "high";   // cross into urgent band
  if (!meta.urgent && currentlyUrgent) patch.priority = "medium"; // cross into not-urgent band
  return patch;
}
```
- [ ] **Step 4:** Run tests → Expected: PASS.
- [ ] **Step 5:** Commit: `git add ui/src/components/board/grouping.ts ui/src/components/board/grouping.test.ts && git commit -m "feat(ui): board grouping + drop-to-patch logic"`

---

### Task 4: Card + column presentational components

**Files:**
- Create: `ui/src/components/board/IssueCard.tsx`
- Create: `ui/src/components/board/BoardColumn.tsx`

**Consumes:** `Issue` type; existing `StatusIcon`, `Identity`, `Badge`/priority pill, design-system classes.
**Produces:** `<IssueCard issue onOpen />` (dnd `useDraggable`), `<BoardColumn id title count>` (dnd `useDroppable`).

- [ ] **Step 1:** `IssueCard.tsx` — a `useDraggable({ id: issue.id })` card showing `identifier`, `title`, `StatusIcon`, priority pill, assignee via `Identity`, labels; `onClick={() => onOpen(issue)}`; apply drag transform via `@dnd-kit/utilities` `CSS.Translate`. Follow existing card styling (reuse classes from `IssuesList`/`IssueColumns`).
- [ ] **Step 2:** `BoardColumn.tsx` — a `useDroppable({ id })` container with header (title + count) and a scrollable body rendering children; highlight when `isOver`.
- [ ] **Step 3:** Typecheck: `pnpm --filter paperclip-ui exec tsc --noEmit` → Expected: success.
- [ ] **Step 4:** Commit: `git add ui/src/components/board && git commit -m "feat(ui): board IssueCard + BoardColumn (dnd-kit)"`

---

### Task 5: `ProjectBoardView` (query, mutation, optimistic, toggle) + story

**Files:**
- Create: `ui/src/components/board/ProjectBoardView.tsx`
- Create: `ui/storybook/stories/project-board.stories.tsx`

**Consumes:** Task 3 grouping fns, Task 4 components, `issuesApi.list/update`, `queryKeys.issues.listByProject`.
**Produces:** `<ProjectBoardView projectId companyId />`.

- [ ] **Step 1:** Build `ProjectBoardView`:
  - `useQuery(queryKeys.issues.listByProject(companyId, projectId), () => issuesApi.list(companyId, { projectId }))`.
  - Local view state `"kanban" | "eisenhower"` (persist in `localStorage` key `paperclip:project-board-view`).
  - `<DndContext onDragEnd={...}>` wrapping columns. Kanban: map `KANBAN_STATUSES` → `BoardColumn`, cards from `groupByStatus`. Eisenhower: 2×2 of `QUADRANTS` + an "Unsorted" `BoardColumn`, cards from `groupByQuadrant`.
  - `onDragEnd`: resolve dropped issue + target container id; compute `patchForStatusDrop`/`patchForQuadrantDrop`; **optimistic** `queryClient.setQueryData` on the list key; call `issuesApi.update(id, patch)`; on error restore snapshot; `onSettled` invalidate `listByProject` + `issues.list(companyId)`.
  - Card `onOpen` → navigate to the existing issue detail route.
- [ ] **Step 2:** Story with fixture issues covering every quadrant, Unsorted, and all statuses; render both layouts.
- [ ] **Step 3:** Typecheck: `pnpm --filter paperclip-ui exec tsc --noEmit` → success.
- [ ] **Step 4:** Commit: `git add ui/src/components/board ui/storybook && git commit -m "feat(ui): ProjectBoardView with kanban+eisenhower drag-drop"`

---

### Task 6: Wire Board tab into `ProjectDetail` + routes

**Files:**
- Modify: `ui/src/pages/ProjectDetail.tsx` (type ~47, `resolveProjectTab` ~55, nav effect ~512, tab list ~825, content switch ~853, cached-tab ~709)
- Modify: `ui/src/App.tsx` (project routes ~124-132 and prefixed ~433-440)

- [ ] **Step 1:** Add `"board"` to `ProjectBaseTab`. In `resolveProjectTab` add `if (tab === "board") return "board";`.
- [ ] **Step 2:** In the nav effect, add `if (activeTab === "board") { navigate(\`/projects/${canonicalProjectRef}/board\`, { replace: true }); return; }` (mirror the `list` branch). Add matching branch in the ~709 tab-resolution block.
- [ ] **Step 3:** In `PageTabBar` tabs array add `{ value: "board", label: "Board" }` right after `{ value: "list", label: "Tasks" }`.
- [ ] **Step 4:** In the content switch add:
```tsx
{activeTab === "board" && project?.id && resolvedCompanyId && (
  <ProjectBoardView projectId={project.id} companyId={resolvedCompanyId} />
)}
```
and import `ProjectBoardView`.
- [ ] **Step 5:** In `App.tsx` add `<Route path="projects/:projectId/board" element={<ProjectDetail />} />` next to the other project routes, and the prefixed `UnprefixedBoardRedirect` variant.
- [ ] **Step 6:** Typecheck: `pnpm --filter paperclip-ui exec tsc --noEmit` → success.
- [ ] **Step 7:** Commit: `git add ui/src/pages/ProjectDetail.tsx ui/src/App.tsx && git commit -m "feat(ui): add Board tab to project detail"`

---

### Task 7: Full build, tests, and e2e verification

- [ ] **Step 1:** `pnpm --filter @paperclipai/shared build && pnpm --filter @paperclipai/db build` → success.
- [ ] **Step 2:** `pnpm --filter paperclip-ui exec tsc --noEmit` → success.
- [ ] **Step 3:** Run board unit tests → PASS.
- [ ] **Step 4:** Run the migration against the dev DB (`pnpm db:migrate` or documented equivalent) → column added; existing issues load.
- [ ] **Step 5:** E2E (invoke the `verify`/`run` skill): launch the app, open a project → Board tab; toggle Kanban/Eisenhower; drag a card across a status column (persists status) and across quadrants (persists importance, and priority on band cross); reload to confirm persistence.
- [ ] **Step 6:** Refine any issues found; re-run steps 1-5.
- [ ] **Step 7:** Final commit if refinements were made.

## Self-Review

- **Spec coverage:** importance model (T1/T2), derived quadrant + drag semantics (T3), kanban statuses (T3/T5), per-project scope + tab (T5/T6), optimistic updates (T5), testing (T3 unit + T5 story + T7 e2e), non-breaking/additive constraint (T1/T2). ✓
- **Placeholders:** pure logic fully coded (T3); UI tasks describe exact hooks/props/integration lines. ✓
- **Type consistency:** `Quadrant`, `KanbanStatus`, `IssueImportance`, patch shapes consistent across T3→T5; `importance: IssueImportance | null` matches T1 type. ✓
