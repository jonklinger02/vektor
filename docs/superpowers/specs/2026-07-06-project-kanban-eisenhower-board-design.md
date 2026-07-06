# Per-Project Kanban + Eisenhower Board — Design

- **Date:** 2026-07-06
- **Branch:** `vektor-kanban-eisenhower`
- **Status:** Design — pending user review

## Problem

Vektor (paperclip) surfaces tasks as `issues` rendered as **lists + comment threads**.
For a user managing many issues this is overwhelming: there is no spatial, at-a-glance
way to understand what matters, and no direct-manipulation way to reprioritize or move
work through its workflow. Reference for the desired feel: the standalone "Command
Center" at `http://192.168.2.133:3742/` (a personal-task MCP tool) with its Eisenhower
matrix + Kanban + drag-drop.

## Goal

Add a **per-project board** to the Vektor app offering two spatial layouts over the
project's issues, both with drag-and-drop:

1. **Kanban** — columns by workflow `status`; drag to change status.
2. **Eisenhower** — a 2×2 (urgency × importance); drag to reprioritize.

## Non-goals

- No change to the existing issue **list** view, comment threads, or issue detail.
- No calendar / AI-chat panel (those are Command-Center-only concepts).
- No cross-project or "my-issues" global board (scope is a single project — matches the
  chosen per-project scope). A global board is a possible follow-up.
- No new drag-drop dependency — `@dnd-kit/*` is already installed.

## Data model change (additive, non-breaking)

`priority` (`critical | high | medium | low`) stays **exactly as-is** and keeps driving
everything it already drives (routing, scheduling, the priority pill). We add **one**
nullable column — the only genuinely new stored value:

```
importance  text  NULL   -- 'important' | 'not_important' | NULL (uncategorized)
```

- Nullable, **no backfill**. Existing issues read as `NULL` → shown in an "Unsorted"
  strip on the Eisenhower layout. No risky rewrite of existing rows.
- New shared constant `ISSUE_IMPORTANCE = ['important','not_important'] as const` and
  type `IssueImportance`.
- Added to `createIssueBaseSchema` as `.optional().nullable()`, so it flows into
  `updateIssueSchema` (used by `PATCH /issues/:id`) and `createIssueSchema` automatically.
- Added to the `Issue` type in `@paperclipai/shared` and the DB `issues` schema/select.

### Files touched by the model change
- `packages/db/src/schema/issues.ts` — add `importance: text("importance")`.
- `packages/db/` migration — add nullable column (see Migration).
- `packages/shared/src/constants.ts` — `ISSUE_IMPORTANCE` + `IssueImportance`.
- `packages/shared/src/validators/issue.ts` — add `importance` to `createIssueBaseSchema`.
- `packages/shared` `Issue` type — add `importance: IssueImportance | null`.
- `ui/src/api/issues.ts` — `Issue` type mirror already re-exports shared; verify field present.

## Eisenhower derivation & drag semantics

The 2×2 is **derived**; `priority` is the urgency axis, `importance` is the new axis:

|                   | **Urgent** (`critical`/`high`) | **Not urgent** (`medium`/`low`) |
|-------------------|-------------------------------|---------------------------------|
| **Important**     | Q1 · Do Now                   | Q2 · Schedule                   |
| **Not important** | Q3 · Delegate                 | Q4 · Eliminate                  |

- `importance = NULL` → card sits in the **Unsorted** strip (not in any quadrant).
- **Drag controls both axes** (chosen option):
  - **Vertical** move (Important ↔ Not important) → `PATCH { importance }`.
  - **Horizontal** move (Urgent ↔ Not urgent) → `PATCH { priority }`, nudging across the
    boundary: dropping into **Urgent** sets `priority: 'high'` if it was `medium`/`low`
    (leaves `critical` as-is); dropping into **Not urgent** sets `priority: 'medium'` if
    it was `critical`/`high` (leaves `low` as-is). Rule: only change priority when it
    would cross the band; never downgrade within a band.
  - A diagonal drop (into a different quadrant) issues **one** PATCH with both fields.

## Kanban semantics

