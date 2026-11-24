import { useMemo, useRef, useState } from 'react'
import { addDays, daysBetween, endOfWeek, uid, useApp, ymd } from '../lib'
import { ask, Empty } from '../ui'

export const PRIORITIES = [
  { id: 'high', label: '高', color: '#dc2626' },
  { id: 'normal', label: '中', color: '#f59e0b' },
  { id: 'low', label: '低', color: '#94a3b8' }
]
export const REPEATS = [
  { id: '', label: '不重复' },
  { id: 'day', label: '每天' },
  { id: 'workday', label: '每个工作日' },
  { id: 'week', label: '每周' },
  { id: 'month', label: '每月' }
]

/** 重复待办的下一次日期 */
export function nextDue(due: string, repeat: string) {
  if (repeat === 'day') return addDays(due, 1)
  if (repeat === 'week') return addDays(due, 7)
  if (repeat === 'workday') {
    let d = addDays(due, 1)
    while ([0, 6].includes(new Date(d + 'T00:00:00').getDay())) d = addDays(d, 1)
    return d
  }
  if (repeat === 'month') {
    const [y, m, day] = due.split('-').map(Number)
    const last = new Date(y, m + 1, 0).getDate() // 下个月最后一天（31 号遇到小月取月底）
    return ymd(new Date(y, m, Math.min(day, last)))
  }
  return due
}

const prioRank = (t: any) => (t.priority === 'high' ? 0 : t.priority === 'low' ? 2 : 1)

export function groupTodos(todos: any[]) {
  const today = ymd()
  const eow = endOfWeek(today)
  const open = todos.filter((t) => !t.done)
  const byDue = (a: any, b: any) => String(a.due).localeCompare(String(b.due)) || prioRank(a) - prioRank(b) || Number(!!b.starred) - Number(!!a.starred)
  return {
    overdue: open.filter((t) => t.due && t.due < today).sort(byDue),
    today: open.filter((t) => t.due === today).sort(byDue),
    week: open.filter((t) => t.due && t.due > today && t.due <= eow).sort(byDue),
    later: open.filter((t) => t.due && t.due > eow).sort(byDue),
    none: open.filter((t) => !t.due).sort((a, b) => prioRank(a) - prioRank(b) || Number(!!b.starred) - Number(!!a.starred)),
    done: todos.filter((t) => t.done).sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)))
  }
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
/** 「今天」「明天」「周三 11-26」「逾期 3 天」 */
export function dueLabel(due?: string | null) {
  if (!due) return { text: '未安排', cls: 'faint' }
  const n = daysBetween(ymd(), due)
  if (n < 0) return { text: `逾期 ${-n} 天`, cls: 'red' }
  if (n === 0) return { text: '今天', cls: 'amber' }
  if (n === 1) return { text: '明天', cls: '' }
  const d = new Date(due + 'T00:00:00')
  if (n < 7) return { text: `周${WEEK[d.getDay()]} ${due.slice(5)}`, cls: '' }
  return { text: due.slice(0, 4) === ymd().slice(0, 4) ? due.slice(5) : due, cls: '' }
}

