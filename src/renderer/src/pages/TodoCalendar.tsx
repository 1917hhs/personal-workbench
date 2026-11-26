import { useMemo, useState } from 'react'
import { addDays, ymd, useApp } from '../lib'
import { nextDue, PRIORITIES, QuickAdd, REPEATS, setTodoDone, TodoRow } from './Todos'

// 待办日历：按月 / 按周看每天的待办。勾选完成、拖到别的日子改日期、点某天在右侧看当天明细并添加。
// 重复待办会把以后的几次也画出来（淡色，只做提示；完成当前这次后才真正生成下一次）。

const WEEK = ['一', '二', '三', '四', '五', '六', '日']
const prioColor = (t: any) => PRIORITIES.find((p) => p.id === (t.priority || 'normal'))!.color
const prioRank = (t: any) => (t.priority === 'high' ? 0 : t.priority === 'low' ? 2 : 1)
/** 周一为一周的第一天 */
const mondayOf = (d: string) => addDays(d, -((new Date(d + 'T00:00:00').getDay() + 6) % 7))

type Item = { t: any; ghost?: boolean; overdue?: boolean }

export default function TodoCalendar({ todos }: { todos: any[] }) {
  const { saveTodo, toast } = useApp()
  const today = ymd()
  const [mode, setMode] = useState<'month' | 'week'>(() => (localStorage.getItem('todoCal.mode') === 'week' ? 'week' : 'month'))
  const [anchor, setAnchor] = useState(today) // 当前显示的月 / 周里的某一天
  const [sel, setSel] = useState(today)
  const [showDone, setShowDone] = useState(() => localStorage.getItem('todoCal.done') !== '0')
  const [dragOver, setDragOver] = useState<string | null>(null)

  const setModeKeep = (m: 'month' | 'week') => {
    setMode(m)
    try {
      localStorage.setItem('todoCal.mode', m)
    } catch {}
  }
  const toggleDone = () => {
    setShowDone(!showDone)
    try {
      localStorage.setItem('todoCal.done', showDone ? '0' : '1')
    } catch {}
  }

  // 要画出来的日期
  const days = useMemo(() => {
    if (mode === 'week') {
      const s = mondayOf(anchor)
      return Array.from({ length: 7 }, (_, i) => addDays(s, i))
    }
    const first = anchor.slice(0, 8) + '01'
    const s = mondayOf(first)
    // 够显示整月就行：5 周或 6 周
    const last = ymd(new Date(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)), 0))
    const weeks = Math.ceil((Math.round((new Date(last + 'T00:00:00').getTime() - new Date(s + 'T00:00:00').getTime()) / 86400000) + 1) / 7)
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(s, i))
  }, [mode, anchor])
  const start = days[0]
  const end = days[days.length - 1]

  // 每天的待办（含重复待办以后几次的预告）
  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>()
    const put = (d: string, it: Item) => {
      if (!m.has(d)) m.set(d, [])
      m.get(d)!.push(it)
    }
    for (const t of todos) {
      if (t.done) {
        if (!showDone) continue
        const d = t.due || (t.doneAt ? ymd(new Date(t.doneAt)) : '')
        if (d) put(d, { t })
        continue
      }
      if (!t.due) continue
      put(t.due, { t, overdue: t.due < today })
      if (t.repeat) {
        let d = t.due
        for (let i = 0; i < 400; i++) {
          d = nextDue(d, t.repeat)
          if (d > end) break
          if (d >= start) put(d, { t, ghost: true })
        }
      }
    }
    for (const list of m.values())
      list.sort((a, b) => Number(!!a.t.done) - Number(!!b.t.done) || Number(!!a.ghost) - Number(!!b.ghost) || prioRank(a.t) - prioRank(b.t) || Number(!!b.t.starred) - Number(!!a.t.starred))
    return m
  }, [todos, showDone, start, end, today])

  const shift = (n: number) => {
    if (mode === 'week') setAnchor(addDays(anchor, n * 7))
    else {
      const [y, mo] = anchor.split('-').map(Number)
      setAnchor(ymd(new Date(y, mo - 1 + n, 1)))
    }
  }
  const goToday = () => {
    setAnchor(today)
    setSel(today)
  }

  const drop = (day: string, e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(null)
    const id = e.dataTransfer.getData('text/todo-id')
    const t = todos.find((x) => x.id === id)
    if (!t || t.due === day) return
    saveTodo({ ...t, due: day })
    toast(`已改到 ${day.slice(5)}：${t.title}`)
  }

  const title =
    mode === 'month'
      ? `${anchor.slice(0, 4)} 年 ${Number(anchor.slice(5, 7))} 月`
      : `${start.slice(0, 4)} 年 ${Number(start.slice(5, 7))} 月 ${Number(start.slice(8))} 日 – ${Number(end.slice(5, 7))} 月 ${Number(end.slice(8))} 日`
  const maxShow = mode === 'month' ? (days.length > 35 ? 3 : 4) : 99

  // 右侧：选中这天的明细
  const selItems = (byDay.get(sel) || []).filter((x) => !x.ghost)
  const selGhosts = (byDay.get(sel) || []).filter((x) => x.ghost)
  const overdue = sel === today ? todos.filter((t) => !t.done && t.due && t.due < today).sort((a, b) => a.due.localeCompare(b.due)) : []
  const unplanned = todos.filter((t) => !t.done && !t.due).sort((a, b) => prioRank(a) - prioRank(b))
  const selDate = new Date(sel + 'T00:00:00')
  const selLabel = `${selDate.getMonth() + 1} 月 ${selDate.getDate()} 日 周${WEEK[(selDate.getDay() + 6) % 7]}${sel === today ? ' · 今天' : sel === addDays(today, 1) ? ' · 明天' : ''}`

  const dragProps = (t: any) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('text/todo-id', t.id)
      e.dataTransfer.effectAllowed = 'move'
    }
  })

  return (
    <div className="tc-wrap">
      <div className="tc-main">
        <div className="tc-bar">
          <button className="btn small" onClick={() => shift(-1)} title={mode === 'month' ? '上个月' : '上一周'}>‹</button>
          <button className="btn small" onClick={goToday}>今天</button>
          <button className="btn small" onClick={() => shift(1)} title={mode === 'month' ? '下个月' : '下一周'}>›</button>
          <b className="tc-title">{title}</b>
          <span className="spacer" />
          <label className="tc-opt">
            <input type="checkbox" checked={showDone} onChange={toggleDone} />
            显示已完成
          </label>
          <div className="seg">
            <button className={mode === 'month' ? 'on' : ''} onClick={() => setModeKeep('month')}>月</button>
            <button className={mode === 'week' ? 'on' : ''} onClick={() => setModeKeep('week')}>周</button>
          </div>
        </div>
        <div className="tc-head">
          {WEEK.map((w, i) => (
            <div key={w} className={i >= 5 ? 'wkend' : ''}>周{w}</div>
          ))}
        </div>
        <div className={'tc-grid ' + mode} style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(0, 1fr))` }}>
          {days.map((d) => {
            const items = byDay.get(d) || []
            const inMonth = mode === 'week' || d.slice(0, 7) === anchor.slice(0, 7)
            const open = items.filter((x) => !x.t.done && !x.ghost).length
            const dow = (new Date(d + 'T00:00:00').getDay() + 6) % 7
            return (
              <div
                key={d}
                className={'tc-day' + (inMonth ? '' : ' out') + (d === today ? ' today' : '') + (d === sel ? ' sel' : '') + (dow >= 5 ? ' wkend' : '') + (dragOver === d ? ' over' : '')}
                onClick={() => setSel(d)}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (dragOver !== d) setDragOver(d)
                }}
                onDragLeave={() => dragOver === d && setDragOver(null)}
                onDrop={(e) => drop(d, e)}
              >
                <div className="tc-date">
                  <span className="tc-num">{Number(d.slice(8)) === 1 && mode === 'month' ? `${Number(d.slice(5, 7))}月1日` : Number(d.slice(8))}</span>
                  {open > 0 && <span className="tc-cnt">{open}</span>}
                </div>
                <div className="tc-items">
                  {items.slice(0, maxShow).map(({ t, ghost, overdue }) => (
                    <div
                      key={t.id + (ghost ? '~' + d : '')}
                      className={'tc-item' + (t.done ? ' done' : '') + (ghost ? ' ghost' : '') + (overdue ? ' overdue' : '')}
                      style={{ borderLeftColor: prioColor(t) }}
                      title={(ghost ? `重复（${REPEATS.find((r) => r.id === t.repeat)?.label}）：完成当前这次后生成\n` : '') + t.title + (t.note ? '\n' + t.note : '')}
                      {...(ghost || t.done ? {} : dragProps(t))}
                    >
                      {!ghost && (
                        <input
                          type="checkbox"
                          checked={!!t.done}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setTodoDone(saveTodo, t, e.target.checked)}
                        />
                      )}
                      <span className="tc-t">
                        {t.starred ? '★ ' : ''}
                        {t.title}
                      </span>
                      {(t.repeat || ghost) && <span className="tc-rep" title="重复">↻</span>}
                    </div>
                  ))}
                  {items.length > maxShow && <div className="tc-more">还有 {items.length - maxShow} 项</div>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="faint tc-tip">拖动待办到别的日子可以改日期；点某一天在右边查看和添加。</div>
      </div>

      <div className="tc-side">
        <div className="tc-side-head">{selLabel}</div>
        <QuickAdd key={sel} defaultDue={sel} compact hideDate />
        {overdue.length > 0 && (
          <div className="todo-group">
            <div className="todo-group-head" style={{ color: 'var(--danger)' }}>
              已逾期 <span className="faint">{overdue.length}</span>
            </div>
            {overdue.map((t) => (
              <div key={t.id} {...dragProps(t)}>
                <TodoRow t={t} stacked />
              </div>
            ))}
          </div>
        )}
        <div className="todo-group">
          <div className="todo-group-head">
            {sel === today ? '今天' : '这一天'} <span className="faint">{selItems.length || ''}</span>
          </div>
          {selItems.length === 0 && <div className="faint" style={{ fontSize: 12, padding: '4px 2px' }}>没有待办</div>}
          {selItems.map(({ t }) => (
            <div key={t.id} {...(t.done ? {} : dragProps(t))}>
              <TodoRow t={t} stacked />
            </div>
          ))}
          {selGhosts.length > 0 && (
            <div className="faint" style={{ fontSize: 12, padding: '4px 2px' }}>
              重复待办（到时生成）：{selGhosts.map((x) => x.t.title).join('、')}
            </div>
          )}
        </div>
        {unplanned.length > 0 && (
          <details className="todo-group tc-unplanned">
            <summary className="todo-group-head">
              未安排时间 <span className="faint">{unplanned.length}</span>
              <span className="faint" style={{ fontWeight: 400, fontSize: 11, marginLeft: 6 }}>拖到日历上安排</span>
            </summary>
            {unplanned.map((t) => (
              <div key={t.id} {...dragProps(t)}>
                <TodoRow t={t} stacked />
              </div>
            ))}
          </details>
        )}
      </div>
    </div>
  )
}
