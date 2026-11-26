import { useEffect, useMemo, useState } from 'react'
import { api, FileLink, joinPath, navOfPath, normPath, uid, useApp, ymd } from '../lib'
import { Empty, Modal } from '../ui'
import { CompanyPicker, useSup } from './Companies'
import RefPicker, { RefAttrs } from './RefPicker'

// 履约成本：在履约项目按合同包对比「责任成本」和「签订价（实际招标成本）」，可选填对业主的收入看毛利。
// 每个项目一条记录：合同包列表 + 一套汇率（1 USD = ? 外币），所有金额可以换算成任一币种显示。

type Money = { amount?: number | null; currency?: string }
type Pkg = {
  id: string
  name: string
  companyId?: string | null
  contractNo?: string
  signDate?: string
  status?: string
  budget?: Money // 责任成本
  contract?: Money // 签订价（实际招标成本）
  income?: Money // 对应收入（可选）
  inquiryId?: string | null
  rateSetId?: string | null // 按合同包换算时用的汇率方案，空 = 默认方案
  files?: FileLink[]
  note?: string
}
/** 一套汇率方案：哪天确认的、备注（如「合同签订时」「月底结算」）、各币种汇率 */
type RateSet = { id: string; date?: string; note?: string; rates: Record<string, number> }
// rates / rateDate 始终同步为当前方案的内容（老数据只有这两个字段时当作一套方案）
type CostRec = { id: string; projectId: string; displayCurrency?: string; rates?: Record<string, number>; rateDate?: string; rateSets?: RateSet[]; rateSetId?: string; rateMode?: 'unified' | 'pkg'; packages?: Pkg[] }

function rateSetsOf(rec: CostRec): { sets: RateSet[]; active: RateSet | null } {
  const sets: RateSet[] = rec.rateSets?.length ? rec.rateSets : rec.rates && Object.keys(rec.rates).length ? [{ id: 'legacy', date: rec.rateDate, note: '', rates: rec.rates }] : []
  return { sets, active: sets.find((s) => s.id === rec.rateSetId) || sets[0] || null }
}
const setLabel = (s: RateSet) => [s.date || '未填日期', s.note].filter(Boolean).join(' · ')

const STATUS = ['招标中', '已签约', '已结算']
const statusCls = (s?: string) => (s === '已结算' ? 'good' : s === '已签约' ? 'amber' : '')

/** 换算：rates 里是「1 USD = r 外币」，USD 自己是 1。缺汇率时返回 null */
function makeFx(rates: Record<string, number> = {}) {
  const r = (c?: string) => (!c || c === 'USD' ? 1 : rates[c] > 0 ? rates[c] : null)
  return (m: Money | undefined, to: string) => {
    if (!m || m.amount === null || m.amount === undefined || (m.amount as any) === '') return null
    const a = r(m.currency)
    const b = r(to)
    return a && b ? (Number(m.amount) / a) * b : null
  }
}
const fmt = (n: number | null | undefined, digits = 0) => (n === null || n === undefined || !isFinite(n) ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }))
const pct = (n: number | null) => (n === null || !isFinite(n) ? '—' : (n * 100).toFixed(1) + '%')
const hasAmt = (m?: Money) => !!m && m.amount !== null && m.amount !== undefined && (m.amount as any) !== ''

