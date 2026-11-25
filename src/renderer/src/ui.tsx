import { ReactNode, useEffect, useRef, useState } from 'react'

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [props.onClose])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={{ width: props.width || 480 }}>
        <div className="modal-head">
          <span>{props.title}</span>
          <button className="icon-btn" onClick={props.onClose}>×</button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

// ---------- 输入框弹窗（Electron 里没有 window.prompt） ----------
type Ask = { title: string; value?: string; placeholder?: string; multiline?: boolean; resolve: (v: string | null) => void }
let setAskGlobal: ((a: Ask | null) => void) | null = null

export function ask(title: string, value = '', placeholder = '', multiline = false) {
  return new Promise<string | null>((resolve) => setAskGlobal?.({ title, value, placeholder, multiline, resolve }))
}

export function AskHost() {
  const [a, setA] = useState<Ask | null>(null)
  const [v, setV] = useState('')
  const ref = useRef<any>(null)
  useEffect(() => {
    setAskGlobal = (x) => {
      setA(x)
      setV(x?.value || '')
    }
  }, [])
  useEffect(() => {
    if (a) setTimeout(() => ref.current?.select(), 0)
  }, [a])
  if (!a) return null
  const done = (val: string | null) => {
    a.resolve(val === null ? null : val.trim() || (a.multiline ? '' : null))
    setA(null)
  }
  return (
    <Modal
      title={a.title}
      onClose={() => done(null)}
      footer={
        <>
          <button className="btn" onClick={() => done(null)}>取消</button>
          <button className="btn primary" onClick={() => done(v)}>确定</button>
        </>
      }
    >
      {a.multiline ? (
        <textarea
          ref={ref}
          className="input"
          rows={6}
          value={v}
          placeholder={a.placeholder}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && done(v)}
        />
      ) : (
        <input
          ref={ref}
          className="input"
          value={v}
          placeholder={a.placeholder}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && done(v)}
        />
      )}
    </Modal>
  )
}

// ---------- 右键菜单 ----------
export type MenuItem = { label: string; onClick?: () => void; danger?: boolean; disabled?: boolean } | 'sep' | { swatches: { color: string | null; label: string }[]; onPick: (c: string | null) => void }

export function ContextMenu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: props.x, y: props.y })
  useEffect(() => {
    const el = ref.current!
    const r = el.getBoundingClientRect()
    setPos({ x: Math.min(props.x, innerWidth - r.width - 8), y: Math.min(props.y, innerHeight - r.height - 8) })
    const close = () => props.onClose()
    setTimeout(() => window.addEventListener('mousedown', close), 0)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [])
  return (
    <div ref={ref} className="ctx" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {props.items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="ctx-sep" />
        ) : 'swatches' in it ? (
          <div key={i} className="ctx-swatches">
            {it.swatches.map((s) => (
              <button
                key={s.label}
                title={s.label}
                className="swatch"
                style={{ background: s.color || 'transparent' }}
                onClick={() => {
                  it.onPick(s.color)
                  props.onClose()
                }}
              >
                {s.color ? '' : '×'}
              </button>
            ))}
          </div>
        ) : (
          <button
            key={i}
            className={'ctx-item' + (it.danger ? ' danger' : '')}
            disabled={it.disabled}
            onClick={() => {
              props.onClose()
              it.onClick?.()
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>
  )
}

export function Empty(props: { title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{props.title}</div>
      {props.text && <div className="empty-text">{props.text}</div>}
      {props.children}
    </div>
  )
}

/** 线条小图标（跟随文字颜色） */
export function Ico({ name, size = 14 }: { name: 'pin' | 'building' | 'user' | 'hash'; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (name === 'pin')
    return (
      <svg {...p}>
        <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
        <circle cx="12" cy="9.5" r="2.5" />
      </svg>
    )
  if (name === 'building')
    return (
      <svg {...p}>
        <rect x="4" y="3" width="16" height="18" rx="1.5" />
        <path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M10 21v-3h4v3" />
      </svg>
    )
  if (name === 'user')
    return (
      <svg {...p}>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
      </svg>
    )
  return (
    <svg {...p}>
      <path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16" />
    </svg>
  )
}

export function StageDot({ color }: { color: string }) {
  return <span className="stage-dot" style={{ background: color }} />
}

export function Tabs(props: { value: string; options: { id: string; label: string }[]; onChange: (v: any) => void }) {
  return (
    <div className="tabs">
      {props.options.map((o) => (
        <button key={o.id} className={'tab' + (o.id === props.value ? ' on' : '')} onClick={() => props.onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
