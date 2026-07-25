# Molly Sachs

A real-time AI voice & text companion desktop app. Molly is the **interaction layer** — a
voice/chat client you can use on its own. When you point it at a [hypogum](../hypogum)
backend (the memory & autonomy brain), Molly gains long-term memory, a calendar, and the
ability to delegate background agent tasks.

> **Two-repo design.** Molly Sachs = interaction (voice + desktop UI + chat LLM).
> **hypogum** = memory + autonomy (screen observation, a markdown memory wiki with a
> semantic index, calendars, and an agent that runs tasks). Molly talks to a per-user
> hypogum instance over its local REST API. Without a hypogum URL configured, Molly is a
> plain chat client and all memory/work features stay hidden.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│  Electron Desktop App (React 19 + TypeScript + Vite)       │
│                                                            │
│  Sidebar ── two modes ─────────────────────────────────┐  │
│   • Chat   : new chat · ⌘K search · conversation list   │  │
│   • Memory : work-view tabs (calendar/artifacts/plans/  │  │
│              work/observers) + grouped memory pages     │  │
│              (goals·entities·traits·struggles)          │  │
│                                                            │
│  Chat transcript renders tool-call cards + markdown.       │
│  Memory mode is enabled only when hypogum is reachable.    │
└───────────────┬───────────────────────┬───────────────────┘
                │ HTTP + WebRTC          │ HTTP (per-user URL)
