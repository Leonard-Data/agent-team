import type { ReactNode } from 'react'
import css from './AgentTeam.module.css'

export function Field({
  label,
  children,
  className = '',
}: {
  label: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return <label className={`${css.field} ${className}`}><span className={css.label}>{label}</span>{children}</label>
}

export function Empty({ text, hint }: { text: string; hint?: string }): JSX.Element {
  return (
    <div className={css.empty}>
      <div className={css.emptyCopy}>
        <span className={css.emptyTitle}>{text}</span>
        {hint && <span className={css.emptyHint}>{hint}</span>}
      </div>
    </div>
  )
}
