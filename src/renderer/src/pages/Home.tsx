import { useEffect, useMemo, useState } from 'react'
import { addDays, api, daysBetween, endOfWeek, isActive, isArchived, needsAttention, stageOf, uid, useApp, ymd } from '../lib'
import { Empty, StageDot, Tabs } from '../ui'
import { groupTodos, QuickAdd, TodoRow } from './Todos'
import { DeadlineTag } from './Projects'
import { FocusStats } from './Focus'
import { strip } from './Knowledge'
import ProcurementCard from './Procurement'

const WEEK = ['一', '二', '三', '四', '五', '六', '日']

/** 最近的备忘录：点开直接编辑；也能一键新建 */
function MemoCard() {
  const { go } = useApp()
  const [pages, setPages] = useState<any[]>([])
  useEffect(() => {
    api.call('kb:list').then((l: any[]) => setPages(l.filter((p) => !p.deletedAt).sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || String(b.updatedAt).localeCompare(String(a.updatedAt)))))
  }, [])
  const create = async () => {
    const p = await api.call('kb:save', { id: uid(), title: '', parentId: null, html: '<p></p>', order: Date.now() })
    go({ page: 'kb', pageId: p.id })
  }
  return (
    <div className="card home-card">
      <div className="card-head">
        备忘录 <span className="faint">{pages.length || ''}</span>
        <span className="spacer" />
        <button className="btn small" onClick={create}>+ 新建</button>
      </div>
      <div className="card-body">
        {pages.length === 0 && <div className="faint" style={{ fontSize: 12 }}>随手记：文字、截图、录音、视频，也能引用资料库和项目文件。</div>}
        {pages.slice(0, 5).map((p) => (
          <div key={p.id} className="list-row click" onClick={() => go({ page: 'kb', pageId: p.id })}>
            <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.favorite ? '📌 ' : ''}
              {(p.title || '').trim() || strip(p.html).slice(0, 30) || '新备忘录'}
            </span>
            <span className="faint" style={{ fontSize: 11 }}>{String(p.updatedAt || '').slice(5, 10)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Stickies() {
  const { data, setData } = useApp()
  const add = async () => setData({ stickies: await api.call('stickies:save', { id: uid(), text: '' }) })
  const save = async (s: any, text: string) => text !== s.text && setData({ stickies: await api.call('stickies:save', { ...s, text }) })
  const del = async (id: string) => setData({ stickies: await api.call('stickies:delete', id) })
  return (
    <div className="card home-card grow-card">
      <div className="card-head">
        便签 <span className="faint">{data.stickies.length || ''}</span>
        <span className="spacer" />
        <button className="btn small" onClick={add}>+ 便签</button>
      </div>
      <div className="card-body scroll sticky-grid">
        {data.stickies.length === 0 && <div className="faint" style={{ fontSize: 12 }}>随手记点东西</div>}
        {data.stickies.map((s) => (
          <div key={s.id} className="sticky">
            <textarea defaultValue={s.text} autoFocus={!s.text} placeholder="写点什么…（离开自动保存）" onBlur={(e) => save(s, e.target.value)} />
            <button className="icon-btn sticky-del" title="删除" onClick={() => (!s.text || confirm('删除这张便签？')) && del(s.id)}>×</button>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Home() {
  const { data, go } = useApp()
  const { settings, projects, todos, inquiries } = data
  const today = ymd()
  const eow = endOfWeek(today)
  const g = groupTodos(todos)
  const [todoTab, setTodoTab] = useState<'today' | 'week' | 'all'>('today')
  const [projTab, setProjTab] = useState<'attention' | 'active' | 'recent'>('attention')
  const [calMonth, setCalMonth] = useState(() => today.slice(0, 7))
  const [calSel, setCalSel] = useState(today)

  const active = projects.filter((p) => isActive(settings, p))
  const attention = projects.filter((p) => needsAttention(settings, p))

  // 近 30 天：项目截止、待办、询价回价截止
  const upcoming = useMemo(() => {
    // 已经过了但还没办完的也列在最前面（项目未归档、待办未完成、询价还没回齐）
    const end = addDays(today, 30)
    const a = projects.filter((p) => p.deadline && p.deadline <= end && (p.deadline >= today || !isArchived(settings, p))).map((p) => ({ date: p.deadline, kind: '项目截止', title: p.name, onClick: () => go({ page: 'project', projectId: p.id }) }))
    const b = todos.filter((t) => !t.done && t.due && t.due <= end).map((t) => ({ date: t.due, kind: '待办', title: t.title, onClick: () => go({ page: 'todos' }) }))
    const d = inquiries
      .filter((x) => x.deadline && x.deadline <= end && ['询价中', '编制中'].includes(x.status))
      .map((x) => ({ date: x.deadline, kind: '回价截止', title: x.name, onClick: () => go({ page: 'inquiries', inquiryId: x.id }) }))
    return [...a, ...b, ...d].sort((x, y) => x.date.localeCompare(y.date))
  }, [projects, todos, inquiries])

  const marks = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of projects) if (p.deadline) m.set(p.deadline, (m.get(p.deadline) || 0) + 1)
    for (const t of todos) if (t.due && !t.done) m.set(t.due, (m.get(t.due) || 0) + 1)
    for (const x of inquiries) if (x.deadline) m.set(x.deadline, (m.get(x.deadline) || 0) + 1)
    return m
  }, [projects, todos, inquiries])

  const weekTodos = todos.filter((t) => t.due && t.due >= addDays(eow, -6) && t.due <= eow)
  const weekDone = weekTodos.filter((t) => t.done).length
  const todoList = todoTab === 'today' ? [...g.overdue, ...g.today] : todoTab === 'week' ? [...g.overdue, ...g.today, ...g.week] : [...g.overdue, ...g.today, ...g.week, ...g.later, ...g.none]
  const projList = projTab === 'attention' ? attention : projTab === 'active' ? active : [...projects].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 15)
  const openInq = inquiries.filter((x) => ['编制中', '询价中', '比价中'].includes(x.status))
  // 供应商入库资料：60 天内到期或已过期
  const in60 = addDays(today, 60)
  const certs = data.companies.flatMap((c) => (c.docs || []).filter((x: any) => x.expireDate && x.expireDate <= in60))
  const certsExpired = certs.filter((x: any) => x.expireDate < today).length

  const hour = new Date().getHours()
  const hello = hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 14 ? '中午好' : hour < 19 ? '下午好' : '晚上好'
  const d = new Date()

  const [cy, cm] = calMonth.split('-').map(Number)
  const offset = (new Date(cy, cm - 1, 1).getDay() + 6) % 7
  const days = Array.from({ length: 42 }, (_, i) => ymd(new Date(cy, cm - 1, 1 - offset + i)))
  const shiftMonth = (n: number) => setCalMonth(ymd(new Date(cy, cm - 1 + n, 1)).slice(0, 7))
  const selItems = [
    ...projects.filter((p) => p.deadline === calSel).map((p) => `项目截止：${p.name}`),
    ...inquiries.filter((x) => x.deadline === calSel).map((x) => `回价截止：${x.name}`)
  ]
  const selTodos = todos.filter((t) => t.due === calSel && !t.done)

  const stat = (label: string, num: number, sub: string, onClick?: () => void, color?: string) => (
    <div className={'card stat' + (onClick ? ' click' : '')} onClick={onClick}>
      <div className="stat-label">{label}</div>
      <div className="stat-num" style={{ color }}>{num}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  )

  return (
    <div className="home">
      <div className="row home-top">
        <div>
          <div className="hello">{hello}</div>
          <div className="faint">
            {d.getMonth() + 1} 月 {d.getDate()} 日 周{WEEK[(d.getDay() + 6) % 7]}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => go({ page: 'kb' })}>写备忘录</button>
        <button className="btn primary" onClick={() => go({ page: 'projects' })}>项目列表</button>
      </div>

      <div className="stats">
        {stat('进行中项目', active.length, `共 ${projects.length} 个`, () => go({ page: 'projects' }))}
        {stat('需要关注', attention.length, '两周内到期或已逾期', undefined, attention.length ? 'var(--warn)' : undefined)}
        {stat('待办', g.today.length + g.overdue.length, `今天 ${g.today.length} · 逾期 ${g.overdue.length} · 本周完成 ${weekDone}`, () => go({ page: 'todos' }), g.overdue.length ? 'var(--danger)' : undefined)}
        {stat('询价', openInq.length, `进行中 · 已定标 ${inquiries.filter((x) => x.status === '已定标').length}`, () => go({ page: 'inquiries' }))}
        {stat('资质提醒', certs.length, certs.length ? `已过期 ${certsExpired} · 60 天内到期 ${certs.length - certsExpired}` : '供应商入库资料都在有效期内', () => go({ page: 'contacts' }), certsExpired ? 'var(--danger)' : certs.length ? 'var(--warn)' : undefined)}
      </div>

      <div className="home3">
        <div className="home-col">
          <div className="card home-card grow-card" style={{ flexGrow: 2 }}>
            <div className="card-head">
              待办
              <span className="spacer" />
              <Tabs value={todoTab} onChange={setTodoTab} options={[{ id: 'today', label: '今天' }, { id: 'week', label: '本周' }, { id: 'all', label: '全部' }]} />
            </div>
            <div className="card-body scroll">
              <QuickAdd defaultDue={today} compact />
              {todoList.length === 0 ? <div className="faint">没有要做的待办</div> : todoList.map((t) => <TodoRow key={t.id} t={t} />)}
            </div>
          </div>
          <ProcurementCard />
        </div>

        <div className="home-col">
          <div className="card home-card grow-card">
            <div className="card-head">近期日程 <span className="faint">30 天内 · 含已逾期未完成</span></div>
            <div className="card-body scroll">
              {upcoming.length === 0 ? (
                <div className="faint">30 天内没有截止、待办和回价</div>
              ) : (
                upcoming.map((u, i) => (
                  <div key={i} className="list-row">
                    <span className="tag">{u.date.slice(5)}</span>
                    <span className="faint" style={{ width: 56, fontSize: 12 }}>{u.kind}</span>
                    <span className="grow click" onClick={u.onClick}>{u.title}</span>
                    <span className={daysBetween(today, u.date) < 0 ? 'red-text' : 'faint'} style={{ fontSize: 12 }}>
                      {daysBetween(today, u.date) === 0 ? '今天' : daysBetween(today, u.date) < 0 ? `逾期 ${-daysBetween(today, u.date)} 天` : `${daysBetween(today, u.date)} 天后`}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="card home-card grow-card">
            <div className="card-head">
              项目
              <span className="spacer" />
              <Tabs
                value={projTab}
                onChange={setProjTab}
                options={[
                  { id: 'attention', label: `关注 ${attention.length}` },
                  { id: 'active', label: `进行中 ${active.length}` },
                  { id: 'recent', label: '最近' }
                ]}
              />
            </div>
            <div className="card-body scroll">
              {projList.length === 0 ? (
                <Empty title={projects.length === 0 ? '这里还没有项目' : projTab === 'attention' ? '没有两周内到期或已逾期的项目' : '没有进行中的项目'} />
              ) : (
                projList.map((p) => {
                  const s = stageOf(settings, p.stage)
                  return (
                    <div key={p.id} className="list-row">
                      <StageDot color={s.color} />
                      <span className="grow click" onClick={() => go({ page: 'project', projectId: p.id })}>{p.name}</span>
                      <span className="faint" style={{ fontSize: 12 }}>{s.name}</span>
                      <DeadlineTag date={p.deadline} />
                    </div>
                  )
                })
              )}
            </div>
          </div>
          <Stickies />
        </div>

        <div className="home-col">
          <div className="card home-card">
            <div className="card-head">
              {cy} 年 {cm} 月
              <span className="spacer" />
              <button className="icon-btn" onClick={() => shiftMonth(-1)}>‹</button>
              <button className="btn small" onClick={() => (setCalMonth(today.slice(0, 7)), setCalSel(today))}>今天</button>
              <button className="icon-btn" onClick={() => shiftMonth(1)}>›</button>
            </div>
            <div className="card-body">
              <div className="cal">
                {WEEK.map((w) => (
                  <div key={w} className="cal-h">{w}</div>
                ))}
                {days.map((day, i) => (
                  <button
                    key={day}
                    title="点击查看这天，并可以直接添加待办"
                    className={'cal-d' + (day.slice(0, 7) !== calMonth ? ' other' : '') + (day === today ? ' today' : '') + (day === calSel ? ' sel' : '') + (i % 7 >= 5 ? ' wkend' : '')}
                    onClick={() => setCalSel(day)}
                  >
                    {Number(day.slice(8))}
                    {marks.get(day) && <span className="cal-mark" />}
                  </button>
                ))}
              </div>
              <div className="cal-day">
                <div className="faint" style={{ marginBottom: 4 }}>
                  {calSel === today ? '今天' : calSel} · 给这天加待办
                </div>
                <QuickAdd key={calSel} defaultDue={calSel} compact hideDate />
                {selItems.map((s, i) => (
                  <div key={i} className="faint" style={{ fontSize: 12 }}>{s}</div>
                ))}
                {selTodos.map((t) => (
                  <TodoRow key={t.id} t={t} />
                ))}
              </div>
            </div>
          </div>
          <MemoCard />
          <FocusStats />
        </div>
      </div>
    </div>
  )
}
