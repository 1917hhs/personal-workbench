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

/** 换资料库文件夹：现有文件复制到新位置，原文件夹保留不动 */
export function moveLibraryDir(store: Store, dir: string) {
  const from = store.libraryDir
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