/** 日期标签，点一下弹出日期选择 */
export function DueChip({ due, done, onChange }: { due?: string | null; done?: boolean; onChange: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const l = dueLabel(due)
  return (
    <span className="due-chip">
      <button className={'tag ' + (done ? '' : l.cls)} onClick={() => (ref.current as any)?.showPicker?.()} title="改日期">
        {l.text}
      </button>
      <input ref={ref} type="date" value={due || ''} onChange={(e) => onChange(e.target.value || null)} />
    </span>
  )
}

export function TodoRow({ t, showProject = true }: { t: any; showProject?: boolean }) {
  const { data, saveTodo, deleteTodo, go } = useApp()
  const [open, setOpen] = useState(false)
  const p = data.projects.find((x) => x.id === t.projectId)
  const prio = PRIORITIES.find((x) => x.id === (t.priority || 'normal'))!
  const toggle = async (done: boolean) => {
    await saveTodo({ ...t, done, doneAt: done ? new Date().toISOString() : null })
    // 重复待办：完成后自动排下一次（从原定日期往后推，逾期很久的推到今天以后）
    if (done && t.repeat && t.due && !t.nextId) {
      let due = nextDue(t.due, t.repeat)
      while (due < ymd()) due = nextDue(due, t.repeat)
      const id = uid()
      const { nextId: _n, createdAt: _c, updatedAt: _u, ...rest } = t
      await saveTodo({ ...rest, id, due, done: false, doneAt: null })
      await saveTodo({ ...t, done: true, doneAt: new Date().toISOString(), nextId: id })
    }
  }
  const cyclePrio = () => saveTodo({ ...t, priority: t.priority === 'high' ? 'low' : t.priority === 'low' ? 'normal' : 'high' })
  return (
    <div className={'todo' + (t.done ? ' done' : '')}>
      <div className="todo-line">
        <input type="checkbox" className="check" checked={!!t.done} onChange={(e) => toggle(e.target.checked)} />
        <button className="prio" title={`优先级：${prio.label}（点击切换）`} style={{ background: prio.color }} onClick={cyclePrio} />
        <span
          className="title"
          title="双击修改"
          onClick={() => setOpen(!open)}
          onDoubleClick={async () => {
            const v = await ask('修改待办', t.title)
            if (v) saveTodo({ ...t, title: v })
          }}
        >
          {t.title}
          {t.note && <span className="faint" style={{ marginLeft: 6, fontSize: 12 }}>📝</span>}
          {t.repeat && (
            <span className="faint" style={{ marginLeft: 6, fontSize: 12 }} title={'重复：' + REPEATS.find((r) => r.id === t.repeat)?.label}>
              🔁
            </span>
          )}
        </span>
        {showProject && p && (
          <span className="tag click" onClick={() => go({ page: 'project', projectId: p.id })}>
            {p.name}
          </span>
        )}
        <DueChip due={t.due} done={t.done} onChange={(v) => saveTodo({ ...t, due: v })} />
        <button className={'star' + (t.starred ? ' on' : '')} onClick={() => saveTodo({ ...t, starred: !t.starred })}>★</button>
        <button className="icon-btn" title="删除" onClick={() => deleteTodo(t.id)}>×</button>
      </div>
      {open && (
        <div className="todo-detail">
          <textarea
            className="input"
            rows={2}
            placeholder="备注（离开输入框自动保存）"
            defaultValue={t.note || ''}
            onBlur={(e) => e.target.value !== (t.note || '') && saveTodo({ ...t, note: e.target.value })}
          />
          <div className="row" style={{ marginTop: 6, fontSize: 12 }}>
            <span className="faint">优先级</span>
            {PRIORITIES.map((x) => (
              <button key={x.id} className={'btn small' + ((t.priority || 'normal') === x.id ? ' primary' : '')} onClick={() => saveTodo({ ...t, priority: x.id })}>
                {x.label}
              </button>
            ))}
            <span className="faint" style={{ marginLeft: 8 }}>重复</span>
            <select className="input" style={{ width: 120 }} value={t.repeat || ''} title="完成后自动生成下一次" onChange={(e) => saveTodo({ ...t, repeat: e.target.value || null, due: e.target.value && !t.due ? ymd() : t.due })}>
              {REPEATS.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
            <span className="faint" style={{ marginLeft: 8 }}>项目</span>
            <select className="input" style={{ width: 200 }} value={t.projectId || ''} onChange={(e) => saveTodo({ ...t, projectId: e.target.value || null })}>
              <option value="">不关联</option>
              {data.projects.map((x) => (
                <option key={x.id} value={x.id}>{x.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  )
}

export function QuickAdd({ defaultDue = '', projectId = '', compact = false, hideDate = false, onAdded }: { defaultDue?: string; projectId?: string; compact?: boolean; hideDate?: boolean; onAdded?: () => void }) {
  const { data, saveTodo } = useApp()
  const [title, setTitle] = useState('')
  const [due, setDue] = useState(defaultDue)
  const [pid, setPid] = useState(projectId)
  const [priority, setPriority] = useState('normal')
  const add = async () => {
    if (!title.trim()) return
    await saveTodo({ id: uid(), title: title.trim(), due: due || null, projectId: pid || null, priority, done: false })
    setTitle('')
    onAdded?.()
  }
  return (
    <div className="todo-add">
      <input autoFocus={compact} className="input" placeholder="添加待办，回车保存" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
      {!hideDate && <input type="date" className="input" style={{ width: 140 }} value={due} onChange={(e) => setDue(e.target.value)} />}
      {!compact && (
        <>
          <select className="input" style={{ width: 70 }} value={priority} onChange={(e) => setPriority(e.target.value)} title="优先级">
            {PRIORITIES.map((x) => (
              <option key={x.id} value={x.id}>{x.label}</option>
            ))}
          </select>
          {!projectId && (
            <select className="input" style={{ width: 170 }} value={pid} onChange={(e) => setPid(e.target.value)}>
              <option value="">不关联项目</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
        </>
      )}
      <button className="btn primary" onClick={add}>添加</button>
    </div>
  )
}

type View = 'all' | 'today' | 'week' | 'overdue' | 'starred' | 'none' | 'done' | `p:${string}`

export default function Todos() {
  const { data } = useApp()
  const [view, setView] = useState<View>('all')
  const [q, setQ] = useState('')
  const today = ymd()
  const eow = endOfWeek(today)

  const filtered = useMemo(() => {
    const has = (t: any) => !q.trim() || String(t.title + ' ' + (t.note || '')).toLowerCase().includes(q.trim().toLowerCase())
    return data.todos.filter(has)
  }, [data.todos, q])

  const open = filtered.filter((t) => !t.done)
  const counts: Record<string, number> = {
    all: open.length,
    today: open.filter((t) => t.due && t.due <= today).length,
    week: open.filter((t) => t.due && t.due <= eow).length,
    overdue: open.filter((t) => t.due && t.due < today).length,
    starred: open.filter((t) => t.starred).length,
    none: open.filter((t) => !t.due).length,
    done: filtered.filter((t) => t.done).length
  }

  const list =
    view === 'done'
      ? filtered.filter((t) => t.done)
      : view === 'today'
        ? open.filter((t) => t.due && t.due <= today)
        : view === 'week'
          ? open.filter((t) => t.due && t.due <= eow)
          : view === 'overdue'
            ? open.filter((t) => t.due && t.due < today)
            : view === 'starred'
              ? open.filter((t) => t.starred)
              : view === 'none'
                ? open.filter((t) => !t.due)
                : view.startsWith('p:')
                  ? filtered.filter((t) => t.projectId === view.slice(2))
                  : open

  const g = groupTodos(list)
  const sections: [string, any[], string?][] = [
    ['已逾期', g.overdue, 'var(--danger)'],
    ['今天', g.today],
    ['本周', g.week],
    ['以后', g.later],
    ['未安排时间', g.none],
    ...(view === 'done' || view.startsWith('p:') ? ([['已完成', g.done]] as [string, any[]][]) : [])
  ]
  const projectsWithTodos = data.projects.filter((p) => data.todos.some((t) => t.projectId === p.id && !t.done))
  const nav = (id: View, label: string, n?: number, color?: string) => (
    <button key={id} className={'nav' + (view === id ? ' on' : '')} onClick={() => setView(id)} style={{ color }}>
      {label}
      {!!n && <span className="count">{n}</span>}
    </button>
  )

  return (
    <>
      <div className="topbar">
        <h1>待办</h1>
        <input className="input" style={{ width: 240 }} placeholder="搜索待办和备注…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="lib-wrap">
        <div className="lib-types">
          {nav('all', '全部', counts.all)}
          {nav('today', '今天（含逾期）', counts.today)}
          {nav('week', '本周', counts.week)}
          {nav('overdue', '已逾期', counts.overdue, counts.overdue ? 'var(--danger)' : undefined)}
          {nav('starred', '星标', counts.starred)}
          {nav('none', '未安排时间', counts.none)}
          {nav('done', '已完成', counts.done)}
          {projectsWithTodos.length > 0 && <div className="side-sub">按项目</div>}
          {projectsWithTodos.map((p) => nav(`p:${p.id}`, p.name, data.todos.filter((t) => t.projectId === p.id && !t.done).length))}
        </div>
        <div className="lib-list">
          <div style={{ maxWidth: 880 }}>
            <QuickAdd key={view} defaultDue={view === 'today' ? today : ''} projectId={view.startsWith('p:') ? view.slice(2) : ''} />
            {data.todos.length === 0 && <Empty title="还没有待办" text="在上面输入一条，回车即可添加。可以设截止日期、优先级、关联项目、加星标；点标题展开写备注。" />}
            {data.todos.length > 0 && list.length === 0 && <Empty title="这里没有待办" />}
            {sections.map(([name, items, color]) =>
              items.length ? (
                <div key={name} className="todo-group">
                  <div className="todo-group-head" style={{ color }}>
                    {name} <span className="faint">{items.length}</span>
                  </div>
                  {items.slice(0, name === '已完成' ? 200 : undefined).map((t) => (
                    <TodoRow key={t.id} t={t} />
                  ))}
                </div>
              ) : null
            )}
            {view === 'all' && g.done.length === 0 && counts.done > 0 && (
              <button className="btn small" onClick={() => setView('done')}>查看已完成（{counts.done}）</button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
