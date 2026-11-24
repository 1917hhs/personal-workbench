import { createContext, useContext } from 'react'

declare global {
  interface Window {
    api: {
      call: (channel: string, ...args: any[]) => Promise<any>
      send: (channel: string, ...args: any[]) => void
      on: (channel: string, cb: (...a: any[]) => void) => () => void
      pathForFile: (f: File) => string
      startDrag: (id: string, rel: string) => void
      startDragAbs: (p: string) => void
    }
  }
}

export const api = window.api

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

/**
 * 解析经纬度（WGS-84），支持：
 *   39.7528, 37.0179 ／ 39.7528 37.0179（先纬度后经度，和谷歌地图一致）
 *   39°45'10"N 37°01'05"E ／ N39°45'10" E37°1'5" ／ 39 45 10, 37 1 5（度分秒）
 *   北纬39.75 东经37.01 ／ 37.0179E 39.7528N（带方向时顺序不限）
 * 解析不了返回 null
 */
export function parseLatLng(input: string): { lat: number; lng: number; swapped?: boolean } | null {
  let s = String(input || '')
    .toUpperCase()
    .replace(/北纬/g, 'N').replace(/南纬/g, 'S').replace(/东经/g, 'E').replace(/西经/g, 'W')
    .replace(/，/g, ',').replace(/[：:]/g, ' ')
  const tokens = s.match(/-?\d+(?:\.\d+)?|[NSEW]/g)
  if (!tokens) return null
  const hasDir = tokens.some((t) => /[NSEW]/.test(t))
  const groups: { nums: number[]; dir?: string }[] = []
  if (hasDir) {
    const prefix = /[NSEW]/.test(tokens[0])
    let g: { nums: number[]; dir?: string } = { nums: [] }
    for (const t of tokens) {
      if (/[NSEW]/.test(t)) {
        if (prefix) {
          if (g.nums.length || g.dir) groups.push(g)
          g = { nums: [], dir: t }
        } else {
          g.dir = t
          groups.push(g)
          g = { nums: [] }
        }
      } else g.nums.push(Number(t))
    }
    if (g.nums.length) groups.push(g)
  } else {
    const n = tokens.map(Number)
    const per = n.length === 2 ? 1 : n.length === 4 ? 2 : n.length === 6 ? 3 : 0
    if (!per) return null
    groups.push({ nums: n.slice(0, per) }, { nums: n.slice(per) })
  }
  if (groups.length !== 2 || groups.some((g) => !g.nums.length || g.nums.length > 3)) return null
  const val = (g: { nums: number[]; dir?: string }) => {
    const [d, m = 0, sec = 0] = g.nums
    if (m < 0 || m >= 60 || sec < 0 || sec >= 60) return NaN
    const v = Math.abs(d) + m / 60 + sec / 3600
    return (d < 0 || g.dir === 'S' || g.dir === 'W' ? -1 : 1) * v
  }
  let lat: number, lng: number, swapped = false
  const [a, b] = groups
  if (a.dir && b.dir) {
    const aLat = a.dir === 'N' || a.dir === 'S'
    const bLat = b.dir === 'N' || b.dir === 'S'
    if (aLat === bLat) return null
    lat = val(aLat ? a : b)
    lng = val(aLat ? b : a)
  } else {
    lat = val(a)
    lng = val(b)
    // 第一个超出纬度范围、第二个没超：多半是写成了「经度, 纬度」
    if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
      ;[lat, lng] = [lng, lat]
      swapped = true
    }
  }
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), ...(swapped ? { swapped } : {}) }
}

