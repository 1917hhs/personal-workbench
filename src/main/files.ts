import fs from 'fs'
import path from 'path'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'

export const CATEGORIES: Record<string, string[]> = {
  doc: ['doc', 'docx', 'wps', 'txt', 'md', 'rtf', 'odt'],
  sheet: ['xls', 'xlsx', 'xlsm', 'csv', 'et', 'ods'],
  pdf: ['pdf', 'ofd'],
  drawing: ['dwg', 'dxf', 'dwf', 'rvt', 'skp', '3dm', 'shp', 'kml', 'kmz', 'geojson'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'svg', 'heic'],
  video: ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'webm', 'mp3', 'wav', 'm4a']
}

export function extOf(name: string) {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function categoryOf(name: string) {
  const e = extOf(name)
  for (const [k, list] of Object.entries(CATEGORIES)) if (list.includes(e)) return k
  return 'other'
}

/** 把 "*.bak"、"temp/" 这类规则编译成判断函数。以 / 结尾的只匹配文件夹。 */
export function compileHide(patterns: string[]) {
  const rules = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const dirOnly = p.endsWith('/')
      const body = dirOnly ? p.slice(0, -1) : p
      const re = new RegExp(
        '^' + body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
        'i'
      )
      return { dirOnly, re }
    })
  return (name: string, isDir: boolean) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(name))
}

export interface TreeNode {
  name: string
  rel: string
  dir: boolean
  mtime: number
  size?: number
  fileCount?: number
  hiddenCount?: number
  hidden?: boolean
  children?: TreeNode[]
}

const collator = new Intl.Collator('zh-CN', { numeric: true })

/** 扫描项目文件夹，得到导图用的树。 */
export function scanTree(
  root: string,
  isHidden: (name: string, isDir: boolean) => boolean,
  metaNodes: Record<string, any>,
  showHidden: boolean,
  limit = 30000
) {
  let count = 0
  let hiddenTotal = 0
  const flat: { rel: string; name: string; dir: boolean }[] = []

  function walk(abs: string, rel: string, depth: number): TreeNode {
    const node: TreeNode = { name: path.basename(abs), rel, dir: true, mtime: 0, fileCount: 0, hiddenCount: 0, children: [] }
    try {
      node.mtime = fs.statSync(abs).mtimeMs
    } catch {}
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return node
    }
    for (const e of entries) {
      if (count > limit) break
      const isDir = e.isDirectory()
      const childRel = rel ? rel + '/' + e.name : e.name
      const hidden = isHidden(e.name, isDir) || !!metaNodes[childRel]?.hidden
      if (hidden) {
        node.hiddenCount!++
        hiddenTotal++
        if (!showHidden) continue
      }
      count++
      const childAbs = path.join(abs, e.name)
      if (isDir) {
        if (depth > 40) continue
        const c = walk(childAbs, childRel, depth + 1)
        c.hidden = hidden
        node.fileCount! += c.fileCount!
        node.children!.push(c)
        flat.push({ rel: childRel, name: e.name, dir: true })
      } else {
        let st: fs.Stats | null = null
        try {
          st = fs.statSync(childAbs)
        } catch {}
        node.children!.push({ name: e.name, rel: childRel, dir: false, mtime: st?.mtimeMs || 0, size: st?.size || 0, hidden })
        if (!hidden) node.fileCount!++
        flat.push({ rel: childRel, name: e.name, dir: false })
      }
    }
    node.children!.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1))
    // 文件夹的修改时间取其中最新的一项，更能反映「最近动过」
    for (const c of node.children!) if (c.mtime > node.mtime) node.mtime = c.mtime
    return node
  }

  const tree = walk(root, '', 0)
  return { tree, flat, hiddenTotal, truncated: count > limit }
}

/** 把相对路径拼成绝对路径，并确认没有跑出项目根目录。 */
export function safeJoin(root: string, rel: string) {
  const base = path.resolve(root)
  const abs = path.resolve(base, rel || '')
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('路径超出项目文件夹')
  return abs
}

export function uniqueTarget(dir: string, name: string) {
  let target = path.join(dir, name)
  if (!fs.existsSync(target)) return target
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 2; ; i++) {
    target = path.join(dir, `${stem} (${i})${ext}`)
    if (!fs.existsSync(target)) return target
  }
}

export function importPaths(destDir: string, paths: string[], mode: 'move' | 'copy') {
  const done: string[] = []
  for (const p of paths) {
    const target = uniqueTarget(destDir, path.basename(p))
    if (mode === 'copy') {
      fs.cpSync(p, target, { recursive: true })
    } else {
      try {
        fs.renameSync(p, target)
      } catch (e: any) {
        if (e.code !== 'EXDEV') throw e
        fs.cpSync(p, target, { recursive: true })
        fs.rmSync(p, { recursive: true, force: true })
      }
    }
    done.push(target)
  }
  return done
}

const TEXT_EXT = ['txt', 'md', 'csv', 'json', 'xml', 'log', 'ini', 'yaml', 'yml', 'geojson', 'kml', 'py', 'js', 'ts', 'bat', 'ps1']

export function fileUrl(abs: string) {
  return 'lf://file/?p=' + encodeURIComponent(abs)
}

/** 生成侧栏预览所需的数据。DWG 不预览，只给元信息。 */
export async function previewData(abs: string) {
  const e = extOf(abs)
  const cat = categoryOf(abs)
  if (cat === 'image' && e !== 'heic' && e !== 'tif' && e !== 'tiff') return { kind: 'image', url: fileUrl(abs) }
  if (e === 'pdf') return { kind: 'pdf', url: fileUrl(abs) }
  if (['mp4', 'webm', 'mov', 'm4v'].includes(e)) return { kind: 'video', url: fileUrl(abs) }
  if (['mp3', 'wav', 'm4a', 'ogg'].includes(e)) return { kind: 'audio', url: fileUrl(abs) }
  if (e === 'docx') {
    const r = await mammoth.convertToHtml({ path: abs })
    return { kind: 'html', html: r.value }
  }
  if (['xlsx', 'xls', 'xlsm', 'ods', 'et'].includes(e)) {
    const wb = XLSX.readFile(abs, { sheetRows: 200 })
    const html = wb.SheetNames.slice(0, 5)
      .map((n) => `<h4>${n.replace(/</g, '&lt;')}</h4>` + XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' }))
      .join('')
    return { kind: 'html', html, note: '每个工作表最多显示前 200 行' }
  }
  if (TEXT_EXT.includes(e)) {
    const fd = fs.openSync(abs, 'r')
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 300 * 1024))
    fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    return { kind: 'text', text: buf.toString('utf8') }
  }
  return { kind: 'none' }
}
