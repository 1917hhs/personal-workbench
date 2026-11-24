import fs from 'fs'
import path from 'path'
import type { Store } from './store'
import { readJson, writeJsonAtomic } from './store'

// 知识库：每个页面一个 JSON 文件（kb/pages/<id>.json），正文是编辑器生成的 HTML。
// 历史版本放在 kb/history/<id>/，编辑时每隔 5 分钟自动存一份，也可以手动存一个有名字的版本。

const AUTO_EVERY_MS = 5 * 60 * 1000
const KEEP_AUTO = 50
const TRASH_DAYS = 30

const pagesDir = (s: Store) => path.join(s.dataDir, 'kb', 'pages')
const histDir = (s: Store, id: string) => path.join(s.dataDir, 'kb', 'history', id)
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

export function listPages(store: Store) {
  const dir = pagesDir(store)
  if (!fs.existsSync(dir)) seedGuide(store)
  const pages: any[] = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const p = readJson<any>(path.join(dir, f), null)
    if (p) pages.push(p)
  }
  // 回收站里超过 30 天的页面彻底删除
  const limit = Date.now() - TRASH_DAYS * 86400000
  for (const p of pages.filter((x) => x.deletedAt && new Date(x.deletedAt).getTime() < limit)) purgePage(store, p.id)
  return pages.filter((x) => !(x.deletedAt && new Date(x.deletedAt).getTime() < limit))
}

export function savePage(store: Store, page: any, versionName?: string) {
  const file = path.join(pagesDir(store), page.id + '.json')
  const old = readJson<any>(file, null)
  const now = new Date().toISOString()
  const next = { createdAt: now, ...old, ...page, updatedAt: now }
  writeJsonAtomic(file, next)
  // 正文有变化时，按时间间隔自动存历史版本；手动命名的版本随时存
  const changed = !old || old.html !== next.html || old.title !== next.title
  if (versionName || (changed && old)) {
    const hd = histDir(store, page.id)
    fs.mkdirSync(hd, { recursive: true })
    const list = fs.readdirSync(hd).sort()
    const lastAuto = list.filter((f) => !f.includes('__')).pop()
    const lastTime = lastAuto ? Number(lastAuto.replace('.json', '')) : 0
    if (versionName || Date.now() - lastTime > AUTO_EVERY_MS) {
      // 自动版本存的是「这次修改之前」的内容，命名版本存当前内容
      const snap = versionName ? next : old
      const name = versionName ? `${Date.now()}__${versionName.replace(/[\\/:*?"<>|]/g, '_')}.json` : `${Date.now()}.json`
      writeJsonAtomic(path.join(hd, name), { title: snap.title, html: snap.html, savedAt: now })
      const autos = fs.readdirSync(hd).filter((f) => !f.includes('__')).sort()
      for (const f of autos.slice(0, Math.max(0, autos.length - KEEP_AUTO))) fs.rmSync(path.join(hd, f), { force: true })
    }
  }
  return next
}

export function listHistory(store: Store, id: string) {
  const hd = histDir(store, id)
  if (!fs.existsSync(hd)) return []
  return fs
    .readdirSync(hd)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => {
      const [ts, name] = f.replace('.json', '').split('__')
      return { file: f, time: Number(ts), name: name || '' }
    })
}

export function readVersion(store: Store, id: string, file: string) {
  return readJson<any>(path.join(histDir(store, id), path.basename(file)), null)
}

export function purgePage(store: Store, id: string) {
  fs.rmSync(path.join(pagesDir(store), id + '.json'), { force: true })
  fs.rmSync(histDir(store, id), { recursive: true, force: true })
}

/** 第一次打开备忘录时放一条使用说明 */
function seedGuide(store: Store) {
  fs.mkdirSync(pagesDir(store), { recursive: true })
  const id = newId()
  const html = [
    '<p>备忘录随手记：会议要点、现场情况、电话内容、想法。这一条可以随便改、随便删。</p>',
    '<h2>能放什么</h2>',
    '<ul><li><p>文字、清单、表格：上面的工具栏，或在空行输入「/」</p></li><li><p>图片：直接粘贴截图，或把图片拖进来</p></li><li><p>录音：工具栏「🎙 录音」，录完自动插入</p></li><li><p>视频、附件：工具栏选择文件，会复制一份放进备忘录</p></li></ul>',
    '<h2>引用文件</h2>',
    '<p>工具栏「🔗 引用文件」可以引用资料库或项目里的文件，只记位置、不复制，点一下就能打开。这些文件被删除时，软件会提示被哪条备忘录引用了。</p>',
    '<h2>找内容</h2>',
    '<p>左上角搜索会同时搜标题、正文和引用的文件名；Ctrl+K 全局搜索也能搜到备忘录。点「📌 置顶」放到列表最上面。</p>'
  ].join('')
  savePage(store, { id, title: '开始使用备忘录', parentId: null, html })
}
