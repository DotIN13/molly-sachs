---
name: debug-electron
description: >-
  Drive and debug the Molly Sachs Electron desktop app the way you'd use Chrome
  DevTools — launch it under Playwright's Electron API, capture console + page
  errors + failed network requests, log in, switch tabs, and screenshot the
  renderer. Use when asked to run/inspect/screenshot the Molly app, verify a UI
  change actually renders, or diagnose a blank screen / console error in the
  desktop client. NOT for the FastAPI backend or hypogum (those are plain HTTP).
---

# Debugging the Molly Sachs Electron app

Molly's renderer is Chromium, so it speaks the Chrome DevTools Protocol. The
bundled harness (`debug.mjs`) launches the app via **Playwright's Electron API**
— which controls both the Node main process and the renderer — captures logs,
optionally logs in and switches tabs, screenshots, and exits.

## Prerequisite (one-time)

Playwright's driver must be installed in `frontend/` (Electron control needs **no**
browser download):

```bash
cd molly-sachs/frontend
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i -D playwright
```

## Run it

From anywhere (paths default to `molly-sachs/frontend`):

```bash
# Dev mode — attach to a running Molly Vite dev server (skips backend spawn).
# Use an isolated port if 5173 is taken by another app.
VITE_DEV_SERVER_URL=http://localhost:5173 \
  node molly-sachs/.claude/skills/debug-electron/debug.mjs \
  --screenshot=/tmp/molly.png --tab=work

# Prod mode — no VITE_DEV_SERVER_URL: loads frontend/dist and main.cjs spawns
# the backend itself (requires a built dist: `npm run build`).
node molly-sachs/.claude/skills/debug-electron/debug.mjs --screenshot=/tmp/molly.png
```

The harness prints a JSON report to stdout — `mode`, `title`, `url`, **`tabs`**
(which Molly tabs are present in the DOM — a layout-independent view of what the
app exposes, e.g. `['chat']` vs the full set), and captured `console` /
`pageerror` / `requestfailed`. Electron main-process logs (prefixed `[main]`) go
to stderr. So `... 2>/dev/null | jq .tabs` gives a clean machine-readable answer.

### Options & env

| Flag / env | Effect |
|---|---|
| `--tab=<name>` | Click a tab after load: `chat screen camera insights calendar tips plans work artifacts memories` (`--tab=login` = stay on login) |
| `--screenshot=<path>` | Save a PNG of the renderer |
| `--offscreen` | Move the window offscreen (`-3000,-3000`) so it doesn't grab the user's screen — good for a background run |
| `--keep` | Leave the app open (Ctrl+C to quit) for interactive poking |
| `--gpu` | Keep hardware GPU accel (default disables it + forces device-scale-factor=1 — see gotchas) |
| `--main=<rel path>` | Launch an alternate Electron entrypoint (e.g. a debug `main.cjs` that skips the backend wait — see below) |
| `--timeout=<ms>` | Launch/first-window timeout (default 25000; raise if the backend-wait is slow) |
| `MOLLY_FRONTEND` | Override path to `molly-sachs/frontend` |
| `MOLLY_BACKEND_URL` | Injects `localStorage.molly_backend_url` + reloads, so the app talks to a chosen Molly backend (e.g. an isolated `:8010`) |
| `MOLLY_ACCESS_TOKEN` / `MOLLY_REFRESH_TOKEN` | Injects auth tokens + reloads → app boots **logged in**, skipping the login UI |
| `MOLLY_TEST_EMAIL` / `MOLLY_TEST_PASSWORD` | Alternative: best-effort form login (fills email/password, clicks sign-in) |

**Authenticated debugging.** Passwords are hashed, so you can't recover one.
To boot logged-in, mint a short-lived JWT for an existing user with Molly's own
signing key and pass it via `MOLLY_ACCESS_TOKEN`/`MOLLY_REFRESH_TOKEN`:

```python
# run from backend/ with the venv (loads .env → JWT_SECRET)
import config, auth, sqlite3
uid = sqlite3.connect('../data/app.db').execute(
    "SELECT id FROM users WHERE email_verified=1 LIMIT 1").fetchone()[0]
print(auth.create_access_token(uid), auth.create_refresh_token(uid))
```

