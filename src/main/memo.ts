import fs from 'fs'
import path from 'path'
import { BrowserWindow } from 'electron'
import type { Store } from './store'
import { readJson, writeJsonAtomic } from './store'
import { uniqueTarget } from './files'
import { listPages } from './kb'
import { libAbs } from './library'

// 备忘录（知识库页面）里插入的图片、录音、视频、附件，以及对资料库 / 项目文件的引用。
//
// 媒体文件放在 数据/kb/media/<归属>/，归属是备忘录 id。正文里用相对地址
//   lf://kbmedia/?p=<归属>/<文件名>
// 这样工作区整体搬家后也不会断。
//
// 引用写在正文 HTML 里的一个标签上（不复制文件，只记住它在哪）：
//   <span data-ref="lib"  data-id="<资料库条目 id>" data-name="...">        资料库文件
//   <span data-ref="proj" data-pid="<项目 id>" data-rel="<项目内相对路径>" data-name="...">  项目文件
//   <span data-ref="att"  data-src="lf://kbmedia/?p=..." data-name="...">   附件（复制进备忘录的其他文件）

export const mediaRoot = (s: Store) => path.join(s.dataDir, 'kb', 'media')
const safe = (s: string) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/[. ]+$/, '') || '未命名'
export const mediaUrl = (owner: string, name: string) => 'lf://kbmedia/?p=' + encodeURIComponent(safe(owner) + '/' + name)

/** lf://kbmedia/?p=... 换成磁盘上的绝对路径（只允许在 media 文件夹里） */
export function mediaAbs(store: Store, rel: string) {
  const root = mediaRoot(store)
  const p = path.resolve(root, rel)
  if (!p.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) throw new Error('路径不对')
  return p
}
export const urlToAbs = (store: Store, url: string) => {
  const m = String(url || '').match(/^lf:\/\/kbmedia\/?\?p=(.+)$/)
  return m ? mediaAbs(store, decodeURIComponent(m[1])) : null
}

const KIND: Record<string, string> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', mkv: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', aac: 'audio', flac: 'audio', opus: 'audio'
}
export const mediaKind = (name: string) => KIND[path.extname(name).slice(1).toLowerCase()] || 'file'

/** 把电脑上的文件复制进备忘录，返回 [{ name, url, kind }] */
export function importMedia(store: Store, owner: string, paths: string[]) {
  const dir = path.join(mediaRoot(store), safe(owner))
  fs.mkdirSync(dir, { recursive: true })
  return (paths || [])
    .filter((p) => p && fs.existsSync(p) && fs.statSync(p).isFile())
    .map((p) => {
      const target = uniqueTarget(dir, safe(path.basename(p)))
      fs.copyFileSync(p, target)
      const name = path.basename(target)
      return { name, url: mediaUrl(owner, name), kind: mediaKind(name) }
    })
}

/** 保存录音、粘贴的截图等（界面传来的是二进制内容） */
export function saveMedia(store: Store, owner: string, name: string, data: ArrayBuffer | Uint8Array, kind?: string) {
  const dir = path.join(mediaRoot(store), safe(owner))
  fs.mkdirSync(dir, { recursive: true })
  const target = uniqueTarget(dir, safe(name))
  fs.writeFileSync(target, Buffer.from(data as any))
  const n = path.basename(target)
  return { name: n, url: mediaUrl(owner, n), kind: kind || mediaKind(n) }
}

export function purgeMedia(store: Store, owner: string) {
  fs.rmSync(path.join(mediaRoot(store), safe(owner)), { recursive: true, force: true })
}

// ---------- 引用 ----------

export type RefTarget = { kind: 'lib'; id: string } | { kind: 'proj'; pid: string; rel: string }

const attr = (tag: string, k: string) => {
  const m = tag.match(new RegExp(`\\s${k}="([^"]*)"`))
  return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : ''
}
/** 取出一段 HTML 里的所有引用 */
export function refsIn(html: string) {
  const out: { kind: string; id?: string; pid?: string; rel?: string; name: string; src?: string }[] = []
  for (const m of String(html || '').matchAll(/<span[^>]*\sdata-ref="[^"]*"[^>]*>/g)) {
    const t = m[0]
    out.push({ kind: attr(t, 'data-ref'), id: attr(t, 'data-id'), pid: attr(t, 'data-pid'), rel: attr(t, 'data-rel'), src: attr(t, 'data-src'), name: attr(t, 'data-name') })
  }
  return out
}

const hits = (r: ReturnType<typeof refsIn>[number], t: RefTarget) =>
  t.kind === 'lib' ? r.kind === 'lib' && r.id === t.id : r.kind === 'proj' && r.pid === t.pid && (r.rel === t.rel || String(r.rel).startsWith(t.rel + '/'))

/**
 * 哪些备忘录引用了这个文件（项目里删文件夹时，文件夹里的文件被引用也算）。
 * 返回 [{ where: '备忘录', id, title, files: [被引用的文件名] }]
 */
