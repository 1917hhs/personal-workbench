import { useEffect, useMemo, useRef, useState } from 'react'
import { api, clip, errMsg, extOf, fmtSize, uid, useApp, refWarn } from '../lib'
import { ask, Empty } from '../ui'
import { FileBadge } from './MindMap'
import { Preview } from './ProjectView'

const STATUSES = ['现行', '待实施', '已废止']

export default function Library({ focusId }: { focusId?: string }) {
  const { data, setData, saveSettings, toast } = useApp()
  const { library, settings, projects } = data
  const types = settings.libraryTypes
  const [type, setType] = useState<string>('')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(focusId || null)
  const [dragging, setDragging] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const list = useMemo(() => {
    const has = (s: any) => String(s || '').toLowerCase().includes(q.trim().toLowerCase())
    return library
      .filter((x) => !type || x.type === type)
      .filter((x) => !q || has(x.name) || has(x.code) || has(x.note) || (x.tags || []).some(has))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }, [library, type, q])

  const cur = library.find((x) => x.id === sel)

  // 对照资料库文件夹：文件被删了的标红，在文件夹里挪动 / 改名的自动更新路径
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [untracked, setUntracked] = useState<string[]>([])
  const scan = async () => {
    const r = await api.call('library:scan')
    if (r.moved.length) setData({ library: r.library })
    setMissing(new Set(r.missing.map((x: any) => x.id)))
    setUntracked(r.untracked)
    return r
  }
  useEffect(() => {
    scan().catch(() => {})
    // 从资源管理器切回来时再查一次
    const f = () => scan().catch(() => {})
    window.addEventListener('focus', f)
    return () => window.removeEventListener('focus', f)
  }, [data.libraryDir])

  const refresh = async () => {
    try {
      const r = await scan()
      const done: string[] = []
      if (r.moved.length) done.push(`${r.moved.length} 份在文件夹里被挪动或改名，已更新位置`)
      let removeIds: string[] = []
      if (r.missing.length) {
        const refs = (await Promise.all(r.missing.map((x: any) => api.call('memo:findRefs', { kind: 'lib', id: x.id }).catch(() => [])))).flat()
        const names = r.missing.slice(0, 10).map((x: any) => `· ${x.code ? x.code + ' ' : ''}${x.name}`).join('\n') + (r.missing.length > 10 ? `\n…等 ${r.missing.length} 份` : '')
        if (confirm(`下面 ${r.missing.length} 份资料的文件已经不在资料库文件夹里了：\n${names}\n\n从资料库列表里移除它们？${refWarn(refs)}`)) removeIds = r.missing.map((x: any) => x.id)
      }
      let addRels: string[] = []
      if (r.untracked.length) {
        const names = r.untracked.slice(0, 10).map((x: string) => '· ' + x).join('\n') + (r.untracked.length > 10 ? `\n…等 ${r.untracked.length} 个` : '')
        if (confirm(`资料库文件夹里有 ${r.untracked.length} 个文件还没登记在资料库里：\n${names}\n\n把它们加进资料库？（按所在的子文件夹归类）`)) addRels = r.untracked
      }
      if (removeIds.length || addRels.length) {
        setData({ library: await api.call('library:applyScan', removeIds, addRels) })
        if (removeIds.length) done.push(`移除 ${removeIds.length} 份`)
        if (addRels.length) done.push(`新加入 ${addRels.length} 份`)
        if (removeIds.includes(sel || '')) setSel(null)
        await scan()
      }
      toast(done.length ? done.join('；') : r.missing.length || r.untracked.length ? '没有改动' : '资料库和文件夹一致，没有需要更新的')
    } catch (e) {
      toast(errMsg(e))
    }
  }

  const importPaths = async (paths: string[]) => {
    if (!paths.length) return
    try {
      setData({ library: await api.call('library:import', paths, type || types[0]?.id) })
      toast(`已导入 ${paths.length} 项`)
    } catch (e) {
      toast(errMsg(e))
    }
  }

  const save = async (patch: any) => setData({ library: await api.call('library:save', { ...cur, ...patch }) })

  const remove = async () => {
    if (!cur) return
    const refs: any[] = await api.call('memo:findRefs', { kind: 'lib', id: cur.id }).catch(() => [])
    if (!confirm(`删除「${cur.name}」？\n资料库里的这份文件会移到系统回收站。${refWarn(refs)}`)) return
    setData({ library: await api.call('library:delete', cur.id) })
    setSel(null)
  }

  const onKey = (e: React.KeyboardEvent) => {
    const i = list.findIndex((x) => x.id === sel)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel(list[Math.min(list.length - 1, i + 1)]?.id || null)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel(list[Math.max(0, i - 1)]?.id || null)
    } else if (e.key === 'Enter' && cur) {
      api.call('library:abs', cur.id).then((p) => p && api.call('shell:openPath', p))
    }
  }

  const typeName = (id: string) => types.find((t: any) => t.id === id)?.name || ''

  return (
    <>
      <div className="topbar">
        <h1>资料库</h1>
        <input className="input" style={{ width: 280 }} placeholder="搜索名称、编号、标签、备注…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="spacer" />
        <button className="btn" title="对照资料库文件夹：移除文件已被删除的资料，登记直接放进文件夹的新文件" onClick={refresh}>
          ⟳ 刷新
        </button>
        <button className="btn" onClick={() => api.call('shell:openPath', data.libraryDir)}>打开资料库文件夹</button>
        <button className="btn primary" onClick={async () => setData({ library: await api.call('library:pickImport', type || types[0]?.id) })}>
          + 导入资料
        </button>
      </div>
      <div
        className="lib-wrap"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          importPaths(Array.from(e.dataTransfer.files).map((f) => api.pathForFile(f)).filter(Boolean))
        }}
      >
        <div className="lib-types">
          <button className={'nav' + (!type ? ' on' : '')} onClick={() => setType('')}>
            全部资料<span className="count">{library.length}</span>
          </button>
          <div className="side-sub">类型</div>
          {types.map((t: any) => (
            <button key={t.id} className={'nav' + (type === t.id ? ' on' : '')} onClick={() => setType(t.id)}>
              {t.name}
              <span className="count">{library.filter((x) => x.type === t.id).length || ''}</span>
            </button>
          ))}
          <button
            className="nav faint"
            onClick={async () => {
              const name = await ask('新建资料类型', '', '如：地方标准、影像底图')
              if (name) saveSettings({ ...settings, libraryTypes: [...types, { id: uid(), name }] })
            }}
          >
            + 新建类型
          </button>
        </div>

        <div className="lib-list" tabIndex={0} onKeyDown={onKey} ref={listRef}>
          {(missing.size > 0 || untracked.length > 0) && (
            <div className="lib-sync">
              {missing.size > 0 && <span>⚠ {missing.size} 份资料的文件已经不在了</span>}
              {untracked.length > 0 && <span>📥 文件夹里有 {untracked.length} 个新文件没登记</span>}
              <button className="btn small primary" onClick={refresh}>刷新整理</button>
            </div>
          )}
          {dragging && <div className="drop-hint">松开即可导入到「{typeName(type) || typeName(types[0]?.id)}」</div>}
          {library.length === 0 ? (
            <Empty title="规范、模板、收集的数据，放一处，所有项目都能用" text="点右上角「导入资料」，或者直接把文件、文件夹拖到这里。文件会复制进资料库文件夹，原文件以后移动、删除都不影响。规范文件名里的编号（如 GB 50201-2014）会自动识别。" />
          ) : list.length === 0 ? (
            <Empty title="没有符合条件的资料" />
          ) : (
            list.map((x) => (
              <div key={x.id} className={'lib-row' + (sel === x.id ? ' on' : '') + (missing.has(x.id) ? ' gone' : '')} onClick={() => setSel(x.id)} onDoubleClick={() => api.call('library:abs', x.id).then((p) => p && api.call('shell:openPath', p))}>
                <FileBadge name={x.file} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="nm">
                    {x.code && <b style={{ marginRight: 6 }}>{x.code}</b>}
                    {x.name}
                  </div>
                  <div className="sub">
                    {[typeName(x.type), x.date, ...(x.tags || [])].filter(Boolean).join(' · ')}
                    {x.status === '已废止' && <span className="tag red" style={{ marginLeft: 6 }}>已废止{x.supersededBy ? `，被 ${x.supersededBy} 替代` : ''}</span>}
                    {x.status === '待实施' && <span className="tag amber" style={{ marginLeft: 6 }}>待实施</span>}
                    {missing.has(x.id) && <span className="tag red" style={{ marginLeft: 6 }}>文件已不在</span>}
                  </div>
                </div>
              </div>
            ))
          )}
          <div className="faint" style={{ fontSize: 11, padding: '10px 4px' }}>共 {list.length} 份 · 拖入文件或文件夹即可导入 · ↑↓ 选择 · 回车打开</div>
        </div>

        {cur && <LibraryPanel key={cur.id} item={cur} save={save} remove={remove} projects={projects} types={types} />}
      </div>
    </>
  )
}

