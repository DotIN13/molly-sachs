# Unified Architecture: Molly Sachs × Hypogum

**Status:** Design proposal
**Date:** 2026-07-24
**Owner:** tzhang3

## One sentence

**Hypogum becomes the memory + autonomy layer (the brain); Molly Sachs becomes the
interaction layer (the voice and face).** The two run as separate processes from separate
repos, linked only at runtime over plain HTTP/REST.

---

## Locked decisions

These were decided up front; the rest of the document follows from them.

| Decision | Choice | Consequence |
|----------|--------|-------------|
| **Transport** | Plain REST/HTTP | No MCP on the Molly↔Hypogum seam. Molly is an HTTP client of hypogum's web API. |
| **User model** | Keep Molly's multi-user auth (JWT + email verify); **hypogum stays single-user** | Each Molly user points at **their own single-user hypogum instance** (configured URL / local / auto-detected). No multi-user work in hypogum. See [Per-user hypogum instances](#per-user-hypogum-instances-resolved). |
| **Observer** | Hypogum owns all capture | All observe / ingest / planning happen in hypogum. Molly stops capturing entirely. |
| **First build slice** | Memory seam first | Add hypogum memory write + semantic search, delete Molly's ChromaDB, re-point Molly's chat tools. |
| **Packaging** | **Separate repos**, runtime-only link | Hypogum stays a standalone project. No build-time dependency. They discover each other via a configured base URL. |
| **Integration depth** | Unify memory (Phase 2) | One shared brain. Molly deletes its own memory/observer/processor. |
| **Primary goal** | Voice-driven autonomy | Molly notices → hypogum *does the work* → Molly narrates the result by voice. |

---

## Why these two combine

They are two halves of the same product with a shared lineage (identical describer model
`gemini-3.1-flash-lite`, near-identical memory category taxonomy, both watch the screen and
pause when locked).

| | **Molly Sachs (today)** | **Hypogum (today)** |
|---|---|---|
| Identity | A *presence* — voice + face | A *worker* — plans and acts |
| Frontend | Electron voice companion, 6 tabs, WebRTC | System-tray agent + web dashboard |
| LLM path | Direct Gemini calls (low-latency voice) | Shells out to an **agent CLI** (opencode/claude) |
| Memory | ChromaDB vectors + semantic dedup | Markdown files + ripgrep + MCP server |
| "Noticed something" → | A **proactive tip** (text advice) | A **run** that executes → produces artifacts |
| Planning | none | observed / planned / suggested calendar blocks, ICS |

**The punchline:** Molly can talk but can't do. Hypogum can do but can't talk. Fused, you get
a voice companion that notices what you're working on, actually does the prep work, and tells
you about it out loud.

---

## Target architecture

```
┌──────────────────────────────────────────────────────────────┐
│  MOLLY = INTERACTION LAYER   (repo: molly-sachs)               │
│                                                                │
│  Electron desktop app (React 19 + TS)                          │
│    • Unified tabs: Chat · Schedule · Plans · Work · Memory     │
│    • Notifications, presence                                   │
│  FastAPI + Pipecat backend (port 8000)                         │
│    • Voice chat: WebRTC · STT/TTS · direct Gemini (latency)    │
│    • Auth (JWT + email verify), settings (Fernet)              │
│    • Owns SQLite: users, conversations, messages ONLY          │
│    • Hypogum client: HTTP calls to the brain                   │
└───────────────────────────────┬────────────────────────────────┘
                                 │  REST / HTTP  (+ SSE for run streams)
                                 │  base URL configured per install
┌───────────────────────────────┴────────────────────────────────┐
│  HYPOGUM = MEMORY + AUTONOMY LAYER   (repo: hypogum)            │
│                                                                │
│  Always-on local service                                       │
│    • ONE observer → describe → ingest → plan → run             │
│    • Memory: markdown pages (source of truth)                  │
│        + NEW embedding index (semantic search)                 │
│    • Runner: DB-queue → agent CLI (opencode/claude) → artifacts│
│    • MCP server — retained, but ONLY for the agent runner      │
│      to read/write memory during a run (not the Molly seam)    │
│  Two internal servers today:                                   │
│    • db/server.py   /api/v1/…  durable store + run queue       │
│    • web/server.py  user-facing API (memory/calendar/plans/runs)│
└──────────────────────────────────────────────────────────────┘
```

