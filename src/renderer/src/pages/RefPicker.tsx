import { useEffect, useMemo, useState } from 'react'
import { api, useApp } from '../lib'
import { Modal, Tabs } from '../ui'

export type RefAttrs = Record<string, string>

/** 选择要引用的文件：资料库里的文件，或某个项目文件夹里的文件。只记住位置，不复制文件 */
export default function RefPicker({ onClose, onPick, allowDirs = false, title = '引用文件', okLabel = '插入' }: { onClose: () => void; onPick: (refs: RefAttrs[]) => void; allowDirs?: boolean; title?: string; okLabel?: string }) {
  const { data } = useApp()
  const [tab, setTab] = useState<'lib' | 'proj'>(() => (localStorage.getItem('refTab') as any) || 'lib')
  const [q, setQ] = useState('')
  const [pid, setPid] = useState<string>(() => localStorage.getItem('refPid') || data.projects.find((p) => p.rootPath)?.id || '')
  const [files, setFiles] = useState<{ rel: string; name: string; dir: string; isDir: boolean }[] | null>(null)
  const [sel, setSel] = useState<Map<string, RefAttrs>>(new Map())
  const projects = data.projects.filter((p) => p.rootPath)

  useEffect(() => {
    if (tab !== 'proj' || !pid) return
    setFiles(null)
    api
      .call('project:tree', pid, false)
      .then((r: { flat?: { rel: string; name: string; dir: boolean }[] }) =>
        setFiles(
          (r.flat || [])
            .filter((f) => allowDirs || !f.dir)
            .map((f) => ({ rel: f.rel, name: f.name, isDir: f.dir, dir: f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '' }))
            .sort((a, b) => Number(b.isDir) - Number(a.isDir))
        )
      )
      .catch(() => setFiles([]))
  }, [tab, pid])

  const lq = q.trim().toLowerCase()
  const libList = useMemo(
    () => data.library.filter((x: any) => !lq || [x.name, x.code, ...(x.tags || [])].join(' ').toLowerCase().includes(lq)).slice(0, 300),
    [data.library, lq]
  )
  const projList = useMemo(() => (files || []).filter((f) => !lq || (f.dir + '/' + f.name).toLowerCase().includes(lq)).slice(0, 300), [files, lq])
  const pname = data.projects.find((p) => p.id === pid)?.name || ''

  const toggle = (key: string, attrs: RefAttrs) =>
    setSel((m) => {
      const n = new Map(m)
      n.has(key) ? n.delete(key) : n.set(key, attrs)
      return n
    })

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={720}
      footer={
        <>
          <span className="faint" style={{ marginRight: 'auto', fontSize: 12 }}>只记住文件位置，不复制。文件被删除时会提示这里引用了它。</span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!sel.size} onClick={() => onPick([...sel.values()])}>
            {okLabel}{sel.size ? ` ${sel.size} 个` : ''}
          </button>
        </>
      }
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <Tabs
          value={tab}
          onChange={(v: any) => (setTab(v), localStorage.setItem('refTab', v))}
          options={[
            { id: 'lib', label: `资料库 ${data.library.length}` },
            { id: 'proj', label: '项目文件' }
          ]}
        />
        {tab === 'proj' && (
          <select className="input" style={{ width: 'auto' }} value={pid} onChange={(e) => (setPid(e.target.value), localStorage.setItem('refPid', e.target.value))}>
            {projects.length === 0 && <option value="">没有关联文件夹的项目</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        <input autoFocus className="input" style={{ flex: 1 }} placeholder={tab === 'lib' ? '搜索资料名称、编号、标签' : allowDirs ? '搜索文件夹或文件名' : '搜索文件名或文件夹'} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="ref-list">
        {tab === 'lib' ? (
          libList.length === 0 ? (
            <div className="faint" style={{ padding: 12 }}>{data.library.length ? '没有符合的资料' : '资料库还是空的'}</div>
          ) : (
            libList.map((x: any) => {
              const key = 'lib:' + x.id
              return (
                <label key={key} className={'ref-row' + (sel.has(key) ? ' on' : '')}>
                  <input type="checkbox" checked={sel.has(key)} onChange={() => toggle(key, { 'data-ref': 'lib', 'data-id': x.id, 'data-name': x.name, 'data-sub': '资料库 · ' })} />
                  <span className="grow">📚 {x.name}</span>
                  <span className="faint">{[x.code, x.type].filter(Boolean).join(' · ')}</span>
                </label>
              )
            })
          )
        ) : !pid ? (
          <div className="faint" style={{ padding: 12 }}>先在项目里关联文件夹</div>
        ) : files === null ? (
          <div className="faint" style={{ padding: 12 }}>正在读取项目文件…</div>
        ) : projList.length === 0 ? (
          <div className="faint" style={{ padding: 12 }}>{allowDirs ? '没有符合的文件或文件夹' : '没有符合的文件'}</div>
        ) : (
          projList.map((f) => {
            const key = 'proj:' + pid + ':' + f.rel
            return (
              <label key={key} className={'ref-row' + (sel.has(key) ? ' on' : '')}>
                <input type="checkbox" checked={sel.has(key)} onChange={() => toggle(key, { 'data-ref': 'proj', 'data-pid': pid, 'data-rel': f.rel, 'data-name': f.name, 'data-sub': pname + ' · ', ...(f.isDir ? { 'data-dir': '1' } : {}) })} />
                <span className="grow">{allowDirs ? (f.isDir ? '📁 ' : '📄 ') : '📁 '}{f.name}</span>
                <span className="faint" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.dir || '（根目录）'}</span>
              </label>
            )
          })
        )}
      </div>
    </Modal>
  )
}
