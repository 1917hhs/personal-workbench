import type { Store } from './store'
import { buildXlsx, textWidth, type Cell, type Sheet, type Style } from './xlsxw'
import { toUsd } from './procure'

// 询价导出：一条询价的比价表，或同一项目（任选几条）询价的汇总表，共用一套逻辑。
// 工作表和回价字段都可选，界面通过 inquiry:exportOptions 拿到下面的清单。

type Q = any
type X = any

interface Field {
  key: string
  label: string
  /** 默认是否勾选 */
  def: boolean
  width: number
  kind?: 'money' | 'pct' | 'int' | 'wrap'
  get: (q: Q, x: X, ctx: Ctx) => string | number | null | undefined
}

interface Ctx {
  co: (id: string) => string
  today: string
}

/** 回价字段（「比价明细」「全部回价」两张表的列） */
export const QUOTE_FIELDS: Field[] = [
  { key: 'round', label: '轮次', def: true, width: 6, kind: 'int', get: (q) => Number(q.round) || 1 },
  { key: 'date', label: '报价日期', def: true, width: 11, get: (q) => q.date || '' },
  { key: 'amount', label: '报价金额（不含税）', def: true, width: 16, kind: 'money', get: (q) => (q.amount === '' || q.amount == null ? null : Number(q.amount)) },
  { key: 'currency', label: '币种', def: true, width: 6, get: (q) => q.currency || '' },
  { key: 'rate', label: '汇率（1 单位 = USD）', def: false, width: 10, get: (q) => (q.rate ? Number(q.rate) : null) },
  { key: 'usd', label: '折合 USD', def: true, width: 15, kind: 'money', get: (q) => toUsd(q) },
  { key: 'tax', label: '是否含税', def: true, width: 8, get: (q) => q.tax || '' },
  { key: 'taxRate', label: '税率', def: false, width: 6, get: (q) => (q.taxRate ? q.taxRate + '%' : '') },
  { key: 'amountWithTax', label: '含税总价', def: false, width: 15, kind: 'money', get: (q) => (q.amountWithTax ? Number(q.amountWithTax) : null) },
  { key: 'vsBudget', label: '比控制价', def: true, width: 9, kind: 'pct', get: (q, x) => (x.budget && Number(q.amount) ? (Number(q.amount) - Number(x.budget)) / Number(x.budget) : null) },
  { key: 'quoteNo', label: '报价编号', def: false, width: 16, get: (q) => q.quoteNo || '' },
  { key: 'versionNo', label: '响应版次', def: false, width: 8, get: (q) => (q.versionNo ? 'V' + q.versionNo : '') },
  { key: 'leadDays', label: '工期 / 交货期（天）', def: true, width: 10, kind: 'int', get: (q) => (q.leadDays ? Number(q.leadDays) : null) },
  { key: 'payment', label: '付款条件', def: true, width: 26, kind: 'wrap', get: (q) => q.payment || '' },
  { key: 'validTo', label: '有效期至', def: true, width: 15, get: (q, _x, c) => (q.validTo ? q.validTo + (q.validTo < c.today ? '（已过期）' : '') : '') },
  { key: 'scopeNote', label: '报价范围', def: true, width: 40, kind: 'wrap', get: (q) => q.scopeNote || '' },
  { key: 'deviation', label: '技术偏差', def: true, width: 30, kind: 'wrap', get: (q) => q.deviation || '' },
  { key: 'verify', label: '核实状态', def: true, width: 8, get: (q) => q.verify || '' },
  { key: 'issues', label: '待核实疑点', def: true, width: 36, kind: 'wrap', get: (q) => q.issues || '' },
  { key: 'channel', label: '接收渠道', def: false, width: 8, get: (q) => q.channel || '' },
  { key: 'note', label: '备注', def: false, width: 30, kind: 'wrap', get: (q) => q.note || '' },
  { key: 'files', label: '回价文件', def: false, width: 30, kind: 'wrap', get: (q) => (q.files || []).map((f: string) => f.split(/[\\/]/).pop()).join('\n') }
]

export const SHEETS = [
  { key: 'summary', label: '汇总', hint: '每条询价一行：状态、发包与回价家数、最低价、定标', def: true },
  { key: 'compare', label: '比价明细', hint: '按询价分组，每家取最新一轮，按价格排名，最低价标绿', def: true },
  { key: 'sends', label: '发包记录', hint: '发给了哪些单位、什么时候、是否回价', def: true },
  { key: 'quotes', label: '全部回价', hint: '每家每一轮的报价，便于看议价过程', def: false },
  { key: 'info', label: '询价信息', hint: '范围、地点、截止、控制价、询价文件版次、比选结论', def: true }
] as const
type SheetKey = (typeof SHEETS)[number]['key']

