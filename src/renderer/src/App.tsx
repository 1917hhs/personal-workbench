import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, AppCtx, AppData, Ctx, errMsg, flushers, Nav, stageOf, useApp as useAppCtx, ymd } from './lib'
import { AskHost, Modal } from './ui'
import Home from './pages/Home'
import Projects from './pages/Projects'
import ProjectView from './pages/ProjectView'
import Todos from './pages/Todos'
import Settings from './pages/Settings'
import Contacts from './pages/Contacts'
import Library from './pages/Library'
import Knowledge from './pages/Knowledge'
import Flows from './pages/Flows'
import MapPage from './pages/MapPage'
import { FocusWidget } from './pages/Focus'
import Inquiries from './pages/Inquiries'
import { Icon } from './icons'

const PAGE_NAMES: Record<Nav['page'], string> = {
  home: '工作台',
  projects: '项目',
  project: '项目',
  todos: '待办',
  contacts: '供应商与联系人',
  library: '资料库',
  kb: '备忘录',
  map: '地图',
  flows: '流程',
  inquiries: '询价',
  settings: '设置'
}
/** 「返回」按钮上显示的去处：页面名，能找到具体那条就带上名字 */
function navLabel(n: Nav, d: AppData) {
  const nm = (list: any[] | undefined, id?: string) => (id ? list?.find((x) => x.id === id)?.name : '') || ''
  const detail =
    n.page === 'inquiries'
      ? nm(d.inquiries, n.inquiryId)
      : n.page === 'project'
        ? nm(d.projects, n.projectId)
        : n.page === 'contacts'
          ? nm(d.companies, n.companyId) || nm(d.contacts, n.contactId)
          : n.page === 'flows'
            ? nm(d.flows, n.flowId)
            : ''
  return detail ? `${PAGE_NAMES[n.page]} · ${detail}` : PAGE_NAMES[n.page]
}