---

## Responsibility split

**Molly owns (interaction only):**
- The Electron shell and all UI (repurposed tabs render hypogum's data).
- The Pipecat voice pipeline: WebRTC, VAD, STT, TTS.
- The real-time conversational LLM (direct Gemini call — latency-sensitive).
- Auth, user accounts, settings.
- Conversation + message persistence (its SQLite).

**Hypogum owns (everything about knowing and doing):**
- The single screen/camera observer, dedup, describer.
- Ingest (screen → memory) and planning (goals + schedule → suggested time blocks).
- Memory: the markdown wiki (source of truth) + the new embedding index.
- The runner: durable DB-queued execution via the agent CLI, producing artifacts.

**Deleted from Molly** (this is the point — collapse the redundancy):
- `frontend/src/observers/index.ts` — hypogum is the single observer.
- `backend/processor.py` — replaced by hypogum describe + ingest.
- `backend/proactive.py` — replaced by hypogum's planner; Molly *voices* suggestions.
- `backend/database.py` `VectorDB` (ChromaDB) + memory internals of `/api/memories` — memory now lives in hypogum. (`AppDB` stays for users/conversations/messages.)

**Kept in Molly:** `bot.py` (voice pipeline), WebRTC endpoints, `auth.py`, `config.py`,
`mailer.py`, `ratelimit.py`, `db/settings.py`, conversation endpoints.

---

## The REST seam (concrete)

Molly talks to hypogum's **web API** (`web/server.py`). Below, ✅ = exists today, 🆕 = must be
added to hypogum.

### Memory
| Need | Endpoint | Status |
|------|----------|--------|
| Browse memory tree | `GET  /api/memory/tree` | ✅ |
| Read a memory page | `GET  /api/memory/page?path=…` | ✅ |
| **Semantic search** (Molly chat `search_memory` tool) | `GET  /api/memory/search?q=…&limit=…` | 🆕 needs embedding index |
| **Write/update memory** (Molly chat `add_memory` tool) | `POST /api/memory` | 🆕 web API is read-only today |

> Today, memory *writes* only happen via the ingest pipeline and the MCP `memory_add` tool
> (used by the agent). Because we chose REST (not MCP) for Molly, hypogum must expose a REST
> write endpoint. It should reuse the exact logic behind MCP `memory_add` so both paths are
> consistent.

### Planning & schedule (feed Molly's Plans / Schedule tabs)
| Need | Endpoint | Status |
|------|----------|--------|
| List plans | `GET  /api/plans` | ✅ |
| List tasks in a plan | `GET  /api/tasks?plan_id=…` | ✅ |
| List calendar entries (observed/planned/suggested) | `GET  /api/calendar/entries` | ✅ |
| Accept a suggested block | `POST /api/calendar/accept` | ✅ |
| Dismiss a suggestion | `POST /api/calendar/dismiss` | ✅ |

### Runs (voice-driven autonomy)
| Need | Endpoint | Status |
|------|----------|--------|
| Submit a run from a plan/task | `POST /api/runs` (plan_path, prompt, task_path, task_id) | ✅ |
| **Submit an ad-hoc run from a voice command** | `POST /api/runs` w/ `{ prompt, user_id }`, no plan | 🆕 relax existing to make plan optional |
| List runs | `GET  /api/runs` | ✅ |
| Get run status/result **incl. short `summary`** | `GET  /api/runs/{id}` | 🆕 add `summary` field for voice announce |
| Stream run events | `GET  /api/runs/{id}/stream` (SSE) | ✅ |
| Abort a run | `POST /api/runs/{id}/abort` | ✅ |
| List / fetch artifacts | (via run result / artifacts dir) | ✅ (confirm shape) |

Every request carries Molly's authenticated `user_id` (see multi-user below).

---

## Memory unification

### Current state (verified 2026-07-24)

Hypogum has **no vector store today.** `memory/search.py` is **ripgrep only** (lexical), with a
plain substring fallback. There is nothing to keep in sync yet — the embedding index below is
net-new work.

### The index

Hypogum's markdown wiki is the **single source of truth** — git-friendly, human-readable,
and agent-native (the CLI reads/writes it directly). Molly's semantic needs (its dedup at
cosine ≥ 0.85 and goal/trait matching) are served by a **derived embedding index layered on
top of the markdown**. Reuse **ChromaDB** (persistent, same store Molly already used) with
Gemini embeddings via hypogum's existing `llm/gemini.py`.

