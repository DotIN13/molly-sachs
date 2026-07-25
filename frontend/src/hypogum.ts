// Client for the user's hypogum instance (the memory + autonomy brain).
//
// Phase 2: Molly's Screen/Camera/Insights tabs read observations and activity
// directly from hypogum's REST API. Hypogum is a local, single-user service
// with no auth; it CORS-allows the Vite origin. The per-user base URL comes
// from Molly settings (`hypogum_base_url`); we fall back to the default port.

const DEFAULT_HYPOGUM_URL = 'http://localhost:8056'

let hypogumUrl = DEFAULT_HYPOGUM_URL

export function setHypogumUrl(url?: string | null): void {
  hypogumUrl = (url && url.trim()) || DEFAULT_HYPOGUM_URL
}

/** URL that serves a hypogum observation image by its relative path. */
export function hypogumImageUrl(relPath: string): string {
  return `${hypogumUrl}/api/v1/observations/file?path=${encodeURIComponent(relPath)}`
}

async function hgGet(path: string): Promise<any> {
  const res = await fetch(`${hypogumUrl}${path}`)
  if (!res.ok) throw new Error(`hypogum ${path} -> ${res.status}`)
  return res.json()
}

export async function hypogumHealthy(url?: string): Promise<boolean> {
  const base = (url && url.trim()) || hypogumUrl
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/v1/health`)
    return res.ok
  } catch {
    return false
  }
}

export interface HypogumObservation {
  id: string
  imageUrl: string
  timestamp: string
  type: 'screen' | 'camera' | 'other'
}

// Filenames look like:
//   2026-06-25/artifacts/screen_2026-06-25_00-00-11.760270+00-00_78a87b.jpg
function parseImage(rel: string): { type: 'screen' | 'camera' | 'other'; timestamp: string } {
  const name = rel.split('/').pop() || ''
  const type = name.startsWith('camera') ? 'camera' : name.startsWith('screen') ? 'screen' : 'other'
  const m = name.match(/^(?:screen|camera)_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/)
  const timestamp = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : ''
  return { type, timestamp }
}

/**
 * Flat, newest-first list of a given observation type across days, paginated.
 * Stateless: re-derives from hypogum each call and slices by offset/limit, so
 * it composes with the existing infinite-scroll (offset accumulation) logic.
 */
export async function fetchHypogumObservations(
  type: 'screen' | 'camera',
  limit: number,
  offset: number,
): Promise<{ items: HypogumObservation[]; total: number }> {
  const { dates } = await hgGet('/api/v1/observations/dates') // newest first
  const collected: HypogumObservation[] = []
  const want = offset + limit
  for (const date of (dates || [])) {
    if (collected.length > want) break // +1 beyond the page → we know there's more
    const day = await hgGet(`/api/v1/observations/day?date=${encodeURIComponent(date)}`)
    const imgs: string[] = (day.images || []).slice().sort().reverse() // newest first within day
    for (const rel of imgs) {
      const meta = parseImage(rel)
      if (meta.type !== type) continue
      collected.push({
        id: rel,
        imageUrl: hypogumImageUrl(rel),
        timestamp: meta.timestamp || `${date}T00:00:00Z`,
        type: meta.type,
      })
    }
  }
  const page = collected.slice(offset, offset + limit)
  const hasMore = collected.length > offset + limit
  return { items: page, total: hasMore ? offset + limit + 1 : offset + page.length }
}

// Molly → hypogum memory category mapping (mirror of the backend client).
const CATEGORY_MAP: Record<string, string> = {
  trait: 'personality', preference: 'preference', interest: 'interest',
  skill: 'skill', goal: 'goal', relationship: 'relationship',
  ownership: 'ownership', weakness: 'weakness', event: 'event', other: 'personality',
}


// ── Memories: hypogum pages, shaped like Molly's flat memory rows ──
// Row contract used by the tab: { id(path), type, content, confidence, evidence }.
export interface HypogumMemoryRow {
  id: string; group: string; type: string; content: string; confidence: number | null; evidence: string
}

function toMemoryRow(e: any, fallbackType: string): HypogumMemoryRow {
  const conf = e.confidence != null && e.confidence !== '' ? Number(e.confidence) : null
  const path = e.path || ''
  // Top-level directory is the category group (goals/entities/traits/struggles),
  // matching the original hypogum wiki layout.
  const group = path.split('/')[0] || fallbackType || 'other'
  return {
    id: e.path,
    group,
    type: e.category || e.type || fallbackType || 'other',
    content: e.title || (e.snippet ? String(e.snippet).slice(0, 120) : e.path),
    confidence: Number.isFinite(conf as number) ? (conf as number) : null,
    evidence: '',
  }
}

export async function fetchHypogumMemories(
  search?: string, typeFilter?: string,
): Promise<{ items: HypogumMemoryRow[]; total: number }> {
  let rows: HypogumMemoryRow[] = []
  if (search && search.trim()) {
    const data = await hgGet(`/api/v1/memory/semantic?q=${encodeURIComponent(search.trim())}&limit=50`)
    rows = (data.results || []).map((r: any) => toMemoryRow(r, ''))
  } else {
    const data = await hgGet('/api/v1/memory/tree')
    const groups = data.groups || {}
    for (const [group, entries] of Object.entries(groups)) {
      if (group === 'pages') continue // skip index.md / log.md / AGENTS.md
      for (const e of (entries as any[])) rows.push(toMemoryRow(e, group))
    }
  }
  if (typeFilter) {
    const hg = CATEGORY_MAP[typeFilter] || typeFilter
    rows = rows.filter(r => r.type === typeFilter || r.type === hg)
  }
  return { items: rows, total: rows.length }
}

export async function addHypogumMemory(
  fact: string, category: string, confidence: number, lifespan: number,
): Promise<any> {
  const res = await fetch(`${hypogumUrl}/api/v1/memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: fact, category: CATEGORY_MAP[category] || 'personality',
      confidence, lifespan, source: 'molly',
    }),
  })
  if (!res.ok) throw new Error(`hypogum add memory -> ${res.status}`)
  return res.json()
}