export default function App() {
  const [data, setDataState] = useState<AppData | null>(null)
  const [nav, setNav] = useState<Nav>({ page: 'home' })
  const [toastMsg, setToastMsg] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const toastTimer = useRef<any>(null)

  useEffect(() => {
    api.call('app:init').then((d: AppData) => {
      setDataState(d)
      // 数据文件损坏：已经另存了一份，提醒用户去「数据」文件夹里找
      if (d.loadProblems?.length) setTimeout(() => alert('读取数据时发现问题：\n\n' + d.loadProblems.join('\n') + `\n\n损坏的文件在：${d.dataDir}\n可以用网盘里的历史版本替换后重启软件。`), 300)
    })
  }, [])

  // AI 助手通过 MCP 改了数据：刷新界面并提示
  useEffect(() => {
    const off1 = api.on('data:changed', () => api.call('app:init').then(setDataState))
    // 关窗口前：让正在编辑的输入框失去焦点（触发它的自动保存），再把编辑器里没到时间的内容存掉
    const off3 = api.on('app:before-close', async () => {
      try {
        ;(document.activeElement as HTMLElement | null)?.blur?.()
        await new Promise((r) => setTimeout(r, 50))
        await Promise.all([...flushers].map((f) => Promise.resolve(f()).catch(() => {})))
        await new Promise((r) => setTimeout(r, 150)) // 失去焦点触发的保存还在路上
      } finally {
        api.send('app:flushed')
      }
    })
    const off2 = api.on('ai:action', (a: any) => {
      setToastMsg('AI 助手：' + a.summary + (a.canUndo ? '（可在 设置 → 智能体 里撤销）' : ''))
      clearTimeout(toastTimer.current)
      toastTimer.current = setTimeout(() => setToastMsg(''), 6000)
    })
    return () => {
      off1()
      off2()
      off3()
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

  const [toastAct, setToastAct] = useState<{ label: string; run: () => void } | null>(null)
  const toast = useCallback((m: string, action?: { label: string; run: () => void }) => {
    setToastMsg(m)
    setToastAct(action || null)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => (setToastMsg(''), setToastAct(null)), action ? 6000 : 3200)
  }, [])

  // 没被单独处理的操作失败（比如打开的文件已被改名）：用提示条告诉用户，而不是什么都不发生
  useEffect(() => {
    const f = (e: PromiseRejectionEvent) => {
      const m = errMsg(e.reason)
      if (m && !/已取消|AbortError/.test(m)) toast(m)
    }
    window.addEventListener('unhandledrejection', f)
    return () => window.removeEventListener('unhandledrejection', f)
  }, [toast])

  const setData = useCallback((patch: Partial<AppData>) => setDataState((d) => ({ ...d!, ...patch })), [])

  // ---------- 导航历史：跳到别的页面后可以「返回」 ----------
  type Hist = { nav: Nav; scroll: [number, number][] }
  const [hist, setHist] = useState<Hist[]>([])
  const navRef = useRef(nav)
  navRef.current = nav
  const extra = useRef<Partial<Nav>>({}) // 当前页面里选中的那条（询价、单位…）
  const mainRef = useRef<HTMLElement>(null)
  const remember = useCallback((patch: Partial<Nav>) => {
    extra.current = { ...extra.current, ...patch }
  }, [])
  // 记下页面里各个滚动区域的位置（按元素顺序），返回时恢复
  const grabScroll = (): [number, number][] => {
    const out: [number, number][] = []
    mainRef.current?.querySelectorAll('*').forEach((el, i) => {
      if (el.scrollTop > 0) out.push([i, el.scrollTop])
    })
    return out
  }
  const go = useCallback((n: Nav) => {
    const cur = { ...navRef.current, ...extra.current }
    const clean = (x: any) => JSON.stringify(Object.fromEntries(Object.entries(x).filter(([, v]) => v != null && v !== '')))
    if (clean(cur) !== clean(n)) setHist((h) => [...h.slice(-29), { nav: cur, scroll: grabScroll() }])
    extra.current = {}
    setNav(n)
  }, [])
  const histRef = useRef(hist)
  histRef.current = hist
  const back = useCallback(() => {
    const h = histRef.current
    const last = h[h.length - 1]
    if (!last) return
    histRef.current = h.slice(0, -1)
    setHist(histRef.current)
    extra.current = {}
    setNav(last.nav)
    const restore = () => {
      const all = mainRef.current?.querySelectorAll('*')
      if (all) for (const [i, top] of last.scroll) if (all[i]) all[i].scrollTop = top
    }
    setTimeout(restore, 30)
    setTimeout(restore, 250) // 内容晚一点才撑开的区域再设一次
  }, [])
  // 鼠标侧键「后退」、Alt+←
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault()
        back()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        back()
      }
    }
    window.addEventListener('mouseup', onMouse)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mouseup', onMouse)
      window.removeEventListener('keydown', onKey)
    }
  }, [back])

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
      go,
      back,
      remember,
      toast,
      saveProject: (p) => wrap(async () => setData({ projects: await api.call('projects:save', p) })),
      saveTodo: (t) => wrap(async () => setData({ todos: await api.call('todos:save', t) })),
      deleteTodo: (id) =>
        wrap(async () => {
          const old = data.todos.find((t) => t.id === id)
          setData({ todos: await api.call('todos:delete', id) })
          if (old) toast(`已删除待办「${old.title}」`, { label: '撤销', run: async () => setData({ todos: await api.call('todos:save', old) }) })
        }),
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
    }
  }, [data, nav, setData, toast, go, back, remember])

  if (!ctx) return <div className="empty">正在加载…</div>

  const { projects, todos, settings } = ctx.data
  const today = ymd()
  const todoCount = todos.filter((t) => !t.done && t.due && t.due <= today).length
  const starred = projects.filter((p) => p.starred)
  const stars = ctx.data.stars || []
  const starInq = ctx.data.inquiries.filter((x) => x.starred)
  const unstar = async (s: { projectId: string; rel: string }) => {
    await api.call('project:meta', s.projectId, s.rel, { starred: null })
    setData({ stars: await api.call('stars:list') })
  }

  const navBtn = (page: Nav['page'], label: string, count?: number) => (
    <button className={'nav side-nav' + (nav.page === page || (page === 'projects' && nav.page === 'project') ? ' on' : '')} onClick={() => go({ page })}>
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
          {hist.length > 0 && (
            <button className="back-btn" onClick={back} title="返回上一个页面（Alt+← 或鼠标侧键）">
              <span>←</span>
              <span className="back-label">返回 {navLabel(hist[hist.length - 1].nav, ctx.data)}</span>
            </button>
          )}
          {navBtn('home', '工作台')}
          {navBtn('projects', '项目', projects.length)}
          {navBtn('todos', '待办', todoCount)}
          {navBtn('kb', '备忘录')}
          {navBtn('library', '资料库', ctx.data.library.length)}
          {navBtn('contacts', '供应商与联系人', ctx.data.contacts.length)}
          {navBtn('inquiries', '询价', ctx.data.inquiries.filter((x) => ['编制中', '询价中', '比价中'].includes(x.status)).length)}
          {navBtn('map', '地图')}
          {navBtn('flows', '流程', ctx.data.flows?.length)}
          {navBtn('settings', '设置')}
          {starred.length > 0 && <div className="side-sub">星标项目</div>}
          {starred.map((p) => (
            <button key={p.id} className="side-proj" onClick={() => go({ page: 'project', projectId: p.id })}>
              <span className="stage-dot" style={{ background: stageOf(settings, p.stage).color }} />
              {p.name}
            </button>
          ))}
          {stars.length > 0 && <div className="side-sub">星标文件</div>}
          {stars.map((s) => (
            <div key={s.projectId + s.rel} className={'side-proj side-star' + (s.exists ? '' : ' missing')} title={s.projectName + ' / ' + s.rel + (s.exists ? '' : '\n（找不到了：可能被删除或在软件外改了名）')}>
              <button className="side-star-main" onClick={() => go({ page: 'project', projectId: s.projectId, select: s.rel })}>
                <span className="side-star-ico">{s.dir ? '📁' : '📄'}</span>
                <span className="side-star-text">
                  <span className="side-star-name">{s.name}</span>
                  <span className="side-star-sub">{s.projectName}</span>
                </span>
              </button>
              <button className="side-star-x" title="取消星标" onClick={() => unstar(s)}>×</button>
            </div>
          ))}
          {starInq.length > 0 && <div className="side-sub">星标询价</div>}
          {starInq.map((x) => (
            <div key={x.id} className="side-proj side-star" title={(projects.find((p) => p.id === x.projectId)?.name || '未关联项目') + ' · ' + x.status}>
              <button className="side-star-main" onClick={() => go({ page: 'inquiries', inquiryId: x.id })}>
                <span className="side-star-ico">
                  <Icon name="inquiries" size={13} />
                </span>
                <span className="side-star-text">
                  <span className="side-star-name">{x.name}</span>
                  <span className="side-star-sub">
                    {projects.find((p) => p.id === x.projectId)?.name || '未关联项目'} · {x.status}
                  </span>
                </span>
              </button>
              <button className="side-star-x" title="取消星标" onClick={() => ctx.saveItem('inquiries', { id: x.id, starred: false })}>×</button>
            </div>
          ))}
          <div style={{ marginTop: 'auto' }} />
          <FocusWidget />
          <div className="side-foot" style={{ marginTop: 8 }}>
            v{ctx.data.version}
          </div>
        </aside>
        <main className="main" ref={mainRef}>
          {nav.page === 'home' && <Home />}
          {nav.page === 'projects' && <Projects />}
          {nav.page === 'project' && nav.projectId && <ProjectView key={nav.projectId + (nav.tab || '') + (nav.select || '')} id={nav.projectId} select={nav.select} tab={nav.tab} />}
          {nav.page === 'todos' && <Todos />}
          {nav.page === 'contacts' && <Contacts key={(nav.contactId || '') + (nav.companyId || '')} focusId={nav.contactId} companyId={nav.companyId} />}
          {nav.page === 'library' && <Library key={nav.libraryId || ''} focusId={nav.libraryId} />}
          {nav.page === 'kb' && <Knowledge key={nav.pageId || ''} pageId={nav.pageId} />}
          {nav.page === 'flows' && <Flows key={nav.flowId || ''} focusId={nav.flowId} />}
          {nav.page === 'map' && <MapPage key={nav.projectId || ''} focusId={nav.projectId} />}
          {nav.page === 'inquiries' && <Inquiries key={nav.inquiryId || ''} focusId={nav.inquiryId} />}
          {nav.page === 'settings' && <Settings key={nav.settingsSection || ''} section={nav.settingsSection} />}
        </main>
      </div>
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
      <AskHost />
      {toastMsg && (
        <div className="toast">
          {toastMsg}
          {toastAct && (
            <button
              className="toast-act"
              onClick={() => {
                toastAct.run()
                setToastMsg('')
                setToastAct(null)
              }}
            >
              {toastAct.label}
            </button>
          )}
        </div>
      )}
    </AppCtx.Provider>
  )
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const { go } = useAppCtx()
  const [q, setQ] = useState('')
  const [r, setR] = useState<any>({ projects: [], todos: [], files: [], notes: [], contacts: [], library: [], pages: [], flows: [] })
  const { data } = useAppCtx()
  useEffect(() => {
    const t = setTimeout(() => api.call('search', q).then(setR), 120)
    return () => clearTimeout(t)
  }, [q])
  const pick = (n: Nav) => {
    go(n)
    onClose()
  }
  const total = r.projects.length + r.todos.length + r.files.length + r.notes.length + r.contacts.length + r.library.length + r.pages.length + (r.flows?.length || 0)
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
      {r.flows?.length > 0 && <div className="sr-group">工作流程</div>}
      {(r.flows || []).map((x: any) => (
        <button key={x.id} className="sr-item" onClick={() => pick({ page: 'flows', flowId: x.id })}>
          {x.name}
          <span className="faint">{x.snippet}</span>
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
