import { extOf } from './lib'
import type { TNode } from './pages/MindMap'

// 版本归组：同一文件夹里「方案.docx」「方案最终版.docx」「方案最终版(真的不改了).docx」
// 这类文件名去掉版本字样后相同，就收进同一个版本组节点。只改显示，不动磁盘。

const GROUPABLE = ['doc', 'docx', 'wps', 'xls', 'xlsx', 'et', 'pdf', 'dwg', 'dxf', 'ppt', 'pptx', 'dps', 'skp', 'rvt', 'md', 'txt', 'ofd']

const VERSION_WORDS = [
  '真的不改了', '征求意见稿', '最终版', '最终稿', '终版', '终稿', '定稿', '确认版', '完整版',
  '修改版', '修改稿', '修订版', '修订稿', '修订', '修改', '改稿', '初稿', '送审稿', '送审版',
  '报批稿', '报批版', '汇报版', '汇报稿', '新版', '旧版', '副本', '备份', '最终', '最新'
]

export function versionKey(name: string) {
  const ext = extOf(name)
  if (!GROUPABLE.includes(ext)) return null
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name
  let s = stem
  let hadMarker = false
  const cut = (re: RegExp) => {
    const t = s.replace(re, '')
    if (t !== s) hadMarker = true
    s = t
  }
  cut(/[（(][^）)]*[）)]/g) // 括号里的说明
  cut(/[【\[][^】\]]*[】\]]/g)
  cut(/(19|20)\d{2}[-._年]?\d{1,2}[-._月]?\d{1,2}日?/g) // 日期
  cut(/[-_\s]?[vV]\s?\d+(\.\d+)*/g) // v2、V3.1
  cut(/第?[一二三四五六七八九十\d]+稿/g)
  for (const w of VERSION_WORDS) cut(new RegExp(w, 'g'))
  // 去掉了版本字样后，末尾剩下的编号也算版本号（方案最终版2）
  if (hadMarker) s = s.replace(/[-_\s.]*\d{1,3}$/, '')
  s = s.replace(/[-_\s.·]+/g, '').toLowerCase()
  if (!s) s = stem.toLowerCase()
  return s + '.' + ext
}

export function groupVersions(node: TNode, meta: Record<string, any>): TNode {
  if (!node.dir || node.virtual) return node
  const kids = (node.children || []).map((c) => (c.dir ? groupVersions(c, meta) : c))
  const groups = new Map<string, TNode[]>()
  for (const c of kids) {
    if (c.dir || c.virtual || meta[c.rel]?.noGroup) continue
    const k = versionKey(c.name)
    if (!k) continue
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(c)
  }
  const out: TNode[] = []
  const placed = new Set<string>()
  for (const c of kids) {
    const k = !c.dir && !c.virtual && !meta[c.rel]?.noGroup ? versionKey(c.name) : null
    const g = k ? groups.get(k)! : null
    if (!g || g.length < 2) {
      out.push(c)
      continue
    }
    if (placed.has(k!)) continue
    placed.add(k!)
    const sorted = [...g].sort((a, b) => a.mtime - b.mtime)
    const members = sorted.map((f, i) => ({ ...f, version: i + 1 }))
    const latest = members[members.length - 1]
    const finalOne = members.find((f) => meta[f.rel]?.tag === '定稿')
    out.push({
      name: latest.name,
      rel: (node.rel ? node.rel + '/' : '') + '~v~' + k,
      dir: true,
      virtual: 'versions',
      mtime: latest.mtime,
      fileCount: members.length,
      finalVersion: finalOne?.version,
      children: members
    })
  }
  return { ...node, children: out }
}

/** 把引用节点挂到它所在的文件夹下 */
export function injectRefs(tree: TNode, refs: any[]): TNode {
  if (!refs?.length) return tree
  const byParent = new Map<string, any[]>()
  const dirs = new Set<string>()
  const walk = (n: TNode) => {
    if (n.dir) {
      dirs.add(n.rel)
      n.children?.forEach(walk)
    }
  }
  walk(tree)
  for (const r of refs) {
    const parent = dirs.has(r.parentRel) ? r.parentRel : ''
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent)!.push(r)
  }
  const copy = (n: TNode): TNode => {
    if (!n.dir || n.virtual) return n
    const extra = (byParent.get(n.rel) || []).map((r): TNode => {
      const rel = (n.rel ? n.rel + '/' : '') + '~ref~' + r.id
      return {
        name: r.name,
        rel,
        dir: !!r.dir && r.exists,
        virtual: 'ref',
        refId: r.id,
        refPath: r.path,
        refExists: r.exists,
        mtime: r.mtime || 0,
        size: r.size,
        fileCount: r.fileCount,
        children: r.dir && r.exists ? (r.tree || []).map((c: any) => refChild(c, rel, r.path)) : undefined
      }
    })
    return { ...n, children: [...(n.children || []).map(copy), ...extra] }
  }
  return copy(tree)
}

/** 引用文件夹里面的子文件夹和文件：也是引用节点（指向原位置），但不能单独移除 */
function refChild(c: any, parentRel: string, parentAbs: string): TNode {
  const rel = parentRel + '/' + c.name
  const abs = parentAbs.replace(/[\\/]+$/, '') + '\\' + c.name
  return {
    name: c.name,
    rel,
    dir: c.dir,
    virtual: 'ref',
    refPath: abs,
    refExists: true,
    refSub: true,
    mtime: c.mtime || 0,
    size: c.size,
    fileCount: c.fileCount,
    children: c.dir ? (c.children || []).map((x: any) => refChild(x, rel, abs)) : undefined
  }
}