┌───────────────┴───────────────┐  ┌────┴───────────────────────┐
│  Molly Backend — FastAPI :8000 │  │  hypogum (separate repo)    │
│                                │  │  local REST API :8056       │
│  • Auth (JWT) + settings       │  │                             │
│  • SQLite: users, convos, msgs │  │  • memory wiki + semantic   │
│  • Pipecat WebRTC pipeline     │  │    index (goals/entities/…) │
│      STT → VAD → LLM → TTS     │  │  • calendar (observed/      │
│  • Chat LLM: Google / OpenAI / │  │    planned/suggested)       │
│    Anthropic / DeepSeek        │  │  • runs / artifacts / plans │
│  • Chat tools ─────────────────┼──┼─▶ search_memory, add_memory │
│    (only when hypogum is set)  │  │    read_memory_page,        │
│  • hypogum_client (async REST) │  │    fetch_calendar,          │
│                                │  │    list_artifacts, run_task │
└────────────────────────────────┘  └─────────────────────────────┘
```

**Tech Stack**
- **Frontend**: Electron 42 · React 19 · TypeScript · Vite 8 · Tailwind CSS 3 · react-i18next
- **Backend**: Python 3.12 · FastAPI · Pipecat-ai 1.6 (WebRTC)
- **Chat LLM**: selectable per user — Google Gemini · OpenAI · Anthropic Claude · DeepSeek
- **Voice**: Cartesia TTS · Soniox or Cartesia STT · Silero VAD · RNNoise
- **Storage (Molly)**: SQLite only — users, conversations, messages, per-user settings
- **Memory/autonomy**: delegated to **hypogum** over REST (Molly stores no vector data)

---

## Features

### Sidebar: Chat / Memory

The app has two top-level modes. **Chat** works with no backend beyond Molly itself.
**Memory** unlocks only when a reachable hypogum URL is configured (health-checked every
15 s; if it drops, you snap back to Chat).

| Mode | Sidebar | Main view |
|------|---------|-----------|
| **Chat** | New chat · ⌘K search popup · conversation list | The conversation (voice + text) |
| **Memory** | ⌘K search · memory pages grouped by category (goals · entities · traits · struggles) | Work-view tabs in the header |

Work-view tabs (Memory mode): **Calendar · Artifacts · Plans · Work · Observers** — all
served live from the connected hypogum instance.

### Voice & text chat (WebRTC)

The chat pipeline runs via Pipecat over WebRTC:

- **Audio in** → RNNoise → audio-level meter → VAD (Silero) → STT (Soniox/Cartesia) → text
- **LLM** (selected provider) → response → text chunking → TTS (Cartesia) → **audio out**

Voice mode toggles on/off (mic muted + TTS silenced when off). Text chat works in parallel
over the DataChannel with or without voice. Conversation history persists in SQLite, and
you can hot-switch conversations without tearing down the WebRTC connection.

### Selectable chat LLM

Pick the chat provider and model in **Settings → API Config**:

| Provider | Default model | Key |
|----------|---------------|-----|
| Google Gemini | `gemini-3.1-flash-lite` | `gemini_api_key` |
| OpenAI | `gpt-4.1` | `openai_api_key` |
| Anthropic Claude | `claude-sonnet-4-6` | `anthropic_api_key` |
| DeepSeek | `deepseek-chat` | `deepseek_api_key` |

Leave the model field blank to use the provider default. Changing provider/model/key
rebuilds the pipeline transparently.

### Chat tools (memory & autonomy)

When a hypogum backend is configured, Molly's LLM gains six tools that call the user's
hypogum instance. Each tool call — and its result — is recorded to the conversation and
rendered as a collapsible **tool card** in the transcript.

| Tool | What it does |
|------|--------------|
| `search_memory` | Semantic search over the user's memory wiki |
| `read_memory_page` | Read a specific memory page in full |
| `add_memory` | Queue the user's statement to hypogum's **ingest** inbox; the ingest agent categorizes and files it (Molly does not categorize) |
| `fetch_calendar` | Look up observed / planned / suggested calendar entries |
| `list_artifacts` | List deliverables produced by background agent runs |
| `run_task` | Delegate a background task to the hypogum agent; returns immediately, then narrates the result by voice when it completes |

`run_task` completion is **LLM-in-the-loop**: when the background run finishes, a briefing
is injected into the live context and one inference is triggered, so Molly narrates the
outcome in her own words through the normal TTS path.

### Memory pages

Memory pages live in hypogum and are browsed from Molly's sidebar, grouped by category.
Clicking a page opens it in the main view with **in-place markdown editing** (saved back to
hypogum via `PUT /api/v1/memory/page`).

### Calendar

Day and Apple-style week views. Click any event to open a detail drawer showing its full
info, accept/dismiss suggested blocks, run any linked agent tasks, or launch an ad-hoc
agent run seeded from the event.

---

## Project Structure

```
molly-sachs/
├── backend/
│   ├── main.py            # FastAPI server — auth, settings, conversations, WebRTC
│   ├── bot.py             # Pipecat WebRTC pipeline, chat LLM selection, tools, prompts
│   ├── hypogum_client.py  # Async REST client to the user's hypogum instance
│   ├── database.py        # SQLite (AppDB): users, conversations, messages, observations
│   ├── auth.py            # JWT auth + password hashing (pwdlib)
│   ├── config.py          # Paths, CORS, ICE servers, env helpers
│   ├── mailer.py          # SMTP email verification
│   ├── ratelimit.py       # In-memory rate limiter
│   ├── requirements.txt
│   ├── db/
│   │   └── settings.py    # Per-user settings; API keys encrypted at rest (Fernet)
│   └── scripts/           # One-off maintenance scripts
│
├── frontend/
│   ├── electron/          # main.cjs + preload.cjs (context bridge)
│   └── src/
│       ├── App.tsx        # Shell: sidebar modes, header tabs, chat, WebRTC wiring
│       ├── hypogum.ts     # REST client for the connected hypogum instance
│       ├── config.ts      # API URL, token storage, platform detection
│       ├── components/
│       │   ├── CalendarTab.tsx / CalendarEventDetail.tsx  # day+week views, event drawer
│       │   ├── MemoryDetailView.tsx    # memory page viewer + markdown editor
│       │   ├── ToolCallCard.tsx        # tool-call transcript cards
│       │   ├── WorkTab.tsx / PlansTab.tsx / ArtifactsTab.tsx / ObserversTab.tsx
│       │   ├── SettingsModal.tsx       # LLM / speech / hypogum settings
│       │   └── Markdown.tsx, EmptyState.tsx, ui/…
│       ├── hooks/         # useWebRTC, useAudioVisualizer
│       ├── contexts/      # AuthContext
│       ├── pages/         # Login (register + email verification)
│       └── i18n/          # react-i18next (en.json / zh.json)
│
└── data/                  # Runtime data (gitignored): app.db (SQLite)
```

---

## Configuration

### Environment Variables (`backend/.env`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMINI_API_KEY` | — | Default chat-LLM key (also usable per-user in Settings) |
| `CARTESIA_API_KEY` | — | Cartesia TTS/STT key |
| `SONIOX_API_KEY` | — | Soniox STT key |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` | — | Optional chat-LLM provider keys |
| `HYPOGUM_BASE_URL` | `http://127.0.0.1:8056` | Default hypogum URL (overridable per user) |
| `JWT_SECRET` | auto-generated | HS256 signing key |
| `FERNET_KEY` | auto-generated | Symmetric encryption for stored API keys |
| `DEBUG` | false | Enable debug panel in settings |
| `DATA_DIR` | `../data` | Root path for SQLite storage |

