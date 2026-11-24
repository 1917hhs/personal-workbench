import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, AppCtx, AppData, Ctx, errMsg, Nav, stageOf, useApp as useAppCtx, ymd } from './lib'
import { AskHost, Modal } from './ui'
import Home from './pages/Home'
import Projects from './pages/Projects'
import ProjectView from './pages/ProjectView'
import Todos from './pages/Todos'
import Settings from './pages/Settings'
import Contacts from './pages/Contacts'
import Library from './pages/Library'
import Knowledge from './pages/Knowledge'
import MapPage from './pages/MapPage'
import { FocusWidget } from './pages/Focus'
import Inquiries from './pages/Inquiries'
import { Icon } from './icons'

export default function App() {
  const [data, setDataState] = useState<AppData | null>(null)
  const [nav, setNav] = useState<Nav>({ page: 'home' })
  const [toastMsg, setToastMsg] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const toastTimer = useRef<any>(null)

  useEffect(() => {
    api.call('app:init').then(setDataState)
  }, [])

  // AI 助手通过 MCP 改了数据：刷新界面并提示
  useEffect(() => {
    const off1 = api.on('data:changed', () => api.call('app:init').then(setDataState))
    const off2 = api.on('ai:action', (a: any) => {
      setToastMsg('AI 助手：' + a.summary + (a.canUndo ? '（可在 设置 → 智能体 里撤销）' : ''))
      clearTimeout(toastTimer.current)
      toastTimer.current = setTimeout(() => setToastMsg(''), 6000)
    })
    return () => {
      off1()
      off2()
    }
  }, [])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  const toast = useCallback((m: string) => {
    setToastMsg(m)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(''), 3200)
  }, [])

  const setData = useCallback((patch: Partial<AppData>) => setDataState((d) => ({ ...d!, ...patch })), [])

  const ctx: Ctx | null = useMemo(() => {
    if (!data) return null
    const wrap = async (fn: () => Promise<void>) => {
      try {
        await fn()
      } catch (e) {
        toast(errMsg(e))
        throw e
      }
    }
    return {
      data,
      setData,
      nav,
      go: setNav,
      toast,
      saveProject: (p) => wrap(async () => setData({ projects: await api.call('projects:save', p) })),
      saveTodo: (t) => wrap(async () => setData({ todos: await api.call('todos:save', t) })),
      deleteTodo: (id) => wrap(async () => setData({ todos: await api.call('todos:delete', id) })),
      saveSettings: (s) => wrap(async () => setData({ settings: await api.call('settings:save', s) })),
      saveContact: (c) => wrap(async () => setData({ contacts: await api.call('contacts:save', c) })),
      saveItem: async (kind, x) => {
        try {
          const list = await api.call(`${kind}:save`, x)
          setData({ [kind]: list } as any)
          return list.find((y: any) => y.id === x.id)
        } catch (e) {
          toast(errMsg(e))
          throw e
        }
      },
      deleteItem: (kind, id) => wrap(async () => setData(await api.call(`${kind}:delete`, id))),
      saveReview: (r) => wrap(async () => setData({ reviews: await api.call('reviews:save', r) })),
      deleteReview: (id) => wrap(async () => setData({ reviews: await api.call('reviews:delete', id) }))
    }
  }, [data, nav, setData, toast])

  if (!ctx) return <div className="empty">正在加载…</div>

  const { projects, todos, settings } = ctx.data
  const today = ymd()
  const todoCount = todos.filter((t) => !t.done && t.due && t.due <= today).length
  const starred = projects.filter((p) => p.starred)

  const navBtn = (page: Nav['page'], label: string, count?: number) => (
    <button className={'nav side-nav' + (nav.page === page || (page === 'projects' && nav.page === 'project') ? ' on' : '')} onClick={() => setNav({ page })}>
      <Icon name={page === 'home' ? 'home' : page} />
      {label}
      {!!count && <span className="count">{count}</span>}
    </button>
  )

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <aside className="side">
          <div className="brand">
            <span className="brand-logo">工</span>个人工作台
          </div>
          <button className="search-btn" onClick={() => setSearchOpen(true)}>
            <span className="row" style={{ gap: 6 }}>
              <Icon name="search" size={15} />
              搜索
            </span>
            <span>Ctrl K</span>
          </button>
          {navBtn('home', '工作台')}
          {navBtn('projects', '项目', projects.length)}
          {navBtn('todos', '待办', todoCount)}
          {navBtn('kb', '备忘录')}
          {navBtn('library', '资料库', ctx.data.library.length)}
          {navBtn('contacts', '通讯录与单位', ctx.data.contacts.length)}
          {navBtn('inquiries', '询价', ctx.data.inquiries.filter((x) => ['编制中', '询价中', '比价中'].includes(x.status)).length)}
          {navBtn('map', '地图')}
          {navBtn('settings', '设置')}
          {starred.length > 0 && <div className="side-sub">星标项目</div>}
          {starred.map((p) => (
            <button key={p.id} className="side-proj" onClick={() => setNav({ page: 'project', projectId: p.id })}>
              <span className="stage-dot" style={{ background: stageOf(settings, p.stage).color }} />
              {p.name}
            </button>
          ))}
          <div style={{ marginTop: 'auto' }} />
          <FocusWidget />
          <div className="side-foot" style={{ marginTop: 8 }}>
            v{ctx.data.version}
          </div>
        </aside>
        <main className="main">
          {nav.page === 'home' && <Home />}
          {nav.page === 'projects' && <Projects />}
          {nav.page === 'project' && nav.projectId && <ProjectView key={nav.projectId + (nav.tab || '') + (nav.select || '')} id={nav.projectId} select={nav.select} tab={nav.tab} />}
          {nav.page === 'todos' && <Todos />}
          {nav.page === 'contacts' && <Contacts key={(nav.contactId || '') + (nav.companyId || '')} focusId={nav.contactId} companyId={nav.companyId} />}
          {nav.page === 'library' && <Library key={nav.libraryId || ''} focusId={nav.libraryId} />}
          {nav.page === 'kb' && <Knowledge key={nav.pageId || ''} pageId={nav.pageId} />}
          {nav.page === 'map' && <MapPage key={nav.projectId || ''} focusId={nav.projectId} />}
          {nav.page === 'inquiries' && <Inquiries key={nav.inquiryId || ''} focusId={nav.inquiryId} />}
          {nav.page === 'settings' && <Settings key={nav.settingsSection || ''} section={nav.settingsSection} />}
        </main>
      </div>
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
      <AskHost />
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </AppCtx.Provider>
  )
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const { go } = useAppCtx()
  const [q, setQ] = useState('')
  const [r, setR] = useState<any>({ projects: [], todos: [], files: [], notes: [], contacts: [], reviews: [], library: [], pages: [] })
  const { data } = useAppCtx()
  useEffect(() => {
    const t = setTimeout(() => api.call('search', q).then(setR), 120)
    return () => clearTimeout(t)
  }, [q])
  const pick = (n: Nav) => {
    go(n)
    onClose()
  }
  const total = r.projects.length + r.todos.length + r.files.length + r.notes.length + r.contacts.length + r.reviews.length + r.library.length + r.pages.length
  return (
    <Modal title="搜索项目、文件、备注、待办" onClose={onClose} width={640}>
      <input autoFocus className="input search-input" placeholder="输入关键词…" value={q} onChange={(e) => setQ(e.target.value)} />
      {q && total === 0 && <div className="empty">没有找到相关内容</div>}
      {r.projects.length > 0 && <div className="sr-group">项目</div>}
      {r.projects.map((p: any) => (
        <button key={p.id} className="sr-item" onClick={() => pick({ page: 'project', projectId: p.id })}>
          {p.name}
          <span className="faint">{[p.code, p.client].filter(Boolean).join(' · ')}</span>
        </button>
      ))}
      {r.files.length > 0 && <div className="sr-group">文件</div>}
      {r.files.map((f: any) => (
        <button key={f.projectId + f.rel} className="sr-item" onClick={() => pick({ page: 'project', projectId: f.projectId, select: f.rel })}>
          {f.dir ? '📁 ' : ''}
          {f.name}
          <span className="faint">
            {f.projectName} / {f.rel}
          </span>
        </button>
      ))}
      {r.notes.length > 0 && <div className="sr-group">备注</div>}
      {r.notes.map((n: any) => (
        <button key={n.projectId + n.rel} className="sr-item" onClick={() => pick({ page: 'project', projectId: n.projectId, select: n.rel })}>
          {n.note.slice(0, 60)}
          <span className="faint">
            {n.projectName} / {n.rel || '项目'}
          </span>
        </button>
      ))}
      {r.pages.length > 0 && <div className="sr-group">备忘录</div>}
      {r.pages.map((p: any) => (
        <button key={p.id} className="sr-item" onClick={() => pick({ page: 'kb', pageId: p.id })}>
          {p.title || '无标题'}
          <span className="faint">{p.snippet}</span>
        </button>
      ))}
      {r.library.length > 0 && <div className="sr-group">资料库</div>}
      {r.library.map((x: any) => (
        <button key={x.id} className="sr-item" onClick={() => pick({ page: 'library', libraryId: x.id })}>
          {x.code ? x.code + ' ' : ''}
          {x.name}
          <span className="faint">{x.status === '已废止' ? '已废止' : ''}</span>
        </button>
      ))}
      {r.contacts.length > 0 && <div className="sr-group">联系人</div>}
      {r.contacts.map((c: any) => (
        <button key={c.id} className="sr-item" onClick={() => pick({ page: 'contacts', contactId: c.id })}>
          {c.name}
          <span className="faint">{[c.org, c.phone].filter(Boolean).join(' · ')}</span>
        </button>
      ))}
      {r.reviews.length > 0 && <div className="sr-group">审查记录</div>}
      {r.reviews.map((x: any) => (
        <button key={x.id} className="sr-item" onClick={() => pick({ page: 'project', projectId: x.projectId, tab: 'detail' })}>
          {x.type} {x.date}
          <span className="faint">{data.projects.find((p) => p.id === x.projectId)?.name}</span>
        </button>
      ))}
      {r.todos.length > 0 && <div className="sr-group">待办</div>}
      {r.todos.map((t: any) => (
        <button key={t.id} className="sr-item" onClick={() => pick({ page: 'todos' })}>
          {t.title}
          <span className="faint">{t.due || '未安排'}</span>
        </button>
      ))}
    </Modal>
  )
}
