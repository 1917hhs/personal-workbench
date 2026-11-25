import { useMemo, useState } from 'react'
import { api, daysBetween, errMsg, leadsOf, needsAttention, progressOf, stageOf, useApp, ymd } from '../lib'
import { Empty, Ico, StageDot, Tabs } from '../ui'
import ProjectDialog from './ProjectDialog'

export function DeadlineTag({ date }: { date?: string }) {
  if (!date) return null
  const d = daysBetween(ymd(), date)
  if (d < 0) return <span className="tag red">逾期 {-d} 天</span>
  if (d <= 14) return <span className="tag amber">{d === 0 ? '今天截止' : `${d} 天后截止`}</span>
  return <span className="tag">截止 {date}</span>
}

export default function Projects() {
  const { data, go, toast, saveProject } = useApp()
  const { settings, projects } = data
  const [view, setView] = useState<'card' | 'list' | 'board'>(() => (localStorage.getItem('projView') as any) || 'card')
  const [q, setQ] = useState('')
  const [stage, setStage] = useState('')
  const [owner, setOwner] = useState('')
  const [creating, setCreating] = useState(false)

  const setViewSave = (v: any) => {
    setView(v)
    localStorage.setItem('projView', v)
  }

  const list = useMemo(() => {
    const has = (s: any) => String(s || '').toLowerCase().includes(q.trim().toLowerCase())
    return projects
      .filter((p) => !q || has(p.name) || has(p.code) || has(p.client) || has(p.location))
      .filter((p) => !stage || p.stage === stage)
      .filter((p) => !owner || leadsOf(p).some((l) => l.name === owner) || p.members?.includes(owner))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }, [projects, q, stage, owner])

  // 子项目排在主项目后面，缩进显示
  const ordered = useMemo(() => {
    const ids = new Set(list.map((p) => p.id))
    const tops = list.filter((p) => !p.parentId || !ids.has(p.parentId))
    return tops.flatMap((p) => [{ p, sub: false }, ...list.filter((c) => c.parentId === p.id).map((c) => ({ p: c, sub: true }))])
  }, [list])

  const open = (id: string) => go({ page: 'project', projectId: id })
  const parentName = (p: any) => projects.find((x) => x.id === p.parentId)?.name

  // 卡片上的统计：未完成待办、询价（进行中 / 全部）
  const stats = useMemo(() => {
    const m = new Map<string, { todo: number; inq: number; inqOpen: number }>()
    const get = (id: string) => m.get(id) || (m.set(id, { todo: 0, inq: 0, inqOpen: 0 }), m.get(id)!)
    for (const t of data.todos || []) if (t.projectId && !t.done) get(t.projectId).todo++
    for (const x of data.inquiries || []) {
      if (!x.projectId) continue
      const s = get(x.projectId)
      s.inq++
      if (!['已定标', '取消'].includes(x.status)) s.inqOpen++
    }
    return m
  }, [data.todos, data.inquiries])
  const statusCls = (s: string) => (/暂停|搁置|风险|延期/.test(s || '') ? ' red' : /洽谈|待|准备|投标/.test(s || '') ? ' amber' : /进行|实施|完成/.test(s || '') ? ' good' : '')

  const Card = ({ p }: { p: any }) => {
    const s = stageOf(settings, p.stage)
    const pr = progressOf(p)
    const st = stats.get(p.id) || { todo: 0, inq: 0, inqOpen: 0 }
    const leads = leadsOf(p)
    // 点进度条直接设成点到的位置（手动进度）
    const setPct = (e: React.MouseEvent) => {
      e.stopPropagation()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const v = Math.max(0, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 20) * 5))
      saveProject({ id: p.id, progress: v })
    }
    return (
      <div className="card proj-card" onClick={() => open(p.id)} title="点击打开项目">
        <div className="row" style={{ gap: 6 }}>
          <StageDot color={s.color} />
          <span className="pc-stage">{s.name}</span>
          {p.starred && <span style={{ color: '#f59e0b' }}>★</span>}
          {p.status && <span className={'tag' + statusCls(p.status)} style={{ marginLeft: 'auto' }}>{p.status}</span>}
        </div>
        <div className="proj-name">{p.name}</div>
        {p.parentId && <div className="faint" style={{ fontSize: 12, marginTop: -6 }}>↳ {parentName(p)}</div>}
        <div className="pc-meta">
          <div title="委托单位 / 业主"><span className="pc-ico"><Ico name="building" /></span>{p.client || <span className="faint">—</span>}</div>
          <div title="地点"><span className="pc-ico"><Ico name="pin" /></span>{p.location || <span className="faint">—</span>}</div>
          {p.code && <div title="项目编号"><span className="pc-ico"><Ico name="hash" /></span>{p.code}</div>}
        </div>
        <div className="pc-stats">
          <span className={st.todo ? '' : 'faint'}>待办 <b>{st.todo}</b></span>
          <span className={st.inq ? '' : 'faint'}>询价 <b>{st.inqOpen}</b>{st.inq > st.inqOpen ? <span className="faint"> / {st.inq}</span> : null}</span>
          <span style={{ marginLeft: 'auto' }}><DeadlineTag date={p.deadline} /></span>
        </div>
        <div className="pc-foot">
          {pr && (
            <div className="row" style={{ gap: 10, marginBottom: 8 }}>
              <div
                className="pc-bar adjustable"
                title={(pr.manual ? '手动设置的进度' : `按时间自动计算：${p.startDate} → ${p.deadline}`) + '\n点击进度条可手动调整'}
                onClick={setPct}
              >
                <div style={{ width: pr.pct + '%', background: s.color || 'var(--accent)' }} />
              </div>
              <span className="faint" style={{ fontSize: 12, minWidth: 34, textAlign: 'right' }}>{pr.pct}%</span>
              {pr.manual && (
                <button
                  className="pc-auto"
                  title={p.startDate && p.deadline ? '恢复按时间自动计算' : '清除手动进度（没填开始和截止日期时不显示进度条）'}
                  onClick={(e) => {
                    e.stopPropagation()
                    saveProject({ id: p.id, progress: null })
                  }}
                >
                  ↺
                </button>
              )}
            </div>
          )}
          <div className="pc-leads">
            {leads.length ? (
              leads.map((l, i) => (
                <span key={i} className="pc-lead" title={l.role || '负责人'}>
                  <Ico name="user" size={12} />
                  {l.role && <span className="faint">{l.role}</span>}
                  {l.name}
                </span>
              ))
            ) : (
              <span className="faint" style={{ fontSize: 12.5 }}>未指定负责人</span>
            )}
            {!p.rootPath && <span className="tag" style={{ marginLeft: 'auto' }}>未关联文件夹</span>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="topbar">
        <h1>项目</h1>
        <input className="input" style={{ width: 240 }} placeholder="搜索名称、编号、单位…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" style={{ width: 'auto' }} value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">全部阶段</option>
          {settings.stages.map((s: any) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        {settings.members.length > 0 && (
          <select className="input" style={{ width: 'auto' }} value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">全部人员</option>
            {settings.members.map((m: any) => (
              <option key={m.id}>{m.name}</option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <Tabs value={view} onChange={setViewSave} options={[{ id: 'card', label: '卡片' }, { id: 'list', label: '列表' }, { id: 'board', label: '看板' }]} />
        <button
          className="btn"
          disabled={!list.length}
          title="导出当前筛选出的项目"
          onClick={() => api.call('export:ledger', ordered.map(({ p }) => p.id)).catch((e) => toast(errMsg(e)))}
        >
          导出台账
        </button>
        <button className="btn primary" onClick={() => setCreating(true)}>+ 新建项目</button>
      </div>
      <div className="page">
        {projects.length === 0 ? (
          <Empty title="创建你的第一个项目" text="可以按模板新建项目文件夹，也可以直接关联电脑上已有的项目文件夹。">
            <div className="row">
              <button className="btn primary" onClick={() => setCreating(true)}>+ 新建项目</button>
              <button className="btn" onClick={() => go({ page: 'settings', settingsSection: 'pack' })} title="设置 → 数据包（换电脑）">从另一台电脑导入</button>
            </div>
          </Empty>
        ) : list.length === 0 ? (
          <Empty title="没有符合条件的项目" />
        ) : view === 'card' ? (
          <div className="proj-grid">
            {list.map((p) => (
              <Card key={p.id} p={p} />
            ))}
          </div>
        ) : view === 'list' ? (
          <table className="tbl card">
            <thead>
              <tr>
                <th>项目</th>
                <th>编号</th>
                <th>委托单位</th>
                <th>阶段</th>
                <th>状态</th>
                <th>负责人</th>
                <th>截止</th>
              </tr>
            </thead>
            <tbody>
              {settings.stages.map((s: any) => {
                const rows = ordered.filter(({ p }) => p.stage === s.id)
                if (!rows.length) return null
                return [
                  <tr key={s.id} className="group">
                    <td colSpan={7}>
                      <span className="row" style={{ gap: 6 }}>
                        <StageDot color={s.color} />
                        {s.name} · {rows.length}
                      </span>
                    </td>
                  </tr>,
                  ...rows.map(({ p, sub }) => (
                    <tr key={p.id} className="click-row" onClick={() => open(p.id)}>
                      <td style={{ paddingLeft: sub ? 28 : 8 }}>
                        {sub && <span className="faint">↳ </span>}
                        {p.name}
                        {needsAttention(settings, p) && <span style={{ color: 'var(--warn)' }}> ●</span>}
                      </td>
                      <td className="muted">{p.code}</td>
                      <td className="muted">{p.client}</td>
                      <td>{s.name}</td>
                      <td className="muted">{p.status}</td>
                      <td className="muted">{leadsOf(p).map((l) => l.name).join('、')}</td>
                      <td><DeadlineTag date={p.deadline} /></td>
                    </tr>
                  ))
                ]
              })}
            </tbody>
          </table>
        ) : (
          <div className="board">
            {settings.stages.map((s: any) => {
              const rows = list.filter((p) => p.stage === s.id)
              return (
                <div key={s.id} className="board-col">
                  <div className="board-col-head">
                    <StageDot color={s.color} />
                    {s.name}
                    <span className="faint" style={{ marginLeft: 'auto' }}>{rows.length}</span>
                  </div>
                  {rows.map((p) => (
                    <Card key={p.id} p={p} />
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {creating && <ProjectDialog onClose={() => setCreating(false)} onCreated={(id) => open(id)} />}
    </>
  )
}