- The index is a **derived cache, never the source** — it can be dropped and rebuilt from the
  markdown at any time.
- One collection per hypogum instance (single-user), one vector **per memory page**, keyed by
  the page's relative path, with a stored **content hash** in metadata for change detection.

### Keeping it fresh — periodic reconciliation, not just write hooks

**Why a sweep is mandatory:** most memory pages are written by the **agent CLI writing markdown
directly to disk** during ingest — those writes never pass through a Python function, so a
write-time hook alone would miss them. The index must reconcile against the filesystem.

**Primary mechanism — reconciliation sweep on every process cycle** (hypogum already runs one
every `HYPOGUM_PROCESS_INTERVAL`, default 600s; hook the indexer into it, right after ingest):

1. Walk the markdown tree (excluding `.tasks/`, `AGENTS.md`, `calendar_events/`).
2. For each page, compute a content hash; compare to the hash stored in the index.
3. **New or changed** → (re)embed and upsert. **Missing on disk** → delete from the index.
4. Unchanged → skip (no wasted embedding calls). This makes the sweep cheap and idempotent.

**Secondary mechanism — write-time upsert** for the paths that *do* go through Python (the new
REST `POST /api/memory` and MCP `memory_add`): upsert immediately so Molly's next query reflects
what you just said in chat, without waiting for the next cycle. The periodic sweep remains the
source of correctness; write-time upserts are only for latency.

**Exposure:** `GET /api/memory/search` for Molly (semantic), and optionally a
`memory_semantic_search` MCP tool so the agent runner benefits from the same index.

> This mirrors what Molly's `processor.py` did (embed + dedup at cosine ≥ 0.85), but relocated
> into hypogum and driven by a filesystem-reconciling sweep instead of an in-process pipeline.

The category taxonomies already align (goal / event / skill / interest / preference /
ownership / relationship / weakness), so there is **no data-model negotiation** — only a
mapping of hypogum's directory layout (`traits/*`, `entities/*`, `goals`, `struggles`,
`calendar_events/*`) to Molly's flat categories in the UI.

---

## Voice-driven autonomy: the end-to-end flow

```
You (voice): "Prep the apartment-outreach emails for me."
        │
        ▼
Molly bot.py — conversational Gemini decides this is an action, not just a reply
        │  POST /api/runs { user_id, prompt: "draft apartment outreach emails", ... }
        ▼
Hypogum web API → DB run queue (status=queued)
        │
        ▼
Hypogum RunnerService claims the run → agent CLI (opencode/claude) executes
        │  agent reads memory via MCP (goals, entities, prior context)
        │  writes artifacts into data/agent_workspace/<run>/
        ▼
Run reaches terminal state (done) → artifact available
        │
        ▼
Molly polls GET /api/runs/{id}/stream (SSE) → detects completion
        │
        ▼
Molly TTS: "I drafted three outreach emails — want me to read the first one?"
        │  Work tab shows the artifact; Molly can open/summarize it by voice
```

This is the payoff: Molly's mouth on hypogum's hands. Molly's old `proactive.py` "tips" become
hypogum's *suggested* calendar blocks and *runs* that Molly surfaces and narrates.

---

## Keep both LLM paths (a feature, not debt)

Do **not** collapse the two LLM strategies:
- **Real-time conversation** stays a **direct Gemini call** inside Molly's Pipecat pipeline —
  voice needs low latency and streaming.
- **Autonomous multi-step work** goes to hypogum's **agent CLI** — it needs tools, retries,
  filesystem access, and durable artifacts.

The split maps cleanly onto the layer boundary: interaction = direct LLM, autonomy = agent CLI.

