import type { Store } from './store'
import { buildXlsx, textWidth, type Cell, type Sheet, type Style } from './xlsxw'

// 履约成本导出：一个项目的成本表 → Excel。
// 「合同包对比」按当前显示币种和当前汇率方案换算，原币金额另列；「汇率」列出所有保存过的方案，标出本次用的那套。

type Money = { amount?: number | null; currency?: string }
type RateSet = { id: string; date?: string; note?: string; rates?: Record<string, number> }

const C = { head: '1F3A5F', faint: '8A94A6', red: 'C0392B', green: '1E7B3A', amber: 'B7791F', total: 'E8EEF7', used: 'FFF3C4' }
const S = {
  title: { bold: true, size: 14 } as Style,
  sub: { color: C.faint, size: 9 } as Style,
  head: { bold: true, color: 'FFFFFF', fill: C.head, border: true, wrap: true, align: 'center', valign: 'center' } as Style
}
const cell = (extra: Style = {}): Style => ({ border: true, valign: 'top', ...extra })
const money = (extra: Style = {}): Style => cell({ numFmt: '#,##0.00', align: 'right', ...extra })
const pctS = (extra: Style = {}): Style => cell({ numFmt: '0.0%', align: 'right', ...extra })

const has = (m?: Money) => !!m && m.amount !== null && m.amount !== undefined && (m.amount as any) !== ''

export function makeFx(rates: Record<string, number> = {}) {
  const r = (c?: string) => (!c || c === 'USD' ? 1 : rates[c] > 0 ? rates[c] : null)
  return (m: Money | undefined, to: string) => {
    if (!has(m)) return null
    const a = r(m!.currency)
    const b = r(to)
    return a && b ? (Number(m!.amount) / a) * b : null
  }
}

/** 当前生效的汇率方案（老数据只有 rates / rateDate 时当作一套） */
export function rateSetsOf(rec: any): { sets: RateSet[]; active: RateSet | null } {
  const sets: RateSet[] = rec.rateSets?.length ? rec.rateSets : rec.rates && Object.keys(rec.rates).length ? [{ id: 'legacy', date: rec.rateDate, note: '', rates: rec.rates }] : []
  const active = sets.find((s) => s.id === rec.rateSetId) || sets[0] || null
  return { sets, active }
}

