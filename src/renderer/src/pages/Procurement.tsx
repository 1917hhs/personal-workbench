import { useMemo, useState } from 'react'
import { daysBetween, useApp, ymd } from '../lib'
import { Tabs } from '../ui'
import { toUsd } from './Inquiries'
import { statusCls } from './Companies'

const INQ_CLS: Record<string, string> = { 编制中: '', 询价中: ' blue', 比价中: ' amber', 已定标: ' good', 取消: '' }
const money = (v: number | null | undefined, cur = '') => (v == null || !isFinite(v) ? '—' : `${Math.round(v).toLocaleString()}${cur ? ' ' + cur : ''}`)

/** 每家取最新一轮，返回最低的一条（币种不同时按折合 USD 比） */
function lowest(x: any) {
  const m = new Map<string, any>()
  for (const r of [...(x.quotes || [])].sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0) || String(a.date).localeCompare(String(b.date)))) m.set(r.companyId, r)
  const latest = [...m.values()].filter((r) => Number(r.amount) > 0)
  if (!latest.length) return null
  const sameCur = new Set(latest.map((r) => r.currency)).size === 1
  const key = (r: any) => (sameCur ? Number(r.amount) : toUsd(r) ?? Infinity)
  return latest.sort((a, b) => key(a) - key(b))[0]
}