export default function Costs({ focusId }: { focusId?: string }) {
  const { data, saveItem, deleteItem } = useApp()
  const recs: CostRec[] = data.costs || []
  const [sel, setSel] = useState<string | null>(focusId || recs[0]?.projectId || null)
  const [adding, setAdding] = useState(false)
  const rec = recs.find((r) => r.projectId === sel)

  // 左侧：已建立成本表的项目，按进行中的优先
  const projOf = (id: string) => data.projects.find((p) => p.id === id)
  const list = recs.map((r) => ({ r, p: projOf(r.projectId) })).filter((x) => x.p)
  const candidates = data.projects.filter((p) => !recs.some((r) => r.projectId === p.id))

  const addProject = async (projectId: string) => {
    setAdding(false)
    if (!projectId) return
    await saveItem('costs', { id: uid(), projectId, displayCurrency: 'USD', rates: {}, packages: [] })
    setSel(projectId)
  }

  return (
    <>
      <div className="topbar">
        <h1>履约成本</h1>
        <span className="faint" style={{ fontSize: 12 }}>按合同包对比责任成本与签订价，看节超和利润</span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)} disabled={!candidates.length}>+ 添加项目</button>
      </div>
      <div className="lib-wrap">
        <div className="lib-types" style={{ width: 240 }}>
          {list.length === 0 && <div className="faint" style={{ fontSize: 12, padding: 8, lineHeight: 1.7 }}>点右上角「+ 添加项目」，选一个在履约的项目，再把签了的合同一个个加进来。</div>}
          {list.map(({ r, p }) => {
            const n = (r.packages || []).length
            return (
              <div key={r.id} className={'tpl-item' + (sel === r.projectId ? ' on' : '')} onClick={() => setSel(r.projectId)}>
                <b style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p!.name}</b>
                <div className="faint" style={{ fontSize: 11 }}>
                  {n} 个合同包 · {p!.status || ''}
                </div>
              </div>
            )
          })}
        </div>
        <div className="lib-list">
          {rec && projOf(rec.projectId) ? (
            <CostDetail key={rec.id} rec={rec} onRemove={async () => {
              if (!confirm(`从履约成本里移除「${projOf(rec.projectId)!.name}」？（只删这张成本表，不动项目和文件）`)) return
              await deleteItem('costs', rec.id)
              setSel(null)
            }} />
          ) : (
            <Empty title={list.length ? '选左边的一个项目' : '还没有履约项目'} text="把在履约项目的每个合同包（分包、采购合同）列出来：责任成本、签订价、币种，确认汇率后统一换算，一眼看出节约还是超支。">
              {candidates.length > 0 && <button className="btn primary" onClick={() => setAdding(true)}>+ 添加项目</button>}
            </Empty>
          )}
        </div>
      </div>
      {adding && (
        <Modal title="添加履约项目" width={420} onClose={() => setAdding(false)}>
          <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>选一个项目，为它建一张责任成本表。</div>
          <div className="cost-pick">
            {[...candidates]
              .sort((a, b) => Number(b.status === '进行中') - Number(a.status === '进行中'))
              .map((p) => (
                <button key={p.id} className="cost-pick-row" onClick={() => addProject(p.id)}>
                  <span>{p.name}</span>
                  <span className="faint">{p.status || ''}</span>
                </button>
              ))}
          </div>
        </Modal>
      )}
    </>
  )
}