export async function deleteHypogumMemory(path: string): Promise<void> {
  const res = await fetch(`${hypogumUrl}/api/v1/memory?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`hypogum delete memory -> ${res.status}`)
}

// ── Calendar: observed / planned / suggested blocks ──
export async function fetchHypogumCalendar(): Promise<any[]> {
  const data = await hgGet('/api/v1/calendar')
  return data.entries || []
}

export async function acceptCalendarBlock(path: string): Promise<void> {
  const res = await fetch(`${hypogumUrl}/api/v1/calendar/accept`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!res.ok) throw new Error(`hypogum accept -> ${res.status}`)
}

export async function dismissCalendarBlock(path: string): Promise<void> {
  const res = await fetch(`${hypogumUrl}/api/v1/calendar/dismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!res.ok) throw new Error(`hypogum dismiss -> ${res.status}`)
}

// ── Persisted settings (Molly controls these; hypogum .env are defaults) ──
export async function fetchHypogumSettings(): Promise<Record<string, any>> {
  const data = await hgGet('/api/v1/settings')
  return data.settings || {}
}

export async function patchHypogumSettings(settings: Record<string, any>): Promise<void> {
  const res = await fetch(`${hypogumUrl}/api/v1/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
  if (!res.ok) throw new Error(`hypogum settings -> ${res.status}`)
}

// ── Runs (agent work queue) ──
export async function fetchHypogumRuns(): Promise<any[]> {
  const data = await hgGet('/api/v1/runs')
  return data.runs || []
}
// Queue a freeform/adhoc agent run from a natural-language prompt (no plan/task).
export async function submitHypogumRun(prompt: string): Promise<any> {
  const res = await fetch(`${hypogumUrl}/api/v1/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (!res.ok) throw new Error(`run -> ${res.status}`)
  return res.json()
}
export async function fetchHypogumRunEvents(id: string, after = 0): Promise<any[]> {
  const data = await hgGet(`/api/v1/runs/${id}/events?after=${after}&limit=2000`)
  return data.events || []
}
export async function abortHypogumRun(id: string): Promise<void> {
  const res = await fetch(`${hypogumUrl}/api/v1/runs/${id}/abort`, { method: 'POST' })
  if (!res.ok) throw new Error(`abort -> ${res.status}`)
}

// ── Artifacts (run deliverables) ──
export async function fetchHypogumArtifacts(limit = 50): Promise<any[]> {
  const data = await hgGet(`/api/v1/artifacts?limit=${limit}`)
  return data.artifacts || []
}
export async function fetchHypogumArtifact(id: string): Promise<any | null> {
  try { return await hgGet(`/api/v1/artifacts/${id}`) } catch { return null }
}
export function artifactFileUrl(id: string, file: string): string {
  return `${hypogumUrl}/api/v1/artifacts/${id}/file/${file}`
}
export function artifactPreviewUrl(id: string): string {
  return `${hypogumUrl}/api/v1/artifacts/${id}/preview`
}

// ── Agent plans + manual run ──
export async function fetchHypogumPlans(limit = 10): Promise<any[]> {
  const data = await hgGet(`/api/v1/plans?limit=${limit}`)
  return data.plans || []
}
export async function runHypogumPlanTask(
  planPath: string, prompt: string, taskPath?: string,
): Promise<any> {
  const res = await fetch(`${hypogumUrl}/api/v1/plans/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan_path: planPath, prompt, task_path: taskPath ?? null }),
  })
  if (!res.ok) throw new Error(`run -> ${res.status}`)
  return res.json()
}

// ── Agent status ──
export async function fetchHypogumAgentStatus(): Promise<any | null> {
  try { return await hgGet('/api/v1/agent/status') } catch { return null }
}

// ── Memory page detail ──
export async function fetchHypogumMemoryPage(path: string): Promise<any> {
  return hgGet(`/api/v1/memory/page?path=${encodeURIComponent(path)}`)
}

export async function saveHypogumMemoryPage(path: string, content: string): Promise<void> {
  const res = await fetch(`${hypogumUrl}/api/v1/memory/page`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  })
  if (!res.ok) throw new Error(`hypogum save memory page -> ${res.status}`)
}