/** 经纬度显示成「39.752800, 37.017900」和度分秒两种 */
export function fmtLatLng(lat: number, lng: number) {
  const dms = (v: number, pos: string, neg: string) => {
    const a = Math.abs(v)
    const d = Math.floor(a)
    const m = Math.floor((a - d) * 60)
    const s = ((a - d) * 60 - m) * 60
    return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″${v >= 0 ? pos : neg}`
  }
  return { dec: `${lat.toFixed(6)}, ${lng.toFixed(6)}`, dms: `${dms(lat, 'N', 'S')} ${dms(lng, 'E', 'W')}` }
}

const p2 = (n: number) => String(n).padStart(2, '0')

/** 本地日期 YYYY-MM-DD */
export function ymd(d: Date = new Date()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

export function addDays(s: string, n: number) {
  const d = new Date(s + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return ymd(d)
}

/** 本周日（周一为一周第一天） */
export function endOfWeek(s: string = ymd()) {
  const d = new Date(s + 'T00:00:00')
  const dow = (d.getDay() + 6) % 7
  return addDays(s, 6 - dow)
}

export function daysBetween(a: string, b: string) {
  return Math.round((new Date(b + 'T00:00:00').getTime() - new Date(a + 'T00:00:00').getTime()) / 86400000)
}

export function fmtTime(ms: number | string | undefined) {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

export function fmtSize(n?: number) {
  if (n === undefined) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}

export const CATS: { id: string; name: string; exts: string[]; color: string }[] = [
  { id: 'doc', name: '文档', exts: ['doc', 'docx', 'wps', 'txt', 'md', 'rtf', 'odt'], color: '#2563eb' },
  { id: 'sheet', name: '表格', exts: ['xls', 'xlsx', 'xlsm', 'csv', 'et', 'ods'], color: '#16a34a' },
  { id: 'pdf', name: 'PDF', exts: ['pdf', 'ofd'], color: '#dc2626' },
  { id: 'drawing', name: '图纸', exts: ['dwg', 'dxf', 'dwf', 'rvt', 'skp', '3dm', 'shp', 'kml', 'kmz', 'geojson'], color: '#7c3aed' },
  { id: 'image', name: '图片', exts: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'svg', 'heic'], color: '#0891b2' },
  { id: 'video', name: '视频', exts: ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'webm', 'mp3', 'wav', 'm4a'], color: '#db2777' }
]

export function extOf(name: string) {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function catOf(name: string) {
  const e = extOf(name)
  return CATS.find((c) => c.exts.includes(e)) || null
}

export function errMsg(e: any) {
  const m = String(e?.message || e)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// ---------- 全局数据 ----------
export interface AppData {
  settings: any
  projects: any[]
  todos: any[]
  stickies: any[]
  contacts: any[]
  library: any[]
  focus: any[]
  companies: any[]
  inquiries: any[]
  flows: any[]
  libraryDir: string
  root: string
  backupDir: string
  companyDir: string
  migratedFrom: string | null
  loadProblems: string[]
  dataDir: string
  version: string
}

export interface Nav {
  page: 'home' | 'projects' | 'project' | 'todos' | 'contacts' | 'library' | 'kb' | 'map' | 'flows' | 'inquiries' | 'settings'
  inquiryId?: string
  flowId?: string
  companyId?: string
  date?: string
  settingsSection?: string
  projectId?: string
  pageId?: string
  libraryId?: string
  select?: string
  tab?: 'map' | 'detail'
  contactId?: string
}

export interface Ctx {
  data: AppData
  setData: (patch: Partial<AppData>) => void
  nav: Nav
  go: (n: Nav) => void
  saveProject: (p: any) => Promise<void>
  saveTodo: (t: any) => Promise<void>
  deleteTodo: (id: string) => Promise<void>
  saveSettings: (s: any) => Promise<void>
  saveContact: (c: any) => Promise<void>
  /** 保存单位 / 询价 / 流程 */
  saveItem: (kind: 'companies' | 'inquiries' | 'flows', x: any) => Promise<any>
  deleteItem: (kind: 'companies' | 'inquiries' | 'flows', id: string) => Promise<void>
  /** 底部提示；带 action 时显示一个按钮（如「撤销」） */
  toast: (msg: string, action?: { label: string; run: () => void }) => void
}

export function joinPath(root: string, rel: string) {
  return rel ? root.replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\') : root
}

export const normPath = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** 「复制为引用」的内容：项目里或资料库里都可以复制，再到项目文件夹上「粘贴引用」 */
export const clip = { ref: null as string | null }

/** 关窗口前要先存掉的东西（编辑器里还没到时间自动保存的内容）。关窗口时主进程会等它们都存完 */
export const flushers = new Set<() => Promise<any> | void>()

export const AppCtx = createContext<Ctx>(null as any)
export const useApp = () => useContext(AppCtx)

export function stageOf(settings: any, id: string) {
  return settings.stages.find((s: any) => s.id === id) || settings.stages[0]
}

export function isArchived(settings: any, p: any) {
  const last = settings.stages[settings.stages.length - 1]
  return p.stage === last?.id
}

/** 需要关注：未归档，且截止日期在 14 天内或已逾期 */
export function needsAttention(settings: any, p: any) {
  if (!p.deadline || isArchived(settings, p)) return false
  return daysBetween(ymd(), p.deadline) <= 14
}

export function isActive(settings: any, p: any) {
  return !isArchived(settings, p) && !['暂停', '未成交'].includes(p.status)
}

/** 删除文件前的提示：被哪些备忘录引用了（memo:findRefs 的结果） */
export const refWarn = (refs: { title: string; files: string[] }[]) =>
  refs?.length
    ? `\n\n⚠ 注意：下面 ${refs.length} 处引用了${refs.some((r) => r.files.length > 1) ? '它或它里面的文件' : '它'}，删除后那里的引用会失效：\n` +
      refs
        .slice(0, 12)
        .map((r) => `· ${r.title}${r.files.length > 1 || r.files[0] ? `（${r.files.slice(0, 3).join('、')}${r.files.length > 3 ? ' 等' : ''}）` : ''}`)
        .join('\n') +
      (refs.length > 12 ? `\n…还有 ${refs.length - 12} 处` : '')
    : ''