function LibraryPanel({ item, save, remove, projects, types }: any) {
  const { toast, go } = useApp()
  const [preview, setPreview] = useState<any>(null)
  const [abs, setAbs] = useState('')
  const [pid, setPid] = useState('')
  useEffect(() => {
    let alive = true
    setPreview({ kind: 'loading' })
    api.call('library:abs', item.id).then((p) => {
      if (!alive) return
      setAbs(p)
      api
        .call('previewAbs', p)
        .then((r) => alive && setPreview(r))
        .catch((e) => alive && setPreview({ kind: 'error', error: errMsg(e) }))
    })
    return () => {
      alive = false
    }
  }, [item.id, item.file])

  const field = (label: string, key: string, placeholder = '') => (
    <div className="field">
      <label>{label}</label>
      <input className="input" defaultValue={item[key] || ''} placeholder={placeholder} onBlur={(e) => e.target.value !== (item[key] || '') && save({ [key]: e.target.value.trim() })} />
    </div>
  )

  const useTpl = async () => {
    if (!pid) return toast('先选一个项目')
    try {
      const rel = await api.call('library:useTemplate', item.id, pid)
      if (rel) go({ page: 'project', projectId: pid, select: rel })
    } catch (e) {
      toast(errMsg(e))
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="row">
          <FileBadge name={item.file} />
          <div className="panel-title">{item.code ? item.code + ' ' : ''}{item.name}</div>
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
          {item.file} · {fmtSize(item.size)}
        </div>
      </div>
      <div className="panel-body">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn small primary" onClick={() => api.call('shell:openPath', abs)}>打开</button>
          <button className="btn small" onClick={() => api.call('shell:reveal', abs)}>在资源管理器中显示</button>
          <button
            className="btn small"
            onClick={() => {
              clip.ref = abs
              toast('已复制。到项目导图的文件夹上右键「粘贴引用」')
            }}
          >
            复制为引用
          </button>
          <button className="btn small danger" onClick={remove}>删除</button>
        </div>
        <div className="grid2">
          {field('名称', 'name')}
          {field('编号', 'code', '如 GB 50201-2014')}
          <div className="field">
            <label>类型</label>
            <select className="input" value={item.type} onChange={(e) => save({ type: e.target.value })}>
              {types.map((t: any) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>日期</label>
            <input type="date" className="input" defaultValue={item.date || ''} onBlur={(e) => e.target.value !== (item.date || '') && save({ date: e.target.value })} />
          </div>
          <div className="field">
            <label>状态</label>
            <select className="input" value={item.status || '现行'} onChange={(e) => save({ status: e.target.value })}>
              {STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          {field('被哪个版本替代', 'supersededBy', '如 GB 50180-2018')}
        </div>
        <div className="field">
          <label>标签（逗号分隔）</label>
          <input
            className="input"
            defaultValue={(item.tags || []).join('，')}
            onBlur={(e) => save({ tags: e.target.value.split(/[，,、\s]+/).filter(Boolean) })}
          />
        </div>
        <div className="field">
          <label>备注</label>
          <textarea className="input" rows={2} defaultValue={item.note || ''} onBlur={(e) => e.target.value !== (item.note || '') && save({ note: e.target.value })} />
        </div>
        <div className="field">
          <label>用这份资料（如报告模板）在项目里新建文件</label>
          <div className="row">
            <select className="input" value={pid} onChange={(e) => setPid(e.target.value)}>
              <option value="">选择项目…</option>
              {projects
                .filter((p: any) => p.rootPath)
                .map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
            </select>
            <button className="btn small" disabled={!pid} onClick={useTpl}>新建…</button>
          </div>
        </div>
        <div>
          <div className="faint" style={{ marginBottom: 4 }}>预览</div>
          <Preview p={preview} ext={extOf(item.file)} />
        </div>
      </div>
    </div>
  )
}
