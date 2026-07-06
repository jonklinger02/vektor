# The Refinery — chat-driven work intake

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation plan
**Route:** `vektorlabs.io/refinery`

## Purpose

A standalone, notepad-like chat section where the user describes a problem or
need, refines it in conversation with a model of their choice, and — once the
plan is finalized — materializes it as exactly one of: a new **task** (issue),
a new **goal**, or a new **project**. Independent of the dashboard: sessions
are private scratch space, never visible in issue lists, exports, or company
views.

Decisions locked with the user:

| Decision | Choice |
|---|---|
| Surface | New top-level page `/refinery`, outside the company prefix |
| Notepad shape | Many named sessions in a left sidebar |
| Company scope | Chosen at finalize time (proposal card selector) |
| Chat powers | Agentic with **read** tools (API lookups mid-chat) |
| Engine | opencode relay (same engine as agent runs); model picker |
| Persistence | New dedicated tables (`refinery_sessions`, `refinery_messages`) |
| Context control | User-managed filter over an immutable transcript |

## Data model (migration 0134)

`refinery_sessions`
- `id` uuid pk
- `owner_user_id` — sessions are user-scoped and private to their owner
- `title` text — auto-generated from the first user message, renameable
- `status` text: `active` → `finalized` → `archived`
- `model` text — last-used model id (picker default on reopen)
- `finalized_kind` (`task|goal|project`), `finalized_entity_id`,
  `finalized_company_id` — set when the proposal card creates the entity
- `created_at`, `updated_at`

`refinery_messages`
- `id` uuid pk, `session_id` fk (indexed)
- `role` text: `user | assistant`
- `body` text — **immutable after insert**
- `model` text — model that produced/received the turn
- `context_excluded` boolean default false — the ONLY mutable field
- `created_at`

No company FK anywhere until finalize. Access rule: owner only (no
instance-admin bypass in v1).

## Server (`server/src/routes/refinery.ts`)

Session/message plumbing:
- `GET    /api/refinery/sessions` — own sessions, newest first
- `POST   /api/refinery/sessions` — create (optional title)
- `PATCH  /api/refinery/sessions/:id` — rename / archive
- `GET    /api/refinery/sessions/:id/messages` — full transcript incl. flags
- `PATCH  /api/refinery/messages/:id/context` — toggle `context_excluded`
  (body is never mutable; no message edit/delete endpoints exist)
- `GET    /api/refinery/models` — picker list assembled from
  `PAPERCLIP_OPENCODE_PROVIDERS` (custom providers) + the built-in
  ollama-cloud entries the smart-router catalog already knows. Shape:
  `{id, label, tier}`. The UI hardcodes no models.

Chat relay:
- `POST /api/refinery/sessions/:id/chat/stream` `{message, model}` → SSE
  1. Persist the user message.
  2. Assemble history: all session messages **where `context_excluded` =
     false**, oldest first, serialized as injection-safe tagged turns
     (`<turn role=…>` with `</turn` neutralized). This serializer is
     extracted from `board-chat.ts` into a shared helper and reused by both.
  3. Spawn `opencode run --format json --model <picked>` with the refinery
     skill as system prompt, following the opencode adapter's invocation
     pattern (provider injection from `PAPERCLIP_OPENCODE_PROVIDERS`, XDG
     config dir injection, permission config).
  4. Stream SSE events — same protocol as board chat: `start / status /
     chunk / done / error`.
  5. Persist the assistant reply with `%%ACTIONS%%…%%/ACTIONS%%` blocks
     stripped from the durable body (signals are transport, not transcript).
- Concurrency cap: 3 simultaneous relay processes (shared pattern with
  board chat); excess requests get SSE `error` "busy".

Agentic reads — **revised for the authenticated deployment** (2026-07-06,
during planning): the existing board chat is deliberately gated to
`local_trusted` mode because a spawned CLI with tool permissions is the
server operator's shell; CT111 runs `authenticated` mode with the service
as root, so giving the model bash/curl would hand a root shell to any
signed-in user via prompt injection. Therefore v1 spawns opencode with
**all tools denied** (permission: bash/edit/webfetch = deny — a pure
inference relay), and instance awareness comes from a **server-injected
context pack**: before each turn the relay fetches, with the session
owner's own authorization, compact listings of companies, agents,
projects, and goals, and appends them to the system prompt. The model
"knows the org" — the benefit the agentic option was chosen for — with
zero tool attack surface. True read-tools via a scoped MCP endpoint are
a v2 follow-up. Entity creation never flows through the model in any case.

