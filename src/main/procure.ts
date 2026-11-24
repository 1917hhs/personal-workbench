import fs from 'fs'
import path from 'path'
import type { Store } from './store'
import { uniqueTarget } from './files'

// 采购（单位 / 供应商、询价、发包、回价）在主进程里的公共逻辑：界面（ipc）和 AI 助手（mcp）共用。

export const INQ_STATUS = ['编制中', '询价中', '比价中', '已定标', '取消']
export const SEND_STATUS = ['已发送', '已回价', '未回复', '放弃报价']
export const TAX = ['含税', '不含税', '未说明']

/**
 * 做文件夹 / 文件名用：去掉 Windows 不允许的字符。末尾的「.」和空格也要去掉，
 * 否则（如单位名「XXX A.Ş.」）资源管理器打不开、删不掉这个文件夹。
 */
export const clean = (s: string) => {
  let t = String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().slice(0, 80).replace(/[. ]+$/, '')
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(t)) t = '_' + t
  return t || '未命名'
}
/** 比较单位名用：去掉重音和附加符号（İ Ş Ç Ğ Ö Ü 等土耳其字母按拉丁字母算）、大小写、空格和标点 */
export const normName = (s: any) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/[\s.,，。·_\-()（）]+/g, '')

/**
 * 询价文件 / 回价文件「上传」：复制到项目文件夹里统一存放，返回复制后的路径。
 * 询价文件 → <项目>/03 询价文件/<询价名>/V<版次>；回价文件 → <项目>/04 回价与比价/<询价名>/<单位>
 * 项目没有关联文件夹时，放到资料库下的「询价文件 / 回价文件」。已经在目标文件夹里的文件不再复制。
 */
export function storeInquiryFiles(store: Store, inquiry: { projectId?: string | null; name: string }, kind: 'version' | 'quote', sub: string, paths: string[]) {
  const p = store.projects.find((x) => x.id === inquiry.projectId)
  let base: string
  if (p?.rootPath && fs.existsSync(p.rootPath)) {
    const want = kind === 'version' ? /询价文件/ : /回价/
    const hit = fs.readdirSync(p.rootPath, { withFileTypes: true }).find((d) => d.isDirectory() && want.test(d.name))
    base = path.join(p.rootPath, hit ? hit.name : kind === 'version' ? '03 询价文件' : '04 回价与比价')
  } else base = path.join(store.libraryDir, kind === 'version' ? '询价文件' : '回价文件')
  const dir = path.join(base, clean(inquiry.name), clean(sub))
  fs.mkdirSync(dir, { recursive: true })
  const out: string[] = []
  const missing: string[] = []
  for (const src of paths || []) {
    if (!src || !fs.existsSync(src)) {
      missing.push(src)
      continue
    }
    if (path.resolve(path.dirname(src)).toLowerCase() === path.resolve(dir).toLowerCase()) {
      out.push(src)
      continue
    }
    const base = path.basename(src)
    const ext = path.extname(base)
    const target = uniqueTarget(dir, ext && ext.length < base.length ? clean(base.slice(0, -ext.length)) + ext : clean(base))
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, target, { recursive: true })
    else fs.copyFileSync(src, target)
    out.push(target)
  }
  if (missing.length && !out.length) throw new Error('找不到文件：' + missing.join('、'))
  return out
}

/**
 * 单位的附件「上传」：复制到「供应商与联系人/<单位名>/入库资料|项目经验」，返回复制后的路径。
 * 已经在这个单位文件夹里的文件不再复制。
 */
export function storeCompanyFiles(store: Store, companyName: string, kind: 'docs' | 'experience', paths: string[]) {
  const dir = path.join(store.companyDir, clean(companyName), kind === 'docs' ? '入库资料' : '项目经验')
  const coRoot = path.resolve(store.companyDir, clean(companyName)).toLowerCase() + path.sep
  const out: string[] = []
  for (const src of paths || []) {
    if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) continue
    if (path.resolve(src).toLowerCase().startsWith(coRoot)) {
      out.push(src)
      continue
    }
    fs.mkdirSync(dir, { recursive: true })
    const base = path.basename(src)
    const ext = path.extname(base)
    const target = uniqueTarget(dir, ext && ext.length < base.length ? clean(base.slice(0, -ext.length)) + ext : clean(base))
    fs.copyFileSync(src, target)
    out.push(target)
  }
  return out
}