---

## What happens to MCP (answering the open question)

**Molly never needed an MCP server, and it does not get one.** The Molly↔hypogum seam is REST.

But hypogum's **existing MCP server stays** — its job is different: it is how the **agent CLI**
(the runner) reads and writes memory *during a run*. That is an internal, agent-to-brain
channel, not the interaction seam. So:

- ❌ No MCP between Molly and hypogum.
- ✅ MCP retained inside hypogum for the agent runner.
- 🆕 Add `memory_semantic_search` as an MCP tool too, if we want the agent to benefit from the
  new embedding index.

---

## Per-user hypogum instances (resolved)

Molly keeps multi-user auth, but **hypogum stays a single-user local daemon** — we do *not*
namespace hypogum by `user_id`. Instead, the multi-user story lives entirely in Molly:

- **Each Molly user brings their own hypogum.** A hypogum instance is one person's brain,
  running on their own machine. Molly, per authenticated user, holds a **hypogum base URL** in
  that user's settings (encrypted alongside the API keys via the existing Fernet store).
- **Discovery, in priority order:**
  1. **Auto-detect** a hypogum on the expected local port (health check `GET /api/v1/health`).
  2. **User-configured URL** in Molly's Settings → "Hypogum" panel (for a hypogum running
     elsewhere on the LAN, or a non-default port).
  3. If neither resolves, Molly shows a "connect your hypogum" prompt in the affected tabs.
- **Mapping:** Molly's authenticated `user_id` → that user's configured hypogum instance. The
  instance itself is single-user, so no `user_id` needs to travel over the seam (though we may
  still send it for logging/telemetry).

This keeps the personal-companion model honest (your brain lives on your machine), requires
**zero multi-user work in hypogum**, and matches how both apps already assume "one human at the
keyboard." The only new work is Molly-side: a per-user hypogum URL setting + a detect/health
step at login.

---

## Implementation status (2026-07-24)

**Phase 1 (memory seam) — built and validated end-to-end.**

Hypogum (repo: `hypogum`):
- `memory/vector_index.py` — new `MemoryIndex`: persistent ChromaDB collection,
  one Gemini-embedded vector per page, content-hash metadata, `upsert_page` /
  `delete_page` / `search` / `reconcile`. All Chroma ops degrade gracefully.
- `memory/writer.py` — extracted the memory-write logic so the MCP `memory_add`
  tool and the new REST endpoint share one implementation.
- `memory/processor/pipeline.py` — reconciliation sweep hooked into the process
  cycle (Phase E0, after ingest).
- `web/server.py` — `POST /api/v1/memory` (write + write-time upsert) and
  `GET /api/v1/memory/semantic` (semantic search). Note the real prefix is
  **`/api/v1`**, not `/api` as sketched earlier in this doc.
- `config.py` — `embedding_model` (`gemini-embedding-001`), `memory_index_dir`.
- `pyproject.toml` — `chromadb>=0.5`.

Molly (repo: `molly-sachs`):
- `hypogum_client.py` — new async HTTP client (semantic search + write, base-URL
  resolution, health check, Molly→hypogum category mapping).
- `bot.py` — `make_search_memory` / `make_add_memory` re-pointed at hypogum;
  no longer touch ChromaDB.
- `config.py` `hypogum_base_url()` + `db/settings.py` per-user `hypogum_base_url`.

Verified: cross-process, Molly's client wrote two facts to a live hypogum web
server and semantically retrieved them (cosine 0.716 / 0.636, correct ranking).

**Phase 2 (retire Molly's observer + processor; tabs read hypogum) — built and validated.**

Molly backend:
- Deleted `processor.py`; removed `POST /api/observations` (upload sink) and
  `POST /api/processor/trigger`, plus the `process_pending_observations` import.
- `SettingsReq` + `GET/POST /api/settings` now carry `hypogum_base_url` so the
  frontend can discover the user's hypogum instance.

Molly frontend:
- `observers/index.ts` gutted to no-op stubs (hypogum owns all capture).
- New `hypogum.ts` — calls the user's hypogum directly (no auth; hypogum
  CORS-allows the Vite origin): observations (dates → day → file), and insights
  from the observed-calendar timeline. Base URL from settings, default `:8056`.
