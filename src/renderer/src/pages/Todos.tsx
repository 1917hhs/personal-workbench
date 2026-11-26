import { useEffect, useMemo, useRef, useState } from 'react'
import { addDays, api, clip, daysBetween, endOfWeek, FileLink, joinPath, navOfPath, normPath, uid, useApp, ymd } from '../lib'
import { ask, Empty, Tabs } from '../ui'
import TodoCalendar from './TodoCalendar'
import RefPicker, { RefAttrs } from './RefPicker'

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

/** 勾选 / 取消完成。重复待办完成后自动排下一次（从原定日期往后推，逾期很久的推到今天以后）。清单和日历共用 */
export async function setTodoDone(saveTodo: (t: any) => Promise<void> | void, t: any, done: boolean) {
  await saveTodo({ ...t, done, doneAt: done ? new Date().toISOString() : null })
  if (done && t.repeat && t.due && !t.nextId) {
    let due = nextDue(t.due, t.repeat)
    while (due < ymd()) due = nextDue(due, t.repeat)
    const id = uid()
    const { nextId: _n, createdAt: _c, updatedAt: _u, ...rest } = t
    await saveTodo({ ...rest, id, due, done: false, doneAt: null })
    await saveTodo({ ...t, done: true, doneAt: new Date().toISOString(), nextId: id })
  }
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

/** 已完成的按完成日期分组：今天 / 昨天 / 近 7 天 / 更早 */
function doneGroups(done: any[]): [string, any[]][] {
  const today = ymd()
  const day = (t: any) => (t.doneAt ? ymd(new Date(t.doneAt)) : '')
  const buckets: [string, (d: string) => boolean][] = [
    ['今天完成', (d) => d === today],
    ['昨天完成', (d) => d === addDays(today, -1)],
    ['近 7 天完成', (d) => !!d && d >= addDays(today, -7)],
    ['更早完成', () => true]
  ]
  const out: [string, any[]][] = buckets.map(([n]) => [n, []])
  for (const t of done) out[buckets.findIndex(([, f]) => f(day(t)))][1].push(t)
  return out
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

/** 时间戳显示成「11-24 14:30」，不是今年的带上年份 */
function stamp(iso?: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const day = ymd(d)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = ymd()
  if (day === today) return '今天 ' + hm
  if (day === addDays(today, -1)) return '昨天 ' + hm
  return (day.slice(0, 4) === today.slice(0, 4) ? day.slice(5) : day) + ' ' + hm
}

/** 已完成的待办：显示添加时间和完成时间；截止日期和用时放在悬停提示里 */
function DoneMeta({ t }: { t: any }) {
  const tip: string[] = []
  if (t.createdAt) tip.push('添加：' + new Date(t.createdAt).toLocaleString())
  if (t.doneAt) tip.push('完成：' + new Date(t.doneAt).toLocaleString())
  if (t.due) tip.push('截止：' + t.due)
  if (t.createdAt && t.doneAt) {
    const days = daysBetween(ymd(new Date(t.createdAt)), ymd(new Date(t.doneAt)))
    tip.push(days <= 0 ? '当天完成' : `用了 ${days} 天`)
  }
  return (
    <span className="done-meta faint" title={tip.join('\n')}>
      {t.createdAt && <span>添加 {stamp(t.createdAt)}</span>}
      {t.doneAt && <span>完成 {stamp(t.doneAt)}</span>}
    </span>
  )
}

/** 待办里关联的文件 / 文件夹：点名字跳到它在软件里的位置（项目导图、资料库），旁边的按钮直接打开 */
function TodoFiles({ t, editing }: { t: any; editing: boolean }) {
  const { data, saveTodo, go, toast } = useApp()
  const files: FileLink[] = t.files || []
  const [gone, setGone] = useState<boolean[]>([])
  const key = files.map((f) => f.path).join('|')
  useEffect(() => {
    if (!files.length) return
    api.call('fs:existsMany', files.map((f) => f.path)).then((r: boolean[]) => setGone(r.map((x) => !x))).catch(() => {})
  }, [key])
  if (!files.length) return null
  const openIt = async (f: FileLink) => {
    const err = await api.call('shell:openPath', f.path)
    if (err) toast('打不开：' + err)
  }
  const jump = (f: FileLink, i: number) => {
    if (gone[i]) return toast('找不到了：' + f.path + '（可能被删除，或在软件外改了名）')
    const n = navOfPath(data, f.path, f.libId)
    if (n) go(n)
    else openIt(f)
  }
  return (
    <div className="todo-files">
      {files.map((f, i) => (
        <span key={f.path + i} className={'todo-file' + (gone[i] ? ' missing' : '')} title={f.path}>
          <button className="tf-main" onClick={() => jump(f, i)} title={(navOfPath(data, f.path, f.libId) ? '跳到它所在的位置' : '打开') + '\n' + f.path}>
            <span>{f.dir ? '📁' : '📄'}</span>
            <span>{f.name}</span>
          </button>
          {!gone[i] && (
            <button className="tf-act" title={f.dir ? '在资源管理器中打开' : '直接打开文件'} onClick={() => openIt(f)}>
              {f.dir ? '📂' : '↗'}
            </button>
          )}
          {editing && (
            <button className="tf-act" title="取消关联（文件不动）" onClick={() => saveTodo({ ...t, files: files.filter((_, j) => j !== i) })}>
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

export function TodoRow({ t, showProject = true }: { t: any; showProject?: boolean }) {
  const { data, saveTodo, deleteTodo, go, toast } = useApp()
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const addFiles = (more: FileLink[]) => {
    const cur: FileLink[] = t.files || []
    const add = more.filter((m) => !cur.some((c) => normPath(c.path) === normPath(m.path)))
    if (!add.length) return toast('已经关联过了')
    saveTodo({ ...t, files: [...cur, ...add] })
  }
  const fromPicker = (refs: RefAttrs[]) => {
    const out: FileLink[] = []
    for (const r of refs) {
      if (r['data-ref'] === 'lib') {
        const it = data.library.find((x) => x.id === r['data-id'])
        if (it) out.push({ path: joinPath(data.libraryDir, it.file), name: it.name || r['data-name'], libId: it.id })
      } else {
        const p = data.projects.find((x) => x.id === r['data-pid'])
        if (p?.rootPath) out.push({ path: joinPath(p.rootPath, r['data-rel']), name: r['data-name'], dir: r['data-dir'] === '1' })
      }
    }
    setPicking(false)
    if (out.length) addFiles(out)
  }
  const p = data.projects.find((x) => x.id === t.projectId)
  const prio = PRIORITIES.find((x) => x.id === (t.priority || 'normal'))!
  const toggle = (done: boolean) => setTodoDone(saveTodo, t, done)

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
              ↻
            </span>
          )}
        </span>
        {showProject && p && (
          <span className="tag click" onClick={() => go({ page: 'project', projectId: p.id })}>
            {p.name}
          </span>
        )}
        {t.done ? <DoneMeta t={t} /> : <DueChip due={t.due} done={t.done} onChange={(v) => saveTodo({ ...t, due: v })} />}
        <button className={'star' + (t.starred ? ' on' : '')} onClick={() => saveTodo({ ...t, starred: !t.starred })}>★</button>
        <button className="icon-btn" title="删除" onClick={() => deleteTodo(t.id)}>×</button>
      </div>
      <TodoFiles t={t} editing={open} />
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
          <div className="row" style={{ marginTop: 6, fontSize: 12, flexWrap: 'wrap' }}>
            <span className="faint">关联文件</span>
            <button className="btn small" title="从项目文件夹或资料库里选" onClick={() => setPicking(true)}>🔗 选择文件 / 文件夹</button>
            <button
              className="btn small"
              onClick={async () => {
                const paths: string[] = await api.call('dialog:pickFiles', '选择要关联的文件')
                if (paths.length) addFiles(paths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop()! })))
              }}
            >
              电脑上的文件…
            </button>
            <button
              className="btn small"
              onClick={async () => {
                const p: string | null = await api.call('dialog:pickFolder', '选择要关联的文件夹')
                if (p) addFiles([{ path: p, name: p.split(/[\\/]/).pop()!, dir: true }])
              }}
            >
              电脑上的文件夹…
            </button>
            {clip.ref && (
              <button className="btn small" title={clip.ref} onClick={() => addFiles([{ path: clip.ref!, name: clip.ref!.split(/[\\/]/).pop()!, dir: clip.dir }])}>
                粘贴引用：{clip.ref.split(/[\\/]/).pop()}
              </button>
            )}
            <span className="faint">关联后点名字就能跳到它所在的位置</span>
          </div>
        </div>
      )}
      {picking && <RefPicker allowDirs title="关联文件 / 文件夹" okLabel="关联" onClose={() => setPicking(false)} onPick={fromPicker} />}
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
  // 日历 / 清单，记住上次用的（默认日历）
  const [layout, setLayout] = useState<'cal' | 'list'>(() => (localStorage.getItem('todos.layout') === 'list' ? 'list' : 'cal'))
  const [calPid, setCalPid] = useState('')
  const pickLayout = (v: 'cal' | 'list') => {
    setLayout(v)
    try {
      localStorage.setItem('todos.layout', v)
    } catch {}
  }
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
    ...(view === 'done' ? doneGroups(g.done) : view.startsWith('p:') ? ([['已完成', g.done]] as [string, any[]][]) : [])
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
        <Tabs value={layout} onChange={pickLayout} options={[{ id: 'cal', label: '日历' }, { id: 'list', label: '清单' }]} />
        <input className="input" style={{ width: 240 }} placeholder="搜索待办和备注…" value={q} onChange={(e) => setQ(e.target.value)} />
        {layout === 'cal' && (
          <select className="input" style={{ width: 180 }} value={calPid} onChange={(e) => setCalPid(e.target.value)}>
            <option value="">全部项目</option>
            {data.projects
              .filter((p) => data.todos.some((t) => t.projectId === p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
          </select>
        )}
      </div>
      {layout === 'cal' ? (
        <TodoCalendar todos={calPid ? filtered.filter((t) => t.projectId === calPid) : filtered} />
      ) : (
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
                  {items.slice(0, name.endsWith('完成') ? 200 : undefined).map((t) => (
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
      )}
    </>
  )
}