function fitCols(rows: Cell[][], base: number[], max = 44) {
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

export function buildCostBook(store: Store, costId: string) {
  const rec = store.costs.find((c) => c.id === costId)
  if (!rec) throw new Error('找不到这张成本表')
  const p = store.projects.find((x) => x.id === rec.projectId)
  const pname = p?.name || '未关联项目'
  const disp: string = rec.displayCurrency || 'USD'
  const { sets, active } = rateSetsOf(rec)
  const perPkg = rec.rateMode === 'pkg' && sets.length > 1
  const setOf = (k: any) => (perPkg && sets.find((s) => s.id === k.rateSetId)) || active
  const label = (s: RateSet | null) => (s ? [s.date || '未填日期', s.note].filter(Boolean).join(' ') : '')
  const pkgs: any[] = rec.packages || []
  const co = (id?: string) => store.companies.find((c) => c.id === id)?.name || ''
  const inq = (id?: string) => store.inquiries.find((x) => x.id === id)?.name || ''
  const today = new Date().toISOString().slice(0, 10)
  const hasIncome = pkgs.some((k) => has(k.income))
  const rateText = active ? Object.entries(active.rates || {}).map(([c, v]) => `1 USD = ${v} ${c}`).join('，') : ''
  const subLine = `导出日期 ${today} · 金额按 ${disp} 显示${perPkg ? ' · 各合同包按自己选的汇率方案换算（见「汇率方案」列和「汇率」表），未单独选的用默认方案：' + label(active) : active ? ` · 汇率方案：${label(active)}（${rateText || '仅美元'}）` : ' · 未设汇率'} · 节超 = 责任成本 − 签订价，正数节约、负数超支`

  const cols = [
    '序号', '合同包', '分包 / 供货单位', '合同编号', '签订日期', '状态', ...(perPkg ? ['汇率方案'] : []),
    `责任成本（${disp}）`, `签订价（${disp}）`, '签订价 / 责任成本', `节超（${disp}）`, '节超率',
    ...(hasIncome ? [`对应收入（${disp}）`, `毛利（${disp}）`, '毛利率'] : []),
    '责任成本（原币）', '原币', '签订价（原币）', '原币',
    ...(hasIncome ? ['对应收入（原币）', '原币'] : []),
    '关联询价', '引用文件'
  ]
  const n = cols.length
  const rows: Cell[][] = [[{ v: `${pname} 履约成本分析`, s: S.title }], [{ v: subLine, s: S.sub }], cols.map((c) => ({ v: c, s: S.head }))]
  const merges: Sheet['merges'] = [
    [0, 0, 0, n - 1],
    [1, 0, 1, n - 1]
  ]
  const tot = { b: 0, c: 0, sb: 0, diff: 0, i: 0, pi: 0, profit: 0 }
  let missing = false
  pkgs.forEach((k, idx) => {
    const fx = makeFx(setOf(k)?.rates || {})
    const b = fx(k.budget, disp)
    const c = fx(k.contract, disp)
    const i = fx(k.income, disp)
    if ((has(k.budget) && b === null) || (has(k.contract) && c === null) || (has(k.income) && i === null)) missing = true
    const diff = b !== null && c !== null ? b - c : null
    const profit = i !== null && c !== null ? i - c : null
    tot.b += b ?? 0
    tot.c += c ?? 0
    if (diff !== null) (tot.sb += b!), (tot.diff += diff)
    tot.i += i ?? 0
    if (profit !== null) (tot.pi += i!), (tot.profit += profit)
    const tone = diff === null ? undefined : diff < 0 ? C.red : C.green
    const st = k.status === '已结算' ? C.green : k.status === '已签约' ? C.amber : undefined
    rows.push([
      { v: idx + 1, s: cell({ align: 'center' }) },
      { v: k.name || '未命名合同包', s: cell({ bold: true, wrap: true }) },
      { v: co(k.companyId), s: cell({ wrap: true }) },
      { v: k.contractNo || '', s: cell() },
      { v: k.signDate || '', s: cell({ align: 'center' }) },
      { v: k.status || '', s: cell({ align: 'center', bold: true, color: st }) },
      ...(perPkg ? [{ v: label(setOf(k)), s: cell({ wrap: true }) }] : []),
      { v: b, s: money() },
      { v: c, s: money() },
      { v: b && c !== null ? c / b : null, s: pctS({ color: diff !== null && diff < 0 ? C.red : undefined }) },
      { v: diff, s: money({ color: tone, bold: true, numFmt: '#,##0.00;-#,##0.00' }) },
      { v: diff !== null && b ? diff / b : null, s: pctS({ color: tone, numFmt: '+0.0%;-0.0%;0.0%' }) },
      ...(hasIncome
        ? [
            { v: i, s: money() },
            { v: profit, s: money({ color: profit !== null && profit < 0 ? C.red : undefined }) },
            { v: profit !== null && i ? profit / i : null, s: pctS() }
          ]
        : []),
      { v: has(k.budget) ? Number(k.budget.amount) : null, s: money({ color: C.faint }) },
      { v: has(k.budget) ? k.budget.currency || 'USD' : '', s: cell({ align: 'center', color: C.faint }) },
      { v: has(k.contract) ? Number(k.contract.amount) : null, s: money({ color: C.faint }) },
      { v: has(k.contract) ? k.contract.currency || 'USD' : '', s: cell({ align: 'center', color: C.faint }) },
      ...(hasIncome
        ? [
            { v: has(k.income) ? Number(k.income.amount) : null, s: money({ color: C.faint }) },
            { v: has(k.income) ? k.income.currency || 'USD' : '', s: cell({ align: 'center', color: C.faint }) }
          ]
        : []),
      { v: inq(k.inquiryId), s: cell({ wrap: true }) },
      { v: (k.files || []).map((f: any) => f.name).join('\n'), s: cell({ wrap: true }) }
    ])
  })
  // 合计
  const T = (extra: Style = {}) => ({ fill: C.total, bold: true, ...extra })
  const totTone = tot.diff < 0 ? C.red : C.green
  const totalRow: Cell[] = [
    { v: `合计（${disp}）`, s: cell(T()) },
    ...Array.from({ length: perPkg ? 6 : 5 }, () => ({ v: null, s: cell(T()) })),
    { v: tot.b, s: money(T()) },
    { v: tot.c, s: money(T()) },
    { v: tot.sb ? tot.c / tot.sb : null, s: pctS(T()) },
    { v: tot.sb ? tot.diff : null, s: money(T({ color: totTone, numFmt: '#,##0.00;-#,##0.00' })) },
    { v: tot.sb ? tot.diff / tot.sb : null, s: pctS(T({ color: totTone, numFmt: '+0.0%;-0.0%;0.0%' })) },
    ...(hasIncome ? [{ v: tot.i, s: money(T()) }, { v: tot.pi ? tot.profit : null, s: money(T()) }, { v: tot.pi ? tot.profit / tot.pi : null, s: pctS(T()) }] : [])
  ]
  while (totalRow.length < n) totalRow.push({ v: null, s: cell(T()) })
  rows.push(totalRow)
  merges.push([rows.length - 1, 0, rows.length - 1, perPkg ? 6 : 5])
  const notes: string[] = []
  if (tot.sb && tot.sb !== tot.b) notes.push(`「签订价 / 责任成本」和合计节超只算已签订价的合同包（对应责任成本 ${tot.sb.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${disp}）。`)
  if (missing) notes.push('有币种缺汇率，对应金额没法换算，留空。')
  for (const t of notes) {
    rows.push([{ v: t, s: { color: C.faint, size: 9, italic: true } }])
    merges.push([rows.length - 1, 0, rows.length - 1, n - 1])
  }
  const base = [5, 26, 22, 14, 11, 8, ...(perPkg ? [18] : []), 15, 15, 10, 15, 9, ...(hasIncome ? [15, 15, 9] : []), 15, 6, 15, 6, ...(hasIncome ? [15, 6] : []), 18, 40]
  const sheets: Sheet[] = [
    {
      name: '合同包对比',
      rows,
      merges,
      cols: fitCols(rows.slice(3, 3 + pkgs.length), base),
      freeze: { rows: 3, cols: 2 },
      filter: pkgs.length ? { row: 2, c1: 0, c2: n - 1, lastRow: 2 + pkgs.length } : undefined,
      printTitleRow: 2,
      heights: [26, 18, 32]
    }
  ]

  // 汇率方案
  const curs = [...new Set(sets.flatMap((s) => Object.keys(s.rates || {})))].sort()
  const rc = [perPkg ? '默认' : '本次使用', '确认日期', '备注', ...(perPkg ? ['使用的合同包'] : []), ...curs.map((c) => `1 USD = ? ${c}`)]
  const rrows: Cell[][] = [[{ v: '汇率方案', s: S.title }], [{ v: '按「1 美元可以换多少外币」记录；任意两种币种经美元互相换算。', s: S.sub }], rc.map((c) => ({ v: c, s: S.head }))]
  for (const s of sets) {
    const on = s.id === active?.id
    const f = on ? { fill: C.used, bold: true } : {}
    rrows.push([
      { v: on ? '✓' : '', s: cell({ align: 'center', ...f }) },
      { v: s.date || '', s: cell({ align: 'center', ...f }) },
      { v: s.note || '', s: cell({ wrap: true, ...f }) },
      ...(perPkg ? [{ v: pkgs.filter((k) => setOf(k)?.id === s.id).map((k) => k.name).join('\n'), s: cell({ wrap: true, ...f }) }] : []),
      ...curs.map((c) => ({ v: s.rates?.[c] ?? null, s: cell({ numFmt: '#,##0.0000', align: 'right' as const, ...f }) }))
    ])
  }
  if (!sets.length) rrows.push([{ v: '还没有汇率方案', s: S.sub }])
  sheets.push({ name: '汇率', rows: rrows, merges: [[0, 0, 0, Math.max(0, rc.length - 1)], [1, 0, 1, Math.max(0, rc.length - 1)]], cols: fitCols(rrows.slice(3), [9, 12, 24, ...(perPkg ? [30] : []), ...curs.map(() => 16)]), freeze: { rows: 3 }, heights: [26, 18, 24] })

  return { buffer: buildXlsx(sheets, { title: `${pname} 履约成本分析` }), fileName: `${pname} 履约成本 ${today}.xlsx`.replace(/[\\/:*?"<>|]/g, '_') }
}