Pair with `MOLLY_BACKEND_URL` pointing at a running Molly backend (that same DB)
so the token validates. On a HiDPI/small display the harness auto-zooms so the
desktop layout (full tab bar) renders; it also reports `tabs` regardless of layout.

## Gotchas (learned the hard way — read before debugging a "blank window")

1. **`main.cjs` blocks on the backend before creating the window.** In
   `app.whenReady()` it does `await waitForBackend('http://localhost:8000/api/health')`
   **unconditionally** (even in dev), then `createWindow()`. If nothing answers
   `200` on `:8000`, the window is delayed ~30s — and if the OS network service
   is down (see #2) the `fetch` can hang and the window **never appears**. So:
   run with Molly's own backend up on `:8000`, or in prod mode. Watch for a
   different app squatting `:8000` (e.g. the `tutor` project also uses 5173/8000)
   — it will 404 the health check and stall the launch.
   - The URL is hardcoded to `:8000` and ignores `BACKEND_PORT`. Recommended
     `main.cjs` hardening: `if (!isDev) await waitForBackend(...)`, and build the
     URL from `BACKEND_PORT`. This also makes the app debuggable without a backend.

2. **Run on an interactive desktop with a real GPU.** In a headless / background /
   session-0 context, Electron's GPU + network service crash under the full
   React renderer (`Network service crashed … GPU process exited`). The harness
   disables the GPU by default (`--disable-gpu` etc.) to mitigate this, but a
   fully headless CI box may still be flaky — a normal logged-in desktop session
   is the reliable place to run this. Pass `--gpu` there for render fidelity.

3. **Most tabs need auth + hypogum.** The app opens on a login page; Chat and the
   agent tabs (Work / Artifacts / Plans / Calendar / Memories) need a logged-in
   session and a reachable **hypogum** on `:8056`. Provide `MOLLY_TEST_EMAIL` /
   `MOLLY_TEST_PASSWORD` and `MOLLY_HYPOGUM_URL`, and have `hypogum db` + `hypogum web`
   running (see hypogum's `python dev.py`). Login selectors are best-effort — if
   the Login DOM changes, update the locators in `debug.mjs`.

4. **Don't fight port conflicts.** Dev mode needs a Molly Vite server; if `5173`
   is used by another app, start Molly's on another port
   (`npx vite --port 5174 --strictPort`) and point `VITE_DEV_SERVER_URL` at it.

## Working around the backend-wait for a quick UI check

When you just want to see the renderer and `:8000` isn't serving Molly's backend
(gotcha #1), launch a debug entrypoint that skips the wait — no app edits:

```bash
cd molly-sachs/frontend/electron
# generate a debug main that skips waitForBackend (delete it afterwards)
sed 's|await waitForBackend(.*)|Promise.resolve()|' main.cjs > main.debug.cjs
cd ..
VITE_DEV_SERVER_URL=http://localhost:5174 \
  node ../.claude/skills/debug-electron/debug.mjs \
  --main=electron/main.debug.cjs --offscreen --screenshot=/tmp/molly.png
rm electron/main.debug.cjs
```

The proper fix is the `main.cjs` hardening noted in gotcha #1 (guard
`waitForBackend` behind `!isDev`, honor `BACKEND_PORT`).

## Test status

**Validated end-to-end**, including authenticated flows:
- Launched the real Molly renderer, captured console / errors / failed requests,
  and screenshotted the **login page** and the **logged-in Chat view**.
- Verified the **hypogum gating** by minting a JWT for a test user + isolated
  backend on `:8010`: with no hypogum configured the report showed
  `tabs = ['chat']`; after setting `hypogum_base_url` it showed all ten
  (`chat, screen, camera, insights, calendar, tips, plans, work, artifacts, memories`).

Done in a headless background session (small clamped display, GPU/network
instability) — the harness works around it (GPU-disable switches, offscreen,
adaptive zoom, DOM `tabs` report). On a normal desktop with Molly's backend on
`:8000` the plain `main.cjs` path works without the debug-main workaround.
