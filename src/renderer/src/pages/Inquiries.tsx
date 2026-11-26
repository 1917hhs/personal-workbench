import { useEffect, useMemo, useState } from 'react'
import { api, errMsg, uid, useApp, useRemember, ymd } from '../lib'
import { ask, Empty, Modal } from '../ui'
import { companyStats, CompanyPicker, DropZone, Files, useSup } from './Companies'

// 询价：参照飞书「供应商库与询价台账」——项目 → 专业包（这里的一条询价）→ 询价包版本 → 发包记录 → 供应商回价。
// 一条询价里记：询价文件的版次、发给了哪些单位、各家回价，以及比价和定标。

export const INQ = {
  status: ['编制中', '询价中', '比价中', '已定标', '取消'],
  sendStatus: ['已发送', '已回价', '未回复', '放弃报价'],
  channels: ['邮件', '微信', 'WhatsApp', '电话', '现场', '其他'],
  tax: ['含税', '不含税', '未说明']
}
const statusCls = (s: string) => (s === '已定标' ? 'good' : s === '取消' ? '' : s === '比价中' ? 'amber' : '')
const money = (n: any) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }))
/** 折合 USD：填了汇率（1 单位币种 = 多少 USD）就换算；币种本身是 USD 直接用 */
export const toUsd = (q: any) => (q.currency === 'USD' ? Number(q.amount) : q.rate ? Number(q.amount) * Number(q.rate) : null)