export function findRefs(store: Store, t: RefTarget) {
  const out: { where: string; id: string; title: string; files: string[] }[] = []
  for (const p of listPages(store)) {
    if (p.deletedAt) continue
    const f = refsIn(p.html).filter((r) => hits(r, t))
    if (f.length) out.push({ where: '备忘录', id: p.id, title: p.title || '无标题', files: [...new Set(f.map((r) => r.name))] })
  }
  // 工作流程里「所需附件」引用的模板文件
  for (const fl of store.flows || []) {
    const f = flowRefs(fl).filter((r) => hits(r, t))
    if (f.length) out.push({ where: '流程', id: fl.id, title: '流程「' + (fl.name || '未命名') + '」', files: [...new Set(f.map((r) => r.name))] })
  }
  return out
}

/** 流程图里所有附件引用（节点和连线上的「所需附件」可以引用资料库 / 项目里的模板文件） */
function flowRefs(fl: any) {
  const out: ReturnType<typeof refsIn> = []
  for (const x of [...(fl.nodes || []), ...(fl.edges || [])])
    for (const a of x.attachments || []) {
      const r = a.ref
      if (r) out.push({ kind: r['data-ref'], id: r['data-id'], pid: r['data-pid'], rel: r['data-rel'], name: r['data-name'] || a.name })
    }
  return out
}

/** 一句话说明被哪里引用，没有就返回空字符串（AI 删除文件时附在结果里） */
export function refsWarning(store: Store, t: RefTarget) {
  const r = findRefs(store, t)
  return r.length ? `注意：这个文件被 ${r.map((x) => `「${x.title}」`).join('、')} 引用，删除后那里的引用会失效。` : ''
}

/** 引用的文件还在不在（界面上把失效的引用标出来） */
export function refStatus(store: Store, refs: { kind: string; id?: string; pid?: string; rel?: string; src?: string }[]) {
  return (refs || []).map((r) => {
    try {
      if (r.kind === 'lib') {
        const item = store.library.find((x) => x.id === r.id)
        return !!item && fs.existsSync(libAbs(store, item))
      }
      if (r.kind === 'proj') {
        const p = store.projects.find((x) => x.id === r.pid)
        return !!p?.rootPath && fs.existsSync(path.join(p.rootPath, r.rel || ''))
      }
      if (r.kind === 'att') {
        const a = urlToAbs(store, r.src || '')
        return !!a && fs.existsSync(a)
      }
    } catch {}
    return false
  })
}

/** 打开引用的文件；找不到时报错说明 */
export function refPath(store: Store, r: { kind: string; id?: string; pid?: string; rel?: string; src?: string; name?: string }) {
  let p: string | null = null
  if (r.kind === 'lib') {
    const item = store.library.find((x) => x.id === r.id)
    if (!item) throw new Error(`资料库里已经没有「${r.name}」了`)
    p = libAbs(store, item)
  } else if (r.kind === 'proj') {
    const pr = store.projects.find((x) => x.id === r.pid)
    if (!pr?.rootPath) throw new Error('找不到这个文件所在的项目')
    p = path.join(pr.rootPath, r.rel || '')
  } else if (r.kind === 'att') p = urlToAbs(store, r.src || '')
  if (!p || !fs.existsSync(p)) throw new Error(`文件「${r.name}」已经不在了`)
  return p
}

/** 项目里的文件改名 / 移动后，备忘录里指向它的引用跟着改 */
export function renameProjectRefs(store: Store, pid: string, from: string, to: string) {
  const fix = renameFixer(pid, from, to)
  const changed: string[] = []
  const pd = path.join(store.dataDir, 'kb', 'pages')
  if (fs.existsSync(pd))
    for (const f of fs.readdirSync(pd).filter((x) => x.endsWith('.json'))) {
      const p = readJson<any>(path.join(pd, f), null)
      if (!p?.html || !p.html.includes('data-ref="proj"')) continue
      const html = fix(p.html)
      if (html !== p.html) {
        writeJsonAtomic(path.join(pd, f), { ...p, html })
        changed.push(p.id)
      }
    }
  // 流程图里引用的项目文件也跟着改
  let flowsChanged = false
  for (const fl of store.flows || [])
    for (const x of [...(fl.nodes || []), ...(fl.edges || [])])
      for (const a of x.attachments || []) {
        const r = a.ref
        if (!r || r['data-ref'] !== 'proj' || r['data-pid'] !== pid) continue
        const rel = r['data-rel'] || ''
        if (rel !== from && !rel.startsWith(from + '/')) continue
        r['data-rel'] = to + rel.slice(from.length)
        if (rel === from) r['data-name'] = path.basename(r['data-rel'])
        flowsChanged = true
      }
  if (flowsChanged) {
    store.save('flows')
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('data:changed')
  }
  // 正打开着的备忘录要重新载入，否则编辑器里的旧内容会把改好的路径存回去
  if (changed.length) for (const w of BrowserWindow.getAllWindows()) w.webContents.send('kb:changed', changed)
}

function renameFixer(pid: string, from: string, to: string) {
  const fix = (html: string) =>
    String(html || '').replace(/<span[^>]*\sdata-ref="proj"[^>]*>/g, (tag) => {
      if (attr(tag, 'data-pid') !== pid) return tag
      const rel = attr(tag, 'data-rel')
      if (rel !== from && !rel.startsWith(from + '/')) return tag
      const nr = to + rel.slice(from.length)
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      return tag.replace(/\sdata-rel="[^"]*"/, ` data-rel="${esc(nr)}"`).replace(/\sdata-name="[^"]*"/, (m) => (rel === from ? ` data-name="${esc(path.basename(nr))}"` : m))
    })
  return fix
}