export function exportOptions() {
  return {
    sheets: SHEETS.map((s) => ({ key: s.key, label: s.label, hint: s.hint, def: s.def })),
    fields: QUOTE_FIELDS.map((f) => ({ key: f.key, label: f.label, def: f.def }))
  }
}

export interface ExportReq {
  inquiryIds: string[]
  sheets?: string[]
  fields?: string[]
}

// ---------- 样式 ----------
const C = { head: '1F3A5F', band: 'E8EEF7', low: 'E3F4E8', award: 'FFF3C4', faint: '8A94A6', red: 'C0392B', amber: 'B7791F', green: '1E7B3A', grey: 'F4F5F7' }
const S = {
  title: { bold: true, size: 14 } as Style,
  sub: { color: C.faint, size: 9 } as Style,
  head: { bold: true, color: 'FFFFFF', fill: C.head, border: true, wrap: true, align: 'center' } as Style,
  band: { bold: true, fill: C.band, border: true } as Style,
  cell: { border: true } as Style
}
const kindStyle = (k?: Field['kind'], extra: Style = {}): Style => ({
  border: true,
  valign: 'top',
  ...(k === 'money' ? { numFmt: '#,##0.00', align: 'right' } : k === 'pct' ? { numFmt: '+0.0%;-0.0%;0.0%', align: 'right' } : k === 'int' ? { align: 'center' } : k === 'wrap' ? { wrap: true } : {}),
  ...extra
})
const statusColor = (s: string) => (s === '已定标' ? C.green : s === '比价中' ? C.amber : s === '取消' ? C.faint : undefined)

/** 按内容放宽列：不超过 max，不小于表头 */
function fitCols(rows: Cell[][], base: number[], max = 50) {
  const w = [...base]
  for (const r of rows)
    r.forEach((c, i) => {
      const v = c && typeof c === 'object' ? c.v : c
      if (v === null || v === undefined || typeof v === 'number') return
      const longest = Math.max(...String(v).split('\n').map(textWidth))
      if (longest > (w[i] || 0)) w[i] = Math.min(max, longest + 1)
    })
  return w
}

/** 每家取最新一轮；可比较时排名（同币种按金额，不同币种按折合 USD，没折算的不排名） */
function ranked(x: X) {
  const m = new Map<string, Q>()
  for (const r of [...(x.quotes || [])].sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0) || String(a.date).localeCompare(String(b.date)))) m.set(r.companyId, r)
  const list = [...m.values()]
  const sameCur = new Set(list.map((r) => r.currency)).size <= 1
  const key = (r: Q) => (sameCur ? (Number(r.amount) > 0 ? Number(r.amount) : null) : toUsd(r))
  const withKey = list.map((q) => ({ q, k: key(q) }))
  withKey.sort((a, b) => (a.k ?? Infinity) - (b.k ?? Infinity))
  let rank = 0
  return withKey.map(({ q, k }) => ({ q, rank: k === null ? null : ++rank, comparable: k !== null }))
}

