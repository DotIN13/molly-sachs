import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, FileText, X } from 'lucide-react'
import EmptyState from './EmptyState'
import Markdown from './Markdown'
import { fetchHypogumArtifacts, fetchHypogumArtifact, artifactFileUrl, artifactPreviewUrl } from '../hypogum'

const IMG_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']

function ext(name?: string): string {
  return name ? '.' + (name.split('.').pop() || '').toLowerCase() : ''
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function Preview({ art, onClose }: { art: any; onClose: () => void }) {
  const [file, setFile] = useState<string | undefined>(art.main_file || (art.files && art.files[0]))
  const [text, setText] = useState<string | null>(null)
  const e = ext(file)
  const isImg = IMG_EXT.includes(e)
  const isHTML = e === '.html' || e === '.htm'
  const isMD = e === '.md'

  useEffect(() => {
    setText(null)
    if (file && (isMD || e === '.txt' || e === '.json' || e === '.js' || e === '.css')) {
      fetch(artifactFileUrl(art.id, file)).then(r => r.text()).then(setText).catch(() => setText(null))
    }
  }, [file, art.id, e, isMD])

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/20 backdrop-blur-sm" onClick={onClose}>
      <div className="flex h-full w-full max-w-3xl flex-col bg-white shadow-2xl border-l border-slate-100" onClick={ev => ev.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-800 truncate">{art.title || art.name}</div>
            <div className="text-[10px] font-mono text-slate-400">{art.name} · {art.file_count} files · {fmtSize(art.size || 0)}</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
        </div>
        {(art.files?.length ?? 0) > 1 && (
          <div className="flex gap-1 overflow-x-auto border-b border-slate-50 px-3 py-2">
            {art.files.map((f: string) => (
              <button key={f} onClick={() => setFile(f)} className={`text-[10px] font-mono px-2 py-1 rounded-lg whitespace-nowrap ${file === f ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{f}</button>
            ))}
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-4">
          {!file ? (
            <p className="text-xs text-slate-400">No previewable file.</p>
          ) : isImg ? (
            <img src={artifactFileUrl(art.id, file)} alt={file} className="max-w-full rounded-lg border border-slate-100" />
          ) : isHTML ? (
            <iframe title={file} src={art.renderable ? artifactPreviewUrl(art.id) : artifactFileUrl(art.id, file)} className="w-full h-[70vh] rounded-lg border border-slate-100 bg-white" />
          ) : isMD && text != null ? (
            <Markdown content={text} />
          ) : text != null ? (
            <pre className="text-[11px] font-mono text-slate-700 whitespace-pre-wrap break-words">{text}</pre>
          ) : (
            <a href={artifactFileUrl(art.id, file)} target="_blank" rel="noreferrer" className="text-xs text-indigo-600 hover:underline">Open {file}</a>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ArtifactsTab() {
  const { t } = useTranslation()
  const [artifacts, setArtifacts] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState<any | null>(null)

  const load = async () => {
    setLoading(true)
    try { setArtifacts(await fetchHypogumArtifacts()) } catch { /* offline */ } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const open = async (a: any) => {
    const full = await fetchHypogumArtifact(a.id)
    setActive(full || a)
  }

  return (
    <div className="overflow-y-auto flex-1 min-h-0 px-3 sm:px-6 md:px-10 py-4 sm:py-6 bg-slate-50/40">
      <div className="max-w-4xl mx-auto w-full animate-in fade-in duration-300">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">{t('tabs.artifacts')}</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">{t('artifacts.desc')}</p>
          </div>
          <button onClick={load} className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 bg-white border border-slate-200 px-3 py-1.5 rounded-full shadow-sm hover:shadow transition-all flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3" /> {t('app.refresh')}
          </button>
        </div>
        {artifacts.length === 0 ? (
          <EmptyState icon={<FileText className="w-6 h-6 text-slate-400" />} title={t('artifacts.empty')} hint={t('artifacts.emptyHint')} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {artifacts.map(a => (
              <button key={a.id} onClick={() => open(a)} className="text-left bg-white rounded-2xl border border-slate-100 p-4 shadow-sm hover:shadow-md transition-all">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  <span className="text-sm font-medium text-slate-800 truncate">{a.title || a.name}</span>
                </div>
                <div className="text-[10px] font-mono text-slate-400 mt-2">{a.file_count} files · {fmtSize(a.size || 0)}</div>
                {a.created && <div className="text-[10px] text-slate-400 mt-0.5">{new Date(a.created).toLocaleString()}</div>}
              </button>
            ))}
          </div>
        )}
        {loading && <p className="text-center text-[10px] text-slate-400 mt-4">…</p>}
      </div>
      {active && <Preview art={active} onClose={() => setActive(null)} />}
    </div>
  )
}