- `App.tsx` — `fetchObservations` sources screen/camera/insights from hypogum;
  removed the processor-trigger effect (now only polls for new tips); sets the
  hypogum URL from settings on load. `ObservationCard` takes a precomputed
  `imageUrl` (hypogum file URL) instead of building a Molly URL + token.

Verified: `tsc -b` clean, full `vite build` succeeds; the frontend's parser and
insight-mapping tested against a **live hypogum on real data** (14 days of
observations, 90 observed-calendar entries) — image relpaths and calendar
fields parse correctly. Molly backend imports clean with the processor gone.

Chosen approach for the read-tabs: **rewrite to consume hypogum's native shapes
directly** (per the decision), adapted in a thin `hypogum.ts` helper so the tab
JSX and pagination stay intact.

> Operational note: validating Phase 2 required stopping the developer's running
> hypogum instances on ports 8056/8055 (they were restarted only transiently for
> the test). Restart your hypogum daemon after pulling these changes.

**Phase 3 — autonomy bridge built and validated; retirement cleanup outstanding.**

Done (voice-driven autonomy — the marquee feature):
- Hypogum: `POST /api/v1/runs` (freeform prompt, no plan) via `RunManager.submit_adhoc`
  (creates an ad-hoc workspace); `summary` field added to run meta for voice announce.
- Molly `hypogum_client.py`: `submit_run` / `get_run` / `list_artifacts`.
- Molly `bot.py`: `run_task` LLM tool — enqueues a hypogum run, acks immediately,
  and a background poller narrates the outcome by voice (`TTSSpeakFrame`) + data-channel
  message + persisted assistant message on completion. Registered as a third chat tool;
  system prompt instructs Molly to use it for "do X for me" requests.
- Verified live: Molly's client enqueued a freeform run and polled it to `queued`
  (needed the `hypogum db` service on :8055 up alongside web on :8056). Full execution +
  spoken narration require the `hypogum runner` + opencode CLI + a live WebRTC session.

Retirement cleanup — done (frontend-direct rewrite, per the decision):
- Molly backend: deleted `proactive.py`, `/api/proactive/*`, and `/api/memories`
  (GET/POST/DELETE + model); removed `_embed_query` and the `google.genai` import
  from `bot.py`; **deleted `VectorDB`**, the `vector` singleton, its `init`, and the
  `chromadb` import from `database.py`. Molly's SQLite (`AppDB`) is all that remains.
- Hypogum: added `DELETE /api/v1/memory?path=` (removes page + index vector).
- Molly frontend (`hypogum.ts` + `App.tsx`): Tips tab now renders hypogum **suggested
  calendar blocks** (adapted to the existing `{tips:[{goal,tip_summary,tip_content}]}`
  shape so the JSX is unchanged); Memories tab lists via `memory/tree`, searches via
  `memory/semantic`, adds via `POST /api/v1/memory`, deletes via the new `DELETE`.
- Verified live: 199 suggested blocks feed Tips; memory tree groups feed Memories; a
  full add→delete round-trip removed the page from the semantic index. `tsc -b` +
  `vite build` clean; Molly backend imports clean with `VectorDB`/proactive gone.

ChromaDB now lives **only in hypogum** (the semantic index over the markdown wiki).
Molly no longer embeds, stores vectors, observes, or processes — it is purely the
interaction layer over hypogum's brain.

## Pick-your-hypogum + standalone chat mode (2026-07-24) — done

Molly now degrades gracefully to a **plain chat client when no hypogum backend is
configured**, and lights up memory + autonomy once the user picks one.

- **Backend URL picker** (Settings → Hypogum): a "Hypogum backend URL" field with
  **Test** (health-checks the entered URL) and **Detect local** (`:8056`) buttons +
  reachable/offline status. Persists to Molly's per-user `hypogum_base_url` setting;
  applied live (`setHypogumUrl`) on save.
- **Gating (frontend):** `hypogumEnabled = (hypogum_base_url is non-empty)`. When off,
  only the **Chat** tab is shown (`visibleTabs`), the active tab snaps back to Chat,
  and the proactive-tip poller is disabled. When on, all memory tabs appear.