## UI

New route `/refinery` (auth-gated), nav entry with notepad icon, Command
Center theme.

Layout:
- **Sidebar** — session list (title, status chip, updated-at), New session,
  rename, archive. Finalized sessions show a link chip to their created
  entity.
- **Chat pane** — reuses `ChatComposer`, `MarkdownBody`, and the SSE
  streaming pattern from `BoardChat.tsx`.
- **Header** — session title, **model picker** (from `/api/refinery/models`,
  last choice persisted per user in localStorage), **Finalize** button,
  **Context** drawer toggle.

Transcript & context control:
- Every bubble has an include/exclude toggle (eye icon). Excluded messages
  remain fully visible but render dimmed/struck — the transcript is a
  permanent record; exclusion only removes them from future model context.
- **Context drawer** — shows exactly what the next turn will send: ordered
  included messages + system-prompt reference + rough size indicator. The
  drawer and the server history builder share the same selection rule
  (excluded ⇒ absent), so inspect-equals-send.
- Bulk range action: "exclude from here up/down" for cutting whole tangents.

## Finalize flow

1. Model-initiated: when the conversation converges, the skill emits one
   `%%ACTIONS%%{"proposal":{"kind":"task|goal|project","title":…,
   "description":…,"priority"?:…,"level"?:…}}%%/ACTIONS%%` signal.
2. User-initiated: the header **Finalize** button sends a canned instruction
   asking the model to produce the proposal from current (filtered) context.
3. The UI renders the proposal as a **card**: kind switcher, editable
   title/description, priority (task) or level (goal), and a **company
   selector** defaulting to the user's active/only company.
4. **Create** calls the existing APIs from the browser session —
   `POST /companies/:id/issues`, `/goals`, or `/projects` — deterministic
   and permission-checked; the model is never in the write path.
5. Success: card shows a link to the created entity; session `status` →
   `finalized` with kind/entity/company recorded. The session remains
   readable and can keep chatting. Re-finalizing is allowed: each Create
   makes a **new** entity (nothing is retroactively modified) and the
   session's recorded pointer moves to the most recently created one.
6. Recovery path: exclude the sideways messages, hit Finalize again — a
   fresh proposal is generated from the filtered context.

## Skill (`skills/vektor-refinery/SKILL.md`)

A refinement partner, not an operator:
- Ask clarifying questions; converge on scope, outcome, and constraints.
- May READ the API for context (list companies, agents, projects, goals)
  using `$PAPERCLIP_API_URL` + bearer key; presents findings conversationally.
- Emits exactly one proposal signal per finalize request, only after user
  confirmation in-chat or an explicit Finalize instruction.
- Never creates, updates, or deletes entities. Never emits actions other
  than `proposal`.

## Error handling

- opencode spawn failure → SSE `error` with stderr tail; slot released.
- Malformed proposal JSON → ignored; visible status line ("proposal signal
  unreadable — ask again or hit Finalize"); never a crash.
- Entity-create API failure → inline error on the card; fields stay
  editable; retryable.
- Relay busy (cap reached) → SSE `error` "busy", user retries.

## Testing

- Server unit: session/message CRUD + owner isolation; models endpoint
  (providers parsing incl. the truncated-JSON regression); history builder
  respects `context_excluded`; shared turn serializer (injection cases);
  proposal-signal parse/strip round-trip.
- UI: sidebar CRUD flows; bubble exclude toggle renders + persists; context
  drawer matches filter state; proposal card render → create → link chip
  (mirroring `BoardChat.test.tsx` patterns).
- Live verification on the dev instance (`~/.paperclip-vektor-dev`) against
  Ollama Cloud: full describe → refine → exclude → finalize → task created.
- Deploy notes: migration 0134 ships in artifact; `skills/vektor-refinery/`
  must be included in the deploy pack (same loader pattern as
  `paperclip-board`); CT111 rollout per the established runbook.

## Out of scope (v1)

- Sharing sessions between users; admin visibility.
- Editing or deleting transcript messages (immutable by design).
- Write-capable tools for the model.
- Claude-CLI engine path (board chat's existing relay is untouched).
- Token-accurate context accounting (rough size indicator only).
