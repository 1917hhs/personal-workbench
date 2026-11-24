import { useEffect, useMemo, useState } from 'react'
import { addDays, api, endOfWeek, uid, useApp, ymd } from '../lib'
import { Modal } from '../ui'

// 番茄钟：专注 → 休息，循环。计时器放在侧栏，切换页面不会中断；
// 状态存进 localStorage，软件意外关掉重开也能接着算。每完成一个专注就记一条专注记录。

interface Run {
  phase: 'work' | 'break'
  start: number
  minutes: number
  projectId?: string
  todoId?: string
  label?: string
  count: number
}

const KEY = 'focusRun'
const load = (): Run | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null')
  } catch {
    return null
  }
}
const store = (r: Run | null) => {
  try {
    if (r) localStorage.setItem(KEY, JSON.stringify(r))
    else localStorage.removeItem(KEY)
  } catch {}
}

function beep() {
  try {
    const ctx = new AudioContext()
    ;[0, 0.25, 0.5].forEach((t) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.frequency.value = 880
      g.gain.setValueAtTime(0.15, ctx.currentTime + t)
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2)
      o.connect(g).connect(ctx.destination)
      o.start(ctx.currentTime + t)
      o.stop(ctx.currentTime + t + 0.2)
    })
  } catch {}
}

function notify(title: string, body: string) {
  try {
    new Notification(title, { body, silent: true })
  } catch {}
}

const mmss = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

export function FocusWidget() {
  const { data, setData, toast } = useApp()
  const cfg = data.settings.focus || { work: 25, shortBreak: 5, longBreak: 15, sound: true }
  const [run, setRunState] = useState<Run | null>(load)
  const [now, setNow] = useState(Date.now())
  const [starting, setStarting] = useState(false)
  const setRun = (r: Run | null) => {
    store(r)
    setRunState(r)
  }

  const saveRecord = async (r: Run, end: number) => {
    const minutes = Math.round((end - r.start) / 60000)
    if (minutes < 1) return
    const rec = { id: uid(), start: new Date(r.start).toISOString(), end: new Date(end).toISOString(), minutes, projectId: r.projectId || null, todoId: r.todoId || null, label: r.label || '' }
    setData({ focus: await api.call('focus:save', rec) })
  }

  useEffect(() => {
    if (!run) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [run])

  // 时间到了
  useEffect(() => {
    if (!run) return
    const end = run.start + run.minutes * 60000
    if (now < end) return
    if (run.phase === 'work') {
      saveRecord(run, end)
      const count = run.count + 1
      const long = count % 4 === 0
      const mins = long ? cfg.longBreak : cfg.shortBreak
      if (cfg.sound) beep()
      notify('专注完成', `完成第 ${count} 个番茄，休息 ${mins} 分钟`)
      toast(`专注完成，休息 ${mins} 分钟`)
      setRun({ ...run, phase: 'break', start: Date.now(), minutes: mins, count })
    } else {
      if (cfg.sound) beep()
      notify('休息结束', '可以开始下一个专注了')
      toast('休息结束')
      setRun(null)
    }
  }, [now])

  if (!run) {
    return (
      <>
        <button className="focus-start" onClick={() => setStarting(true)}>
          ▶ 开始专注
        </button>
        {starting && <StartFocus onClose={() => setStarting(false)} onStart={(r) => (setRun(r), setNow(Date.now()), setStarting(false))} />}
      </>
    )
  }

  const left = Math.max(0, (run.start + run.minutes * 60000 - now) / 1000)
  const pct = 100 - (left / (run.minutes * 60)) * 100
  const project = data.projects.find((p) => p.id === run.projectId)
  const todo = data.todos.find((t) => t.id === run.todoId)
  const what = run.label || todo?.title || project?.name || ''

  return (
    <div className={'focus-box ' + run.phase}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12 }}>{run.phase === 'work' ? '专注中' : '休息中'}</span>
        <b style={{ fontSize: 16, fontVariantNumeric: 'tabular-nums' }}>{mmss(left)}</b>
      </div>
      <div className="focus-bar">
        <div style={{ width: pct + '%' }} />
      </div>
      {what && run.phase === 'work' && <div className="faint" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{what}</div>}
      <div className="row" style={{ gap: 4, marginTop: 4 }}>
        {run.phase === 'work' ? (
          <button
            className="btn small"
            onClick={async () => {
              const done = Math.round((Date.now() - run.start) / 60000)
              if (!confirm(done >= 1 ? `提前结束？已专注的 ${done} 分钟会记下来。` : '放弃这个番茄？不满 1 分钟不记录。')) return
              await saveRecord(run, Date.now())
              setRun(null)
            }}
          >
            结束
          </button>
        ) : (
          <button className="btn small" onClick={() => setRun(null)}>跳过休息</button>
        )}
        <span className="faint" style={{ fontSize: 11, marginLeft: 'auto' }}>第 {run.count + (run.phase === 'work' ? 1 : 0)} 个</span>
      </div>
    </div>
  )
}