/**
 * 旧数据迁移：从飞书导入的供应商附件原来放在「资料库/供应商资料/<单位>」，
 * 现在搬到「供应商与联系人/<单位>」（单位文件夹名去掉末尾的点），并改掉单位里记的路径。
 */
export function migrateCompanyFiles(store: Store) {
  const old = path.join(store.libraryDir, '供应商资料')
  if (!fs.existsSync(old)) return 0
  // 注意：土耳其字母「İ」转小写会变成两个字符，所以只用小写来比较，截取路径时用原来的写法
  const moves: { from: string; low: string; to: string }[] = []
  fs.mkdirSync(store.companyDir, { recursive: true })
  for (const e of fs.readdirSync(old, { withFileTypes: true })) {
    const from = path.resolve(old, e.name)
    const to = path.join(store.companyDir, e.isDirectory() ? clean(e.name) : e.name)
    if (fs.existsSync(to)) {
      fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false })
      fs.rmSync(from, { recursive: true, force: true })
    } else fs.renameSync(from, to)
    moves.push({ from, low: from.toLowerCase(), to })
  }
  const fix = (p: string) => {
    if (typeof p !== 'string') return p
    const abs = path.resolve(p)
    const low = abs.toLowerCase()
    for (const m of moves) if (low === m.low || low.startsWith(m.low + path.sep)) return m.to + abs.slice(m.from.length)
    return p
  }
  // 从飞书导入时留下的「飞书附件 → 本地文件」对照表，跟着附件一起搬，路径也改过去
  const idx = path.join(store.libraryDir, 'attachments.json')
  if (fs.existsSync(idx)) {
    try {
      const j = JSON.parse(fs.readFileSync(idx, 'utf8'))
      for (const k of Object.keys(j)) if (typeof j[k] === 'string') j[k] = fix(j[k])
      fs.writeFileSync(path.join(store.companyDir, '飞书附件对照表.json'), JSON.stringify(j, null, 2))
      fs.rmSync(idx)
    } catch (e) {
      console.error('搬飞书附件对照表失败', e)
    }
  }
  let n = 0
  store.companies = store.companies.map((c) => {
    const rows = (k: string) =>
      (c[k] || []).map((r: any) => {
        const files = (r.files || []).map(fix)
        n += files.filter((f: string, i: number) => f !== r.files[i]).length
        return { ...r, files }
      })
    return { ...c, docs: rows('docs'), experience: rows('experience') }
  })
  store.save('companies')
  if (!fs.readdirSync(old).length) fs.rmdirSync(old)
  return n
}

/** 询价 / 回价文件统一存放的文件夹（项目里的「03 询价文件」「04 回价与比价」，资料库里的「询价文件」「回价文件」），以及单位附件文件夹 */
function managedRoots(store: Store) {
  const roots = [path.join(store.libraryDir, '询价文件'), path.join(store.libraryDir, '回价文件'), store.companyDir]
  for (const p of store.projects) {
    if (!p.rootPath || !fs.existsSync(p.rootPath)) continue
    for (const d of fs.readdirSync(p.rootPath, { withFileTypes: true })) if (d.isDirectory() && /询价文件|回价/.test(d.name)) roots.push(path.join(p.rootPath, d.name))
  }
  return roots.map((r) => path.resolve(r).toLowerCase() + path.sep)
}

/**
 * 删除询价 / 回价文件：只删工作台自己复制进来、放在上面那些文件夹里的文件（移到回收站，能恢复），
 * 别处的原文件不动。删完把变空的文件夹也清掉。返回实际移到回收站的个数。
 */
export async function trashInquiryFiles(store: Store, paths: string[]) {
  const { shell } = await import('electron')
  const roots = managedRoots(store)
  let n = 0
  for (const p of paths || []) {
    const abs = path.resolve(String(p || ''))
    const root = roots.find((r) => abs.toLowerCase().startsWith(r))
    if (!root || !fs.existsSync(abs)) continue
    await shell.trashItem(abs)
    n++
    // 往上清空文件夹，到统一存放的根文件夹为止
    for (let d = path.dirname(abs); (d + path.sep).toLowerCase() !== root && (d + path.sep).toLowerCase().startsWith(root); d = path.dirname(d)) {
      try {
        if (fs.readdirSync(d).length) break
        fs.rmdirSync(d)
      } catch {
        break
      }
    }
  }
  return n
}