function CostDetail({ rec, onRemove }: { rec: CostRec; onRemove: () => void }) {
  const { data, saveItem, go, toast } = useApp()
  const sup = useSup()
  const p = data.projects.find((x) => x.id === rec.projectId)!
  const pkgs = rec.packages || []
  const { sets, active } = rateSetsOf(rec)
  // 换算方式：统一用默认方案；或每个合同包用自己选的方案（如签订时的汇率），没选的用默认方案
  const perPkg = rec.rateMode === 'pkg' && sets.length > 1
  const setOf = (k: Pkg) => (perPkg && sets.find((s) => s.id === k.rateSetId)) || active
  const used = useMemo(() => [...new Set(pkgs.flatMap((k) => [k.budget?.currency, k.contract?.currency, k.income?.currency]).filter(Boolean) as string[])], [pkgs])
  const currencies = [...new Set(['USD', ...used, ...sup.currencies])]
  const disp = rec.displayCurrency || 'USD'
  const missing: string[] = []
  for (const k of pkgs) {
    const r = setOf(k)?.rates || {}
    for (const c of [k.budget?.currency, k.contract?.currency, k.income?.currency, disp]) if (c && c !== 'USD' && !(r[c] > 0) && !missing.includes(c)) missing.push(c)
  }
  if (!pkgs.length && disp !== 'USD' && !((active?.rates || {})[disp] > 0)) missing.push(disp)
  const [edit, setEdit] = useState<Pkg | null>(null)
  const [rateOpen, setRateOpen] = useState(false)

  const save = (patch: Partial<CostRec>) => saveItem('costs', { id: rec.id, ...patch })
  const applySet = (v: string) => {
    if (v === '__pkg') return save({ rateMode: 'pkg' })
    const s = sets.find((x) => x.id === v)!
    save({ rateMode: 'unified', rateSetId: s.id, rates: s.rates, rateDate: s.date })
  }
  const savePkg = (k: Pkg) => save({ packages: pkgs.some((x) => x.id === k.id) ? pkgs.map((x) => (x.id === k.id ? k : x)) : [...pkgs, k] })
  const delPkg = (id: string) => save({ packages: pkgs.filter((x) => x.id !== id) })

  // 每行算好的数（显示币种）
  const rows = pkgs.map((k) => {
    const rs = setOf(k)
    const fx = makeFx(rs?.rates || {})
    const b = fx(k.budget, disp)
    const c = fx(k.contract, disp)
    const i = fx(k.income, disp)
    const save_ = b !== null && c !== null ? b - c : null // 节超：正数节约，负数超支
    return { k, rs, b, c, i, diff: save_, diffRate: save_ !== null && b ? save_ / b : null, ratio: b && c !== null ? c / b : null, profit: i !== null && c !== null ? i - c : null, margin: i && c !== null ? (i - c) / i : null }
  })
  // 各合同包用的都是同一套时不逐行标，表头说一句就行
  const sameRate = new Set(rows.map((r) => r.rs?.id)).size <= 1
  const sum = (f: (r: (typeof rows)[number]) => number | null, only?: (r: (typeof rows)[number]) => boolean) => rows.filter((r) => (only ? only(r) : true)).reduce((s, r) => s + (f(r) ?? 0), 0)
  const signed = rows.filter((r) => r.c !== null && r.b !== null)
  const tot = {
    budget: sum((r) => r.b),
    contract: sum((r) => r.c),
    signedBudget: sum((r) => r.b, (r) => r.c !== null && r.b !== null),
    diff: sum((r) => r.diff, (r) => r.diff !== null),
    income: sum((r) => r.i),
    profitIncome: sum((r) => r.i, (r) => r.i !== null && r.c !== null),
    profit: sum((r) => r.profit, (r) => r.profit !== null),
    over: rows.filter((r) => r.diff !== null && r.diff < 0).length
  }
  const totDiffRate = tot.signedBudget ? tot.diff / tot.signedBudget : null
  const totMargin = tot.profitIncome ? tot.profit / tot.profitIncome : null
  const hasIncome = rows.some((r) => hasAmt(r.k.income))
  const co = (id?: string | null) => data.companies.find((c) => c.id === id)?.name || ''
  const orig = (m?: Money) => (hasAmt(m) && m!.currency !== disp ? `${fmt(Number(m!.amount))} ${m!.currency}` : '')

  return (
    <div className="cost-page">
      <div className="cost-head">
        <div>
          <div className="cost-title click" onClick={() => go({ page: 'project', projectId: p.id })} title="打开项目">
            {p.name}
          </div>
          <div className="faint" style={{ fontSize: 12 }}>
            {pkgs.length} 个合同包 · 已签 {signed.length} 个{tot.over ? ` · ` : ''}
            {tot.over > 0 && <span className="red-text">{tot.over} 个超出责任成本</span>}
            {perPkg && sameRate && rows[0]?.rs && <span title={setLabel(rows[0].rs)}> · 各合同包都按 {(rows[0].rs.date || '').slice(5)} 汇率</span>}
          </div>
        </div>
        <span className="spacer" />
        <label className="cost-disp">
          显示币种
          <select className="input" value={disp} onChange={(e) => save({ displayCurrency: e.target.value })}>
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        {sets.length > 1 && (
          <label className="cost-disp" title="统一：整个项目按同一套汇率对比；各合同包：每个合同包按自己选的汇率（如签订时），在合同包里选，没选的用默认方案">
            汇率
            <select className="input" style={{ maxWidth: 240 }} value={perPkg ? '__pkg' : active?.id || ''} onChange={(e) => applySet(e.target.value)}>
              <option value="__pkg">各合同包用自己的汇率</option>
              <optgroup label="整个项目统一用">
                {sets.map((s) => (
                  <option key={s.id} value={s.id}>{setLabel(s)}</option>
                ))}
              </optgroup>
            </select>
          </label>
        )}
        <button className={'btn' + (missing.length ? ' warn-btn' : '')} onClick={() => setRateOpen(true)} title="保存几套汇率（可备注），一键切换">
          {missing.length ? `缺 ${missing.join('、')} 汇率` : sets.length > 1 ? '汇率方案…' : active ? `汇率 · ${setLabel(active)}` : '汇率未确认'}
        </button>
        <button className="btn" disabled={!pkgs.length} onClick={() => api.call('cost:export', rec.id).catch((e: any) => toast(e.message || String(e)))} title="按当前币种和汇率方案导出 Excel">
          导出 Excel
        </button>
        <button className="btn primary" onClick={() => setEdit({ id: uid(), name: '', status: '已签约', budget: { currency: disp }, contract: { currency: disp }, files: [] })}>
          + 合同包
        </button>
      </div>

      <div className="cost-kpis">
        <Kpi label="责任成本合计" value={fmt(tot.budget)} unit={disp} />
        <Kpi label="已签合同合计" value={fmt(tot.contract)} unit={disp} sub={`对应责任成本 ${fmt(tot.signedBudget)}`} />
        <Kpi
          label={tot.diff >= 0 ? '节约（责任成本 − 签订价）' : '超支（签订价 − 责任成本）'}
          value={fmt(Math.abs(tot.diff))}
          unit={disp}
          sub={totDiffRate === null ? '已签合同包按责任成本计' : `${tot.diff >= 0 ? '节约率' : '超支率'} ${pct(Math.abs(totDiffRate))}`}
          tone={signed.length ? (tot.diff >= 0 ? 'good' : 'bad') : undefined}
        />
        {hasIncome ? (
          <Kpi label="毛利（收入 − 签订价）" value={fmt(tot.profit)} unit={disp} sub={`毛利率 ${pct(totMargin)}`} tone={tot.profit >= 0 ? 'good' : 'bad'} />
        ) : (
          <Kpi label="毛利" value="—" sub="合同包里填「对应收入」后显示" />
        )}
      </div>

      {missing.length > 0 && (
        <div className="cost-warn" onClick={() => setRateOpen(true)}>
          还没有 {missing.join('、')} 的汇率，这些金额暂时不能换算成 {disp}（显示为「—」）。点这里填写。
        </div>
      )}

      {pkgs.length === 0 ? (
        <Empty title="还没有合同包" text="每签一个分包或采购合同，就加一个合同包：填责任成本和签订价（各自的币种），可以引用项目里的合同文件。">
          <button className="btn primary" onClick={() => setEdit({ id: uid(), name: '', status: '已签约', budget: { currency: disp }, contract: { currency: disp }, files: [] })}>+ 合同包</button>
        </Empty>
      ) : (
        <div className="card cost-table-wrap">
          <table className="cost-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>合同包</th>
                <th>状态</th>
                <th className="num">责任成本</th>
                <th className="num">签订价</th>
                <th style={{ width: 150 }}>签订价 / 责任成本</th>
                <th className="num">节超</th>
                {hasIncome && <th className="num">毛利率</th>}
                <th>文件</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const over = r.diff !== null && r.diff < 0
                return (
                  <tr key={r.k.id} className="click" onClick={() => setEdit(r.k)}>
                    <td>
                      <div className="cost-name">
                        {r.k.name || '未命名合同包'}
                        {perPkg && !sameRate && r.rs && (
                          <span className={'cost-rate-tag' + (r.k.rateSetId && r.rs.id === r.k.rateSetId ? ' own' : '')} title={(r.k.rateSetId && r.rs.id === r.k.rateSetId ? '这个合同包选的汇率' : '没单独选，用默认方案') + '：' + setLabel(r.rs) + '\n' + Object.entries(r.rs.rates).map(([c, v]) => `1 USD = ${v} ${c}`).join('\n')}>
                            {(r.rs.date || '').slice(5) || '未填日期'} 汇率
                          </span>
                        )}
                      </div>
                      <div className="faint cost-sub">{[co(r.k.companyId), r.k.contractNo, r.k.signDate].filter(Boolean).join(' · ') ||' '}</div>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span className={'tag ' + statusCls(r.k.status)}>{r.k.status || '—'}</span>
                    </td>
                    <td className="num">
                      {fmt(r.b)}
                      {orig(r.k.budget) && <div className="faint cost-sub">{orig(r.k.budget)}</div>}
                    </td>
                    <td className="num">
                      {fmt(r.c)}
                      {orig(r.k.contract) && <div className="faint cost-sub">{orig(r.k.contract)}</div>}
                    </td>
                    <td>
                      {r.ratio !== null ? (
                        <div className="cost-bar" title={`签订价是责任成本的 ${pct(r.ratio)}`}>
                          <div className="cost-bar-track">
                            <div className={'cost-bar-fill' + (over ? ' over' : '')} style={{ width: Math.min(100, (r.ratio / 1.25) * 100) + '%' }} />
                            <div className="cost-bar-mark" style={{ left: (1 / 1.25) * 100 + '%' }} />
                          </div>
                          <span className={over ? 'red-text' : ''}>{pct(r.ratio)}</span>
                        </div>
                      ) : (
                        <span className="faint" style={{ fontSize: 12 }}>{hasAmt(r.k.contract) ? '缺汇率' : '未签'}</span>
                      )}
                    </td>
                    <td className={'num ' + (r.diff === null ? '' : over ? 'red-text' : 'green-text')}>
                      {r.diff === null ? '—' : (over ? '超 ' : '省 ') + fmt(Math.abs(r.diff))}
                      {r.diffRate !== null && <div className="cost-sub">{pct(Math.abs(r.diffRate))}</div>}
                    </td>
                    {hasIncome && <td className={'num ' + (r.margin === null ? '' : r.margin < 0 ? 'red-text' : '')}>{pct(r.margin)}</td>}
                    <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                      <FileChips files={r.k.files || []} compact />
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>合计（{disp}）</td>
                <td />
                <td className="num">{fmt(tot.budget)}</td>
                <td className="num">{fmt(tot.contract)}</td>
                <td>{tot.signedBudget ? <span className="faint" style={{ fontSize: 12 }}>已签部分 {pct(tot.contract / (tot.signedBudget || 1))}</span> : null}</td>
                <td className={'num ' + (tot.diff < 0 ? 'red-text' : 'green-text')}>{signed.length ? (tot.diff < 0 ? '超 ' : '省 ') + fmt(Math.abs(tot.diff)) : '—'}</td>
                {hasIncome && <td className="num">{pct(totMargin)}</td>}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <div className="cost-foot faint">
        节超 = 责任成本 − 签订价，正数为节约、负数为超支；按「{disp}」显示，原币金额写在下方小字里。点一行编辑。
        <span className="spacer" />
        <button className="btn small" onClick={onRemove}>移除这张成本表</button>
      </div>

      {rateOpen && (
        <RateDialog
          sets={sets}
          activeId={active?.id || null}
          need={[...new Set([...used.filter((c) => c !== 'USD'), ...(disp !== 'USD' ? [disp] : [])])]}
          all={sup.currencies.filter((c) => c !== 'USD')}
          onSave={(list, id) => {
            const a = list.find((s) => s.id === id) || list[0]
            save({ rateSets: list, rateSetId: a?.id, rates: a?.rates || {}, rateDate: a?.date })
            setRateOpen(false)
          }}
          onClose={() => setRateOpen(false)}
        />
      )}
      {edit && <PkgDialog pkg={edit} project={p} currencies={currencies} sets={sets} defaultSet={active} perPkg={perPkg} onClose={() => setEdit(null)} onSave={(k) => (savePkg(k), setEdit(null))} onDelete={pkgs.some((x) => x.id === edit.id) ? () => (delPkg(edit.id), setEdit(null)) : undefined} />}
    </div>
  )
}

function Kpi({ label, value, unit, sub, tone }: { label: string; value: string; unit?: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={'card cost-kpi' + (tone ? ' ' + tone : '')}>
      <div className="stat-label">{label}</div>
      <div className="cost-kpi-v">
        {value}
        {unit && value !== '—' && <span className="cost-kpi-u">{unit}</span>}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

/**
 * 汇率方案：可以存好几套（如「合同签订时」「本月」「预算口径」），每套有日期和备注；
 * 汇率一律写成「1 USD = ? 外币」。保存时选中的那套就是当前用来换算的。
 */
type EditSet = { id: string; date: string; note: string; rates: Record<string, string> }
function RateDialog({ sets, activeId, need, all, onSave, onClose }: { sets: RateSet[]; activeId: string | null; need: string[]; all: string[]; onSave: (list: RateSet[], activeId: string) => void; onClose: () => void }) {
  const blank = (from?: EditSet): EditSet => ({ id: uid(), date: ymd(), note: '', rates: from ? { ...from.rates } : Object.fromEntries(need.map((c) => [c, ''])) })
  const [list, setList] = useState<EditSet[]>(() => {
    const l = sets.map((s) => ({ id: s.id === 'legacy' ? uid() : s.id, date: s.date || '', note: s.note || '', rates: Object.fromEntries([...new Set([...need, ...Object.keys(s.rates || {})])].map((c) => [c, s.rates?.[c] ? String(s.rates[c]) : ''])) }))
    return l.length ? l : [blank()]
  })
  const initActive = sets.findIndex((s) => s.id === activeId)
  const [act, setAct] = useState(list[Math.max(0, initActive)].id) // 当前使用
  const [cur, setCur] = useState(act) // 正在编辑
  const [extra, setExtra] = useState('')
  const s = list.find((x) => x.id === cur) || list[0]
  const patch = (p: Partial<EditSet>) => setList(list.map((x) => (x.id === s.id ? { ...x, ...p } : x)))
  const codes = Object.keys(s.rates)
  const more = all.filter((c) => !codes.includes(c))
  const lack = (x: EditSet) => need.filter((c) => !(Number(x.rates[c]) > 0))
  const add = () => {
    const n = blank(s)
    setList([...list, n])
    setCur(n.id)
  }
  const del = () => {
    if (list.length <= 1) return
    if (!confirm(`删除汇率方案「${setLabel({ ...s, rates: {} })}」？`)) return
    const rest = list.filter((x) => x.id !== s.id)
    setList(rest)
    setCur(rest[0].id)
    if (act === s.id) setAct(rest[0].id)
  }
  const ok = () => {
    const out: RateSet[] = list.map((x) => ({ id: x.id, date: x.date, note: x.note.trim(), rates: Object.fromEntries(Object.entries(x.rates).filter(([, v]) => Number(v) > 0).map(([c, v]) => [c, Number(v)])) }))
    onSave(out, act)
  }
  return (
    <Modal
      title="汇率方案"
      width={720}
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ fontSize: 12, marginRight: 'auto' }}>默认方案：整个项目统一对比时用它，合同包没单独选汇率时也用它。</span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={ok}>保存</button>
        </>
      }
    >
      <div className="rate-mgr">
        <div className="rate-sets">
          {list.map((x) => (
            <div key={x.id} className={'rate-set' + (x.id === cur ? ' on' : '')} onClick={() => setCur(x.id)}>
              <div className="rate-set-top">
                <b>{x.date || '未填日期'}</b>
                {x.id === act && <span className="tag good">默认</span>}
              </div>
              <div className="faint rate-set-note">{x.note || '无备注'}</div>
              <div className="faint rate-set-vals">
                {Object.entries(x.rates)
                  .filter(([, v]) => Number(v) > 0)
                  .map(([c, v]) => `${c} ${v}`)
                  .join(' · ') || '还没填汇率'}
                {lack(x).length > 0 && <span className="red-text"> · 缺 {lack(x).join('、')}</span>}
              </div>
            </div>
          ))}
          <button className="btn small" style={{ marginTop: 6 }} onClick={add} title="复制当前这套的汇率作为起点">
            + 新建方案
          </button>
        </div>
        <div className="rate-edit">
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <div className="field" style={{ flex: '0 0 150px', margin: 0 }}>
              <label>确认日期</label>
              <input className="input" type="date" value={s.date} onChange={(e) => patch({ date: e.target.value })} />
            </div>
            <div className="field" style={{ flex: 1, margin: 0 }}>
              <label>备注</label>
              <input className="input" value={s.note} placeholder="如：合同签订时、月底结算、预算口径" onChange={(e) => patch({ note: e.target.value })} />
            </div>
          </div>
          <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>按「1 美元可以换多少外币」填写，任意两种币种经美元互相换算。</div>
          {codes.length === 0 && <div className="faint" style={{ marginBottom: 8 }}>合同包都是美元，不需要汇率。</div>}
          {codes.map((c) => (
            <div key={c} className="rate-row">
              <span>1 USD =</span>
              <input className="input" type="number" step="any" min="0" value={s.rates[c]} placeholder="填汇率" onChange={(e) => patch({ rates: { ...s.rates, [c]: e.target.value } })} />
              <b>{c}</b>
              <span className="faint" style={{ fontSize: 12 }}>{Number(s.rates[c]) > 0 ? `1 ${c} ≈ ${(1 / Number(s.rates[c])).toPrecision(4)} USD` : need.includes(c) ? '合同包用到，需要填' : ''}</span>
            </div>
          ))}
          {more.length > 0 && (
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              <select className="input" style={{ width: 'auto' }} value={extra} onChange={(e) => setExtra(e.target.value)}>
                <option value="">再加一种币种…</option>
                {more.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <button className="btn small" disabled={!extra} onClick={() => (patch({ rates: { ...s.rates, [extra]: '' } }), setExtra(''))}>添加</button>
            </div>
          )}
          <div className="row" style={{ marginTop: 14, gap: 6 }}>
            <button className="btn small primary" disabled={act === s.id} onClick={() => setAct(s.id)}>
              {act === s.id ? '✓ 默认方案' : '设为默认'}
            </button>
            <span className="spacer" />
            <button className="btn small danger" disabled={list.length <= 1} onClick={del}>删除这套</button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** 金额 + 币种 */
function MoneyInput({ value, onChange, currencies }: { value?: Money; onChange: (m: Money) => void; currencies: string[] }) {
  const v = value || {}
  return (
    <div className="money-in">
      <input className="input" type="number" step="any" placeholder="金额" value={v.amount ?? ''} onChange={(e) => onChange({ ...v, amount: e.target.value === '' ? null : Number(e.target.value) })} />
      <select className="input" value={v.currency || 'USD'} onChange={(e) => onChange({ ...v, currency: e.target.value })}>
        {currencies.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    </div>
  )
}

function PkgDialog({ pkg, project, currencies, sets, defaultSet, perPkg, onSave, onClose, onDelete }: { pkg: Pkg; project: any; currencies: string[]; sets: RateSet[]; defaultSet: RateSet | null; perPkg: boolean; onSave: (k: Pkg) => void; onClose: () => void; onDelete?: () => void }) {
  const { data, toast } = useApp()
  const [k, setK] = useState<Pkg>(pkg)
  const [picking, setPicking] = useState(false)
  const set = (patch: Partial<Pkg>) => setK({ ...k, ...patch })
  const inqs = data.inquiries.filter((x) => x.projectId === project.id)
  const addFiles = (more: FileLink[]) => {
    const cur = k.files || []
    const add = more.filter((m) => !cur.some((c) => normPath(c.path) === normPath(m.path)))
    if (!add.length) return toast('已经引用过了')
    set({ files: [...cur, ...add] })
  }
  const fromPicker = (refs: RefAttrs[]) => {
    const out: FileLink[] = []
    for (const r of refs) {
      if (r['data-ref'] === 'lib') {
        const it = data.library.find((x) => x.id === r['data-id'])
        if (it) out.push({ path: joinPath(data.libraryDir, it.file), name: it.name || r['data-name'], libId: it.id })
      } else {
        const p = data.projects.find((x) => x.id === r['data-pid'])
        if (p?.rootPath) out.push({ path: joinPath(p.rootPath, r['data-rel']), name: r['data-name'], dir: r['data-dir'] === '1' })
      }
    }
    setPicking(false)
    if (out.length) addFiles(out)
  }
  // 选了询价、还没填签订价时，带出定标单位
  useEffect(() => {
    const x = inqs.find((i) => i.id === k.inquiryId)
    if (x?.awardedCompanyId && !k.companyId) set({ companyId: x.awardedCompanyId })
  }, [k.inquiryId])

  return (
    <Modal
      title={pkg.name ? '编辑合同包' : '新增合同包'}
      width={600}
      onClose={onClose}
      footer={
        <>
          {onDelete && (
            <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => confirm(`删除合同包「${k.name || '未命名'}」？`) && onDelete()}>
              删除
            </button>
          )}
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!k.name.trim()} onClick={() => onSave({ ...k, name: k.name.trim() })}>保存</button>
        </>
      }
    >
      <div className="pkg-form">
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>合同包名称</label>
          <input className="input" autoFocus value={k.name} placeholder="如：电气工程分包、阀门附件采购" onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label>分包 / 供货单位</label>
          <CompanyPicker value={k.companyId} onChange={(id) => set({ companyId: id })} />
        </div>
        <div className="field">
          <label>状态</label>
          <select className="input" value={k.status || ''} onChange={(e) => set({ status: e.target.value })}>
            {STATUS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>合同编号</label>
          <input className="input" value={k.contractNo || ''} onChange={(e) => set({ contractNo: e.target.value })} />
        </div>
        <div className="field">
          <label>签订日期</label>
          <input className="input" type="date" value={k.signDate || ''} onChange={(e) => set({ signDate: e.target.value })} />
        </div>
        <div className="field money">
          <label>责任成本</label>
          <MoneyInput value={k.budget} currencies={currencies} onChange={(m) => set({ budget: m })} />
        </div>
        <div className="field money">
          <label>签订价（实际招标成本）</label>
          <MoneyInput value={k.contract} currencies={currencies} onChange={(m) => set({ contract: m })} />
        </div>
        <div className="field money">
          <label>
            对应收入 <span className="faint">（可选，对业主的合同额，用来算毛利）</span>
          </label>
          <MoneyInput value={k.income} currencies={currencies} onChange={(m) => set({ income: m })} />
        </div>
        <div className="field">
          <label>来自哪条询价 <span className="faint">（可选）</span></label>
          <select className="input" value={k.inquiryId || ''} onChange={(e) => set({ inquiryId: e.target.value || null })}>
            <option value="">不关联</option>
            {inqs.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
        </div>
        {sets.length > 1 && (
          <div className="field">
            <label>
              换算汇率 <span className="faint">{perPkg ? '（如签订时的汇率）' : '（项目切到「各合同包用自己的汇率」时生效）'}</span>
            </label>
            <select className="input" value={k.rateSetId || ''} onChange={(e) => set({ rateSetId: e.target.value || null })}>
              <option value="">默认方案{defaultSet ? `（${setLabel(defaultSet)}）` : ''}</option>
              {sets.map((s) => (
                <option key={s.id} value={s.id}>{setLabel(s)}</option>
              ))}
            </select>
          </div>
        )}
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>引用文件（合同、结算单、责任成本测算表…）</label>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <button className="btn small" onClick={() => setPicking(true)}>🔗 从项目或资料库选择</button>
            <button
              className="btn small"
              onClick={async () => {
                const paths: string[] = await api.call('dialog:pickFiles', '选择要引用的文件')
                if (paths.length) addFiles(paths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop()! })))
              }}
            >
              电脑上的文件…
            </button>
          </div>
          <FileChips files={k.files || []} onRemove={(i) => set({ files: (k.files || []).filter((_, j) => j !== i) })} />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>备注</label>
          <textarea className="input" rows={2} value={k.note || ''} placeholder="变更、扣款、结算说明等" onChange={(e) => set({ note: e.target.value })} />
        </div>
      </div>
      {picking && <RefPicker allowDirs title="引用文件 / 文件夹" okLabel="引用" onClose={() => setPicking(false)} onPick={fromPicker} />}
    </Modal>
  )
}

/** 引用的文件：点名字跳到它在软件里的位置（项目导图、资料库），找不到位置就直接打开 */
function FileChips({ files, onRemove, compact }: { files: FileLink[]; onRemove?: (i: number) => void; compact?: boolean }) {
  const { data, go, toast } = useApp()
  if (!files.length) return compact ? <span className="faint">—</span> : null
  const open = async (f: FileLink) => {
    const err = await api.call('shell:openPath', f.path)
    if (err) toast('打不开：' + err)
  }
  const jump = (f: FileLink) => {
    const n = navOfPath(data, f.path, f.libId)
    if (n) go(n)
    else open(f)
  }
  if (compact)
    return (
      <span className="cost-files" title={files.map((f) => f.name).join('\n')}>
        {files.slice(0, 2).map((f, i) => (
          <button key={f.path + i} className="cost-file" onClick={() => jump(f)} title={'跳到它所在的位置\n' + f.path}>
            {f.dir ? '📁' : '📄'} {f.name}
          </button>
        ))}
        {files.length > 2 && <span className="faint" style={{ fontSize: 11 }}>+{files.length - 2}</span>}
      </span>
    )
  return (
    <div className="todo-files" style={{ marginTop: 6 }}>
      {files.map((f, i) => (
        <span key={f.path + i} className="todo-file" title={f.path}>
          <button className="tf-main" onClick={() => jump(f)}>
            <span>{f.dir ? '📁' : '📄'}</span>
            <span>{f.name}</span>
          </button>
          <button className="tf-act" title="直接打开" onClick={() => open(f)}>↗</button>
          {onRemove && (
            <button className="tf-act" title="取消引用（文件不动）" onClick={() => onRemove(i)}>×</button>
          )}
        </span>
      ))}
    </div>
  )
}
