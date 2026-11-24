import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errMsg, fmtTime, uid, useApp, ymd, addDays } from '../lib'
import { Modal } from '../ui'
import KbEditor, { KbEditorHandle, pageHref } from './KbEditor'
import { refsOfHtml } from '../memoNodes'

// 备忘录：左边按时间分组的列表，右边直接编辑。正文里可以插入图片、录音、视频、附件，
// 也可以引用资料库和项目里的文件（只记位置，文件被删除时会提示这里引用了它）。
// 数据仍是原来知识库的页面（kb/pages），页面之间的「[[」链接照常可用。

export const strip = (h: string) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

/** 列表里显示的标题：没写标题就用正文第一行 */
const titleOf = (p: any) => (p.title || '').trim() || strip(p.html).slice(0, 40) || '新备忘录'
const media = (html: string) => {
  const h = String(html || '')
  return [/<img\b/.test(h) && '🖼', /<audio\b/.test(h) && '🎙', /<video\b/.test(h) && '🎬', /data-ref="(lib|proj)"/.test(h) && '🔗', /data-ref="att"/.test(h) && '📎'].filter(Boolean).join(' ')
}

export default function Knowledge({ pageId }: { pageId?: string }) {
  const { toast, go } = useApp()
  const [pages, setPages] = useState<any[]>([])
  const [cur, setCur] = useState<string | null>(pageId || null)
  const [trashView, setTrashView] = useState(false)
  const [q, setQ] = useState('')

  const load = useCallback(() => api.call('kb:list').then(setPages), [])
  useEffect(() => {
    load()
  }, [load])

  const alive = pages.filter((p) => !p.deletedAt)
  const trash = pages.filter((p) => p.deletedAt)
  const page = alive.find((p) => p.id === cur) || null

  // 进来时默认打开最近的一条
  useEffect(() => {
    if (!cur && !trashView && alive.length) setCur([...alive].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0].id)
  }, [pages.length])

  // 离开一条什么都没写的备忘录时，自动删掉它（像手机备忘录一样，不留空白条目）
  useEffect(() => {
    if (!cur) return
    const id = cur
    return () => {
      setTimeout(async () => {
        const list: any[] = await api.call('kb:list')
        const p = list.find((x) => x.id === id)
        if (p && !p.deletedAt && !(p.title || '').trim() && !strip(p.html) && !/<(img|audio|video)\b|data-ref=/.test(p.html || '')) setPages(await api.call('kb:purge', id))
      }, 1500)
    }
  }, [cur])

  const upsertLocal = (p: any) => setPages((list) => (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]))

  const create = async (title = '') => {
    const p = await api.call('kb:save', { id: uid(), title, parentId: null, html: '<p></p>', order: Date.now() })
    upsertLocal(p)
    setTrashView(false)
    setQ('')
    setCur(p.id)
    return { id: p.id, title: p.title }
  }

  const remove = async (p: any) => {
    if (!confirm(`把「${titleOf(p)}」移到回收站？\n回收站里保留 30 天。`)) return
    upsertLocal(await api.call('kb:save', { id: p.id, deletedAt: new Date().toISOString() }))
    setCur(null)
  }
  const restore = async (p: any) => {
    upsertLocal(await api.call('kb:save', { id: p.id, deletedAt: null, parentId: null }))
    toast('已恢复')
  }
  const purge = async (p: any) => {
    if (!confirm(`彻底删除「${titleOf(p)}」？里面的图片、录音、视频和附件也一起删除，不能恢复。`)) return
    setPages(await api.call('kb:purge', p.id))
  }

  // 列表：置顶在前，其余按修改时间分组
  const lq = q.trim().toLowerCase()
  const list = useMemo(
    () =>
      alive
        .filter((p) => !lq || (p.title || '').toLowerCase().includes(lq) || strip(p.html).toLowerCase().includes(lq) || refsOfHtml(p.html).some((r) => r.name.toLowerCase().includes(lq)))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    [pages, lq]
  )
  const groups = useMemo(() => {
    const today = ymd()
    const g: [string, any[]][] = [['置顶', []], ['今天', []], ['昨天', []], ['7 天内', []], ['30 天内', []], ['更早', []]]
    for (const p of list) {
      const d = ymd(new Date(p.updatedAt))
      const i = p.favorite ? 0 : d === today ? 1 : d === addDays(today, -1) ? 2 : d >= addDays(today, -7) ? 3 : d >= addDays(today, -30) ? 4 : 5
      g[i][1].push(p)
    }
    return g.filter(([, x]) => x.length)
  }, [list])

  const when = (t: string) => {
    const d = new Date(t)
    return ymd(d) === ymd() ? d.toTimeString().slice(0, 5) : ymd(d).slice(0, 4) === ymd().slice(0, 4) ? ymd(d).slice(5) : ymd(d)
  }

  return (
    <div className="memo-wrap">
      <div className="memo-side">
        <div className="memo-side-head">
          <b style={{ fontSize: 16 }}>备忘录</b>
          <span className="faint" style={{ fontSize: 12 }}>{alive.length}</span>
          <span className="spacer" />
          <button className="btn small primary" title="新建备忘录" onClick={() => create()}>＋ 新建</button>
        </div>
        <input className="input" placeholder="搜索标题、正文、引用的文件…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="memo-list">
          {trashView ? (
            <>
              <div className="memo-group">回收站 · 保留 30 天</div>
              {trash.length === 0 && <div className="faint" style={{ padding: 12, fontSize: 12 }}>回收站是空的</div>}
              {trash.map((p) => (
                <div key={p.id} className="memo-item">
                  <div className="memo-t">{titleOf(p)}</div>
                  <div className="memo-s">删除于 {fmtTime(p.deletedAt)}</div>
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    <button className="btn small" onClick={() => restore(p)}>恢复</button>
                    <button className="btn small danger" onClick={() => purge(p)}>彻底删除</button>
                  </div>
                </div>
              ))}
            </>
          ) : list.length === 0 ? (
            <div className="faint" style={{ padding: 16, fontSize: 12.5, lineHeight: 1.7 }}>{q ? '没有找到' : '还没有备忘录。点「＋ 新建」写第一条：可以插入图片、录音、视频，也可以引用资料库和项目里的文件。'}</div>
          ) : (
            groups.map(([name, ps]) => (
              <div key={name}>
                <div className="memo-group">{name}</div>
                {ps.map((p) => (
                  <div key={p.id} className={'memo-item' + (cur === p.id ? ' on' : '')} onClick={() => setCur(p.id)}>
                    <div className="memo-t">
                      {p.favorite && <span className="pin">📌</span>}
                      {titleOf(p)}
                    </div>
                    <div className="memo-s">
                      <span className="memo-when">{when(p.updatedAt)}</span>
                      {strip(p.html).slice((p.title || '').trim() ? 0 : 40, ((p.title || '').trim() ? 0 : 40) + 60) || <span className="faint">没有更多内容</span>}
                    </div>
                    {media(p.html) && <div className="memo-m">{media(p.html)}</div>}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
        <button className={'memo-trash' + (trashView ? ' on' : '')} onClick={() => (setTrashView(!trashView), setCur(null))}>
          🗑 回收站 {trash.length ? trash.length : ''}
        </button>
      </div>
      <div className="memo-main">
        {page ? (
          <MemoEditor
            key={page.id}
            page={page}
            pages={alive}
            onSaved={upsertLocal}
            onRemove={() => remove(page)}
            onOpen={(id: string) => (setTrashView(false), setCur(id))}
            onCreateTitled={create}
            toast={toast}
          />
        ) : (
          <div className="memo-empty">
            <div style={{ fontSize: 40 }}>🗒️</div>
            <div>{trashView ? '在左边恢复或彻底删除' : '选一条备忘录，或新建一条'}</div>
            {!trashView && <button className="btn primary" onClick={() => create()}>＋ 新建备忘录</button>}
          </div>
        )}
      </div>
    </div>
  )
}

function MemoEditor({ page, pages, onSaved, onRemove, onOpen, onCreateTitled, toast }: any) {
  const [title, setTitle] = useState(page.title)
  const [history, setHistory] = useState<any[] | null>(null)
  const [savedAt, setSavedAt] = useState(page.updatedAt)
  const [html, setHtml] = useState(page.html)
  const editorRef = useRef<KbEditorHandle>(null)
  const pending = useRef<{ html?: string; title?: string }>({})
  const timer = useRef<any>(null)

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const p = pending.current
    if (p.html === undefined && p.title === undefined) return
    pending.current = {}
    try {
      const saved = await api.call('kb:save', { id: page.id, ...p })
      onSaved(saved)
      setSavedAt(saved.updatedAt)
    } catch (e) {
      toast('保存失败：' + errMsg(e))
    }
  }, [page.id])
  const queue = (patch: any) => {
    Object.assign(pending.current, patch)
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, 700)
  }
  useEffect(() => () => void flush(), [flush])

  // 项目里的文件改名 / 移动后，主进程改好了引用路径：重新载入正文
  useEffect(
    () =>
      api.on('kb:changed', async (ids: any) => {
        if (!(ids || []).includes(page.id)) return
        const p = (await api.call('kb:list')).find((x: any) => x.id === page.id)
        if (p) (pending.current = {}, editorRef.current?.setHtml(p.html), onSaved(p))
      }),
    [page.id]
  )

  return (
    <div className="memo-page">
      <div className="memo-bar">
        <span className="faint" style={{ fontSize: 12 }}>
          创建于 {fmtTime(page.createdAt)} · 保存于 {fmtTime(savedAt)}
        </span>
        <span style={{ flex: 1 }} />
        <button className={'btn small' + (page.favorite ? ' primary' : '')} title="置顶到列表最上面" onClick={async () => onSaved(await api.call('kb:save', { id: page.id, favorite: !page.favorite }))}>
          📌 {page.favorite ? '已置顶' : '置顶'}
        </button>
        <button
          className="btn small"
          onClick={async () => {
            await flush()
            setHistory(await api.call('kb:history', page.id))
          }}
        >
          历史版本
        </button>
        <button className="btn small danger" onClick={onRemove}>删除</button>
      </div>
      <div className="memo-doc">
        <input
          className="kb-h1"
          placeholder="标题（可以不写，列表里会显示第一行）"
          value={title}
          autoFocus={!page.title && strip(page.html) === ''}
          onChange={(e) => {
            setTitle(e.target.value)
            queue({ title: e.target.value })
          }}
        />
        <KbEditor
          ref={editorRef}
          html={page.html}
          owner={page.id}
          toolbar
          placeholder="写点什么……输入「/」插入图片、录音、视频、引用文件；可以直接粘贴截图，或把文件拖进来"
          onChange={(h) => {
            setHtml(h)
            queue({ html: h })
          }}
          pages={pages.filter((p: any) => p.id !== page.id).map((p: any) => ({ id: p.id, title: titleOf(p) }))}
          onOpenPage={onOpen}
          onCreatePage={onCreateTitled}
        />
        <RefList html={html} />
        <Backlinks id={page.id} pages={pages} onOpen={onOpen} />
      </div>
      {history && (
        <HistoryDialog
          pageId={page.id}
          list={history}
          onClose={() => setHistory(null)}
          onRestore={async (v: any) => {
            editorRef.current?.setHtml(v.html)
            setTitle(v.title)
            pending.current = { html: v.html, title: v.title }
            await flush()
            setHistory(null)
            toast('已恢复到这个版本（恢复前的内容也存进了历史）')
          }}
        />
      )}
    </div>
  )
}

/** 正文里引用的文件汇总：失效的（被删、被移走）标红 */
function RefList({ html }: { html: string }) {
  const { toast } = useApp()
  const refs = useMemo(() => {
    const seen = new Set<string>()
    return refsOfHtml(html).filter((r) => {
      const k = [r.kind, r.id, r.pid, r.rel, r.src].join('|')
      return !seen.has(k) && (seen.add(k), true)
    })
  }, [html])
  const key = refs.map((r) => [r.kind, r.id, r.pid, r.rel, r.src].join('|')).join(';')
  const [ok, setOk] = useState<boolean[]>([])
  useEffect(() => {
    if (refs.length) api.call('memo:refStatus', refs).then(setOk)
  }, [key])
  if (!refs.length) return null
  const label = (k: string) => (k === 'lib' ? '资料库' : k === 'proj' ? '项目文件' : '附件')
  return (
    <div className="backlinks">
      <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>引用的文件 {refs.length}</div>
      {refs.map((r, i) => (
        <div key={i} className="list-row" style={{ fontSize: 13 }}>
          <span className="tag">{label(r.kind)}</span>
          <span className={'grow click' + (ok[i] === false ? ' red-text' : '')} onClick={() => api.call('memo:openRef', r).catch((e: any) => toast(errMsg(e)))}>
            {r.name}
            {ok[i] === false && '（找不到了）'}
          </span>
          {ok[i] !== false && (
            <button className="btn small" onClick={() => api.call('memo:revealRef', r).catch((e: any) => toast(errMsg(e)))}>在文件夹中显示</button>
          )}
        </div>
      ))}
    </div>
  )
}

/** 反向链接：哪些备忘录链接到了这一条 */
export function Backlinks({ id, pages, onOpen }: any) {
  const href = pageHref(id)
  const fromPages = pages.filter((p: any) => p.id !== id && !p.deletedAt && String(p.html || '').includes(href))
  if (!fromPages.length) return null
  const ctx = (html: string) => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const a = doc.querySelector(`a[href="${href}"]`)
    const block = a?.closest('p, li, td, th, h1, h2, h3, blockquote') || a?.parentElement
    const t = (block?.textContent || '').replace(/\s+/g, ' ').trim()
    return t.length > 80 ? t.slice(0, 80) + '…' : t
  }
  return (
    <div className="backlinks">
      <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>链接到这里的 {fromPages.length}</div>
      {fromPages.map((p: any) => (
        <div key={p.id} className="backlink click" onClick={() => onOpen(p.id)}>
          <b>{titleOf(p)}</b>
          <div className="faint">{ctx(p.html)}</div>
        </div>
      ))}
    </div>
  )
}

function HistoryDialog({ pageId, list, onClose, onRestore }: any) {
  const [sel, setSel] = useState<any>(null)
  const [v, setV] = useState<any>(null)
  useEffect(() => {
    if (sel) api.call('kb:version', pageId, sel.file).then(setV)
  }, [sel])
  return (
    <Modal
      title="历史版本"
      onClose={onClose}
      width={900}
      footer={
        <>
          <span className="faint" style={{ marginRight: 'auto', fontSize: 12 }}>编辑时每 5 分钟自动存一份，最多保留最近 50 份</span>
          <button className="btn" onClick={onClose}>关闭</button>
          <button className="btn primary" disabled={!v} onClick={() => onRestore(v)}>恢复这个版本</button>
        </>
      }
    >
      {list.length === 0 ? (
        <div className="faint">还没有历史版本。编辑一会儿之后会自动生成。</div>
      ) : (
        <div style={{ display: 'flex', gap: 12, minHeight: 360 }}>
          <div style={{ width: 220, flex: 'none', overflow: 'auto', maxHeight: 480 }}>
            {list.map((h: any) => (
              <div key={h.file} className={'kb-node' + (sel?.file === h.file ? ' on' : '')} onClick={() => setSel(h)}>
                <span className="kb-title">
                  {new Date(h.time).toLocaleString('zh-CN')}
                  {h.name && <span className="tag amber" style={{ marginLeft: 4 }}>{h.name}</span>}
                </span>
              </div>
            ))}
          </div>
          <div className="preview" style={{ flex: 1 }}>
            {v ? (
              <div className="html kb-readonly">
                <h1>{v.title || '无标题'}</h1>
                <div dangerouslySetInnerHTML={{ __html: v.html }} />
              </div>
            ) : (
              <div className="faint" style={{ padding: 12 }}>点左边的时间查看那个版本</div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
