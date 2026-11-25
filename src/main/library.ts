import fs from 'fs'
import path from 'path'
import type { Store } from './store'
import { uniqueTarget } from './files'

// 资料库：跨项目的规范标准、报告模板、收集的数据、影像资料。
// 导入时把文件复制进「资料库文件夹」，按类型放在子文件夹里；原文件以后移动、删除都不影响。

const STD_RE =
  /^\s*((?:GB\/T|GB\/Z|GB|CJJ\/T|CJJ|JGJ\/T|JGJ|SL\/T|SL|DB\d*\/T|DB\d*|CJ\/T|CJ|HJ|JTG\/T|JTG|JTJ|TB|DL\/T|DL|NB\/T|NB|CECS|T\/[A-Z]+)\s*[\d.]+\s*[-—–]\s*(?:\d{4}|\d{2}))(?!\d)\s*[-_—]?\s*(.*)$/i

/** 从文件名里认出规范编号，如「GB 50201-2014 防洪标准.pdf」 */
export function parseName(filename: string) {
  const stem = filename.replace(/\.[^.]+$/, '')
  const m = STD_RE.exec(stem)
  if (!m) return { code: '', name: stem }
  return { code: m[1].replace(/\s+/g, ' ').replace(/[—–]/g, '-').trim(), name: m[2].trim() || m[1].trim() }
}

const clean = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_')

function walkFiles(p: string, out: string[] = []) {
  const st = fs.statSync(p)
  if (st.isFile()) out.push(p)
  else if (st.isDirectory()) for (const e of fs.readdirSync(p)) walkFiles(path.join(p, e), out)
  return out
}

export function libAbs(store: Store, item: any) {
  return path.join(store.libraryDir, item.file)
}

export function importToLibrary(store: Store, paths: string[], typeId: string) {
  const type = store.settings.libraryTypes.find((t: any) => t.id === typeId) || store.settings.libraryTypes[0]
  const dir = path.join(store.libraryDir, clean(type?.name || '其他资料'))
  fs.mkdirSync(dir, { recursive: true })
  const added: any[] = []
  for (const p of paths.flatMap((x) => walkFiles(x))) {
    const target = uniqueTarget(dir, path.basename(p))
    fs.copyFileSync(p, target)
    const { code, name } = parseName(path.basename(p))
    const now = new Date().toISOString()
    added.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name,
      code,
      type: type?.id,
      date: '',
      tags: [],
      status: '现行',
      supersededBy: '',
      note: '',
      file: path.relative(store.libraryDir, target).split(path.sep).join('/'),
      size: fs.statSync(target).size,
      createdAt: now,
      updatedAt: now
    })
  }
  store.library.push(...added)
  store.save('library')
  return added
}

// 资料库文件夹里不算资料的文件：系统文件、Office 临时文件、下载 / 上传中的半成品
const JUNK = /^(desktop\.ini|thumbs\.db|\.ds_store)$|^~\$|^\.|\.(tmp|partial|crdownload|part)$|\.baiduyun\.(uploading|downloading)\.cfg$/i

// 资料库文件夹下由别的功能管理的子文件夹：没关联项目的询价 / 回价文件、旧版的供应商资料。不算资料库的资料
const MANAGED = /^(询价文件|回价文件|供应商资料)$/

function listLibraryFiles(root: string) {
  const out: { rel: string; size: number }[] = []
  if (!fs.existsSync(root)) return out
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (JUNK.test(e.name)) continue
      if (!rel && e.isDirectory() && MANAGED.test(e.name)) continue
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walk(r)
      else if (e.isFile()) out.push({ rel: r, size: fs.statSync(path.join(root, r)).size })
    }
  }
  walk('')
  return out
}

/**
 * 对照资料库文件夹检查列表：
 * - 文件在资料库文件夹里被挪动 / 改名（同名或同大小只有一个能对上）→ 直接更新路径
 * - 文件找不到了 → missing，交给界面问要不要从列表里移除
 * - 文件夹里有、列表里没有的文件 → untracked，交给界面问要不要加进来
 */
export function scanLibrary(store: Store) {
  const files = listLibraryFiles(store.libraryDir)
  const known = new Set(store.library.map((x) => String(x.file).toLowerCase()))
  let untracked = files.filter((f) => !known.has(f.rel.toLowerCase()))
  const moved: string[] = []
  const missing: any[] = []
  for (const item of store.library) {
    if (fs.existsSync(libAbs(store, item))) continue
    const base = path.posix.basename(String(item.file)).toLowerCase()
    const byName = untracked.filter((f) => path.posix.basename(f.rel).toLowerCase() === base)
    // 只按大小认：文件太小容易撞上别的文件，认错了以后删这条资料会把别的文件删掉，所以小文件不按大小认
    const bySize = item.size >= 8192 ? untracked.filter((f) => f.size === item.size && path.extname(f.rel).toLowerCase() === path.extname(base)) : []
    const hit = byName.length === 1 ? byName[0] : bySize.length === 1 ? bySize[0] : null
    if (hit) {
      item.file = hit.rel
      item.updatedAt = new Date().toISOString()
      untracked = untracked.filter((f) => f !== hit)
      moved.push(item.name)
    } else missing.push({ id: item.id, name: item.name, code: item.code || '', file: item.file })
  }
  if (moved.length) store.save('library')
  return { missing, untracked: untracked.map((f) => f.rel), moved, library: store.library }
}