- **Gating (backend `prompts/system_prompt.md`):** the system prompt is a Jinja
  template whose memory/autonomy half sits behind `{% if memory_enabled %}`, so a
  Molly with no hypogum is never told about tools she does not have. The
  `search_memory` / `add_memory` / `run_task` tools are registered **only when a
  hypogum URL is set**; otherwise the voice/chat LLM runs tool-free. `hypogum_base_url`
  is a pipeline-restart key, so toggling it rebuilds the pipeline (tools + prompt).

Net: `molly` starts as a friendly voice/text chat companion with zero setup; the
moment you point it at a hypogum, screen/insights/calendar/tips/plans/work/artifacts/
memories and the chat memory tools all activate.

## Dashboard retirement + full parity (2026-07-24) — done

Audited hypogum's 7 dashboard pages vs Molly, built the missing pieces into Molly,
then made `hypogum web` API-only. **Molly is now the sole UI.**

New Molly tabs/components (all consume hypogum REST directly via `hypogum.ts`):
- **Work tab** (`WorkTab.tsx`) — runs list + incremental run-event log + abort;
  opencode session browser + transcript; agent-status bar + **Quick Note** (`POST /note`).
- **Artifacts tab** (`ArtifactsTab.tsx`) — deliverables list + preview drawer
  (HTML iframe / image / Markdown / text, multi-file switcher).
- **Plans tab** (`PlansTab.tsx`) — browse agent task-plans, **manually run a task**
  (`POST /plans/run`), recent-runs strip.
- **Memory page-detail** (`MemoryDetailModal.tsx`) — click a memory → frontmatter,
  Markdown body, wikilinks, backlinks (`GET /memory/page`).
- `hypogum.ts` gained runs/sessions/artifacts/plans/status/note/memory-page helpers.
- i18n (en + zh) for all new tabs/strings.

Hypogum dashboard retired:
- `web/server.py` no longer serves the React build — **API-only** now (removed the
  static mount, SPA catch-all, `_resolve_dist`, `StaticFiles`). Root `/` returns a
  small JSON notice. Fixed a shadowing bug (the new root handler was named `root`,
  colliding with the `root = store.root` Path).
- `dev.py` no longer starts the hypogum Vite dev server.
- The `hypogum/frontend/` directory is now dead code (safe to delete later).

Verified live: all new-tab endpoints return real data (runs 9, artifacts 13, plans 10,
status, sessions 0 w/ opencode offline, note queued, memory page body); `/` is API-only;
`memory/tree` still works post-rename. `tsc -b` + `vite build` clean.

Coverage note: every hypogum dashboard feature now has a Molly home —
Schedule→Calendar, Memory→Memories(+detail), Observations→Screen/Camera,
Dashboard(status/note/agenda)→Work+Calendar, Agent Plans→Plans, Artifacts→Artifacts,
Agent Work→Work.

## Follow-up round (2026-07-24, later) — done

- **Cleanup:** dropped `CHROMA_PATH` from Molly `config.py`; pruned dead imports
  (`base64`/`json`/`time`/`Request` in `main.py`, `json`/`os`/`uuid`/`genai`/module-level
  `Settings` in `bot.py`, `dataclass` in `database.py`). pyflakes-clean.
- **Runner-populated run summary:** hypogum `runner/service.py` writes a short
  `summary` on task-run completion (artifact titles / outcome), stored in the runs
  table's existing `summary` column and surfaced by `GET /api/v1/runs/{id}`. Molly's
  `run_task` narrator prefers it, falling back to composing from artifacts.
- **Calendar view (Molly frontend):** new **Calendar tab** consuming hypogum
  `GET /api/v1/calendar` (observed/planned/suggested), grouped by day with bucket
  badges + times; suggested blocks have **Accept/Dismiss** (hypogum
  `/calendar/accept|dismiss`). i18n added (en + zh). Verified live: 294 entries
  (90 observed / 199 suggested / 5 planned).