/**
 * 修复旧数据：以前按单位名建文件夹时没去掉末尾的「.」（如「XXX A.Ş.」），这种文件夹资源管理器打不开也删不掉。
 * 启动时把这类文件挪到改好名的文件夹里，并更新询价里的路径。
 */
export function repairInquiryPaths(store: Store) {
  const bad = (p: string) => p.split(/[\\/]/).slice(1, -1).some((seg) => /[. ]$/.test(seg))
  const fix = (p: string) => {
    const segs = p.split(/[\\/]/)
    return [segs[0], ...segs.slice(1, -1).map((s) => (/[. ]$/.test(s) ? clean(s) : s)), segs[segs.length - 1]].join(path.sep)
  }
  let changed = false
  const move = (p: string) => {
    if (typeof p !== 'string' || !bad(p)) return p
    const to = fix(p)
    try {
      if (fs.existsSync(p)) {
        fs.mkdirSync(path.dirname(to), { recursive: true })
        const dest = fs.existsSync(to) ? uniqueTarget(path.dirname(to), path.basename(to)) : to
        fs.renameSync(p, dest)
        for (let d = path.dirname(p); bad(d + path.sep + 'x'); d = path.dirname(d)) {
          if (fs.readdirSync(d).length) break
          fs.rmdirSync(d)
        }
        changed = true
        return dest
      }
    } catch (e) {
      console.error('修复路径失败', p, e)
      return p
    }
    changed = true
    return to
  }
  for (const x of store.inquiries) {
    for (const v of x.versions || []) v.files = (v.files || []).map(move)
    for (const q of x.quotes || []) q.files = (q.files || []).map(move)
  }
  if (changed) store.save('inquiries')
}

/** 折合 USD：币种是 USD 直接用；填了汇率（1 单位币种 = 多少 USD）就换算 */
export const toUsd = (q: any) => (q.currency === 'USD' ? Number(q.amount) : q.rate ? Number(q.amount) * Number(q.rate) : null)

/** 每家取最新一轮，按价格排序（币种不同时按折合 USD） */
export function latestQuotes(x: any) {
  const m = new Map<string, any>()
  for (const r of [...(x.quotes || [])].sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0) || String(a.date).localeCompare(String(b.date)))) m.set(r.companyId, r)
  const list = [...m.values()]
  const sameCur = new Set(list.map((r) => r.currency)).size <= 1
  const key = (r: any) => (sameCur ? Number(r.amount) : toUsd(r) ?? Infinity)
  return list.sort((a, b) => key(a) - key(b))
}

export function companyStats(store: Store, id: string) {
  let sends = 0
  let quotes = 0
  let last = ''
  for (const q of store.inquiries) {
    sends += (q.sends || []).filter((x: any) => x.companyId === id).length
    const r = (q.quotes || []).filter((x: any) => x.companyId === id)
    if (r.length) quotes++
    for (const x of r) if (x.date > last) last = x.date
  }
  return { sends, quotes, lastQuote: last }
}

/** 报价有效期：从报价日期起 n 天；工作日跳过周六、周日 */
export function validToFrom(date: string, days: number, type: '工作日' | '日历日' = '日历日') {
  const d = new Date((date || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z')
  if (type === '工作日') {
    let left = days
    while (left > 0) {
      d.setUTCDate(d.getUTCDate() + 1)
      const w = d.getUTCDay()
      if (w !== 0 && w !== 6) left--
    }
  } else d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 回价里会用到的字段（界面和 AI 共用一套） */
export const QUOTE_FIELDS = ['amount', 'currency', 'rate', 'date', 'round', 'tax', 'taxRate', 'amountWithTax', 'quoteNo', 'versionNo', 'leadDays', 'validTo', 'payment', 'scopeNote', 'deviation', 'channel', 'verify', 'issues', 'note'] as const

/** 收到回价后：对应发包改为「已回价」，全部回齐（没有「已发送」的了）时询价改为「比价中」 */
export function afterQuote(x: any, companyId: string) {
  x.sends = (x.sends || []).map((s: any) => (s.companyId === companyId && s.status !== '已回价' ? { ...s, status: '已回价' } : s))
  if (x.sends.length && x.sends.every((s: any) => s.status !== '已发送') && ['编制中', '询价中'].includes(x.status)) x.status = '比价中'
}
