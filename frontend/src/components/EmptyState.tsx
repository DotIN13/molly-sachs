import type { ReactNode } from 'react'

interface Props {
  icon: ReactNode
  title: string
  hint: string
}

export default function EmptyState({ icon, title, hint }: Props) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[200px] sm:min-h-[350px] border-2 border-dashed border-slate-200 rounded-2xl bg-white shadow-sm">
      <div className="w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center mb-3">
        {icon}
      </div>
      <span className="text-slate-600 font-medium text-sm">{title}</span>
      <span className="text-[11px] text-slate-400 mt-1 max-w-xs text-center leading-normal">
        {hint}
      </span>
    </div>
  )
}