export function buildInquiryBook(store: Store, req: ExportReq) {
  const list: X[] = req.inquiryIds.map((id) => store.inquiries.find((i) => i.id === id)).filter(Boolean)
  if (!list.length) throw new Error('没有选中要导出的询价')
  const want = new Set<SheetKey>(((req.sheets?.length ? req.sheets : SHEETS.filter((s) => s.def).map((s) => s.key)) as SheetKey[]))
  const fields = req.fields?.length ? QUOTE_FIELDS.filter((f) => req.fields!.includes(f.key)) : QUOTE_FIELDS.filter((f) => f.def)
  const today = new Date().toISOString().slice(0, 10)
  const ctx: Ctx = { co: (id) => store.companies.find((c) => c.id === id)?.name || '（单位已删除）', today }
  const projName = (x: X) => store.projects.find((p) => p.id === x.projectId)?.name || '未关联项目'
  const projects = [...new Set(list.map(projName))]
  const titleBase = list.length === 1 ? `${list[0].name} 比价表` : `${projects.join('、')} 询价汇总`
  const subLine = `导出日期 ${today} · 共 ${list.length} 条询价 · 报价金额均为不含税净价（含税总价另列）· 不同币种按折合 USD 排名`

  const sheets: Sheet[] = []
  /** 每张表前两行：标题 + 说明，表头在第 3 行（下标 2） */
  const head = (title: string, n: number): { rows: Cell[][]; merges: Sheet['merges'] } => ({
    rows: [[{ v: title, s: S.title }], [{ v: subLine, s: S.sub }]],
    merges: [
      [0, 0, 0, Math.max(0, n - 1)],
      [1, 0, 1, Math.max(0, n - 1)]
    ]
  })

  // ---------- 汇总 ----------
  if (want.has('summary')) {
    const cols = ['序号', '询价（专业包）', ...(projects.length > 1 ? ['项目'] : []), '专业', '状态', '回价截止', '发包', '已回价', '最低价单位', '最低报价', '币种', '折合 USD', '控制价', '最低价比控制价', '定标单位', '待核实回价', '比选结论']
    const { rows, merges } = head(titleBase, cols.length)
    rows.push(cols.map((c) => ({ v: c, s: S.head })))
    list.forEach((x, i) => {
      const r = ranked(x)
      const best = r.find((y) => y.rank === 1)?.q
      const replied = new Set((x.quotes || []).map((q: Q) => q.companyId)).size
      const pending = r.filter((y) => y.q.verify === '待核实').length
      const sc = statusColor(x.status)
      rows.push([
        { v: i + 1, s: kindStyle('int') },
        { v: x.name, s: kindStyle('wrap', { bold: true }) },
        ...(projects.length > 1 ? [{ v: projName(x), s: kindStyle('wrap') }] : []),
        { v: x.discipline || '', s: kindStyle() },
        { v: x.status || '', s: kindStyle(undefined, { align: 'center', bold: true, color: sc }) },
        { v: x.deadline || '', s: kindStyle(undefined, { align: 'center' }) },
        { v: (x.sends || []).length, s: kindStyle('int') },
        { v: replied, s: kindStyle('int') },
        { v: best ? ctx.co(best.companyId) : '', s: kindStyle('wrap') },
        { v: best ? Number(best.amount) : null, s: kindStyle('money') },
        { v: best?.currency || '', s: kindStyle(undefined, { align: 'center' }) },
        { v: best ? toUsd(best) : null, s: kindStyle('money') },
        { v: x.budget ? Number(x.budget) : null, s: kindStyle('money') },
        { v: best && x.budget ? (Number(best.amount) - Number(x.budget)) / Number(x.budget) : null, s: kindStyle('pct') },
        { v: x.awardedCompanyId ? ctx.co(x.awardedCompanyId) : '', s: kindStyle('wrap', x.awardedCompanyId ? { bold: true, color: C.green } : {}) },
        { v: pending || null, s: kindStyle('int', pending ? { color: C.red, bold: true } : {}) },
        { v: x.conclusion || '', s: kindStyle('wrap') }
      ])
    })
    const base = [5, 26, ...(projects.length > 1 ? [16] : []), 10, 8, 11, 6, 7, 24, 14, 6, 14, 12, 11, 20, 9, 30]
    sheets.push({ name: '汇总', rows, merges, cols: fitCols(rows.slice(3), base, 40), freeze: { rows: 3, cols: 2 }, filter: { row: 2, c1: 0, c2: cols.length - 1, lastRow: rows.length - 1 }, printTitleRow: 2, heights: [26, 18] })
  }

  // ---------- 比价明细：按询价分组 ----------
  if (want.has('compare')) {
    const cols = ['排名', '单位', ...fields.map((f) => f.label), '备注']
    const n = cols.length
    const { rows, merges } = head(titleBase + ' · 比价明细', n)
    rows.push(cols.map((c) => ({ v: c, s: S.head })))
    const heights: (number | undefined)[] = [26, 18, 30]
    list.forEach((x, i) => {
      const r = ranked(x)
      const replied = new Set(r.map((y) => y.q.companyId))
      const info = [x.discipline, x.status, `发 ${(x.sends || []).length} 家 · 回 ${replied.size} 家`, x.budget ? `控制价 ${Number(x.budget).toLocaleString()} ${x.currency || ''}` : '', x.deadline ? `回价截止 ${x.deadline}` : '']
        .filter(Boolean)
        .join(' · ')
      const band: Cell[] = [{ v: `${i + 1}. ${x.name}${projects.length > 1 ? `（${projName(x)}）` : ''}　${info}`, s: S.band }]
      for (let k = 1; k < n; k++) band.push({ v: null, s: S.band })
      merges!.push([rows.length, 0, rows.length, n - 1])
      heights[rows.length] = 22
      rows.push(band)
      for (const { q, rank } of r) {
        const awarded = x.awardedCompanyId === q.companyId
        const fill = awarded ? C.award : rank === 1 ? C.low : undefined
        const ex: Style = fill ? { fill } : {}
        const notes = [awarded ? '★ 定标单位' : '', rank === 1 ? '最低价' : '', rank === null ? '币种不同且未填汇率，未参与排名' : ''].filter(Boolean).join('；')
        rows.push([
          { v: rank ?? '—', s: kindStyle('int', { ...ex, bold: rank === 1 }) },
          { v: ctx.co(q.companyId), s: kindStyle('wrap', { ...ex, bold: true }) },
          ...fields.map((f) => {
            const v = f.get(q, x, ctx)
            const color = f.key === 'verify' && v === '待核实' ? C.red : f.key === 'validTo' && String(v).includes('已过期') ? C.red : undefined
            return { v, s: kindStyle(f.kind, { ...ex, ...(color ? { color } : {}) }) }
          }),
          { v: notes, s: kindStyle('wrap', { ...ex, color: awarded ? C.green : undefined, bold: awarded }) }
        ])
      }
      // 发了但没回价的单位也列出来，灰色
      for (const s of x.sends || []) {
        if (replied.has(s.companyId)) continue
        const g: Style = { color: C.faint, fill: C.grey }
        rows.push([
          { v: '—', s: kindStyle('int', g) },
          { v: ctx.co(s.companyId), s: kindStyle('wrap', g) },
          ...fields.map(() => ({ v: null, s: kindStyle(undefined, g) })),
          { v: `未回价（${s.status || '已发送'}${s.date ? '，' + s.date + ' 发出' : ''}）${s.note ? '：' + s.note : ''}`, s: kindStyle('wrap', g) }
        ])
      }
      if (!r.length && !(x.sends || []).length) rows.push([{ v: '', s: kindStyle() }, { v: '还没有发包和回价', s: kindStyle(undefined, { color: C.faint }) }, ...fields.map(() => ({ v: null, s: kindStyle() })), { v: '', s: kindStyle() }])
    })
    const base = [5, 26, ...fields.map((f) => f.width), 22]
    sheets.push({ name: '比价明细', rows, merges, heights, cols: fitCols(rows.slice(3).filter((r) => (r[0] as any)?.s !== S.band), base, 50), freeze: { rows: 3, cols: 2 }, printTitleRow: 2 })
  }

  // ---------- 发包记录 ----------
  if (want.has('sends')) {
    const cols = ['询价（专业包）', '单位', '发送日期', '发送渠道', '回价截止', '状态', '回价轮数', '最新报价', '币种', '备注']
    const { rows, merges } = head(titleBase + ' · 发包记录', cols.length)
    rows.push(cols.map((c) => ({ v: c, s: S.head })))
    for (const x of list) {
      for (const s of x.sends || []) {
        const qs = (x.quotes || []).filter((q: Q) => q.companyId === s.companyId)
        const last = ranked(x).find((y) => y.q.companyId === s.companyId)?.q
        const color = s.status === '已回价' ? C.green : s.status === '未回复' || s.status === '放弃报价' ? C.faint : undefined
        rows.push([
          { v: x.name, s: kindStyle('wrap') },
          { v: ctx.co(s.companyId), s: kindStyle('wrap', { bold: true }) },
          { v: s.date || '', s: kindStyle(undefined, { align: 'center' }) },
          { v: s.channel || '', s: kindStyle(undefined, { align: 'center' }) },
          { v: s.deadline || '', s: kindStyle(undefined, { align: 'center' }) },
          { v: s.status || '', s: kindStyle(undefined, { align: 'center', color, bold: true }) },
          { v: qs.length || null, s: kindStyle('int') },
          { v: last ? Number(last.amount) : null, s: kindStyle('money') },
          { v: last?.currency || '', s: kindStyle(undefined, { align: 'center' }) },
          { v: s.note || '', s: kindStyle('wrap') }
        ])
      }
    }
    if (rows.length === 3) rows.push([{ v: '还没有发包记录', s: { color: C.faint } }])
    sheets.push({ name: '发包记录', rows, merges, cols: fitCols(rows.slice(3), [26, 26, 11, 8, 11, 8, 8, 14, 6, 40], 45), freeze: { rows: 3, cols: 2 }, filter: { row: 2, c1: 0, c2: cols.length - 1, lastRow: rows.length - 1 }, printTitleRow: 2 })
  }

  // ---------- 全部回价（各轮） ----------
  if (want.has('quotes')) {
    const qf = fields.filter((f) => f.key !== 'round')
    const cols = ['询价（专业包）', '单位', '轮次', ...qf.map((f) => f.label)]
    const { rows, merges } = head(titleBase + ' · 全部回价', cols.length)
    rows.push(cols.map((c) => ({ v: c, s: S.head })))
    for (const x of list) {
      const qs = [...(x.quotes || [])].sort((a, b) => ctx.co(a.companyId).localeCompare(ctx.co(b.companyId), 'zh-CN') || (Number(a.round) || 0) - (Number(b.round) || 0))
      for (const q of qs)
        rows.push([
          { v: x.name, s: kindStyle('wrap') },
          { v: ctx.co(q.companyId), s: kindStyle('wrap', { bold: true }) },
          { v: Number(q.round) || 1, s: kindStyle('int') },
          ...qf.map((f) => ({ v: f.get(q, x, ctx), s: kindStyle(f.kind) }))
        ])
    }
    if (rows.length === 3) rows.push([{ v: '还没有回价', s: { color: C.faint } }])
    sheets.push({ name: '全部回价', rows, merges, cols: fitCols(rows.slice(3), [26, 26, 6, ...qf.map((f) => f.width)], 50), freeze: { rows: 3, cols: 2 }, filter: { row: 2, c1: 0, c2: cols.length - 1, lastRow: rows.length - 1 }, printTitleRow: 2 })
  }

  // ---------- 询价信息 ----------
  if (want.has('info')) {
    const cols = ['询价（专业包）', '项目', '专业', '状态', '工作范围', '交货 / 施工地点', '启动时间', '回价截止', '采购负责人', '币种', '控制价（不含税）', '控制价说明', '当前询价文件', '定标单位', '比选结论']
    const { rows, merges } = head(titleBase + ' · 询价信息', cols.length)
    rows.push(cols.map((c) => ({ v: c, s: S.head })))
    for (const x of list) {
      const v = (x.versions || []).find((y: any) => y.status === '当前版本') || (x.versions || [])[0]
      rows.push([
        { v: x.name, s: kindStyle('wrap', { bold: true }) },
        { v: projName(x), s: kindStyle('wrap') },
        { v: x.discipline || '', s: kindStyle() },
        { v: x.status || '', s: kindStyle(undefined, { align: 'center', bold: true, color: statusColor(x.status) }) },
        { v: x.scope || '', s: kindStyle('wrap') },
        { v: x.location || '', s: kindStyle('wrap') },
        { v: x.startDate || '', s: kindStyle(undefined, { align: 'center' }) },
        { v: x.deadline || '', s: kindStyle(undefined, { align: 'center' }) },
        { v: x.buyer || '', s: kindStyle() },
        { v: x.currency || '', s: kindStyle(undefined, { align: 'center' }) },
        { v: x.budget ? Number(x.budget) : null, s: kindStyle('money') },
        { v: x.budgetNote || '', s: kindStyle('wrap') },
        { v: v ? `V${v.version}（${v.date || ''}，${(v.files || []).length} 个文件）${v.summary ? '\n' + v.summary : ''}` : '', s: kindStyle('wrap') },
        { v: x.awardedCompanyId ? ctx.co(x.awardedCompanyId) : '', s: kindStyle('wrap', { bold: true, color: C.green }) },
        { v: x.conclusion || '', s: kindStyle('wrap') }
      ])
    }
    sheets.push({ name: '询价信息', rows, merges, cols: [26, 16, 10, 8, 50, 18, 11, 11, 10, 6, 14, 24, 50, 20, 30], freeze: { rows: 3, cols: 1 }, filter: { row: 2, c1: 0, c2: cols.length - 1, lastRow: rows.length - 1 }, printTitleRow: 2 })
  }

  if (!sheets.length) throw new Error('至少选一张工作表')
  const fileTitle = list.length === 1 ? `比价表 ${list[0].name}` : `询价汇总 ${projects.join('、')}`
  return { buffer: buildXlsx(sheets, { title: titleBase }), fileName: `${fileTitle} ${today}.xlsx`.replace(/[\\/:*?"<>|]/g, '_') }
}