- **Persisted settings; `.env` = defaults:** hypogum's runtime knobs (observe
  intervals/toggles, process interval, pause-when-locked, models, timezone…) now
  resolve from the **persisted db settings overlaid on `.env` defaults** via
  `config.apply_persisted_settings`, applied at the `agent`/`runner`/`web` entry
  points. Hypogum web exposes `GET`/`PATCH /api/v1/settings` (proxying the db
  service). Molly's Settings modal has a new **Hypogum** section that loads/saves
  those settings directly. Verified live: PATCH→GET round-trip; empty value ⇒ falls
  back to the `.env` default. Changes take effect on hypogum's next cycle/restart
  (live hot-reload of running observer/processor threads is a future refinement).

**Previously deferred (now superseded above):**
- **`proactive.py` + `/api/proactive/tip` + the Tips tab** — replaced by
  hypogum's planner/suggested-blocks. Still on Molly's `VectorDB`.
- **Full `VectorDB` removal** — `proactive.py` and the dead `/api/memories`
  Memories-tab endpoints still reference it; removed when those go in Phase 3.
- **The autonomy bridge** (voice → `POST /api/runs` → narrate artifact) and the
  Plans/Schedule/Work tabs.

**Deferred (from Phase 1) to later phases:**
- **Full ChromaDB removal from Molly.** `database.VectorDB` still backs
  `processor.py`, `proactive.py`, and the `/api/memories` *Memories-tab*
  endpoints in `main.py`. Those are retired in Phase 2/3; deleting `VectorDB`
  now would break them. The **chat** path no longer uses it.
- **Memories-tab UI migration** to hypogum's data model (Phase 3 tab work).

**Known caveat — multi-process ChromaDB.** Both `hypogum web` and the processor
open the same `memory_index` PersistentClient path. ChromaDB's SQLite store is
not designed for heavy concurrent multi-process writes; all index ops are
wrapped to fail soft (a lock collision logs a warning, never crashes a request
or cycle). If this proves flaky under load, move the index behind a single
owning process (e.g. only the processor writes; the web server reads via a
thin query call), or use Chroma in client/server mode.

## Phasing

1. **Seam up memory (first slice).** Stand up hypogum as the local service. Delete Molly's
   ChromaDB. In hypogum, add: the ChromaDB embedding index + **reconciliation sweep on the
   process cycle** (populates the index from agent-written markdown), 🆕 `POST /api/memory`
   (write, with write-time upsert), and 🆕 `GET /api/memory/search` (semantic). Re-point Molly's
   chat `search_memory` / `add_memory` tools at those REST endpoints.
   → Voice chat now reads/writes the same brain hypogum builds from your screen.
2. **Retire Molly's observer + processor.** Remove `observers/index.ts`, `processor.py`. Molly's
   Screen/Insights tabs read hypogum's observations/memory over REST.
3. **Autonomy bridge.** Molly's LLM can `POST /api/runs`; Molly polls the SSE stream and narrates
   artifacts. Retire `proactive.py`; Plans/Schedule/Work tabs render hypogum data.
4. **Multi-user hardening.** Namespace hypogum by `user_id` per the decision below.

---

## Resolved decisions (follow-up round)

- **Multi-user:** hypogum stays single-user; each Molly user points at their own hypogum
  instance (configured URL / local / auto-detected). See [Per-user hypogum instances](#per-user-hypogum-instances-resolved).
- **Observer:** hypogum owns all capture; Molly stops capturing.
- **First slice:** the memory seam.
- **Ad-hoc runs:** voice commands submit a **freeform prompt with no plan** —
  `POST /api/runs` is relaxed to accept `{ prompt, user_id }` and create a run not tied to a
  calendar plan. (Planned/scheduled runs still exist for the planner's own suggestions.)
- **Artifact delivery:** Molly **announces + summarizes** — she says it's done with a 1–2
  sentence summary and opens the Work tab. This requires hypogum's run result to include a
  short `summary` field (🆕 — the runner or a cheap post-step generates it).
- **Hypogum dashboard:** **demote / eventually retire.** Molly's Electron UI becomes the sole
  frontend over time; hypogum's React dashboard is no longer invested in (kept only as a
  transitional debug tool).

All open questions are now resolved. Implementation can proceed with the memory seam.
```
