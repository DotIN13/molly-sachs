#!/usr/bin/env node
/**
 * Molly Sachs — Electron debug harness.
 *
 * Drives the Molly desktop app via Playwright's Electron API: launches it,
 * captures console + page errors + failed requests, optionally logs in and
 * switches to a tab, screenshots the renderer, then closes.
 *
 * Usage (run from anywhere; paths resolve to molly-sachs/frontend by default):
 *   node debug.mjs [--tab=work] [--screenshot=shot.png] [--offscreen] [--keep] [--timeout=20000]
 *
 * Modes:
 *   - dev  : set VITE_DEV_SERVER_URL=http://localhost:<port>  (Molly Vite; skips backend spawn)
 *   - prod : leave VITE_DEV_SERVER_URL unset → loads frontend/dist and main.cjs spawns the backend
 *
 * Env:
 *   MOLLY_FRONTEND        override path to molly-sachs/frontend
 *   VITE_DEV_SERVER_URL   dev-mode Vite URL (see above)
 *   MOLLY_TEST_EMAIL      optional — attempt login
 *   MOLLY_TEST_PASSWORD   optional — attempt login
 *   MOLLY_HYPOGUM_URL     optional — sets localStorage so agent tabs hit your hypogum
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── args ──
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] ?? true] : [a, true]
}))
const FRONTEND = process.env.MOLLY_FRONTEND || path.resolve(__dirname, '../../../frontend')
const MAIN = path.resolve(FRONTEND, String(args.main || process.env.MOLLY_MAIN || 'electron/main.cjs'))
const TIMEOUT = Number(args.timeout || 25000)
const SHOT = args.screenshot ? path.resolve(String(args.screenshot)) : null
const TAB = args.tab ? String(args.tab) : null

if (!fs.existsSync(MAIN)) {
  console.error(`[debug] main.cjs not found at ${MAIN} — set MOLLY_FRONTEND`)
  process.exit(2)
}

// Resolve electron + playwright from the frontend's node_modules regardless of cwd.
const require = createRequire(path.join(FRONTEND, 'package.json'))
let electronPath, _electron
try {
  electronPath = require('electron')            // electron package exports the binary path
  ;({ _electron } = require('playwright'))
} catch (e) {
  console.error('[debug] missing dependency. In frontend/: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i -D playwright`')
  console.error(String(e.message || e))
  process.exit(2)
}

const logs = { console: [], pageerror: [], requestfailed: [] }
const stamp = () => new Date().toISOString().slice(11, 23)

async function main() {
  const env = { ...process.env }
  const mode = env.VITE_DEV_SERVER_URL ? `dev (${env.VITE_DEV_SERVER_URL})` : 'prod (dist)'
  console.error(`[debug] launching Electron — mode: ${mode}`)

  // Chromium switches for headless/background sessions where the GPU + network
  // service crash under a heavy renderer. Pass --gpu to keep hardware accel
  // (use when running on a real interactive desktop and you want fidelity).
  const safeSwitches = args.gpu ? [] : [
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-gpu-compositing',
    '--disable-dev-shm-usage',
    '--no-sandbox',
  ]
  // Normalize DPI so CSS px == device px — otherwise a HiDPI display shrinks the
  // CSS viewport below the desktop breakpoint and the app renders mobile layout.
  safeSwitches.push('--force-device-scale-factor=1', '--high-dpi-support=1')

  const app = await _electron.launch({
    executablePath: electronPath,
    args: [...safeSwitches, MAIN],
    cwd: FRONTEND,
    env,
    timeout: TIMEOUT,
  })

  // Surface the Electron main-process stdout/stderr (main.cjs console logs,
  // backend startup, crashes) — invaluable when the window never appears.
  app.process().stdout?.on('data', d => process.stderr.write('[main] ' + d))
  app.process().stderr?.on('data', d => process.stderr.write('[main] ' + d))

  // Optionally push the window offscreen so it doesn't grab the user's screen.
  if (args.offscreen) {
    try {
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]
        if (w) { w.setPosition(-3000, -3000); w.showInactive?.() }
      })
    } catch { /* window not ready yet */ }
  }

  const win = await app.firstWindow({ timeout: TIMEOUT })
  // Force a desktop-width window so the full tab bar (lg: breakpoint) renders.
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 900))
  } catch { /* window not ready */ }
  win.on('console', m => logs.console.push({ t: stamp(), type: m.type(), text: m.text() }))
  win.on('pageerror', e => logs.pageerror.push({ t: stamp(), error: String(e) }))
  win.on('requestfailed', r => logs.requestfailed.push({ t: stamp(), url: r.url(), err: r.failure()?.errorText }))

  await win.waitForLoadState('domcontentloaded').catch(() => {})
  await win.waitForTimeout(1500)

  // Inject backend URL + auth tokens into localStorage and reload, so the app
  // boots already pointed at a chosen backend and logged in (skips the login UI).
  if (env.MOLLY_BACKEND_URL || env.MOLLY_ACCESS_TOKEN) {
    await win.evaluate(([b, a, r]) => {
      if (b) localStorage.setItem('molly_backend_url', b)
      if (a) localStorage.setItem('molly_access_token', a)
      if (r) localStorage.setItem('molly_refresh_token', r)
    }, [env.MOLLY_BACKEND_URL, env.MOLLY_ACCESS_TOKEN, env.MOLLY_REFRESH_TOKEN]).catch(() => {})
    await win.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await win.waitForTimeout(3000)
  }

  // Best-effort login.
  if (process.env.MOLLY_TEST_EMAIL && process.env.MOLLY_TEST_PASSWORD) {
    try {
      await win.locator('input[type="email"]').first().fill(process.env.MOLLY_TEST_EMAIL, { timeout: 4000 })
      await win.locator('input[type="password"]').first().fill(process.env.MOLLY_TEST_PASSWORD, { timeout: 4000 })
      await win.getByRole('button', { name: /log ?in|sign ?in|登录/i }).first().click({ timeout: 4000 })
      await win.waitForTimeout(2500)
    } catch (e) {
      console.error('[debug] login skipped/failed:', String(e.message || e).split('\n')[0])
    }
  }

  // Best-effort tab switch (tab labels come from i18n, e.g. "work", "artifacts").
  if (TAB && TAB !== 'login') {
    try {
      await win.getByRole('button', { name: new RegExp(`^${TAB}$`, 'i') }).first().click({ timeout: 4000 })
      await win.waitForTimeout(2000)
    } catch (e) {
      console.error(`[debug] tab '${TAB}' not clickable:`, String(e.message || e).split('\n')[0])
    }
  }

  // On a small/headless display the window is clamped below desktop width, so
  // the app renders its mobile layout. Zoom out until the CSS viewport crosses
  // the desktop breakpoint so the full UI (e.g. the tab bar) is visible.
  try {
    const vw = await win.evaluate(() => window.innerWidth)
    if (vw && vw < 1024) {
      const zoom = Math.max(0.4, vw / 1160)
      await app.evaluate((z) => {
        const { BrowserWindow } = require('electron')
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(z)
      }, zoom)
      await win.waitForTimeout(700)
    }
  } catch { /* ignore */ }

  const title = await win.title().catch(() => '')
  const url = win.url()

  // Which Molly tabs are present in the DOM (they exist even when the desktop
  // tab bar is CSS-hidden at narrow widths) — a layout-independent view of what
  // the app is exposing (e.g. Chat-only vs full memory tabs).
  const tabs = await win.evaluate(() => {
    const known = ['chat', 'screen', 'camera', 'insights', 'calendar', 'tips', 'plans', 'work', 'artifacts', 'memories']
    const found = [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim().toLowerCase())
    return known.filter(k => found.includes(k))
  }).catch(() => [])

  if (SHOT) {
    await win.screenshot({ path: SHOT }).catch(e => console.error('[debug] screenshot failed:', e.message))
    console.error(`[debug] screenshot → ${SHOT}`)
  }

  console.log(JSON.stringify({
    ok: true, mode, title, url, tabs,
    counts: { console: logs.console.length, pageerror: logs.pageerror.length, requestfailed: logs.requestfailed.length },
    console: logs.console.slice(-40),
    pageerror: logs.pageerror,
    requestfailed: logs.requestfailed.slice(-20),
  }, null, 2))

  if (args.keep) {
    console.error('[debug] --keep set; leaving app open. Ctrl+C to exit.')
    await new Promise(() => {})
  }
  await app.close()
}

main().catch(e => { console.error('[debug] fatal:', e); process.exit(1) })
