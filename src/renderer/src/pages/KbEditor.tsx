import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { EditorContent, useEditor, Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import Placeholder from '@tiptap/extension-placeholder'
import Link from '@tiptap/extension-link'
import Highlight from '@tiptap/extension-highlight'
import { api, errMsg, useApp } from '../lib'
import { FileRef, MemoAudio, MemoImage, MemoVideo, refOfEl } from '../memoNodes'
import RefPicker from './RefPicker'

export interface Heading {
  level: number
  text: string
  pos: number
}

export interface KbEditorHandle {
  setHtml: (html: string) => void
  jumpTo: (pos: number) => void
}

type Cmd = { label: string; hint: string; keys: string[]; run: (e: Editor) => void; act?: string }

// 「/」菜单里的命令
const COMMANDS: Cmd[] = [
  { label: '正文', hint: '普通段落', keys: ['zw', 'text', 'p'], run: (e) => e.chain().focus().setParagraph().run() },
  { label: '一级标题', hint: '# 加空格', keys: ['h1', 'bt', 'title'], run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { label: '二级标题', hint: '## 加空格', keys: ['h2', 'bt'], run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { label: '三级标题', hint: '### 加空格', keys: ['h3', 'bt'], run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { label: '无序列表', hint: '- 加空格', keys: ['ul', 'lb', 'list'], run: (e) => e.chain().focus().toggleBulletList().run() },
  { label: '有序列表', hint: '1. 加空格', keys: ['ol', 'lb', 'list'], run: (e) => e.chain().focus().toggleOrderedList().run() },
  { label: '待办', hint: '[] 加空格', keys: ['todo', 'db', 'task'], run: (e) => e.chain().focus().toggleTaskList().run() },
  { label: '表格', hint: '3 × 3', keys: ['table', 'bg'], run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { label: '引用 / 提示块', hint: '> 加空格', keys: ['quote', 'yy', 'ts'], run: (e) => e.chain().focus().toggleBlockquote().run() },
  { label: '代码块', hint: '``` 加空格', keys: ['code', 'dm'], run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { label: '分割线', hint: '--- ', keys: ['hr', 'fgx'], run: (e) => e.chain().focus().setHorizontalRule().run() }
]
// 有「归属」（备忘录）时才有的命令：插入图片、录音、视频、附件，引用资料库 / 项目文件
const MEDIA_COMMANDS: Cmd[] = [
  { label: '图片', hint: '也可以直接粘贴截图', keys: ['tp', 'img', 'image', 'pic'], run: () => {}, act: 'image' },
  { label: '录音', hint: '用麦克风录一段', keys: ['ly', 'rec', 'audio', 'yy'], run: () => {}, act: 'record' },
  { label: '视频', hint: '选择视频文件', keys: ['sp', 'video'], run: () => {}, act: 'video' },
  { label: '附件', hint: '复制一份放进来', keys: ['fj', 'file', 'att'], run: () => {}, act: 'file' },
  { label: '引用文件', hint: '资料库 / 项目文件', keys: ['yy', 'ref', 'yinyong', 'zlk', 'xm'], run: () => {}, act: 'ref' }
]

export interface PageRef {
  id: string
  title: string
}

/** 双向链接的地址格式：#kb-<页面 id> */
export const pageHref = (id: string) => '#kb-' + id

const KbEditor = forwardRef<
  KbEditorHandle,
  {
    html: string
    onChange: (html: string) => void
    onHeadings?: (h: Heading[]) => void
    pages?: PageRef[]
    onOpenPage?: (id: string) => void
    onCreatePage?: (title: string) => Promise<PageRef>
    placeholder?: string
    /** 媒体归属：备忘录 id。有它才能插入图片、录音、视频、附件和引用文件 */
    owner?: string
    /** 显示格式工具栏 */
    toolbar?: boolean
  }
>(function KbEditor(props, ref) {
  const [slash, setSlash] = useState<{ query: string; x: number; y: number; index: number } | null>(null)
  const slashRef = useRef(slash)
  slashRef.current = slash
  // 输入「[[」时弹出的页面列表
  const [link, setLink] = useState<{ query: string; x: number; y: number; index: number } | null>(null)
  const linkRef = useRef(link)
  linkRef.current = link
  const pagesRef = useRef(props.pages || [])
  pagesRef.current = props.pages || []
  const openRef = useRef(props.onOpenPage)
  openRef.current = props.onOpenPage
  const createRef = useRef(props.onCreatePage)
  createRef.current = props.onCreatePage

  type LinkItem = { id?: string; title: string; create?: boolean }
  const linkItems = (q: string): LinkItem[] => {
    const lq = q.trim().toLowerCase()
    const list: LinkItem[] = pagesRef.current.filter((p) => !lq || (p.title || '无标题').toLowerCase().includes(lq)).slice(0, 8)
    if (q.trim() && createRef.current && !pagesRef.current.some((p) => p.title === q.trim())) list.push({ title: q.trim(), create: true })
    return list
  }

  const insertLink = async (e: Editor, item: LinkItem) => {
    const s = linkRef.current
    if (!s) return
    let target: PageRef | undefined = item.id ? { id: item.id, title: item.title } : undefined
    if (item.create && createRef.current) target = await createRef.current(item.title)
    if (!target) return
    const to = e.state.selection.$from.pos
    const from = to - (s.query.length + 2)
    e.chain()
      .focus()
      .deleteRange({ from, to })
      .insertContent([
        { type: 'text', text: target.title || '无标题', marks: [{ type: 'link', attrs: { href: pageHref(target.id) } }] },
        { type: 'text', text: ' ' }
      ])
      .run()
    setLink(null)
  }
  const onChange = useRef(props.onChange)
  onChange.current = props.onChange
  const onHeadings = useRef(props.onHeadings)
  onHeadings.current = props.onHeadings

  const allCmds = props.owner ? [...COMMANDS, ...MEDIA_COMMANDS] : COMMANDS
  // 名称以输入开头的排最前（输入「表」时先出「表格」，再出「无序列表」）
  const matches = (q: string) => {
    if (!q) return allCmds
    const lq = q.toLowerCase()
    const score = (c: Cmd) => (c.label.startsWith(q) ? 0 : c.keys.some((k) => k === lq) ? 1 : c.label.includes(q) ? 2 : c.keys.some((k) => k.startsWith(lq)) ? 3 : 9)
    return allCmds.filter((c) => score(c) < 9).sort((a, b) => score(a) - score(b))
  }

  const runSlash = (e: Editor, cmd: Cmd) => {
    const { $from } = e.state.selection
    // 先删掉输入的「/xxx」，再执行命令
    e.chain().focus().deleteRange({ from: $from.start(), to: $from.end() }).run()
    if (cmd.act) actRef.current(cmd.act)
    else cmd.run(e)
    setSlash(null)
  }

  const collectHeadings = (e: Editor) => {
    if (!onHeadings.current) return
    const hs: Heading[] = []
    e.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') hs.push({ level: node.attrs.level, text: node.textContent, pos })
    })
    onHeadings.current(hs)
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Highlight,
      MemoImage,
      MemoAudio,
      MemoVideo,
      FileRef,
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({ placeholder: props.placeholder || '输入「/」插入标题、列表、待办、表格；输入「[[」链接到其他页面' })
    ],
    content: props.html,
    onCreate: ({ editor }) => collectHeadings(editor as Editor),
    onUpdate: ({ editor }) => {
      onChange.current(editor.getHTML())
      collectHeadings(editor as Editor)
    },
    onSelectionUpdate: ({ editor }) => {
      const { $from, empty } = editor.state.selection
      const text = $from.parent.textContent
      if (empty && $from.parent.type.name === 'paragraph' && /^\/[^\s/]*$/.test(text) && $from.parentOffset === text.length) {
        const c = editor.view.coordsAtPos($from.pos)
        setSlash((s) => ({ query: text.slice(1), x: c.left, y: c.bottom + 4, index: s?.query === text.slice(1) ? s.index : 0 }))
      } else if (slashRef.current) setSlash(null)
      // 「[[关键词」：光标前面是 [[ 加上还没打完的页面名
      const before = empty ? $from.parent.textBetween(0, $from.parentOffset, undefined, '￼') : ''
      const m = props.pages ? before.match(/\[\[([^\[\]￼]{0,40})$/) : null
      if (m) {
        const c = editor.view.coordsAtPos($from.pos)
        setLink((s) => ({ query: m[1], x: c.left, y: c.bottom + 4, index: s?.query === m[1] ? s.index : 0 }))
      } else if (linkRef.current) setLink(null)
    },
    editorProps: {
      handleKeyDown: (_view, ev) => {
        const l = linkRef.current
        if (l) {
          const items = linkItems(l.query)
          if (ev.key === 'ArrowDown') {
            setLink({ ...l, index: (l.index + 1) % Math.max(1, items.length) })
            return true
          }
          if (ev.key === 'ArrowUp') {
            setLink({ ...l, index: (l.index - 1 + items.length) % Math.max(1, items.length) })
            return true
          }
          if (ev.key === 'Enter' && items[l.index]) {
            insertLink(editorRef.current!, items[l.index])
            return true
          }
          if (ev.key === 'Escape') {
            setLink(null)
            return true
          }
        }
        const s = slashRef.current
        if (!s) return false
        const list = matches(s.query)
        if (ev.key === 'ArrowDown') {
          setSlash({ ...s, index: (s.index + 1) % Math.max(1, list.length) })
          return true
        }
        if (ev.key === 'ArrowUp') {
          setSlash({ ...s, index: (s.index - 1 + list.length) % Math.max(1, list.length) })
          return true
        }
        if (ev.key === 'Enter' && list[s.index]) {
          runSlash(editorRef.current!, list[s.index])
          return true
        }
        if (ev.key === 'Escape') {
          setSlash(null)
          return true
        }
        return false
      },
      // 粘贴截图 / 复制的文件：存进来再插入
      handlePaste: (_view, ev) => {
        const files = Array.from(ev.clipboardData?.files || [])
        if (!files.length || !ownerRef.current) return false
        insertFilesRef.current(files)
        return true
      },
      // 从资源管理器拖进来的文件
      handleDrop: (view, ev, _slice, moved) => {
        const files = Array.from((ev as DragEvent).dataTransfer?.files || [])
        if (moved || !files.length || !ownerRef.current) return false
        ev.preventDefault()
        const at = view.posAtCoords({ left: (ev as DragEvent).clientX, top: (ev as DragEvent).clientY })
        if (at) editorRef.current?.commands.setTextSelection(at.pos)
        insertFilesRef.current(files)
        return true
      },
      // 点链接时用系统浏览器打开
      handleClick: (_view, _pos, ev) => {
        const ref = (ev.target as HTMLElement).closest('[data-ref]')
        if (ref) {
          api.call('memo:openRef', refOfEl(ref)).catch((e: any) => toastRef.current(errMsg(e)))
          return true
        }
        const a = (ev.target as HTMLElement).closest('a')
        const href = a?.getAttribute('href') || ''
        // 页面链接：直接跳过去
        if (href.startsWith('#kb-') && openRef.current) {
          openRef.current(href.slice(4))
          return true
        }
        if (a && ev.ctrlKey) {
          window.open(a.getAttribute('href') || '', '_blank')
          return true
        }
        return false
      }
    }
  })
  const editorRef = useRef<Editor | null>(null)
  editorRef.current = editor

  // ---------- 图片、录音、视频、附件、引用 ----------
  const { toast } = useApp()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const ownerRef = useRef(props.owner)
  ownerRef.current = props.owner
  const [picking, setPicking] = useState(false)
  const [rec, setRec] = useState<{ start: number; mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; cancel?: boolean } | null>(null)
  const [now, setNow] = useState(Date.now())

  type Saved = { name: string; url: string; kind: string }
  const insertSaved = (list: Saved[]) => {
    const e = editorRef.current
    if (!e || !list.length) return
    afterSelectedNode(e)
    const content = list.map((f) =>
      f.kind === 'image'
        ? { type: 'image', attrs: { src: f.url, alt: f.name } }
        : f.kind === 'audio'
          ? { type: 'audio', attrs: { src: f.url, 'data-name': f.name } }
          : f.kind === 'video'
            ? { type: 'video', attrs: { src: f.url, 'data-name': f.name } }
            : { type: 'paragraph', content: [{ type: 'fileRef', attrs: { 'data-ref': 'att', 'data-src': f.url, 'data-name': f.name, 'data-sub': '附件 · ' } }] }
    )
    e.chain().focus().insertContent([...content, { type: 'paragraph' }]).run()
  }
  const insertPaths = async (paths: string[]) => {
    if (!paths.length || !ownerRef.current) return
    try {
      insertSaved(await api.call('memo:import', ownerRef.current, paths))
    } catch (err) {
      toast(errMsg(err))
    }
  }
  // 浏览器里的 File：有磁盘路径的按路径复制；截图之类没有路径的按内容保存
  const insertFiles = async (files: File[]) => {
    const withPath = files.map((f) => ({ f, p: api.pathForFile(f) }))
    const saved: Saved[] = []
    try {
      if (withPath.some((x) => x.p)) saved.push(...(await api.call('memo:import', ownerRef.current, withPath.filter((x) => x.p).map((x) => x.p))))
      for (const { f } of withPath.filter((x) => !x.p)) {
        const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '')
        const name = f.name && f.name !== 'image.png' ? f.name : `截图 ${new Date().toLocaleString('zh-CN').replace(/[/:]/g, '-')}.${ext}`
        saved.push(await api.call('memo:save', ownerRef.current, name, await f.arrayBuffer()))
      }
      insertSaved(saved)
    } catch (err) {
      toast(errMsg(err))
    }
  }
  const insertFilesRef = useRef(insertFiles)
  insertFilesRef.current = insertFiles

  const pick = async (title: string, filters?: any) => {
    const ps: string[] = await api.call('dialog:pickFiles', title, undefined, filters)
    insertPaths(ps || [])
  }
  const startRecord = async () => {
    if (rec) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      const r = { start: Date.now(), mr, stream, chunks: [] as Blob[], cancel: false }
      mr.ondataavailable = (ev) => ev.data.size && r.chunks.push(ev.data)
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setRec(null)
        if (r.cancel || !r.chunks.length) return
        const blob = new Blob(r.chunks, { type: mr.mimeType || 'audio/webm' })
        const name = `录音 ${new Date(r.start).toLocaleString('zh-CN').replace(/[/:]/g, '-')}.webm`
        try {
          insertSaved([await api.call('memo:save', ownerRef.current, name, await blob.arrayBuffer(), 'audio')])
        } catch (err) {
          toast(errMsg(err))
        }
      }
      mr.start(1000)
      setRec(r)
    } catch (err) {
      toast('打不开麦克风：' + errMsg(err))
    }
  }
  useEffect(() => {
    if (!rec) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [rec])
  // 离开页面时停掉录音
  useEffect(() => () => rec?.stream.getTracks().forEach((t) => t.stop()), [rec])
  // 录音块「转文字」的提示（节点视图里拿不到 toast）
  useEffect(() => {
    const f = (e: any) => toast(String(e.detail || ''))
    window.addEventListener('memo:toast', f)
    return () => window.removeEventListener('memo:toast', f)
  }, [])

  const act = (a: string) => {
    if (a === 'image') pick('选择图片', [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }])
    else if (a === 'video') pick('选择视频', [{ name: '视频', extensions: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'] }])
    else if (a === 'file') pick('选择要放进来的文件（会复制一份）')
    else if (a === 'record') startRecord()
    else if (a === 'ref') setPicking(true)
  }
  const actRef = useRef(act)
  actRef.current = act
  const fmtDur = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

  useImperativeHandle(ref, () => ({
    setHtml: (html: string) => {
      editor?.commands.setContent(html, true)
    },
    jumpTo: (pos: number) => {
      if (!editor) return
      editor.chain().focus().setTextSelection(pos + 1).run()
      const dom = editor.view.domAtPos(pos + 1).node as HTMLElement
      ;(dom.nodeType === 1 ? dom : dom.parentElement)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }))

  const list = slash ? matches(slash.query) : []
  const links = link ? linkItems(link.query) : []

  return (
    <>
      {props.toolbar && editor && (
        <div className="memo-toolbar" onMouseDown={(e) => (e.target as HTMLElement).closest('button') && e.preventDefault()}>
          <button className={editor.isActive('bold') ? 'on' : ''} title="加粗 Ctrl+B" onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></button>
          <button className={editor.isActive('italic') ? 'on' : ''} title="斜体 Ctrl+I" onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></button>
          <button className={editor.isActive('highlight') ? 'on' : ''} title="高亮" onClick={() => editor.chain().focus().toggleHighlight().run()}><span className="hl">A</span></button>
          <span className="sep" />
          <button className={editor.isActive('heading', { level: 2 }) ? 'on' : ''} title="标题" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>标题</button>
          <button className={editor.isActive('bulletList') ? 'on' : ''} title="列表" onClick={() => editor.chain().focus().toggleBulletList().run()}>• 列表</button>
          <button className={editor.isActive('taskList') ? 'on' : ''} title="清单" onClick={() => editor.chain().focus().toggleTaskList().run()}>☑ 清单</button>
          <button title="表格" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>▦ 表格</button>
          {props.owner && (
            <>
              <span className="sep" />
              <button title="插入图片，也可以直接粘贴截图或把图片拖进来" onClick={() => act('image')}>🖼 图片</button>
              <button className={rec ? 'on rec' : ''} title="用麦克风录音" onClick={() => (rec ? rec.mr.stop() : act('record'))}>{rec ? '■ 停止' : '🎙 录音'}</button>
              <button title="插入视频" onClick={() => act('video')}>🎬 视频</button>
              <button title="放一份文件进来（复制）" onClick={() => act('file')}>📎 附件</button>
              <button title="引用资料库或项目里的文件（不复制，文件删除时会提示）" onClick={() => act('ref')}>🔗 引用文件</button>
            </>
          )}
        </div>
      )}
      {rec && (
        <div className="rec-bar">
          <span className="rec-dot" /> 正在录音 {fmtDur(now - rec.start)}
          <button className="btn small primary" onClick={() => rec.mr.stop()}>完成并插入</button>
          <button className="btn small" onClick={() => ((rec.cancel = true), rec.mr.stop())}>取消</button>
        </div>
      )}
      <EditorContent editor={editor} className="kb-editor" />
      {picking && (
        <RefPicker
          onClose={() => setPicking(false)}
          onPick={(refs) => {
            setPicking(false)
            const e = editorRef.current
            if (!e) return
            afterSelectedNode(e)
            const content: any[] = []
            refs.forEach((attrs, i) => content.push(...(i ? [{ type: 'text', text: ' ' }] : []), { type: 'fileRef', attrs }))
            e.chain().focus().insertContent([...content, { type: 'text', text: ' ' }]).run()
          }}
        />
      )}
      {link && links.length > 0 && (
        <div className="ctx" style={{ left: link.x, top: link.y, maxHeight: 320, overflow: 'auto', minWidth: 220 }} onMouseDown={(e) => e.preventDefault()}>
          <div className="faint" style={{ fontSize: 11, padding: '2px 10px' }}>链接到页面</div>
          {links.map((it, i) => (
            <button key={(it.id || 'new') + i} className={'ctx-item' + (i === link.index ? ' hover' : '')} onClick={() => insertLink(editor!, it)}>
              {it.create ? `＋ 新建页面「${it.title}」` : it.title || '无标题'}
            </button>
          ))}
        </div>
      )}
      {slash && list.length > 0 && (
        <div className="ctx" style={{ left: slash.x, top: slash.y, maxHeight: 320, overflow: 'auto' }} onMouseDown={(e) => e.preventDefault()}>
          {list.map((c, i) => (
            <button key={c.label} className={'ctx-item' + (i === slash.index ? ' hover' : '')} onClick={() => runSlash(editor!, c)}>
              {c.label}
              <span className="faint" style={{ float: 'right', marginLeft: 16, fontSize: 11 }}>{c.hint}</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
})

export default KbEditor

/** 选中的是一张图片 / 一段录音这类整块内容时，把光标挪到它后面，免得新插入的内容把它替换掉 */
function afterSelectedNode(e: Editor) {
  const sel: any = e.state.selection
  if (sel.node) e.commands.setTextSelection(sel.to)
}