/** 按检查结果整理：移除文件已不在的条目；把文件夹里新放进来的文件登记成资料（不再复制） */
export function applyLibraryScan(store: Store, removeIds: string[], addRels: string[]) {
  const rm = new Set(removeIds || [])
  store.library = store.library.filter((x) => !rm.has(x.id))
  const types = store.settings.libraryTypes || []
  const now = new Date().toISOString()
  for (const rel of addRels || []) {
    const abs = path.resolve(store.libraryDir, rel)
    if (!abs.toLowerCase().startsWith(path.resolve(store.libraryDir).toLowerCase() + path.sep)) continue
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile() || store.library.some((x) => String(x.file).toLowerCase() === rel.toLowerCase())) continue
    // 放在哪个类型的子文件夹里，就算哪个类型
    const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : ''
    const type = types.find((t: any) => clean(t.name) === top) || types.find((t: any) => t.name === '其他资料') || types[0]
    const { code, name } = parseName(path.basename(rel))
    store.library.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name,
      code,
      type: type?.id,
      date: '',
      tags: [],
      status: '现行',
      supersededBy: '',
      note: '',
      file: rel,
      size: fs.statSync(abs).size,
      createdAt: now,
      updatedAt: now
    })
  }
  store.save('library')
  return store.library
}

/** 资料类型改名：类型名同时也是资料库里的子文件夹名，文件夹跟着改，资料的路径一起更新 */
export function renameLibraryType(store: Store, id: string, newName: string) {
  const types = store.settings.libraryTypes || []
  const t = types.find((x: any) => x.id === id)
  if (!t) throw new Error('找不到这个类型')
  const name = String(newName || '').trim()
  if (!name) throw new Error('类型名不能为空')
  if (types.some((x: any) => x.id !== id && x.name === name)) throw new Error(`已经有「${name}」了`)
  const from = clean(t.name)
  const to = clean(name)
  if (!to) throw new Error('类型名不能只有特殊字符')
  if (MANAGED.test(to)) throw new Error(`「${to}」是别的功能在用的文件夹名，换一个`)
  const fromAbs = path.join(store.libraryDir, from)
  const toAbs = path.join(store.libraryDir, to)
  const sameFolder = from.toLowerCase() === to.toLowerCase()
  if (from !== to && fs.existsSync(fromAbs)) {
    if (!sameFolder && fs.existsSync(toAbs)) throw new Error(`资料库里已经有「${to}」文件夹了，先把它挪走或换个名字`)
    fs.renameSync(fromAbs, toAbs)
    const pre = from.toLowerCase() + '/'
    for (const item of store.library) {
      const f = String(item.file)
      if (f.toLowerCase().startsWith(pre)) item.file = to + f.slice(from.length)
    }
    store.save('library')
  }
  t.name = name
  store.save('settings')
  return { settings: store.settings, library: store.library }
}

/** 某个类型在资料库里的子文件夹（没有就建一个） */
export function libraryTypeDir(store: Store, id: string) {
  const t = (store.settings.libraryTypes || []).find((x: any) => x.id === id)
  if (!t) throw new Error('找不到这个类型')
  const dir = path.join(store.libraryDir, clean(t.name))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 换资料库文件夹：现有文件复制到新位置，原文件夹保留不动 */
export function moveLibraryDir(store: Store, dir: string) {
  const from = store.libraryDir
  const a = path.resolve(from).toLowerCase() + path.sep
  const b = path.resolve(dir).toLowerCase() + path.sep
  if (a !== b && (b.startsWith(a) || a.startsWith(b))) throw new Error('新的资料库文件夹不能放在原资料库文件夹里面，也不能是它的上级文件夹')
  fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(from) && path.resolve(from) !== path.resolve(dir)) fs.cpSync(from, dir, { recursive: true, force: false })
  store.settings.libraryDir = dir
  store.save('settings')
}

/** 增量镜像：只复制新增或变化的文件，不删除目标里多出来的文件 */
export async function mirrorDir(src: string, dest: string) {
  if (!fs.existsSync(src)) return 0
  let n = 0
  const walk = async (rel: string) => {
    const s = path.join(src, rel)
    for (const e of await fs.promises.readdir(s, { withFileTypes: true })) {
      const r = path.join(rel, e.name)
      if (e.isDirectory()) {
        await walk(r)
        continue
      }
      const a = await fs.promises.stat(path.join(src, r))
      const t = path.join(dest, r)
      try {
        const b = await fs.promises.stat(t)
        if (b.size === a.size && Math.abs(b.mtimeMs - a.mtimeMs) < 2000) continue
      } catch {}
      await fs.promises.mkdir(path.dirname(t), { recursive: true })
      await fs.promises.copyFile(path.join(src, r), t + '.partial')
      await fs.promises.rename(t + '.partial', t)
      await fs.promises.utimes(t, a.atime, a.mtime)
      n++
    }
  }
  await walk('')
  return n
}