- Columns, in order: `backlog, todo, in_progress, in_review, blocked, done`.
  (`cancelled` excluded; reachable via the list view.)
- Drag a card between columns → `PATCH { status }`.
- Column labels/icons reuse `StatusIcon` and existing status language.

## Architecture

New component tree under `ui/src/components/board/`:

- `ProjectBoardView.tsx` — owns the query + mutation + view toggle (Kanban | Eisenhower)
  + optimistic-update logic. Mirrors the existing List-tab pattern in `ProjectDetail`
  (`issuesApi.list(companyId,{projectId})`, `issuesApi.update`, query-key invalidation).
- `BoardColumn.tsx` — a dnd-kit droppable column/quadrant container.
- `IssueCard.tsx` — a dnd-kit draggable card: identifier, title, `StatusIcon`, priority
  pill, assignee (`Identity`), labels. Click opens the existing issue detail route.
- `board/grouping.ts` — pure functions: `groupByStatus(issues)`,
  `groupByQuadrant(issues)`, `quadrantOf(priority, importance)`,
  `dropTargetToPatch(target, issue)` (returns the `{status?}` / `{priority?, importance?}`
  patch for a drop). Pure → unit-testable without the DOM.

### Integration into `ProjectDetail`
- Add `"board"` to `ProjectBaseTab`; map URL segment `board` in `resolveProjectTab()`.
- Add the tab to the `PageTabBar`; render `<ProjectBoardView companyId projectId />`
  when active. `ProjectDetail` gains only wiring, no board logic.
- Routing: add `projects/:projectId/board` (and the `/company/...` prefixed variant that
  mirrors the other project routes) in `ui/src/App.tsx`.

## Data flow

1. `ProjectBoardView` runs `issuesApi.list(companyId, { projectId })` via react-query
   (reuse/extend the existing `queryKeys.issues.listByProject`).
2. Group client-side (`grouping.ts`) into status columns or quadrants.
3. On drop: compute patch, apply **optimistic** cache update, fire `issuesApi.update`,
   invalidate on settle; on error roll back to the pre-drop snapshot and toast.

## API changes

- **None structural.** `PATCH /issues/:id` already accepts partial updates; once
  `importance` is in `createIssueBaseSchema` it is accepted automatically.
- The list endpoint already returns full issue rows → `importance` rides along once the
  DB select includes the column (Drizzle `select()` on the table picks it up).

## Migration

- New Drizzle migration: `ALTER TABLE issues ADD COLUMN importance text;` (nullable, no
  default, no backfill). Generated via the repo's existing drizzle migration workflow.
- Verify the migration is additive-only and does not alter/constrain `priority`.

## Testing

- **Unit** (`vitest`): `grouping.ts` — `quadrantOf`, `groupByQuadrant`,
  `groupByStatus`, and `dropTargetToPatch` boundary rules (medium→Urgent bumps to high;
  critical→Not-urgent drops to medium; low→Not-urgent unchanged; NULL importance →
  Unsorted).
- **Component / Storybook**: a `ProjectBoardView` story with fixture issues covering all
  quadrants + Unsorted + all statuses, in both layouts (repo already uses Storybook).
- **Migration smoke**: existing issues load with `importance = null` and render in Unsorted.
- Follow the design-guide + frontend-design skills during implementation for visual
  consistency with the existing app (not the Command Center's standalone styling).

## Risks / coordination

- **Another session is active** with all workspace `package.json`s modified and may be
  editing the shared schema. The collision surface is `packages/db` (migration + schema)
  and `packages/shared` (constants/validators/type). Keep those edits **strictly
  additive and minimal**. We are isolated on branch `vektor-kanban-eisenhower`.
- **Priority mutation on horizontal drag** can surprise users who think of the Eisenhower
  board as read-only for priority. Mitigation: only cross-band changes mutate priority,
  never within-band; the priority pill still shows the true value on each card.
- Migration ordering must not conflict with a migration the other session may add;
  regenerate against latest `master` before merge.

## Open questions

- None blocking. Confirm during review: exact tab label ("Board") and its position in the
  project tab bar.