function StartFocus({ onClose, onStart }: { onClose: () => void; onStart: (r: Run) => void }) {
  const { data } = useApp()
  const cfg = data.settings.focus || { work: 25 }
  const [minutes, setMinutes] = useState(cfg.work)
  const [projectId, setProjectId] = useState('')
  const [todoId, setTodoId] = useState('')
  const [label, setLabel] = useState('')
  const todos = data.todos.filter((t) => !t.done && (!projectId || t.projectId === projectId))
  const start = () => onStart({ phase: 'work', start: Date.now(), minutes, projectId: projectId || undefined, todoId: todoId || undefined, label: label.trim() || undefined, count: 0 })
  return (
    <Modal
      title="开始专注"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={start}>开始</button>
        </>
      }
    >
      <div className="field">
        <label>时长（分钟）</label>
        <div className="row">
          {[15, 25, 45, 60, 90].map((m) => (
            <button key={m} className={'btn small' + (minutes === m ? ' primary' : '')} onClick={() => setMinutes(m)}>
              {m}
            </button>
          ))}
          <input type="number" className="input" style={{ width: 70 }} min={1} max={240} value={minutes} onChange={(e) => setMinutes(Math.max(1, Math.min(240, Number(e.target.value) || 1)))} />
        </div>
      </div>
      <div className="field">
        <label>做什么（可选）</label>
        <input autoFocus className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如：写方案说明第三章" onKeyDown={(e) => e.key === 'Enter' && start()} />
      </div>
      <div className="grid2">
        <div className="field">
          <label>关联项目</label>
          <select className="input" value={projectId} onChange={(e) => (setProjectId(e.target.value), setTodoId(''))}>
            <option value="">不关联</option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>关联待办</label>
          <select
            className="input"
            value={todoId}
            onChange={(e) => {
              setTodoId(e.target.value)
              const t = data.todos.find((x) => x.id === e.target.value)
              if (t?.projectId && !projectId) setProjectId(t.projectId)
            }}
          >
            <option value="">不关联</option>
            {todos.map((t) => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="faint" style={{ fontSize: 12 }}>专注结束后自动休息 {data.settings.focus?.shortBreak ?? 5} 分钟，每 4 个番茄长休息 {data.settings.focus?.longBreak ?? 15} 分钟。时长可在 设置 → 番茄钟 里改。</div>
    </Modal>
  )
}

/** 工作台上的专注统计 */
export function FocusStats() {
  const { data, go } = useApp()
  const today = ymd()
  const weekStart = addDays(endOfWeek(today), -6)
  const day = (iso: string) => ymd(new Date(iso))
  const todayList = data.focus.filter((f) => day(f.start) === today).sort((a, b) => a.start.localeCompare(b.start))
  const week = data.focus.filter((f) => day(f.start) >= weekStart && day(f.start) <= today)
  const sum = (l: any[]) => l.reduce((s, f) => s + (f.minutes || 0), 0)
  const byProject = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of week) m.set(f.projectId || '', (m.get(f.projectId || '') || 0) + f.minutes)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [data.focus])
  const max = Math.max(1, ...byProject.map((x) => x[1]))
  const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`)
  return (
    <div className="card">
      <div className="card-head">专注</div>
      <div className="card-body">
        <div className="row" style={{ gap: 20, marginBottom: 8 }}>
          <div>
            <div className="stat-label">今天</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{hm(sum(todayList))}</div>
            <div className="faint" style={{ fontSize: 11 }}>{todayList.length} 段</div>
          </div>
          <div>
            <div className="stat-label">本周</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{hm(sum(week))}</div>
            <div className="faint" style={{ fontSize: 11 }}>{week.length} 段</div>
          </div>
        </div>
        {byProject.length === 0 && <div className="faint" style={{ fontSize: 12 }}>点左下角「开始专注」开一个番茄钟</div>}
        {byProject.slice(0, 5).map(([pid, m]) => {
          const p = data.projects.find((x) => x.id === pid)
          return (
            <div key={pid || 'none'} style={{ marginBottom: 6, fontSize: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className={p ? 'click' : 'faint'} onClick={() => p && go({ page: 'project', projectId: p.id, tab: 'detail' })}>{p?.name || '未关联项目'}</span>
                <span className="faint">{hm(m)}</span>
              </div>
              <div className="focus-bar">
                <div style={{ width: (m / max) * 100 + '%' }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 项目详情里显示的专注时长 */
export function projectFocusMinutes(focus: any[], projectId: string) {
  return focus.filter((f) => f.projectId === projectId).reduce((s, f) => s + (f.minutes || 0), 0)
}