export default function Inquiries({ focusId }: { focusId?: string }) {
  const { data, saveItem } = useApp()
  const [sel, setSel] = useState<string | null>(focusId || null)
  useRemember({ inquiryId: sel || undefined })
  const [q, setQ] = useState('')
  const [st, setSt] = useState('')
  const [pid, setPid] = useState('')
  const [exp, setExp] = useState<{ projectId: string; ids: string[] | null } | null>(null)

  const list = data.inquiries
    .filter((x) => !st || x.status === st)
    .filter((x) => !pid || x.projectId === pid)
    .filter((x) => !q.trim() || [x.name, x.discipline, x.scope].join(' ').toLowerCase().includes(q.trim().toLowerCase()))
    // 星标的排在前面，其余按最近修改
    .sort((a, b) => Number(!!b.starred) - Number(!!a.starred) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
  // 没选的时候默认打开列表第一条，不让右边空着
  const cur = data.inquiries.find((x) => x.id === sel) || (sel === null ? list[0] : undefined)

  const add = async () => {
    const name = await ask('新建询价（专业包）', '', '如：1# 楼桩基工程、钢结构材料')
    if (!name) return
    const x = await saveItem('inquiries', { id: uid(), name, projectId: pid || null, status: '编制中', startDate: ymd(), currency: 'CNY', versions: [], sends: [], quotes: [] })
    setSel(x.id)
  }

  return (
    <>
      <div className="topbar">
        <h1>询价</h1>
        <input className="input" style={{ width: 220 }} placeholder="搜索询价、专业、范围…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" style={{ width: 'auto' }} value={st} onChange={(e) => setSt(e.target.value)}>
          <option value="">全部状态</option>
          {INQ.status.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select className="input" style={{ width: 180 }} value={pid} onChange={(e) => setPid(e.target.value)}>
          <option value="">全部项目</option>
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <span className="spacer" />
        <button className="btn" onClick={() => setExp({ projectId: pid || cur?.projectId || '', ids: null })} disabled={!data.inquiries.length} title="导出一个项目全部（或选中几条）询价的汇总表">导出汇总</button>
        <button className="btn primary" onClick={add}>+ 新建询价</button>
      </div>
      {exp && <ExportDialog init={exp} onClose={() => setExp(null)} />}
      <div className="lib-wrap">
        <div className="lib-types" style={{ width: 300 }}>
          {data.inquiries.length === 0 && <div className="faint" style={{ fontSize: 12, padding: 8, lineHeight: 1.7 }}>一条询价对应一个专业包（如「1# 楼桩基」）。发给几家供应商，记下各家回价，自动比价、定标，可以导出比价表。</div>}
          {list.map((x) => {
            const quoted = new Set((x.quotes || []).map((r: any) => r.companyId)).size
            return (
              <div key={x.id} className={'tpl-item' + (cur?.id === x.id ? ' on' : '')} onClick={() => setSel(x.id)}>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className={'star inq-star' + (x.starred ? ' on' : '')}
                    title={x.starred ? '取消星标' : '加星标（排在最前，侧栏「星标询价」里点一下就能打开）'}
                    onClick={(e) => {
                      e.stopPropagation()
                      saveItem('inquiries', { id: x.id, starred: !x.starred })
                    }}
                  >
                    {x.starred ? '★' : '☆'}
                  </button>
                  <b style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name}</b>
                  <span className={'tag ' + statusCls(x.status)}>{x.status}</span>
                </div>
                <div className="faint" style={{ fontSize: 11 }}>
                  {data.projects.find((p) => p.id === x.projectId)?.name || '未关联项目'} · 发 {(x.sends || []).length} 家 · 回 {quoted} 家
                  {x.deadline ? (
                    <span className={x.deadline < ymd() && ['编制中', '询价中'].includes(x.status) ? 'red-text' : ''}>
                      {' · '}截止 {x.deadline.slice(5)}
                      {x.deadline < ymd() && ['编制中', '询价中'].includes(x.status) ? '（已过）' : ''}
                    </span>
                  ) : (
                    ''
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <div className="lib-list">{cur ? <InquiryDetail key={cur.id} x={cur} onDeleted={() => setSel(null)} onExport={() => setExp({ projectId: cur.projectId || '', ids: [cur.id] })} /> : data.inquiries.length ? <Empty title="没有符合筛选条件的询价" /> : <Empty title="还没有询价"><button className="btn primary" onClick={add}>+ 新建询价</button></Empty>}</div>
      </div>
    </>
  )
}

function InquiryDetail({ x, onDeleted, onExport }: { x: any; onDeleted: () => void; onExport: () => void }) {
  const sup = useSup()
  const { data, saveItem, deleteItem, go, toast } = useApp()
  const [sending, setSending] = useState(false)
  const [quoteFor, setQuoteFor] = useState<any>(null)
  // 只传改动的字段，避免慢操作（复制文件）结束时把这期间改的其他字段用旧值盖回去
  const save = (patch: any) => saveItem('inquiries', { id: x.id, ...patch })
  const co = (id: string) => data.companies.find((c) => c.id === id)
  const sends: any[] = x.sends || []
  const quotes: any[] = x.quotes || []
  const versions: any[] = x.versions || []

  const fld = (k: string, label: string, type = 'text', wide = false) => (
    <div className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <label>{label}</label>
      {type === 'area' ? (
        <textarea className="input" rows={2} defaultValue={x[k] || ''} onBlur={(e) => e.target.value !== (x[k] || '') && save({ [k]: e.target.value })} />
      ) : (
        <input type={type} className="input" defaultValue={x[k] ?? ''} onBlur={(e) => e.target.value !== String(x[k] ?? '') && save({ [k]: type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value })} />
      )}
    </div>
  )

  // 比价：每家取最新一轮回价
  const latest = useMemo(() => {
    const m = new Map<string, any>()
    for (const r of [...quotes].sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0) || String(a.date).localeCompare(String(b.date)))) m.set(r.companyId, r)
    return [...m.values()]
  }, [quotes])
  const usdList = latest.map((r) => toUsd(r)).filter((v) => v !== null) as number[]
  const sameCur = new Set(latest.map((r) => r.currency)).size === 1
  const minVal = sameCur ? Math.min(...latest.map((r) => Number(r.amount) || Infinity)) : usdList.length ? Math.min(...usdList) : null
  const isMin = (r: any) => (sameCur ? Number(r.amount) === minVal : toUsd(r) === minVal)

  // 「上传」文件：复制进项目文件夹（询价文件按版次、回价文件按单位分开放）
  const storeFiles = (kind: 'version' | 'quote', sub: string, paths: string[]): Promise<string[]> =>
    api.call('inquiry:storeFiles', { projectId: x.projectId, name: x.name }, kind, sub, paths).catch((e: any) => (toast(errMsg(e)), []))
  // 删除文件：工作台复制进项目「03 询价文件 / 04 回价与比价」的文件移到回收站；别处的原文件只取消关联
  const trash = async (files: string[]) => {
    if (!files?.length) return
    try {
      const n = await api.call('inquiry:trashFiles', files)
      if (n) toast(`已把 ${n} 个文件移到回收站`)
    } catch (e) {
      toast(errMsg(e))
    }
  }
  const fname = (f: string) => f.split(/[\\/]/).pop()
  const newVersion = async (paths: string[]) => {
    const v = (versions.reduce((m, y) => Math.max(m, Number(y.version) || 0), 0) || 0) + 1
    const files = await storeFiles('version', 'V' + v, paths)
    if (!files.length) return
    save({ versions: [{ id: uid(), version: v, date: ymd(), author: '', summary: '', files, status: '当前版本' }, ...versions.map((y) => ({ ...y, status: '已作废' }))] })
    toast(`已新建第 ${v} 版，${files.length} 个文件`)
  }
  const addToVersion = async (v: any, paths: string[]) => {
    const files = await storeFiles('version', 'V' + v.version, paths)
    if (files.length) save({ versions: versions.map((y) => (y.id === v.id ? { ...y, files: [...new Set([...(y.files || []), ...files])] } : y)) })
  }
  // 回价文件拖到某一家那一行：直接打开「记录回价」，文件已附上，收到日期默认今天
  const [dragRow, setDragRow] = useState<string | null>(null)
  const dropQuote = async (s: any, e: React.DragEvent) => {
    e.preventDefault()
    setDragRow(null)
    const paths = Array.from(e.dataTransfer.files).map((f) => api.pathForFile(f)).filter(Boolean)
    if (!paths.length) return
    const files = await storeFiles('quote', co(s.companyId)?.name || '未知单位', paths)
    if (files.length) setQuoteFor({ send: s, files })
  }

  const updSend = (id: string, patch: any) => save({ sends: sends.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  const award = (companyId: string | null) => save({ awardedCompanyId: companyId, status: companyId ? '已定标' : '比价中' })

  // 推荐供应商：专业标签包含询价专业的
  const recommend = data.companies.filter((c) => c.unitType === '供应商' && x.discipline && (c.specialties || []).includes(x.discipline) && !sends.some((s) => s.companyId === c.id))

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <input className="input" style={{ fontSize: 16, fontWeight: 700, flex: 1 }} defaultValue={x.name} onBlur={(e) => e.target.value.trim() && e.target.value !== x.name && save({ name: e.target.value.trim() })} />
        <select className="input" style={{ width: 'auto' }} value={x.status} onChange={(e) => save({ status: e.target.value })}>
          {INQ.status.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <button className="btn" onClick={onExport} title="导出这条询价的比价表，可选工作表和字段">导出比价表</button>
        <button className="btn danger" onClick={async () => confirm(`删除询价「${x.name}」？`) && (await deleteItem('inquiries', x.id), onDeleted())}>删除</button>
      </div>

      <div className="card card-body" style={{ marginBottom: 12 }}>
        <div className="grid3">
          <div className="field">
            <label>所属项目</label>
            <select className="input" value={x.projectId || ''} onChange={(e) => save({ projectId: e.target.value || null })}>
              <option value="">未关联</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>询价专业</label>
            <input className="input" list="inq-disc" defaultValue={x.discipline || ''} onBlur={(e) => e.target.value !== (x.discipline || '') && save({ discipline: e.target.value.trim() })} />
            <datalist id="inq-disc">
              {sup.specialties.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label>币种</label>
            <select className="input" value={x.currency || 'CNY'} onChange={(e) => save({ currency: e.target.value })}>
              {sup.currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          {fld('startDate', '启动时间', 'date')}
          {fld('deadline', '回价截止', 'date')}
          {fld('buyer', '采购负责人')}
          {fld('location', '交货地点')}
          {fld('budget', `控制价 / 测算价（不含税，${x.currency || 'CNY'}）`, 'number')}
          {fld('budgetNote', '控制价说明')}
          {fld('scope', '工作范围简介', 'area', true)}
        </div>
      </div>

      {/* 询价文件版次 */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-head">
          询价文件版次 <span className="faint">{versions.length}</span>
          <span className="spacer" />
          <button
            className="btn small"
            onClick={async () => {
              const files: string[] = await api.call('dialog:pickFiles', '选择询价文件（清单、图纸、技术要求）')
              if (files.length) newVersion(files)
            }}
          >
            + 新版次
          </button>
        </div>
        <DropZone className="card-body" onPaths={newVersion} hint="松开鼠标：用这些文件新建一版询价文件">
          {versions.length === 0 ? (
            <div className="drop-empty">把工程量清单、图纸、技术要求等文件拖到这里，就建好第 1 版；也可以点「+ 新版次」选择文件。改版时再拖一次，旧版自动标为作废。</div>
          ) : (
            <div className="faint" style={{ fontSize: 11.5, marginBottom: 6 }}>文件拖到某一版上是补充到这一版；拖到空白处是新建一版。文件会复制到项目文件夹里保存。</div>
          )}
          {versions.map((v) => (
            <div key={v.id} className="sub-card">
              <div className="row">
                <b>第 {v.version} 版</b>
                <span className={'tag' + (v.status === '当前版本' ? ' good' : '')}>{v.status}</span>
                <input type="date" className="input" style={{ width: 150 }} defaultValue={v.date} onBlur={(e) => save({ versions: versions.map((y) => (y.id === v.id ? { ...y, date: e.target.value } : y)) })} />
                <input className="input" placeholder="编制人" defaultValue={v.author} style={{ width: 100 }} onBlur={(e) => save({ versions: versions.map((y) => (y.id === v.id ? { ...y, author: e.target.value } : y)) })} />
                <input className="input" placeholder="清单内容简介 / 改了什么" defaultValue={v.summary} onBlur={(e) => save({ versions: versions.map((y) => (y.id === v.id ? { ...y, summary: e.target.value } : y)) })} />
                <button className="icon-btn" title="删除这一版" onClick={async () => confirm(`删除第 ${v.version} 版？${v.files?.length ? `其中 ${v.files.length} 个文件会移到回收站。` : ''}`) && (await save({ versions: versions.filter((y) => y.id !== v.id) }), trash(v.files || []))}>×</button>
              </div>
              <Files
                files={v.files}
                onAdd={async () => {
                  const fs: string[] = await api.call('dialog:pickFiles', '添加询价文件')
                  if (fs.length) addToVersion(v, fs)
                }}
                onDropPaths={(ps) => addToVersion(v, ps)}
                dropHint="或把文件拖到这一版"
                onRemove={async (f) => confirm(`删除文件「${fname(f)}」？会移到回收站。`) && (await save({ versions: versions.map((y) => (y.id === v.id ? { ...y, files: y.files.filter((z: string) => z !== f) } : y)) }), trash([f]))}
              />
            </div>
          ))}
        </DropZone>
      </div>

      {/* 发包与回价 */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-head">
          发包与回价 <span className="faint">发 {sends.length} 家 · 已回 {sends.filter((s) => s.status === '已回价').length} 家</span>
          <span className="spacer" />
          <button className="btn small primary" onClick={() => setSending(true)}>+ 发给单位</button>
        </div>
        <div className="card-body">
          {sends.length === 0 && <div className="faint" style={{ fontSize: 12 }}>点「+ 发给单位」选择要询价的供应商。{x.discipline ? `专业标签含「${x.discipline}」的供应商会排在前面。` : '先填「询价专业」，可以按专业推荐供应商。'}</div>}
          {sends.length > 0 && <div className="faint" style={{ fontSize: 11.5, marginBottom: 6 }}>收到回价文件时，直接拖到对应单位那一行，就会打开「记录回价」并附上文件，收到日期默认今天。</div>}
          {sends.length > 0 && (
            <div className="tbl-wrap"><table className="tbl sends-tbl">
              <thead>
                <tr>
                  <th>单位</th>
                  <th>发送日期</th>
                  <th>渠道</th>
                  <th>回价截止</th>
                  <th>状态</th>
                  <th>回价</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sends.map((s) => {
                  const rs = quotes.filter((r) => r.companyId === s.companyId)
                  const c = co(s.companyId)
                  return (
                    <tr
                      key={s.id}
                      className={'drop-row' + (dragRow === s.id ? ' over' : '')}
                      title="把这家的回价文件拖到这一行，直接记录回价"
                      onDragOver={(e) => e.dataTransfer.types.includes('Files') && (e.preventDefault(), dragRow !== s.id && setDragRow(s.id))}
                      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragRow(null)}
                      onDrop={(e) => dropQuote(s, e)}
                    >
                      <td style={{ minWidth: 150 }}>
                        <span className="click" onClick={() => c && go({ page: 'contacts', companyId: c.id })}>{c?.name || '（已删除的单位）'}</span>
                        {c?.grade && c.grade !== '待评价' && <span className="tag" style={{ marginLeft: 4 }}>{c.grade}</span>}
                      </td>
                      <td><input type="date" className="input" style={{ width: '100%', minWidth: 118 }} defaultValue={s.date} onBlur={(e) => updSend(s.id, { date: e.target.value })} /></td>
                      <td>
                        <select className="input" style={{ width: '100%', minWidth: 76 }} value={s.channel || ''} onChange={(e) => updSend(s.id, { channel: e.target.value })}>
                          <option value="">—</option>
                          {INQ.channels.map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      </td>
                      <td><input type="date" className="input" style={{ width: '100%', minWidth: 118 }} defaultValue={s.deadline || x.deadline || ''} onBlur={(e) => updSend(s.id, { deadline: e.target.value })} /></td>
                      <td>
                        <select className="input" style={{ width: '100%', minWidth: 76 }} value={s.status} onChange={(e) => updSend(s.id, { status: e.target.value })}>
                          {INQ.sendStatus.map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {rs
                          .slice()
                          .sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0))
                          .map((r) => (
                            <div key={r.id} className="round-line">
                              <span className="click" title="打开这一轮回价" onClick={() => setQuoteFor({ quote: r })}>
                                第 {r.round || 1} 轮 · <b>{money(r.amount)}</b> {r.currency}
                              </span>
                              {r.verify === '待核实' && <span className="tag red" style={{ marginLeft: 4 }} title={r.issues || ''}>待核实</span>}
                              {(r.files || []).map((f: string) => (
                                <div key={f} className="click round-file" title={f} onClick={() => api.call('shell:openPath', f)}>
                                  📎 {fname(f)}
                                </div>
                              ))}
                            </div>
                          ))}
                        <button className="btn small" onClick={() => setQuoteFor({ send: s })}>
                          {rs.length ? `+ 第 ${Math.max(...rs.map((r) => Number(r.round) || 1)) + 1} 轮` : '+ 回价'}
                        </button>
                      </td>
                      <td>
                        <button
                          className="icon-btn"
                          title="移除"
                          onClick={async () => confirm(`移除这家？${rs.length ? `它的 ${rs.length} 轮回价也会一起删除，回价文件移到回收站。` : ''}`) && (await save({ sends: sends.filter((y) => y.id !== s.id), quotes: quotes.filter((r) => r.companyId !== s.companyId) }), trash(rs.flatMap((r) => r.files || [])))}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table></div>
          )}
        </div>
      </div>

      {/* 比价 */}
      {latest.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-head">
            比价 <span className="faint">每家取最新一轮，按不含税价比{!sameCur ? '；币种不同时按折合 USD 比较（回价里填汇率）' : ''}{x.budget ? `；控制价 ${money(x.budget)} ${x.currency || ''}` : ''}</span>
          </div>
          <div className="card-body">
            <table className="tbl">
              <thead>
                <tr>
                  <th>单位</th>
                  <th>轮次</th>
                  <th>报价（不含税）</th>
                  <th>含税总价</th>
                  <th>折合 USD</th>
                  {x.budget ? <th>比控制价</th> : null}
                  <th>工期/交货期（天）</th>
                  <th>付款条件</th>
                  <th>有效期至</th>
                  <th>范围 / 偏差</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {latest
                  .slice()
                  .sort((a, b) => (toUsd(a) ?? Number(a.amount)) - (toUsd(b) ?? Number(b.amount)))
                  .map((r) => (
                    <tr key={r.id} className={isMin(r) ? 'best' : ''}>
                      <td>
                        <span className="click" onClick={() => setQuoteFor({ quote: r })}>{co(r.companyId)?.name}</span>
                        {isMin(r) && <span className="tag good" style={{ marginLeft: 4 }}>最低</span>}
                        {x.awardedCompanyId === r.companyId && <span className="tag amber" style={{ marginLeft: 4 }}>定标</span>}
                        {r.verify === '待核实' && (
                          <span className="tag red" style={{ marginLeft: 4 }} title={r.issues || ''}>
                            待核实
                          </span>
                        )}
                        {r.quoteNo && <div className="faint" style={{ fontSize: 11 }}>{r.quoteNo}</div>}
                        {r.issues && <div className="red-text" style={{ fontSize: 11, maxWidth: 220 }}>{r.issues}</div>}
                      </td>
                      <td>{r.round || 1}{r.versionNo ? <div className="faint" style={{ fontSize: 11 }}>回应 V{r.versionNo}</div> : null}</td>
                      <td>
                        <b>{money(r.amount)}</b> {r.currency}
                        <div className="faint" style={{ fontSize: 11 }}>{r.tax}{r.taxRate ? ` · 税率 ${r.taxRate}%` : ''}</div>
                      </td>
                      <td className="muted">{r.amountWithTax ? `${money(r.amountWithTax)} ${r.currency}` : ''}</td>
                      <td className="muted">{toUsd(r) !== null ? money(toUsd(r)) : ''}</td>
                      {x.budget ? (
                        <td className={Number(r.amount) > x.budget ? 'red-text' : 'muted'}>
                          {(((Number(r.amount) - x.budget) / x.budget) * 100).toFixed(1)}%
                        </td>
                      ) : null}
                      <td className="muted">{r.leadDays}</td>
                      <td className="muted">{r.payment}</td>
                      <td className={r.validTo && r.validTo < ymd() ? 'red-text' : 'muted'}>{r.validTo}{r.validTo && r.validTo < ymd() ? <div style={{ fontSize: 11 }}>已过期</div> : null}</td>
                      <td className="muted" style={{ maxWidth: 220, fontSize: 12 }}>{[r.scopeNote, r.deviation].filter(Boolean).join('；')}</td>
                      <td>
                        {x.awardedCompanyId === r.companyId ? (
                          <button className="btn small" onClick={() => award(null)}>取消定标</button>
                        ) : (
                          <button className="btn small" onClick={() => award(r.companyId)}>定标</button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <div className="field" style={{ marginTop: 10 }}>
              <label>比选结论</label>
              <textarea className="input" rows={2} defaultValue={x.conclusion || ''} onBlur={(e) => e.target.value !== (x.conclusion || '') && save({ conclusion: e.target.value })} />
            </div>
          </div>
        </div>
      )}

      {sending && (
        <SendDialog
          x={x}
          recommend={recommend}
          onClose={() => setSending(false)}
          onSend={(ids) => {
            const add = ids.filter((id) => !sends.some((s) => s.companyId === id)).map((id) => ({ id: uid(), companyId: id, date: ymd(), channel: '邮件', deadline: x.deadline || '', status: '已发送' }))
            save({ sends: [...sends, ...add], status: x.status === '编制中' ? '询价中' : x.status })
            setSending(false)
          }}
        />
      )}
      {quoteFor && (
        <QuoteDialog
          x={x}
          send={quoteFor.send}
          quote={quoteFor.quote}
          initialFiles={quoteFor.files}
          storeFiles={(paths, company) => storeFiles('quote', company, paths)}
          onClose={(added) => (trash(added), setQuoteFor(null))}
          onSave={async (r, del, removed) => {
            const others = quotes.filter((y) => y.id !== r.id)
            const nextQuotes = del ? others : [...others, r]
            // 收到回价：把对应发包状态改为「已回价」
            const nextSends = sends.map((s) => (s.companyId === r.companyId && !del && s.status !== '已回价' ? { ...s, status: '已回价' } : s))
            const allIn = nextSends.length && nextSends.every((s) => s.status !== '已发送')
            setQuoteFor(null)
            // 先保存再删文件：删的时候主进程会跳过别处还在用的文件
            await save({ quotes: nextQuotes, sends: nextSends, status: allIn && x.status === '询价中' ? '比价中' : x.status })
            trash(del ? r.files || [] : removed || [])
          }}
        />
      )}
    </div>
  )
}

function SendDialog({ x, recommend, onClose, onSend }: { x: any; recommend: any[]; onClose: () => void; onSend: (ids: string[]) => void }) {
  const { data } = useApp()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [newId, setNewId] = useState<string | null>(null)
  const already = new Set((x.sends || []).map((s: any) => s.companyId))
  const sups = data.companies
    .filter((c) => !already.has(c.id))
    .filter((c) => !q.trim() || [c.name, ...(c.specialties || []), c.products].join(' ').toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(recommend.includes(b)) - Number(recommend.includes(a)) || Number(b.unitType === '供应商') - Number(a.unitType === '供应商') || a.name.localeCompare(b.name, 'zh-CN'))
  const toggle = (id: string) => setPicked((s) => (s.has(id) ? new Set([...s].filter((y) => y !== id)) : new Set([...s, id])))
  return (
    <Modal
      title="发给哪些单位"
      onClose={onClose}
      width={620}
      footer={
        <>
          <span className="faint" style={{ marginRight: 'auto' }}>已选 {picked.size} 家</span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!picked.size} onClick={() => onSend([...picked])}>添加发包记录</button>
        </>
      }
    >
      <div className="row" style={{ marginBottom: 8 }}>
        <input autoFocus className="input" placeholder="搜索单位名称、专业、产品…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div style={{ width: 220 }}>
          <CompanyPicker
            value={newId}
            filterType="供应商"
            onChange={(id) => {
              setNewId(id)
              if (id) setPicked((s) => new Set([...s, id]))
            }}
          />
        </div>
      </div>
      {recommend.length > 0 && <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>专业标签含「{x.discipline}」的供应商排在前面</div>}
      <div style={{ maxHeight: 380, overflow: 'auto' }}>
        {sups.map((c) => {
          const s = companyStats(data.inquiries, c.id)
          return (
            <label key={c.id} className="list-row" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
              <span className="grow">
                <b>{c.name}</b> <span className="faint" style={{ fontSize: 12 }}>{c.unitType}{c.category ? ' · ' + c.category : ''}</span>
                {recommend.includes(c) && <span className="tag good" style={{ marginLeft: 4 }}>推荐</span>}
              </span>
              {(c.specialties || []).slice(0, 3).map((t: string) => (
                <span key={t} className="tag">{t}</span>
              ))}
              {c.grade && c.grade !== '待评价' && <span className="tag">{c.grade}</span>}
              <span className="faint" style={{ fontSize: 11, width: 90, textAlign: 'right' }}>{s.sends ? `回价率 ${s.rate}%` : '未询过'}</span>
            </label>
          )
        })}
        {sups.length === 0 && <div className="faint">没有可选的单位。用上面的「+」新建一个供应商。</div>}
      </div>
    </Modal>
  )
}

function QuoteDialog({
  x,
  send,
  quote,
  initialFiles,
  storeFiles,
  onClose,
  onSave
}: {
  x: any
  send?: any
  quote?: any
  initialFiles?: string[]
  storeFiles: (paths: string[], company: string) => Promise<string[]>
  onClose: (added: string[]) => void
  onSave: (r: any, del?: boolean, removed?: string[]) => void
}) {
  const sup = useSup()
  const { data } = useApp()
  const companyId = quote?.companyId || send?.companyId
  const rounds = (x.quotes || []).filter((r: any) => r.companyId === companyId).length
  const [r, setR] = useState<any>(
    quote || { id: uid(), companyId, sendId: send?.id, date: ymd(), round: rounds + 1, amount: '', currency: x.currency || 'CNY', rate: '', tax: '含税', leadDays: '', payment: '', validTo: '', deviation: '', channel: send?.channel || '', files: initialFiles || [], note: '' }
  )
  const set = (k: string, v: any) => setR((y: any) => ({ ...y, [k]: v }))
  // 这次新复制进来的文件（点取消就删掉，不留垃圾）；要删的文件（点保存才移到回收站，取消就不动）
  const [added, setAdded] = useState<string[]>(quote ? [] : initialFiles || [])
  const [removed, setRemoved] = useState<string[]>([])
  const cancel = () => onClose(added)
  const name = data.companies.find((c) => c.id === companyId)?.name
  const addFiles = async (paths: string[]) => {
    const fs = await storeFiles(paths, name || '未知单位')
    if (fs.length) {
      setR((y: any) => ({ ...y, files: [...new Set([...(y.files || []), ...fs])] }))
      setAdded((a) => [...a, ...fs])
    }
  }
  return (
    <Modal
      title={`${quote ? '编辑' : '记录'}回价：${name || ''}`}
      onClose={cancel}
      width={620}
      footer={
        <>
          {quote && (
            <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => confirm(`删除第 ${r.round || 1} 轮回价？${r.files?.length ? `它的 ${r.files.length} 个回价文件会移到回收站。` : ''}`) && onSave(r, true)}>
              删除
            </button>
          )}
          <button className="btn" onClick={cancel}>取消</button>
          <button className="btn primary" disabled={r.amount === '' || isNaN(Number(r.amount))} onClick={() => onSave({ ...r, amount: Number(r.amount), rate: r.rate === '' ? null : Number(r.rate) }, false, removed)}>
            保存
          </button>
        </>
      }
    >
      <div className="grid3">
        <div className="field">
          <label>报价金额 *（不含税净价）</label>
          <input autoFocus type="number" className="input" value={r.amount} onChange={(e) => set('amount', e.target.value)} />
        </div>
        <div className="field">
          <label>币种</label>
          <select className="input" value={r.currency} onChange={(e) => set('currency', e.target.value)}>
            {sup.currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>汇率（1 {r.currency} = ? USD）</label>
          <input type="number" className="input" value={r.rate ?? ''} disabled={r.currency === 'USD'} onChange={(e) => set('rate', e.target.value)} placeholder={r.currency === 'USD' ? '—' : '比价用，可不填'} />
        </div>
        <div className="field">
          <label>收到日期（默认今天）</label>
          <input type="date" className="input" value={r.date} onChange={(e) => set('date', e.target.value)} />
        </div>
        <div className="field">
          <label>轮次</label>
          <input type="number" className="input" value={r.round} onChange={(e) => set('round', Number(e.target.value) || 1)} />
        </div>
        <div className="field">
          <label>报价金额是否含税</label>
          <select className="input" value={r.tax} onChange={(e) => set('tax', e.target.value)}>
            {INQ.tax.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>税率 %（如 KDV 20）</label>
          <input type="number" className="input" value={r.taxRate ?? ''} onChange={(e) => set('taxRate', e.target.value === '' ? null : Number(e.target.value))} />
        </div>
        <div className="field">
          <label>含税总价</label>
          <input
            type="number"
            className="input"
            value={r.amountWithTax ?? ''}
            placeholder={r.tax === '不含税' && r.taxRate && r.amount ? `约 ${money(Number(r.amount) * (1 + r.taxRate / 100))}` : ''}
            onChange={(e) => set('amountWithTax', e.target.value === '' ? null : Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label>报价编号</label>
          <input className="input" value={r.quoteNo || ''} onChange={(e) => set('quoteNo', e.target.value)} placeholder="如 DNM-2026-017 REV1" />
        </div>
        <div className="field">
          <label>回应的询价文件</label>
          <select className="input" value={r.versionNo || ''} onChange={(e) => set('versionNo', e.target.value ? Number(e.target.value) : null)}>
            <option value="">—</option>
            {(x.versions || []).map((v: any) => (
              <option key={v.id} value={v.version}>第 {v.version} 版{v.date ? `（${v.date}）` : ''}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>工期/交货期（天）</label>
          <input type="number" className="input" value={r.leadDays} onChange={(e) => set('leadDays', e.target.value)} />
        </div>
        <div className="field">
          <label>报价有效期至</label>
          <input type="date" className="input" value={r.validTo} onChange={(e) => set('validTo', e.target.value)} />
        </div>
        <div className="field">
          <label>接收渠道</label>
          <select className="input" value={r.channel || ''} onChange={(e) => set('channel', e.target.value)}>
            <option value="">—</option>
            {INQ.channels.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>付款条件</label>
        <input className="input" value={r.payment} onChange={(e) => set('payment', e.target.value)} placeholder="如：预付 30%，进度款 60%，质保金 10%" />
      </div>
      <div className="field">
        <label>报价范围（包含 / 不包含，与询价范围的差异）</label>
        <textarea className="input" rows={2} value={r.scopeNote || ''} onChange={(e) => set('scopeNote', e.target.value)} />
      </div>
      <div className="field">
        <label>技术偏差</label>
        <textarea className="input" rows={2} value={r.deviation} onChange={(e) => set('deviation', e.target.value)} />
      </div>
      <div className="grid3">
        <div className="field">
          <label>核实状态</label>
          <select className="input" value={r.verify || ''} onChange={(e) => set('verify', e.target.value)}>
            <option value="">—</option>
            <option>待核实</option>
            <option>已核实</option>
          </select>
        </div>
        <div className="field" style={{ gridColumn: 'span 2' }}>
          <label>待核实的疑点</label>
          <input className="input" value={r.issues || ''} onChange={(e) => set('issues', e.target.value)} placeholder="如：大写金额与数字不一致；抬头客户不是我方" />
        </div>
      </div>
      <div className="field">
        <label>运费说明 / 备注</label>
        <textarea className="input" rows={2} value={r.note} onChange={(e) => set('note', e.target.value)} />
      </div>
      <div className="field">
        <label>回价文件</label>
        <Files
          files={r.files}
          onAdd={async () => {
            const fs: string[] = await api.call('dialog:pickFiles', '选择回价文件')
            if (fs.length) addFiles(fs)
          }}
          onDropPaths={addFiles}
          dropHint="或把回价文件拖到这里"
          onRemove={(f) => {
            if (!confirm(`删除文件「${f.split(/[\\/]/).pop()}」？点保存后移到回收站。`)) return
            set('files', r.files.filter((y: string) => y !== f))
            setRemoved((x) => [...x, f])
          }}
        />
      </div>
    </Modal>
  )
}

// ---------- 导出：选项目、询价、工作表和回价字段 ----------
type ExportOpts = { sheets: { key: string; label: string; hint: string; def: boolean }[]; fields: { key: string; label: string; def: boolean }[] }
const EXPORT_PREF = 'inqExport.v1'
const loadPref = (): { sheets?: string[]; fields?: string[] } => {
  try {
    return JSON.parse(localStorage.getItem(EXPORT_PREF) || '{}')
  } catch {
    return {}
  }
}

function ExportDialog({ init, onClose }: { init: { projectId: string; ids: string[] | null }; onClose: () => void }) {
  const { data, toast } = useApp()
  const [opts, setOpts] = useState<ExportOpts | null>(null)
  const [pid, setPid] = useState(init.projectId)
  const inProject = (p: string) => data.inquiries.filter((x) => (p ? x.projectId === p : !x.projectId))
  // 默认选中：指定的那几条；否则该项目里没取消的全部
  const [ids, setIds] = useState<Set<string>>(() => new Set(init.ids || inProject(init.projectId).filter((x) => x.status !== '取消').map((x) => x.id)))
  const [sheets, setSheets] = useState<Set<string>>(new Set())
  const [fields, setFields] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.call('inquiry:exportOptions').then((o: ExportOpts) => {
      setOpts(o)
      const pref = loadPref()
      const keep = (saved: string[] | undefined, all: { key: string; def: boolean }[]) => new Set(saved?.length ? saved.filter((k) => all.some((a) => a.key === k)) : all.filter((a) => a.def).map((a) => a.key))
      setSheets(keep(pref.sheets, o.sheets))
      setFields(keep(pref.fields, o.fields))
    })
  }, [])

  const projOpts = data.projects.filter((p) => data.inquiries.some((x) => x.projectId === p.id))
  const hasLoose = data.inquiries.some((x) => !x.projectId)
  const list = inProject(pid)
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, k: string) => {
    const n = new Set(set)
    n.has(k) ? n.delete(k) : n.add(k)
    setter(n)
  }
  const pickProject = (p: string) => {
    setPid(p)
    setIds(new Set(inProject(p).filter((x) => x.status !== '取消').map((x) => x.id)))
  }
  const needFields = sheets.has('compare') || sheets.has('quotes')
  const chosen = list.filter((x) => ids.has(x.id))

  const run = async () => {
    if (!opts) return
    // 按界面里的顺序导出
    const order = [...chosen].sort((a, b) => Number(!!b.starred) - Number(!!a.starred) || String(a.startDate || a.createdAt || '').localeCompare(String(b.startDate || b.createdAt || '')))
    const sheetList = opts.sheets.filter((s) => sheets.has(s.key)).map((s) => s.key)
    const fieldList = opts.fields.filter((f) => fields.has(f.key)).map((f) => f.key)
    try {
      localStorage.setItem(EXPORT_PREF, JSON.stringify({ sheets: sheetList, fields: fieldList }))
    } catch {}
    setBusy(true)
    try {
      const r = await api.call('inquiry:export', { inquiryIds: order.map((x) => x.id), sheets: sheetList, fields: fieldList })
      if (r) onClose()
    } catch (e) {
      toast(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="导出 Excel"
      width={640}
      onClose={onClose}
      footer={
        <>
          <span className="faint" style={{ fontSize: 12, marginRight: 'auto' }}>
            {chosen.length} 条询价 · {sheets.size} 张工作表{needFields ? ` · ${fields.size} 个回价字段` : ''}
          </span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!chosen.length || !sheets.size || (needFields && !fields.size) || busy} onClick={run}>
            {busy ? '正在导出…' : '导出'}
          </button>
        </>
      }
    >
      {!opts ? (
        <div className="faint">正在加载…</div>
      ) : (
        <div className="exp-dlg">
          <div className="exp-sec">
            <div className="exp-head">
              项目
              <select className="input" style={{ width: 'auto', marginLeft: 8 }} value={pid} onChange={(e) => pickProject(e.target.value)}>
                {projOpts.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
                {hasLoose && <option value="">未关联项目</option>}
              </select>
            </div>
            <div className="exp-head">
              询价 <span className="faint">{chosen.length}/{list.length}</span>
              <span className="spacer" />
              <button className="btn small" onClick={() => setIds(new Set(list.map((x) => x.id)))}>全选</button>
              <button className="btn small" onClick={() => setIds(new Set())}>全不选</button>
            </div>
            <div className="exp-list">
              {list.length === 0 && <div className="faint">这个项目还没有询价</div>}
              {list.map((x) => (
                <label key={x.id} className="exp-check">
                  <input type="checkbox" checked={ids.has(x.id)} onChange={() => toggle(ids, setIds, x.id)} />
                  <span className="exp-name">{x.starred ? '★ ' : ''}{x.name}</span>
                  <span className={'tag ' + statusCls(x.status)}>{x.status}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="exp-sec">
            <div className="exp-head">工作表</div>
            <div className="exp-grid">
              {opts.sheets.map((s) => (
                <label key={s.key} className="exp-check" title={s.hint}>
                  <input type="checkbox" checked={sheets.has(s.key)} onChange={() => toggle(sheets, setSheets, s.key)} />
                  <span>
                    {s.label}
                    <span className="faint exp-hint">{s.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {needFields && (
            <div className="exp-sec">
              <div className="exp-head">
                回价字段 <span className="faint">（用于「比价明细」「全部回价」；单位、排名总会导出）</span>
                <span className="spacer" />
                <button className="btn small" onClick={() => setFields(new Set(opts.fields.filter((f) => f.def).map((f) => f.key)))}>恢复默认</button>
                <button className="btn small" onClick={() => setFields(new Set(opts.fields.map((f) => f.key)))}>全选</button>
              </div>
              <div className="exp-fields">
                {opts.fields.map((f) => (
                  <label key={f.key} className={'exp-chip' + (fields.has(f.key) ? ' on' : '')}>
                    <input type="checkbox" checked={fields.has(f.key)} onChange={() => toggle(fields, setFields, f.key)} />
                    {f.label}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="faint" style={{ fontSize: 12 }}>选择会记住，下次导出默认用这次的设置。</div>
        </div>
      )}
    </Modal>
  )
}