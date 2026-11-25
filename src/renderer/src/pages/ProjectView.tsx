import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, CATS, catOf, clip, errMsg, extOf, fmtSize, fmtTime, joinPath, normPath, stageOf, useApp, refWarn, leadsOf } from '../lib'
import { ask, ContextMenu, Empty, MenuItem, Tabs } from '../ui'
import { groupVersions, injectRefs } from '../versions'
import MindMap, { FileBadge, TNode } from './MindMap'
import ProjectDialog from './ProjectDialog'
import ProjectDetail from './ProjectDetail'

function findNode(n: TNode, rel: string): TNode | null {
  if (n.rel === rel) return n
  for (const c of n.children || []) {
    const r = findNode(c, rel)
    if (r) return r
  }
  return null
}

/** 按类型筛选：只留下该类型的文件，以及包含它们的文件夹 */
function filterTree(n: TNode, cat: string | null): TNode | null {
  if (!cat) return n
  if (!n.dir) return catOf(n.name)?.id === cat ? n : null
  const children = (n.children || []).map((c) => filterTree(c, cat)).filter(Boolean) as TNode[]
  if (!children.length && n.rel) return null
  return { ...n, children }
}

function ancestors(rel: string) {
  const parts = rel.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

export default function ProjectView({ id, select, tab: initialTab }: { id: string; select?: string; tab?: 'map' | 'detail' }) {
  const { data, saveProject, go, toast, setData } = useApp()
  const [tab, setTab] = useState<'map' | 'detail'>(initialTab || 'map')
  const { settings } = data
  const project = data.projects.find((p) => p.id === id)
  const [res, setRes] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [showHidden, setShowHidden] = useState(false)
  const [cat, setCat] = useState<string | null>(null)
  const [focus, setFocus] = useState<string>('')
  const [selected, setSelected] = useState<string | null>(select ?? null)
  const [forceExpand, setForceExpand] = useState<Set<string>>(new Set(select ? ancestors(select) : []))
  const [centerOn, setCenterOn] = useState<string | null>(select ?? null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; k?: number } | null>(null)
  const [editing, setEditing] = useState(false)

  const load = useCallback(async () => {
    if (!project?.rootPath) {
      setLoading(false)
      return
    }
    try {
      setRes(await api.call('project:tree', id, showHidden))
    } catch (e) {
      toast(errMsg(e))
    }
    setLoading(false)
  }, [id, showHidden, project?.rootPath])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!project?.rootPath) return
    api.call('project:watch', id).catch(() => {})
    const off = api.on('project:changed', (pid: string) => pid === id && load())
    return () => {
      off()
      api.call('project:watch', null)
    }
  }, [id, project?.rootPath, load])

  const meta = res?.meta?.nodes || {}
  const setMeta = async (rel: string, patch: any) => {
    const m = await api.call('project:meta', id, rel, patch)
    setRes((r: any) => ({ ...r, meta: m }))
  }

  // 每个文件被本项目引用了几次（显示「+N 引用」）
  const refCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of res?.refs || []) m.set(normPath(r.path), (m.get(normPath(r.path)) || 0) + 1)
    return m
  }, [res])
  const refCount = (rel: string) => (res?.root ? refCounts.get(normPath(joinPath(res.root, rel))) || 0 : 0)

  const addRefs = async (parentRel: string, paths: string[]) => {
    const m = await api.call('project:addRefs', id, parentRel, paths)
    setRes((r: any) => ({ ...r, meta: m }))
    await load()
  }

  const removeRef = async (n: TNode) => {
    await api.call('project:removeRef', id, n.refId)
    await load()
    setSelected(null)
    toast('已移除引用，原文件没有变化')
  }

  // 引用所指的文件在本项目里时，跳到原文件节点
  const locateSource = (abs: string) => {
    if (!res?.root) return
    const base = normPath(res.root) + '\\'
    const n = normPath(abs)
    if (!n.startsWith(base)) return toast('原文件不在这个项目里：' + abs)
    const rel = abs.replace(/\//g, '\\').slice(base.length).replace(/\\/g, '/')
    setForceExpand((s) => new Set([...s, ...ancestors(rel)]))
    setSelected(rel)
    setCenterOn(rel)
  }

  const absOf = (n: TNode) => (n.virtual === 'ref' ? n.refPath! : joinPath(res.root, n.rel))

  const run = async (fn: () => Promise<any>, ok?: string) => {
    try {
      await fn()
      if (ok) toast(ok)
      await load()
    } catch (e) {
      toast(errMsg(e))
    }
  }

  const newFolder = async (rel: string) => {
    const name = await ask('新建文件夹', '', '文件夹名称')
    if (!name) return
    await run(async () => {
      const newRel = await api.call('fs:mkdir', id, rel, name)
      if (rel) await setMeta(rel, { collapsed: false })
      setSelected(newRel)
    })
  }

  const rename = async (n: TNode) => {
    const name = await ask('重命名', n.name)
    if (!name || name === n.name) return
    await run(async () => setSelected(await api.call('fs:rename', id, n.rel, name)))
  }

  const trash = async (n: TNode) => {
    if (!n.rel) return
    const refs: any[] = await api.call('memo:findRefs', { kind: 'proj', pid: id, rel: n.rel }).catch(() => [])
    if (!confirm(`把「${n.name}」移到系统回收站？\n可以在回收站里还原。${refWarn(refs)}`)) return
    await run(() => api.call('fs:trash', id, n.rel), '已移到回收站')
    setSelected(null)
  }

  const editNote = async (n: TNode) => {
    const v = await ask(`备注：${n.rel ? n.name : project.name}`, meta[n.rel]?.note || '', '这份资料的来源、用途、注意事项…', true)
    if (v !== null) await setMeta(n.rel, { note: v || null })
  }

  const swatches = [...settings.colorLegend.map((c: any) => ({ color: c.color, label: c.label })), { color: null, label: '清除颜色' }]

  const tagMenu = (n: TNode): MenuItem[] => [
    meta[n.rel]?.tag === '定稿' ? { label: '取消定稿标记', onClick: () => setMeta(n.rel, { tag: null }) } : { label: '标记为定稿', onClick: () => setMeta(n.rel, { tag: '定稿' }) },
    {
      label: '设置标签…',
      onClick: async () => {
        const v = await ask('标签（如 汇报版、送审稿，留空清除）', meta[n.rel]?.tag || '')
        if (v !== null) setMeta(n.rel, { tag: v || null })
      }
    }
  ]

  // 收起 / 展开某文件夹下的所有子文件夹（它自己保持展开，能看到下一层）
  const foldAll = async (n: TNode, collapse: boolean) => {
    const list: { rel: string; patch: any }[] = [{ rel: n.rel, patch: { collapsed: false } }]
    const walk = (x: TNode) => {
      for (const c of x.children || []) {
        if (!c.dir || c.virtual) continue
        list.push({ rel: c.rel, patch: { collapsed: collapse } })
        walk(c)
      }
    }
    walk(n)
    try {
      const m = await api.call('project:metaMany', id, list)
      setRes((r: any) => ({ ...r, meta: m }))
    } catch (e) {
      toast(errMsg(e))
    }
  }

  // 按模板补齐目录：rel 为空补到项目根目录，否则补到这个子文件夹下
  const templateItems = (rel: string): MenuItem[] => {
    const where = rel ? `「${rel.split('/').pop()}」` : '项目根目录'
    return ((settings.templates || []) as any[]).map((t) => ({
      label: `${t.name}（${t.folders.length} 个文件夹）${!rel && t.id === project?.templateId ? ' · 本项目在用' : ''}`,
      onClick: () =>
        run(async () => {
          const r2 = await api.call('projects:applyTemplate', id, t.id, rel)
          setData({ projects: r2.projects })
          toast(r2.created ? `按「${r2.name}」在${where}新建了 ${r2.created} 个文件夹` : `${where}下「${r2.name}」的文件夹都已存在，没有新建`)
        })
    }))
  }

  const openMenu = (n: TNode, x: number, y: number) => {
    const items: MenuItem[] = []
    if (n.virtual === 'ref') {
      items.push(
        { label: '打开', disabled: !n.refExists, onClick: () => api.call('shell:openPath', n.refPath) },
        { label: '在资源管理器中显示', disabled: !n.refExists, onClick: () => api.call('shell:reveal', n.refPath) },
        { label: '定位到原文件', onClick: () => locateSource(n.refPath!) },
        { label: '复制路径', onClick: () => api.call('clipboard:text', n.refPath).then(() => toast('路径已复制')) },
        'sep',
        { label: '移除引用（原文件不动）', danger: true, onClick: () => removeRef(n) }
      )
      return setMenu({ x, y, items })
    }
    if (n.virtual === 'versions') {
      items.push({ label: '展开 / 收起各版本', onClick: () => setMeta(n.rel, { collapsed: !(meta[n.rel]?.collapsed === false) ? false : true }) })
      items.push({ label: '打开最新版', onClick: () => api.call('fs:open', id, n.children![n.children!.length - 1].rel) })
      return setMenu({ x, y, items })
    }
    const inGroup = !n.dir && !!n.version
    if (n.dir) {
      items.push({ label: '新建子文件夹', onClick: () => newFolder(n.rel) })
      if (n.rel) items.push({ label: '聚焦此分支', onClick: () => setFocus(n.rel) })
      const subDirs = (n.children || []).some((c) => c.dir && !c.virtual)
      if (subDirs) {
        items.push(
          { label: '收起所有子文件夹', onClick: () => foldAll(n, true) },
          { label: '展开所有子文件夹', onClick: () => foldAll(n, false) }
        )
      }
      if ((settings.templates || []).length) {
        items.push({ label: '按模板补齐目录 ▸', onClick: () => setMenu({ x, y, k: Date.now(), items: [{ label: n.rel ? `补到「${n.rel.split('/').pop()}」下` : '补到项目根目录', disabled: true }, ...templateItems(n.rel)] }) })
      }
    } else {
      items.push({ label: '打开', onClick: () => api.call('fs:open', id, n.rel) })
    }
    items.push(
      { label: '在资源管理器中显示', onClick: () => api.call('fs:reveal', id, n.rel) },
      { label: '复制路径', onClick: () => api.call('fs:copyPath', id, n.rel).then(() => toast('路径已复制')) }
    )
    if (n.rel) {
      items.push({
        label: '复制为引用',
        onClick: () => {
          clip.ref = joinPath(res.root, n.rel)
          toast('已复制。在要挂过去的文件夹上右键「粘贴引用」')
        }
      })
    }
    if (n.dir && clip.ref) {
      const src = clip.ref
      items.push({ label: `粘贴引用：${src.split(/[\\/]/).pop()}`, onClick: () => addRefs(n.rel, [src]) })
    }
    items.push('sep', { label: meta[n.rel]?.note ? '编辑备注' : '添加备注', onClick: () => editNote(n) }, { swatches, onPick: (c) => setMeta(n.rel, { color: c }) })
    if (!n.dir) items.push(...tagMenu(n))
    if (inGroup) items.push({ label: '移出版本组', onClick: () => setMeta(n.rel, { noGroup: true }) })
    else if (!n.dir && meta[n.rel]?.noGroup) items.push({ label: '重新参与版本归组', onClick: () => setMeta(n.rel, { noGroup: null }) })
    if (n.rel) {
      items.push(
        { label: '重命名', onClick: () => rename(n) },
        meta[n.rel]?.hidden
          ? { label: '取消隐藏', onClick: () => run(() => setMeta(n.rel, { hidden: null })) }
          : { label: '隐藏（不删除）', onClick: () => run(() => setMeta(n.rel, { hidden: true })) },
        'sep',
        { label: '移到回收站', danger: true, onClick: () => trash(n) }
      )
    }
    setMenu({ x, y, items })
  }

  // 磁盘目录树 → 挂上引用 → 版本归组 → 聚焦 → 类型筛选
  const full: TNode | null = useMemo(() => {
    if (!res?.tree) return null
    const withRefs = injectRefs(res.tree, res.refs)
    return settings.autoGroupVersions === false ? withRefs : groupVersions(withRefs, meta)
  }, [res, settings.autoGroupVersions])

  const tree: TNode | null = useMemo(() => {
    if (!full) return null
    const base = focus ? findNode(full, focus) || full : full
    return filterTree(base, cat)
  }, [full, focus, cat])

  const selNode = full && selected !== null ? findNode(full, selected) : null

  const onKey = (e: React.KeyboardEvent) => {
    // 在输入框里打字时（备注、搜索）按 Delete / Enter / Tab 不能当成对文件的操作
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return
    if (!selNode || selNode.virtual) return
    if (e.key === 'Delete') trash(selNode)
    else if (e.key === 'F2' && selNode.rel) rename(selNode)
    else if (e.key === 'Tab' && selNode.dir) {
      e.preventDefault()
      newFolder(selNode.rel)
    } else if (e.key === 'Enter') selNode.dir ? setMeta(selNode.rel, { collapsed: !(meta[selNode.rel]?.collapsed === true) ? true : false }) : api.call('fs:open', id, selNode.rel)
  }

  if (!project) return <Empty title="项目不存在或已移除" />

  const stage = stageOf(settings, project.stage)

  const linkFolder = async () => {
    const dir = await api.call('dialog:pickFolder', '选择项目文件夹')
    if (dir) await saveProject({ ...project, rootPath: dir })
  }

  const removeProject = async () => {
    if (!confirm(`从列表中移除「${project.name}」？\n只删除项目记录，不会删除磁盘上的任何文件。`)) return
    setData(await api.call('projects:delete', id))
    go({ page: 'projects' })
  }

  return (
    <>
      <div className="topbar proj-head">
        <button className="icon-btn" title="返回项目列表" onClick={() => go({ page: 'projects' })}>←</button>
        <h1>{project.name}</h1>
        <button className={'star' + (project.starred ? ' on' : '')} title="星标" onClick={() => saveProject({ ...project, starred: !project.starred })}>★</button>
        <select className="input" style={{ width: 'auto', borderColor: stage.color }} value={project.stage} onChange={(e) => saveProject({ ...project, stage: e.target.value })}>
          {settings.stages.map((s: any) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select className="input" style={{ width: 'auto' }} value={project.status} onChange={(e) => saveProject({ ...project, status: e.target.value })}>
          {settings.statuses.map((s: string) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        {project.deadline && <span className="chip">截止 {project.deadline}</span>}
        {leadsOf(project).map((l, i) => (
          <span key={i} className="chip">{l.role || '负责人'} {l.name}</span>
        ))}
        <span className="spacer" />
        <Tabs value={tab} onChange={setTab} options={[{ id: 'map', label: '导图' }, { id: 'detail', label: '详情' }]} />
        <button className="btn" onClick={() => setEditing(true)}>编辑信息</button>
        {project.rootPath && <button className="btn" onClick={() => api.call('shell:openPath', project.rootPath)}>打开文件夹</button>}
        <button className="btn danger" onClick={removeProject}>移除</button>
      </div>

      {tab === 'detail' ? (
        <ProjectDetail project={project} />
      ) : !project.rootPath ? (
        <Empty title="这个项目还没有关联文件夹" text="关联后，项目文件夹会以思维导图的方式展开。">
          <button className="btn primary" onClick={linkFolder}>关联文件夹…</button>
        </Empty>
      ) : loading ? (
        <Empty title="正在读取项目文件夹…" />
      ) : res && !res.exists ? (
        <Empty title="找不到项目文件夹" text={res.root + '\n可能被移动、改名，或所在的盘没有接上。'}>
          <button className="btn primary" onClick={linkFolder}>重新指定文件夹…</button>
        </Empty>
      ) : (
        tree && (
          <>
            <div className="map-tools">
              <button className={'btn small' + (!cat ? ' primary' : '')} onClick={() => setCat(null)}>全部</button>
              {CATS.map((c) => (
                <button key={c.id} className={'btn small' + (cat === c.id ? ' primary' : '')} onClick={() => setCat(cat === c.id ? null : c.id)}>
                  {c.name}
                </button>
              ))}
              <span className="faint">|</span>
              <label className="row faint" style={{ gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
                显示隐藏文件{res.hiddenTotal ? `（${res.hiddenTotal}）` : ''}
              </label>
              {focus && (
                <span className="chip">
                  聚焦：{focus}
                  <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => setFocus('')}>×</button>
                </span>
              )}
              {res.truncated && <span className="tag amber">文件太多，只显示了前 30000 项</span>}
              <span className="spacer" style={{ flex: 1 }} />
              <button
                className="btn small"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  // 选中了子文件夹就补到它下面，否则补到项目根目录
                  const targetRel = selNode && selNode.dir && !selNode.virtual && selNode.rel ? selNode.rel : ''
                  setMenu({
                    x: r.left,
                    y: r.bottom + 4,
                    items: [
                      { label: targetRel ? `补到「${targetRel.split('/').pop()}」下` : '补到项目根目录（先选中子文件夹可补到它下面）', disabled: true },
                      ...templateItems(targetRel)
                    ]
                  })
                }}
              >
                按模板补齐目录 ▾
              </button>
              <button className="btn small" onClick={load}>刷新</button>
            </div>
            <div className="map-wrap">
              <MindMap
                projectId={id}
                rootName={focus ? focus.split('/').pop()! : project.name}
                tree={tree}
                meta={meta}
                refCount={refCount}
                selected={selected}
                forceExpand={forceExpand}
                expandAll={!!cat}
                centerOn={centerOn}
                onCentered={() => setCenterOn(null)}
                onSelect={setSelected}
                onToggle={(rel, expanded) => {
                  if (expanded && forceExpand.has(rel)) setForceExpand((s) => new Set([...s].filter((x) => x !== rel)))
                  setMeta(rel, { collapsed: expanded })
                }}
                onOpen={(n) => (n.virtual === 'ref' ? api.call('shell:openPath', n.refPath) : api.call('fs:open', id, n.rel))}
                onContext={openMenu}
                onNewFolder={newFolder}
                onDropFiles={(dest, paths) => run(() => api.call('fs:import', id, dest, paths))}
                onKey={onKey}
              />
              {selNode && (
                <DetailPanel
                  projectId={id}
                  project={project}
                  node={selNode}
                  abs={absOf(selNode)}
                  refs={refCount(selNode.rel)}
                  meta={meta[selNode.rel] || {}}
                  allMeta={meta}
                  setMeta={setMeta}
                  onRename={rename}
                  onEditProject={() => setEditing(true)}
                  onSelect={setSelected}
                  onLocate={locateSource}
                  onRemoveRef={removeRef}
                  onFold={foldAll}
                  swatches={swatches}
                />
              )}
            </div>
          </>
        )
      )}
      {menu && <ContextMenu key={menu.k || 0} x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {editing && <ProjectDialog project={project} onClose={() => setEditing(false)} />}
    </>
  )
}

function DetailPanel(props: {
  projectId: string
  project: any
  node: TNode
  abs: string
  refs: number
  meta: any
  allMeta: Record<string, any>
  setMeta: (rel: string, p: any) => Promise<void>
  onRename: (n: TNode) => void
  onEditProject: () => void
  onSelect: (rel: string) => void
  onLocate: (abs: string) => void
  onRemoveRef: (n: TNode) => void
  onFold: (n: TNode, collapse: boolean) => void
  swatches: any[]
}) {
  // 不同类型的节点用不同的面板组件，避免同一组件里条件调用 Hook
  if (props.node.virtual === 'versions') return <VersionPanel {...props} />
  if (props.node.virtual === 'ref') return <RefPanel {...props} />
  return <FilePanel {...props} />
}

function FilePanel(props: any) {
  const { node: n, projectId: id, project } = props as { node: TNode; projectId: string; project: any }
  const [note, setNote] = useState(props.meta.note || '')
  const [preview, setPreview] = useState<any>(null)
  const { toast } = useApp()

  useEffect(() => setNote(props.meta.note || ''), [n.rel, props.meta.note])

  useEffect(() => {
    setPreview(null)
    if (n.dir) return
    let alive = true
    setPreview({ kind: 'loading' })
    api
      .call('preview', id, n.rel)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setPreview({ kind: 'error', error: errMsg(e) }))
    return () => {
      alive = false
    }
  }, [id, n.rel, n.mtime])

  const isRoot = !n.rel
  const ext = extOf(n.name)

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="row">
          {!n.dir && <FileBadge name={n.name} />}
          <div className="panel-title">{isRoot ? project.name : n.name}</div>
        </div>
      </div>
      <div className="panel-body">
        <div className="kv">
          <span className="k">位置</span>
          <span className="v">{n.rel || project.rootPath}</span>
          {n.dir ? (
            <>
              <span className="k">文件数</span>
              <span className="v">{n.fileCount}</span>
            </>
          ) : (
            <>
              <span className="k">大小</span>
              <span className="v">{fmtSize(n.size)}</span>
            </>
          )}
          <span className="k">修改时间</span>
          <span className="v">{fmtTime(n.mtime)}</span>
          {props.meta.tag && (
            <>
              <span className="k">标签</span>
              <span className="v">{props.meta.tag}</span>
            </>
          )}
          {n.version && (
            <>
              <span className="k">版本</span>
              <span className="v">v{n.version}</span>
            </>
          )}
          {props.refs > 0 && (
            <>
              <span className="k">被引用</span>
              <span className="v">{props.refs} 处</span>
            </>
          )}
          {isRoot && (
            <>
              <span className="k">委托单位</span>
              <span className="v">{project.client || '—'}</span>
              <span className="k">项目编号</span>
              <span className="v">{project.code || '—'}</span>
              <span className="k">地点</span>
              <span className="v">{project.location || '—'}</span>
              <span className="k">参与人</span>
              <span className="v">{project.members?.join('、') || '—'}</span>
            </>
          )}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {!n.dir && <button className="btn small primary" onClick={() => api.call('fs:open', id, n.rel)}>打开</button>}
          <button className="btn small" onClick={() => api.call('fs:reveal', id, n.rel)}>在资源管理器中显示</button>
          <button className="btn small" onClick={() => api.call('fs:copyPath', id, n.rel).then(() => toast('路径已复制'))}>复制路径</button>
          {!isRoot && <button className="btn small" onClick={() => props.onRename(n)}>重命名</button>}
          {isRoot && <button className="btn small" onClick={props.onEditProject}>编辑项目信息</button>}
          {n.dir && (n.children || []).some((c) => c.dir && !c.virtual) && (
            <>
              <button className="btn small" title="这个文件夹下的子文件夹全部收起，只看下一层" onClick={() => props.onFold(n, true)}>收起子文件夹</button>
              <button className="btn small" onClick={() => props.onFold(n, false)}>全部展开</button>
            </>
          )}
        </div>
        <div>
          <div className="faint" style={{ marginBottom: 4 }}>颜色</div>
          <div className="row" style={{ gap: 6 }}>
            {props.swatches.map((s) => (
              <button
                key={s.label}
                title={s.label}
                className="swatch"
                style={{ background: s.color || 'transparent', outline: props.meta.color === s.color && s.color ? '2px solid var(--accent)' : undefined }}
                onClick={() => props.setMeta(n.rel, { color: s.color })}
              >
                {s.color ? '' : '×'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="faint" style={{ marginBottom: 4 }}>备注（离开输入框自动保存）</div>
          <textarea
            className="input"
            rows={3}
            placeholder="记下这份资料的来源、用途，例如：测绘院 3 月给的地形图，坐标系 CGCS2000"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note !== (props.meta.note || '') && props.setMeta(n.rel, { note: note.trim() || null })}
          />
        </div>
        {!n.dir && (
          <div>
            <div className="faint" style={{ marginBottom: 4 }}>预览</div>
            <Preview p={preview} ext={ext} />
          </div>
        )}
      </div>
    </div>
  )
}

function VersionPanel(props: any) {
  const n: TNode = props.node
  const versions = [...(n.children || [])].reverse()
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="row">
          <FileBadge name={n.name} stack />
          <div className="panel-title">{n.name}</div>
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
          版本组 · 共 {versions.length} 版，按修改时间排序。文件名去掉「最终版」「修改稿」「v2」、日期、括号说明后相同，就会归到一起。
        </div>
      </div>
      <div className="panel-body">
        {versions.map((v) => {
          const tag = props.allMeta[v.rel]?.tag
          return (
            <div key={v.rel} className="list-row click" onClick={() => props.onSelect(v.rel)}>
              <span className="ver">v{v.version}</span>
              <span className="grow">{v.name}</span>
              {tag && <span className={'tag' + (tag === '定稿' ? ' amber' : '')}>{tag}</span>}
              <span className="faint" style={{ fontSize: 11 }}>{fmtTime(v.mtime)}</span>
            </div>
          )
        })}
        <div className="faint" style={{ fontSize: 12 }}>点一个版本查看预览、打标签。归错了的文件可以右键「移出版本组」。</div>
      </div>
    </div>
  )
}

function RefPanel(props: any) {
  const n: TNode = props.node
  const [preview, setPreview] = useState<any>(null)
  useEffect(() => {
    setPreview(null)
    if (!n.refExists) return
    let alive = true
    setPreview({ kind: 'loading' })
    api
      .call('previewAbs', n.refPath)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setPreview({ kind: 'error', error: errMsg(e) }))
    return () => {
      alive = false
    }
  }, [n.refPath, n.mtime])
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="row">
          <FileBadge name={n.name} />
          <div className="panel-title">{n.name}</div>
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>引用：文件本身不在这里，只是在这个位置挂了一个入口，改原文件这里也能看到最新内容。</div>
      </div>
      <div className="panel-body">
        <div className="kv">
          <span className="k">原文件</span>
          <span className="v">{n.refPath}</span>
          <span className="k">状态</span>
          <span className="v" style={{ color: n.refExists ? undefined : 'var(--danger)' }}>{n.refExists ? '正常' : '原文件找不到（被移动、改名或删除）'}</span>
          {n.refExists && (
            <>
              <span className="k">大小</span>
              <span className="v">{fmtSize(n.size)}</span>
              <span className="k">修改时间</span>
              <span className="v">{fmtTime(n.mtime)}</span>
            </>
          )}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn small primary" disabled={!n.refExists} onClick={() => api.call('shell:openPath', n.refPath)}>打开</button>
          <button className="btn small" disabled={!n.refExists} onClick={() => api.call('shell:reveal', n.refPath)}>在资源管理器中显示</button>
          <button className="btn small" onClick={() => props.onLocate(n.refPath)}>定位到原文件</button>
          <button className="btn small danger" onClick={() => props.onRemoveRef(n)}>移除引用</button>
        </div>
        {n.refExists && (
          <div>
            <div className="faint" style={{ marginBottom: 4 }}>预览</div>
            <Preview p={preview} ext={extOf(n.name)} />
          </div>
        )}
      </div>
    </div>
  )
}

export function Preview({ p, ext }: { p: any; ext: string }) {
  if (!p || p.kind === 'loading') return <div className="faint">正在生成预览…</div>
  if (p.kind === 'error')
    return (
      <div className="faint" title={p.error}>
        无法预览：文件可能损坏，或不是标准格式。双击用默认程序打开。
      </div>
    )
  if (p.kind === 'image') return <div className="preview"><img src={p.url} /></div>
  if (p.kind === 'pdf') return <div className="preview"><iframe src={p.url} /></div>
  if (p.kind === 'video') return <div className="preview"><video src={p.url} controls /></div>
  if (p.kind === 'audio') return <audio src={p.url} controls style={{ width: '100%' }} />
  if (p.kind === 'text') return <div className="preview"><pre>{p.text}</pre></div>
  if (p.kind === 'html')
    return (
      <div className="preview">
        {p.note && <div className="faint" style={{ padding: '6px 10px' }}>{p.note}</div>}
        <div className="html" dangerouslySetInnerHTML={{ __html: p.html }} />
      </div>
    )
  if (['dwg', 'dxf', 'dwf'].includes(ext)) return <div className="faint">图纸文件不在软件内预览，双击用 CAD 打开。</div>
  return <div className="faint">这种格式暂不支持预览，双击用默认程序打开。</div>
}