API keys can also be set per-user in the app (encrypted at rest with Fernet); those take
priority over the environment defaults.

### In-App Settings

- **General** — language (English / 中文), timezone
- **Speech** — TTS voice/volume/speed/emotion; STT provider + language
- **API Config** — chat LLM provider + model + provider key; Cartesia/Soniox speech keys
- **Hypogum** — the backend URL (with a reachable/unreachable badge) plus the hypogum
  instance's own observer/agent knobs (persisted in hypogum; its `.env` supplies defaults)

---

## Getting Started

### Prerequisites
- Node.js 20+
- Python 3.12+
- Windows (Electron desktop client is currently Windows-focused)
- *(optional)* a running [hypogum](../hypogum) instance for memory/autonomy features

### Backend
```bash
cd backend
python -m venv venv
.\venv\Scripts\activate        # Windows
pip install -r requirements.txt
cp .env.example .env           # then set at least one chat-LLM key + speech keys
```

### Frontend
```bash
cd frontend
npm install
```

### Run (development)
```bash
cd frontend
npm run dev
```
Starts the Vite dev server, the Electron app, and the Python backend (uvicorn on `:8000`)
together. First launch shows login/register; after verifying your email, set your API keys
in Settings. To enable memory features, set your hypogum URL there too.

### Run (production build)
```bash
cd frontend
npm run build
```

---

## API Endpoints (Molly backend)

### Auth
| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/auth/register` | Register with email + password |
| POST | `/api/auth/verify` | Verify email with a 6-digit code |
| POST | `/api/auth/login` | Login, receive JWT tokens |
| POST | `/api/auth/refresh` | Refresh an expired access token |
| POST | `/api/auth/resend-verification` | Resend the verification code |
| GET | `/api/auth/me` | Current user |

### Conversations
| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/conversations` | Create a conversation |
| GET | `/api/conversations` | List conversations |
| DELETE | `/api/conversations/{id}` | Delete a conversation |
| POST | `/api/conversations/{id}/messages` | Persist a message |
| GET | `/api/conversations/{id}/messages` | Load messages (incl. `tool` records) |

### Settings & WebRTC
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/settings` | Load user settings (keys returned as `*_configured` booleans) |
| POST | `/api/settings` | Save user settings |
| POST | `/api/webrtc/connect` | SDP offer → start the Pipecat session |
| PATCH | `/api/webrtc/connect` | Trickle-ICE candidate relay |
| GET | `/api/health` | Health check |

> Memory, calendar, observations, runs, and artifacts are read **directly from the
> connected hypogum instance** — by the frontend (`frontend/src/hypogum.ts`) and by the
> chat tools (`backend/hypogum_client.py`), not through Molly's own backend. (A couple of
> legacy read-only endpoints — `/api/observations`, `/api/insights` — remain in `main.py`
> but are unused.) See the [hypogum README](../hypogum/README.md) for that API.