/** 工作台上的采购概况：询价进度 / 价格 / 供应商 */
export default function ProcurementCard() {
  const { data, go } = useApp()
  const { inquiries, companies, projects } = data
  const [tab, setTab] = useState<'inq' | 'price' | 'sup'>('inq')
  const today = ymd()
  const coName = (id: string) => companies.find((c) => c.id === id)?.name || '?'

  // 询价按项目分组，进行中的在前
  const groups = useMemo(() => {
    const order = ['询价中', '比价中', '编制中', '已定标', '取消']
    const m = new Map<string, any[]>()
    for (const x of inquiries) {
      const k = x.projectId || ''
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(x)
    }
    return [...m.entries()]
      .map(([pid, list]) => ({
        pid,
        name: projects.find((p) => p.id === pid)?.name || '未关联项目',
        list: list.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || String(a.discipline || '').localeCompare(String(b.discipline || ''), 'zh-CN'))
      }))
      .sort((a, b) => (a.pid ? 0 : 1) - (b.pid ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN'))
  }, [inquiries, projects])

  // 所有回价，按收到日期倒序
  const quotes = useMemo(
    () =>
      inquiries
        .flatMap((x) => (x.quotes || []).map((q: any) => ({ ...q, inq: x })))
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))),
    [inquiries]
  )
  // 各专业最低价（已回价的询价）
  const byDisc = useMemo(() => {
    const m = new Map<string, { disc: string; n: number; best: any; inq: any }>()
    for (const x of inquiries) {
      const b = lowest(x)
      if (!b) continue
      const d = x.discipline || '未分专业'
      const cur = m.get(d)
      const usd = toUsd(b)
      if (!cur) m.set(d, { disc: d, n: 1, best: b, inq: x })
      else {
        cur.n++
        if (usd != null && (toUsd(cur.best) == null || usd < (toUsd(cur.best) as number))) Object.assign(cur, { best: b, inq: x })
      }
    }
    return [...m.values()]
  }, [inquiries])

  // 供应商分布
  const sups = companies.filter((c) => c.unitType === '供应商')
  const count = (vals: string[]) => {
    const m = new Map<string, number>()
    for (const v of vals.filter(Boolean)) m.set(v, (m.get(v) || 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }
  const byStatus = count(sups.map((c) => c.status || '未填'))
  const bySpec = count(sups.flatMap((c) => c.specialties || [])).slice(0, 8)
  const byCountry = count(sups.flatMap((c) => c.serviceCountries || []))
  const in60 = ymd(new Date(Date.now() + 60 * 86400000))
  const expiring = sups
    .flatMap((c) => (c.docs || []).filter((d: any) => d.expireDate && d.expireDate <= in60).map((d: any) => ({ c, d })))
    .sort((a, b) => a.d.expireDate.localeCompare(b.d.expireDate))
  const maxStatus = Math.max(1, ...byStatus.map((x) => x[1]))
  const maxSpec = Math.max(1, ...bySpec.map((x) => x[1]))

  const open = inquiries.filter((x) => ['编制中', '询价中', '比价中'].includes(x.status))

  return (
    <div className="card home-card grow-card proc-card">
      <div className="card-head">
        采购概况
        <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>
          进行中 {open.length} · 供应商 {sups.length}
        </span>
        <span className="spacer" />
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { id: 'inq', label: '询价进度' },
            { id: 'price', label: '价格' },
            { id: 'sup', label: '供应商' }
          ]}
        />
      </div>
      <div className="card-body scroll">
        {tab === 'inq' && (
          <>
            {groups.length === 0 && <div className="faint">还没有询价。在「询价」里按项目、专业新建。</div>}
            {groups.map((g) => (
              <div key={g.pid || 'none'} className="proc-group">
                <div className="proc-group-head">
                  <span className={g.pid ? 'click' : ''} onClick={() => g.pid && go({ page: 'project', projectId: g.pid, tab: 'detail' })}>{g.name}</span>
                  <span className="faint">{g.list.length} 个专业包</span>
                </div>
                {g.list.map((x) => {
                  const sends = x.sends || []
                  const replied = sends.filter((s: any) => s.status === '已回价').length
                  const b = lowest(x)
                  const left = x.deadline ? daysBetween(today, x.deadline) : null
                  const active = ['编制中', '询价中', '比价中'].includes(x.status)
                  return (
                    <div key={x.id} className="proc-row click" onClick={() => go({ page: 'inquiries', inquiryId: x.id })}>
                      <span className="tag proc-disc">{x.discipline || '—'}</span>
                      <span className="proc-name" title={x.name}>{x.name}</span>
                      <span className={'tag' + (INQ_CLS[x.status] || '')}>{x.status}</span>
                      <span className="proc-num" title="已回价 / 已发送">
                        <b>{replied}</b>/{sends.length}
                        <div className="proc-bar"><i style={{ width: sends.length ? `${(replied / sends.length) * 100}%` : 0 }} /></div>
                      </span>
                      <span className="proc-price" title={b ? `最低：${coName(b.companyId)}` : ''}>
                        {b ? money(Number(b.amount), b.currency) : <span className="faint">未回价</span>}
                      </span>
                      <span className={'proc-due' + (active && left != null && left < 0 ? ' late' : active && left != null && left <= 3 ? ' soon' : '')}>
                        {x.status === '已定标' ? coName(x.awardedCompanyId) : left == null ? '' : left < 0 ? `截止过 ${-left} 天` : left === 0 ? '今天截止' : `${left} 天后截止`}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </>
        )}

        {tab === 'price' && (
          <>
            {quotes.length === 0 ? (
              <div className="faint">还没有回价。在询价里录入回价后，这里会列出各专业最低价和最近收到的报价。</div>
            ) : (
              <>
                <div className="proc-sub">各专业最低价</div>
                <table className="tbl proc-tbl">
                  <tbody>
                    {byDisc.map((r) => (
                      <tr key={r.disc} className="click-row" onClick={() => go({ page: 'inquiries', inquiryId: r.inq.id })}>
                        <td><span className="tag">{r.disc}</span></td>
                        <td className="muted">{r.inq.name}</td>
                        <td>{coName(r.best.companyId)}</td>
                        <td style={{ textAlign: 'right' }}><b>{money(Number(r.best.amount), r.best.currency)}</b></td>
                        <td className="muted" style={{ textAlign: 'right' }}>{r.best.currency !== 'USD' && toUsd(r.best) != null ? `≈ ${money(toUsd(r.best), 'USD')}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="proc-sub">最近收到的报价</div>
                <table className="tbl proc-tbl">
                  <tbody>
                    {quotes.slice(0, 15).map((q) => (
                      <tr key={q.id} className="click-row" onClick={() => go({ page: 'inquiries', inquiryId: q.inq.id })}>
                        <td className="muted">{q.date ? q.date.slice(5) : ''}</td>
                        <td>{coName(q.companyId)}</td>
                        <td className="muted">{q.inq.discipline || q.inq.name}{q.round > 1 ? ` · 第 ${q.round} 轮` : ''}</td>
                        <td style={{ textAlign: 'right' }}>{money(Number(q.amount), q.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}

        {tab === 'sup' && (
          <>
            {sups.length === 0 && <div className="faint">还没有供应商</div>}
            {sups.length > 0 && (
              <div className="proc-two">
                <div>
                  <div className="proc-sub">入库状态</div>
                  {byStatus.map(([k, n]) => (
                    <div key={k} className="proc-hbar">
                      <span className={'tag' + statusCls(k)}>{k}</span>
                      <div className="proc-bar"><i style={{ width: `${(n / maxStatus) * 100}%` }} /></div>
                      <b>{n}</b>
                    </div>
                  ))}
                  <div className="proc-sub" style={{ marginTop: 10 }}>服务国家</div>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                    {byCountry.map(([k, n]) => (
                      <span key={k} className="tag">{k} {n}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="proc-sub">专业（家数）</div>
                  {bySpec.map(([k, n]) => (
                    <div key={k} className="proc-hbar">
                      <span className="proc-hbar-label">{k}</span>
                      <div className="proc-bar"><i style={{ width: `${(n / maxSpec) * 100}%` }} /></div>
                      <b>{n}</b>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {sups.length > 0 && (
              <>
                <div className="proc-sub" style={{ marginTop: 12 }}>
                  资质 60 天内到期 / 已过期 <span className="faint">{expiring.length}</span>
                </div>
                {expiring.length === 0 && <div className="faint" style={{ fontSize: 12 }}>没有快到期的资质</div>}
                {expiring.slice(0, 8).map(({ c, d }) => (
                  <div key={c.id + d.id} className="proc-row proc-exp click" onClick={() => go({ page: 'contacts', companyId: c.id })}>
                    <span className={'tag' + (d.expireDate < today ? ' red' : ' amber')}>{d.expireDate < today ? '已过期' : '将到期'}</span>
                    <span className="proc-name">{c.name}</span>
                    <span className="faint" style={{ fontSize: 12 }}>{d.name || d.type}</span>
                    <span className="proc-due">{d.expireDate}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
