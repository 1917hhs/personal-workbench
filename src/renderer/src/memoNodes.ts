import { Node, mergeAttributes } from '@tiptap/core'

// 备忘录编辑器里的几种块：图片、录音 / 音频、视频，以及行内的文件引用。
// 媒体文件的地址是 lf://kbmedia/?p=<归属>/<文件名>（主进程按数据文件夹解析）。

export const MemoImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ src: { default: null }, alt: { default: '' }, width: { default: null } }),
  parseHTML: () => [{ tag: 'img[src]' }],
  renderHTML: ({ HTMLAttributes }) => ['img', mergeAttributes(HTMLAttributes, { class: 'memo-img' })]
})

export const MemoAudio = Node.create({
  name: 'audio',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ src: { default: null }, 'data-name': { default: '' } }),
  parseHTML: () => [{ tag: 'audio[src]' }],
  renderHTML: ({ HTMLAttributes }) => ['audio', mergeAttributes(HTMLAttributes, { controls: 'true', preload: 'metadata', class: 'memo-audio' })],
  // 编辑时在录音旁边多一个「转文字」按钮（只是界面，保存的仍是 <audio>）
  addNodeView:
    () =>
    ({ node, editor, getPos }) => {
      const dom = document.createElement('div')
      dom.className = 'memo-audio-wrap'
      dom.contentEditable = 'false'
      const audio = document.createElement('audio')
      audio.src = node.attrs.src
      audio.controls = true
      audio.preload = 'metadata'
      audio.className = 'memo-audio'
      const btn = document.createElement('button')
      btn.className = 'memo-audio-tr'
      btn.type = 'button'
      btn.textContent = '📝 转文字'
      btn.title = '用本机语音识别把这段录音转成文字，插在下面'
      btn.onmousedown = (e) => e.preventDefault()
      btn.onclick = async () => {
        if (btn.disabled) return
        btn.disabled = true
        btn.textContent = '识别中…'
        try {
          const { transcribeUrl } = await import('./asr')
          const text = await transcribeUrl(node.attrs.src, (done, total) => {
            if (total > 1) btn.textContent = `识别中 ${done}/${total}`
          })
          const pos = typeof getPos === 'function' ? getPos() : null
          if (!text.trim()) window.dispatchEvent(new CustomEvent('memo:toast', { detail: '没有识别出文字' }))
          else if (pos != null && editor.isEditable)
            editor
              .chain()
              .insertContentAt(pos + node.nodeSize, { type: 'paragraph', content: [{ type: 'text', text: text.trim() }] })
              .run()
        } catch (e: any) {
          const msg = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          window.dispatchEvent(new CustomEvent('memo:toast', { detail: msg }))
        } finally {
          btn.disabled = false
          btn.textContent = '📝 转文字'
        }
      }
      dom.append(audio, btn)
      return { dom, ignoreMutation: () => true, stopEvent: (e) => btn.contains(e.target as any) }
    }
})

export const MemoVideo = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ src: { default: null }, 'data-name': { default: '' } }),
  parseHTML: () => [{ tag: 'video[src]' }],
  renderHTML: ({ HTMLAttributes }) => ['video', mergeAttributes(HTMLAttributes, { controls: 'true', preload: 'metadata', class: 'memo-video' })]
})

/** 引用：资料库文件（lib）、项目文件（proj）、附件（att）。只记住文件在哪，不复制 */
export const FileRef = Node.create({
  name: 'fileRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    'data-ref': { default: 'lib' },
    'data-id': { default: null },
    'data-pid': { default: null },
    'data-rel': { default: null },
    'data-src': { default: null },
    'data-name': { default: '' },
    'data-sub': { default: '' }
  }),
  parseHTML: () => [{ tag: 'span[data-ref]' }],
  renderHTML: ({ HTMLAttributes }) => {
    const kind = HTMLAttributes['data-ref']
    const icon = kind === 'lib' ? '📚' : kind === 'proj' ? '📁' : '📎'
    const tip = kind === 'lib' ? '资料库' : kind === 'proj' ? '项目文件' : '附件'
    return ['span', mergeAttributes(HTMLAttributes, { class: 'file-ref ref-' + kind, title: `${tip}：${HTMLAttributes['data-sub'] || ''}${HTMLAttributes['data-name']}（点击打开）`, contenteditable: 'false' }), `${icon} ${HTMLAttributes['data-name'] || '文件'}`]
  }
})

/** 读出一个 DOM 元素上的引用信息 */
export const refOfEl = (el: Element) => ({
  kind: el.getAttribute('data-ref') || '',
  id: el.getAttribute('data-id') || undefined,
  pid: el.getAttribute('data-pid') || undefined,
  rel: el.getAttribute('data-rel') || undefined,
  src: el.getAttribute('data-src') || undefined,
  name: el.getAttribute('data-name') || ''
})

/** 正文 HTML 里的所有引用（界面上列出、检查是否失效） */
export function refsOfHtml(html: string) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html')
  return [...doc.querySelectorAll('span[data-ref]')].map(refOfEl)
}
