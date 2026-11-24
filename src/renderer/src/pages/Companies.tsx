import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errMsg, uid, useApp, ymd } from '../lib'
import { ask, Empty, Tabs } from '../ui'

// 单位库：业主、供应商、设计咨询、施工单位……都是「单位」，联系人绑定到单位。
// 供应商的字段参照飞书多维表格「供应商库与询价台账」：类别、经营角色、专业标签、服务国家、
// 入库状态、开发阶段、综合等级、评分，以及子表 入库资料 / 项目经验，询价统计（发包、回价、回价率）。

/** 默认选项；实际用的是 设置 → 单位与供应商选项 里改过的 */
export const SUP_DEFAULT: Record<string, string[]> = {
  unitTypes: ['供应商', '业主', '设计咨询', '施工单位', '政府部门', '专家单位', '其他'],
  category: ['分包类', '物资类', '服务类', '设备类'],
  role: ['专业分包商', '制造商', '劳务分包商', '经销商', '服务商', '设备租赁商'],
  status: ['名录收集', '资料收集中', '待审核', '已审核', '拟入库', '已入库', '暂做储备', '不合格'],
  stage: ['名录收集', '已接洽', '已询价／回价', '已考察', '已履约'],
  grade: ['A', 'B', 'C', 'D', '待评价'],
  specialties: ['土建', '机电', '混凝土', '桩基', '钢结构', '劳务', '道路', '总包/EPC', '地勘', '土方', '板房', '检验检测', '给排水暖通', '光伏项目', '测绘', '景观绿化', '设备'],
  countries: ['中国', '土耳其', '阿塞拜疆', '沙特', '其他'],
  docTypes: ['工商注册', '税务登记', '分供方资料审查表', '公司简介', '体系认证', '行业许可', '业绩证明', '财务资料', '其他'],
  verify: ['待核实', '已核实', '存疑'],
  currencies: ['CNY', 'USD', 'EUR', 'TRY', 'AZN', 'SAR']
}

export function useSup(): Record<string, string[]> {
  const { data } = useApp()
  return { ...SUP_DEFAULT, ...(data.settings.supplierOptions || {}), verify: SUP_DEFAULT.verify }
}

/** 名字首字头像，颜色按名字固定 */
export function Avatar({ name, size = 32, square = false }: { name: string; size?: number; square?: boolean }) {
  const s = String(name || '?').trim()
  const ch = (s.match(/[一-龥A-Za-z0-9]/) || ['?'])[0].toUpperCase()
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return (
    <span className="avatar" style={{ width: size, height: size, borderRadius: square ? 8 : '50%', fontSize: size * 0.42, background: `hsl(${h} 55% 92%)`, color: `hsl(${h} 45% 35%)` }}>
      {ch}
    </span>
  )
}

/** 点一下复制的文字（电话、邮箱） */
export function Copyable({ text, href }: { text?: string; href?: string }) {
  const { toast } = useApp()
  if (!text) return <span className="faint">—</span>
  return (
    <span className="copyable">
      <span className="click" title="点击复制" onClick={(e) => (e.stopPropagation(), api.call('clipboard:text', text), toast('已复制：' + text))}>
        {text}
      </span>
      {href && (
        <a className="faint" href={href} onClick={(e) => e.stopPropagation()} title="用默认程序打开">
          ↗
        </a>
      )}
    </span>
  )
}

export const statusCls = (s: string) => (s === '已入库' ? ' good' : s === '不合格' ? ' red' : ['已审核', '拟入库'].includes(s) ? ' blue' : s === '暂做储备' ? ' amber' : '')

const gradeColor = (g: string) => (g === 'A' ? 'var(--good)' : g === 'B' ? '#2563eb' : g === 'C' ? 'var(--warn)' : g === 'D' ? 'var(--danger)' : 'var(--text-3)')

/** 某个单位在询价里的统计 */
export function companyStats(inquiries: any[], id: string) {
  let sends = 0
  let quotes = 0
  let last = ''
  const projects = new Set<string>()
  for (const q of inquiries) {
    const s = (q.sends || []).filter((x: any) => x.companyId === id)
    const r = (q.quotes || []).filter((x: any) => x.companyId === id)
    sends += s.length
    quotes += new Set(r.map((x: any) => x.sendId || x.companyId)).size
    for (const x of r) if (x.date > last) last = x.date
    if (s.length && q.projectId) projects.add(q.projectId)
  }
  return { sends, quotes, rate: sends ? Math.round((Math.min(quotes, sends) / sends) * 100) : null, last, projects: [...projects] }
}

/** 搜索用：去掉大小写、空格标点和土耳其字母的附加符号（İ Ş Ç Ğ Ö Ü 按拉丁字母算） */
const fold = (s: any) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/[\s.,，。·_\-()（）]+/g, '')

/** 选择单位：输入几个字就能搜（名称、简称、类型、城市、国家、专业），没有就直接新建 */
export function CompanyPicker({ value, onChange, filterType }: { value?: string | null; onChange: (id: string | null) => void; filterType?: string }) {
  const { data, saveItem } = useApp()
  const cur = data.companies.find((c) => c.id === value)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [idx, setIdx] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const all = useMemo(() => data.companies.filter((c) => !filterType || c.unitType === filterType).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')), [data.companies, filterType])
  const fq = fold(q)
  const list = useMemo(() => {
    if (!fq) return all.slice(0, 200)
    const score = (c: any) => {
      const n = fold(c.name)
      if (n.startsWith(fq)) return 0
      if (n.includes(fq)) return 1
      if (fold(c.shortName).includes(fq)) return 1
      return fold([c.unitType, c.city, ...(c.serviceCountries || []), c.country, ...(c.specialties || []), c.category].join(' ')).includes(fq) ? 2 : 9
    }
    return all
      .map((c) => [c, score(c)] as const)
      .filter(([, s]) => s < 9)
      .sort((a, b) => a[1] - b[1])
      .map(([c]) => c)
      .slice(0, 200)
  }, [all, fq])
  const exact = all.some((c) => fold(c.name) === fq)
  const canCreate = !!q.trim() && !exact
  const total = list.length + (canCreate ? 1 : 0)

  const place = () => {
    const r = inputRef.current?.getBoundingClientRect()
    if (!r) return
    const up = window.innerHeight - r.bottom < 280 && r.top > 300
    setPos({ left: r.left, width: r.width, top: up ? r.top - 4 : r.bottom + 4, up })
  }
  const show = () => {
    place()
    setOpen(true)
    setIdx(0)
  }
  const close = () => {
    setOpen(false)
    setQ('')
  }
  const pick = (id: string | null) => {
    onChange(id)
    close()
    inputRef.current?.blur()
  }
  const create = async () => {
    const name = q.trim()
    if (!name) return
    const c = await saveItem('companies', { id: uid(), name, unitType: filterType || '其他' })
    pick(c.id)
  }
  useEffect(() => {
    listRef.current?.querySelector('.cp-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  return (
    <div className="cp" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && close()}>
      <input
        ref={inputRef}
        className="input cp-input"
        value={open ? q : cur?.name || ''}
        placeholder={open ? (cur ? `搜索单位（当前：${cur.name}）` : '输入名称、城市、专业搜索…') : '未选择，点击搜索单位'}
        onFocus={show}
        onChange={(e) => (setQ(e.target.value), setIdx(0), open || show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(total - 1, i + 1)))
          else if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)))
          else if (e.key === 'Enter') {
            e.preventDefault()
            if (idx < list.length) pick(list[idx].id)
            else if (canCreate) create()
          } else if (e.key === 'Escape') (e.stopPropagation(), close(), inputRef.current?.blur())
        }}
        title={cur?.name || ''}
      />
      {cur && !open && (
        <button className="cp-clear" title="清除" tabIndex={-1} onMouseDown={(e) => (e.preventDefault(), onChange(null))}>
          ×
        </button>
      )}
      {open && pos && (
        <div
          ref={listRef}
          className="cp-list"
          tabIndex={-1}
          style={{ left: pos.left, width: Math.max(pos.width, 320), ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="cp-head">{fq ? `找到 ${list.length} 个` : `共 ${all.length} 个单位，输入几个字筛选`}{list.length >= 200 ? '（只显示前 200 个）' : ''}</div>
          {list.map((c, i) => (
            <div key={c.id} className={'cp-item' + (i === idx ? ' on' : '') + (c.id === value ? ' cur' : '')} onMouseEnter={() => setIdx(i)} onClick={() => pick(c.id)}>
              <span className="cp-name">{c.name}</span>
              <span className="cp-sub">{[c.unitType !== '其他' && c.unitType, c.city, (c.specialties || []).slice(0, 2).join('、')].filter(Boolean).join(' · ')}</span>
            </div>
          ))}
          {canCreate && (
            <div className={'cp-item cp-new' + (idx === list.length ? ' on' : '')} onMouseEnter={() => setIdx(list.length)} onClick={create}>
              ＋ 新建单位「{q.trim()}」
            </div>
          )}
          {!list.length && !canCreate && <div className="cp-head">没有单位，输入名称可以新建</div>}
        </div>
      )}
    </div>
  )
}

/** 一行联系人：头像、姓名职务、电话邮箱（点击复制），点名字去通讯录 */
export function PersonLine({ p }: { p: any }) {
  const { go } = useApp()
  return (
    <div className="person-line">
      <Avatar name={p.name} size={30} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>
          <span className="click" style={{ fontWeight: 600 }} onClick={() => go({ page: 'contacts', contactId: p.id })}>{p.name}</span>
          {p.title && <span className="faint" style={{ marginLeft: 6, fontSize: 12 }}>{p.title}</span>}
          {p.primary && <span className="tag blue" style={{ marginLeft: 6 }}>主要</span>}
        </div>
        <div className="person-contact">
          {p.phone && <Copyable text={p.phone} />}
          {p.email && <Copyable text={p.email} href={`mailto:${p.email}`} />}
        </div>
      </div>
    </div>
  )
}

/** 多选：只显示已选的，其余从下拉里加 */
function Multi({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const v = value || []
  const rest = options.filter((o) => !v.includes(o))
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
      {v.map((o) => (
        <span key={o} className="chip on">
          {o}
          <button className="chip-x" title="去掉" onClick={() => onChange(v.filter((x) => x !== o))}>×</button>
        </span>
      ))}
      <select
        className="input chip-add"
        value=""
        onChange={async (e) => {
          let x = e.target.value
          if (x === '__new') x = (await ask('添加选项')) || ''
          if (x && !v.includes(x)) onChange([...v, x])
        }}
      >
        <option value="">+ 添加</option>
        {rest.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
        <option value="__new">其他…</option>
      </select>
    </div>
  )
}

/** 1–5 星打分：悬停预览，点同一颗星清零 */
function Stars({ value, onChange }: { value?: number; onChange: (n: number) => void }) {
  const [hover, setHover] = useState(0)
  const v = Number(value) || 0
  const shown = hover || v
  return (
    <span className="stars" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className={shown >= n ? 'on' : ''} title={`${n} 星${v === n ? '（再点一次清除）' : ''}`} onMouseEnter={() => setHover(n)} onClick={() => onChange(v === n ? 0 : n)}>
          ★
        </button>
      ))}
      <span className="stars-label">{hover ? `${hover} 星` : v ? `${v} 星` : '未评分'}</span>
    </span>
  )
}

export default function Companies({ focusId }: { focusId?: string }) {
  const sup = useSup()
  const { data, saveItem } = useApp()
  const [type, setType] = useState<string>('全部')
  const [q, setQ] = useState('')
  const [f, setF] = useState<Record<string, string>>({})
  const [sel, setSel] = useState<string | null>(focusId || null)

  const stats = useMemo(() => Object.fromEntries(data.companies.map((c) => [c.id, companyStats(data.inquiries, c.id)])), [data.companies, data.inquiries])
  const list = data.companies
    .filter((c) => type === '全部' || c.unitType === type)
    .filter((c) => !q.trim() || [c.name, c.enName, c.products, c.note, c.city, ...(c.specialties || [])].join(' ').toLowerCase().includes(q.trim().toLowerCase()))
    .filter((c) => !f.category || c.category === f.category)
    .filter((c) => !f.status || c.status === f.status)
    .filter((c) => !f.grade || c.grade === f.grade)
    .filter((c) => !f.specialty || (c.specialties || []).includes(f.specialty))
    .filter((c) => !f.country || (c.serviceCountries || []).includes(f.country))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  const counts = (t: string) => (t === '全部' ? data.companies.length : data.companies.filter((c) => c.unitType === t).length)
  const contactsOf = (id: string) => data.contacts.filter((c) => c.companyId === id)
  const cur = data.companies.find((c) => c.id === sel)
  const isSup = type === '供应商'
  const sel1 = (k: string, label: string, opts: string[]) => (
    <select className="input" style={{ width: 'auto' }} value={f[k] || ''} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
      <option value="">{label}</option>
      {opts.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </select>
  )

  const add = async () => {
    const name = await ask('新建单位', '', '单位全称')
    if (!name) return
    const c = await saveItem('companies', { id: uid(), name, unitType: type === '全部' ? '其他' : type, ...(type === '供应商' ? { status: sup.status[0] || '', stage: sup.stage[0] || '', grade: sup.grade.includes('待评价') ? '待评价' : '' } : {}) })
    setSel(c.id)
  }

  return (
    <div className="lib-wrap" style={{ height: '100%' }}>
      <div className="lib-list" style={{ minWidth: 0 }}>
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
          <Tabs value={type} onChange={(v) => (setType(v), setF({}))} options={['全部', ...sup.unitTypes].map((t) => ({ id: t, label: `${t} ${counts(t) || ''}` }))} />
          <input className="input" style={{ width: 200 }} placeholder="搜索名称、产品、专业…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn primary" onClick={add}>+ 新建单位</button>
        </div>
        {isSup && (
          <div className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
            {sel1('category', '全部类别', sup.category)}
            {sel1('specialty', '全部专业', [...new Set([...sup.specialties, ...data.companies.flatMap((c) => c.specialties || [])])])}
            {sel1('country', '全部服务国家', [...new Set([...sup.countries, ...data.companies.flatMap((c) => c.serviceCountries || [])])])}
            {sel1('status', '全部入库状态', sup.status)}
            {sel1('grade', '全部等级', sup.grade)}
            {Object.values(f).some(Boolean) && <button className="btn small" onClick={() => setF({})}>清除筛选</button>}
          </div>
        )}
        {data.companies.length === 0 ? (
          <Empty title="还没有单位" text="业主、供应商、设计院、施工单位……都可以建成单位，联系人绑定到单位。供应商可以记录类别、专业、入库状态、评级和资质，询价时直接选用。" />
        ) : (
          <>
            <div className="faint" style={{ fontSize: 12, margin: '0 0 6px 2px' }}>共 {list.length} 家</div>
            <div className="co-list card">
              {list.length === 0 && <div className="faint" style={{ padding: 16 }}>没有符合条件的单位</div>}
              {list.map((c) => {
                const s = stats[c.id]
                const n = contactsOf(c.id).length
                const primary = contactsOf(c.id).find((x) => x.primary) || contactsOf(c.id)[0]
                return (
                  <div key={c.id} className={'co-row' + (sel === c.id ? ' on' : '')} onClick={() => setSel(c.id)}>
                    <Avatar name={c.name} size={36} square />
                    <div className="co-main">
                      <div className="co-name" title={c.name}>
                        {c.name}
                        {c.enName && c.enName !== c.name && <span className="co-en">{c.enName}</span>}
                      </div>
                      <div className="co-meta">
                        {type === '全部' && c.unitType && <span>{c.unitType}</span>}
                        {c.category && <span>{c.category}</span>}
                        {(c.specialties || []).slice(0, 4).map((t: string) => (
                          <span key={t} className="tag">{t}</span>
                        ))}
                        {(c.specialties || []).length > 4 && <span className="faint">+{c.specialties.length - 4}</span>}
                        {(c.serviceCountries || []).length > 0 && <span className="co-country">📍 {c.serviceCountries.join('、')}</span>}
                      </div>
                    </div>
                    <div className="co-side">
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        {c.status && <span className={'tag' + statusCls(c.status)}>{c.status}</span>}
                        {c.grade && <span className="grade" style={{ color: gradeColor(c.grade), borderColor: gradeColor(c.grade) }}>{c.grade === '待评价' ? '–' : c.grade}</span>}
                      </div>
                      <div className="faint co-sub">
                        {primary ? `${primary.name}${n > 1 ? ` 等 ${n} 人` : ''}` : '无联系人'}
                        {s.sends > 0 && ` · 发包 ${s.sends} 回 ${s.quotes}`}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
      {cur && <CompanyPanel key={cur.id} c={cur} onClose={() => setSel(null)} />}
    </div>
  )
}

function CompanyPanel({ c, onClose }: { c: any; onClose: () => void }) {
  const sup = useSup()
  const { data, saveItem, deleteItem, go, toast } = useApp()
  const [tab, setTab] = useState<'overview' | 'info' | 'contacts' | 'docs' | 'exp' | 'inq'>('overview')
  const [openSub, setOpenSub] = useState<string | null>(null)
  // 只传改动的字段：复制附件这类慢操作结束时，不会把这期间改的其他字段用旧值盖回去
  const save = (patch: any) => saveItem('companies', { id: c.id, ...patch })
  const isSup = c.unitType === '供应商'
  const s = companyStats(data.inquiries, c.id)
  const contacts = data.contacts.filter((x) => x.companyId === c.id)

  const txt = (k: string, label: string, ph = '', wide = false) => (
    <div className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <label>{label}</label>
      <input className="input" defaultValue={c[k] || ''} placeholder={ph} onBlur={(e) => e.target.value !== (c[k] || '') && save({ [k]: e.target.value.trim() })} />
    </div>
  )
  const pick = (k: string, label: string, opts: string[]) => (
    <div className="field">
      <label>{label}</label>
      <select className="input" value={c[k] || ''} onChange={(e) => save({ [k]: e.target.value })}>
        <option value="">—</option>
        {[...new Set([...opts, ...(c[k] ? [c[k]] : [])])].map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </div>
  )

  // 子表：入库资料 / 项目经验
  const sub = (key: 'docs' | 'experience') => c[key] || []
  const setSub = (key: 'docs' | 'experience', list: any[]) => save({ [key]: list })
  const subField = (key: 'docs' | 'experience', row: any, k: string, label: string, type = 'text', opts?: string[]) => (
    <div className="field">
      <label>{label}</label>
      {opts ? (
        <select className="input" value={row[k] || ''} onChange={(e) => setSub(key, sub(key).map((x: any) => (x.id === row.id ? { ...x, [k]: e.target.value } : x)))}>
          <option value="">—</option>
          {opts.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <input
          type={type}
          className="input"
          defaultValue={row[k] || ''}
          onBlur={(e) => e.target.value !== (row[k] || '') && setSub(key, sub(key).map((x: any) => (x.id === row.id ? { ...x, [k]: type === 'number' ? Number(e.target.value) || null : e.target.value } : x)))}
        />
      )}
    </div>
  )
  // 附件复制到「供应商与联系人/<单位名>/入库资料|项目经验」统一存放
  const addFiles = async (key: 'docs' | 'experience', row: any, paths: string[]) => {
    if (!paths.length) return
    try {
      const fs: string[] = await api.call('company:storeFiles', c.name, key, paths)
      if (fs.length) setSub(key, sub(key).map((x: any) => (x.id === row.id ? { ...x, files: [...new Set([...(x.files || []), ...fs])] } : x)))
    } catch (e) {
      toast(errMsg(e))
    }
  }
  const attach = async (key: 'docs' | 'experience', row: any) => addFiles(key, row, await api.call('dialog:pickFiles', '选择附件'))
  // 删除附件：放在单位文件夹里的移到回收站，别处的原文件只取消关联
  const removeFile = async (key: 'docs' | 'experience', row: any, f: string) => {
    if (!confirm(`删除附件「${f.split(/[\\/]/).pop()}」？放在单位文件夹里的文件会移到回收站。`)) return
    await setSub(key, sub(key).map((x: any) => (x.id === row.id ? { ...x, files: (x.files || []).filter((y: string) => y !== f) } : x)))
    await api.call('inquiry:trashFiles', [f]).catch(() => 0)
  }
  const docState = (d: any) => (!d.expireDate ? '' : d.expireDate < ymd() ? '已过期' : d.expireDate <= ymd(new Date(Date.now() + 60 * 86400000)) ? '即将到期' : '有效')

  return (
    <div className="panel co-panel">
      <div className="panel-head">
        <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
          <Avatar name={c.name} size={44} square />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="co-panel-name">{c.name}</div>
            {c.enName && c.enName !== c.name && <div className="faint" style={{ fontSize: 12 }}>{c.enName}</div>}
            <div className="row" style={{ marginTop: 6, flexWrap: 'wrap', gap: 4 }}>
              <span className="tag">{c.unitType || '其他'}</span>
              {c.category && <span className="tag">{c.category}</span>}
              {c.role && <span className="tag">{c.role}</span>}
              {c.status && <span className={'tag' + statusCls(c.status)}>{c.status}</span>}
              {c.grade && <span className="grade" style={{ color: gradeColor(c.grade), borderColor: gradeColor(c.grade) }}>{c.grade === '待评价' ? '待评价' : c.grade}</span>}
            </div>
          </div>
          <button className="btn small" title="打开这个单位的附件文件夹（入库资料、项目经验）" onClick={() => api.call('company:openFolder', c.name).catch((e: any) => toast(errMsg(e)))}>📂 文件夹</button>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
        <div style={{ marginTop: 10 }}>
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { id: 'overview', label: '概览' },
              { id: 'info', label: '编辑资料' },
              { id: 'contacts', label: `联系人 ${contacts.length || ''}` },
              ...(isSup
                ? [
                    { id: 'docs', label: `入库资料 ${sub('docs').length || ''}` },
                    { id: 'exp', label: `项目经验 ${sub('experience').length || ''}` }
                  ]
                : []),
              { id: 'inq', label: '询价记录' }
            ]}
          />
        </div>
      </div>
      <div className="panel-body">
        {tab === 'overview' && (
          <>
            <div className="kv co-kv">
              <span className="k">电话</span>
              <span className="v"><Copyable text={c.phone} href={c.phone ? `tel:${c.phone}` : undefined} /></span>
              <span className="k">邮箱</span>
              <span className="v"><Copyable text={c.email} href={c.email ? `mailto:${c.email}` : undefined} /></span>
              {c.website && (
                <>
                  <span className="k">官网</span>
                  <span className="v"><a href={/^https?:/.test(c.website) ? c.website : 'https://' + c.website}>{c.website}</a></span>
                </>
              )}
              <span className="k">所在地</span>
              <span className="v">{[c.regCountry, c.city, c.address].filter(Boolean).join(' · ') || '—'}</span>
              {isSup && (
                <>
                  <span className="k">服务国家</span>
                  <span className="v">{(c.serviceCountries || []).join('、') || '—'}</span>
                  <span className="k">专业</span>
                  <span className="v">
                    {(c.specialties || []).length ? (c.specialties || []).map((t: string) => <span key={t} className="tag" style={{ marginRight: 4 }}>{t}</span>) : '—'}
                  </span>
                  <span className="k">开发阶段</span>
                  <span className="v">{c.stage || '—'}</span>
                </>
              )}
            </div>
            {isSup && c.products && (
              <div className="co-block">
                <div className="co-block-title">供应产品 / 服务</div>
                <div>{c.products}</div>
              </div>
            )}
            {isSup && (
              <div className="co-stats">
                <div><b>{s.sends}</b><span>发包</span></div>
                <div><b>{s.quotes}</b><span>回价</span></div>
                <div><b>{s.rate === null ? '–' : s.rate + '%'}</b><span>回价率</span></div>
                <div><b>{sub('docs').length}</b><span>入库资料</span></div>
                <div><b>{sub('experience').length}</b><span>项目经验</span></div>
              </div>
            )}
            <div className="co-block">
              <div className="co-block-title row">
                联系人 <span className="faint">{contacts.length}</span>
                <span className="spacer" style={{ flex: 1 }} />
                {contacts.length > 3 && <span className="click faint" onClick={() => setTab('contacts')}>全部</span>}
              </div>
              {contacts.length === 0 && <div className="faint">还没有联系人</div>}
              {[...contacts].sort((a, b) => Number(!!b.primary) - Number(!!a.primary)).slice(0, 3).map((x) => <PersonLine key={x.id} p={x} />)}
            </div>
            {(isSup && (c.evaluator || c.evalBasis || c.strengthScore || c.coopScore)) ? (
              <div className="co-block">
                <div className="co-block-title">评价</div>
                <div className="kv">
                  <span className="k">实力</span>
                  <span className="v">{'★'.repeat(c.strengthScore || 0) || '—'}</span>
                  <span className="k">配合度</span>
                  <span className="v">{'★'.repeat(c.coopScore || 0) || '—'}</span>
                  {c.evaluator && (<><span className="k">评价人</span><span className="v">{c.evaluator}{c.evalDate ? ' · ' + c.evalDate : ''}</span></>)}
                  {c.evalBasis && (<><span className="k">依据</span><span className="v">{c.evalBasis}</span></>)}
                </div>
              </div>
            ) : null}
            {(c.source || c.note) && (
              <div className="co-block">
                <div className="co-block-title">备注</div>
                {c.source && <div className="faint" style={{ marginBottom: 4 }}>来源：{c.source}</div>}
                {c.note && <div className="co-note">{c.note}</div>}
              </div>
            )}
          </>
        )}

        {tab === 'info' && (
          <>
            <div className="row" style={{ gap: 6 }}>
              <span className="faint">单位类型</span>
              <select className="input" style={{ width: 'auto' }} value={c.unitType || '其他'} onChange={(e) => save({ unitType: e.target.value })}>
                {sup.unitTypes.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="grid2">
              {txt('name', '单位名称')}
              {txt('enName', '英文名称')}
              {isSup && pick('category', '类别', sup.category)}
              {isSup && pick('role', '经营角色', sup.role)}
              {isSup && pick('status', '入库状态', sup.status)}
              {isSup && pick('stage', '开发阶段', sup.stage)}
              {txt('phone', '电话')}
              {txt('email', '电子邮箱')}
              {txt('website', '公司官网')}
              {pick('regCountry', '注册国家', sup.countries)}
              {txt('city', '所在城市')}
              {txt('address', '地址')}
              {isSup && txt('products', '供应产品／服务', '', true)}
              {isSup && txt('source', '供应商来源', '如：展会、业主推荐、网上搜索')}
            </div>
            {isSup && (
              <>
                <div className="field">
                  <label>专业标签</label>
                  <Multi options={sup.specialties} value={c.specialties || []} onChange={(v) => save({ specialties: v })} />
                </div>
                <div className="field">
                  <label>服务国家</label>
                  <Multi options={sup.countries} value={c.serviceCountries || []} onChange={(v) => save({ serviceCountries: v })} />
                </div>
                <div className="grid2">
                  {pick('grade', '综合等级', sup.grade)}
                  <div className="field">
                    <label>评价日期</label>
                    <input type="date" className="input" defaultValue={c.evalDate || ''} onBlur={(e) => save({ evalDate: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>实力评分</label>
                    <Stars value={c.strengthScore} onChange={(n) => save({ strengthScore: n })} />
                  </div>
                  <div className="field">
                    <label>配合度评分</label>
                    <Stars value={c.coopScore} onChange={(n) => save({ coopScore: n })} />
                  </div>
                  {txt('evaluator', '评价人')}
                  {txt('evalBasis', '评价依据')}
                </div>
              </>
            )}
            <div className="field">
              <label>备注</label>
              <textarea className="input" rows={3} defaultValue={c.note || ''} onBlur={(e) => e.target.value !== (c.note || '') && save({ note: e.target.value })} />
            </div>
            <button
              className="btn small danger"
              style={{ alignSelf: 'flex-start' }}
              onClick={async () => {
                if (!confirm(`删除单位「${c.name}」？绑定的联系人会解除绑定，联系人本身保留。`)) return
                await deleteItem('companies', c.id)
                onClose()
              }}
            >
              删除单位
            </button>
          </>
        )}

        {tab === 'contacts' && (
          <>
            {contacts.length === 0 && <div className="faint">还没有联系人。在「联系人」里新建时选这个单位，或者把已有的人改绑过来。</div>}
            {[...contacts].sort((a, b) => Number(!!b.primary) - Number(!!a.primary)).map((x) => <PersonLine key={x.id} p={x} />)}
          </>
        )}

        {tab === 'docs' && (
          <>
            <div className="row">
              <button
                className="btn small primary"
                onClick={() => {
                  const id = uid()
                  setSub('docs', [{ id, type: '工商注册', name: '', verify: '待核实', files: [] }, ...sub('docs')])
                  setOpenSub(id)
                }}
              >
                + 添加资料
              </button>
              <span className="faint" style={{ fontSize: 12 }}>点资料卡片展开编辑</span>
            </div>
            {sub('docs').map((d: any) => (
              <div key={d.id} className={'sub-card doc-card' + (openSub === d.id ? ' open' : '')}>
                <div className="row click" onClick={() => setOpenSub(openSub === d.id ? null : d.id)}>
                  <span className="tag">{d.type || '资料'}</span>
                  <b style={{ flex: 1, minWidth: 0 }}>{d.name || '未命名资料'}</b>
                  {docState(d) && <span className={'tag' + (docState(d) === '已过期' ? ' red' : docState(d) === '即将到期' ? ' amber' : ' good')}>{docState(d)}</span>}
                  <span className={'tag' + (d.verify === '已核实' ? ' good' : d.verify === '存疑' ? ' red' : ' amber')}>{d.verify || '待核实'}</span>
                </div>
                {openSub !== d.id && (
                  <>
                    <div className="doc-meta">
                      {[d.certNo && '编号 ' + d.certNo, d.issuer, d.issueDate && (d.expireDate ? `${d.issueDate} 至 ${d.expireDate}` : `签发 ${d.issueDate}`), !d.issueDate && d.expireDate && '到期 ' + d.expireDate].filter(Boolean).join(' · ')}
                    </div>
                    {d.scope && <div className="doc-meta">{d.scope}</div>}
                    {d.note && <div className="doc-note">{d.note}</div>}
                    {(d.files || []).map((f: string) => (
                      <div key={f} className="click doc-file" title={f} onClick={() => api.call('shell:openPath', f)}>📎 {f.split(/[\\/]/).pop()}</div>
                    ))}
                  </>
                )}
                {openSub === d.id && (
                <>
                <div className="grid2">
                  {subField('docs', d, 'type', '资料类型', 'text', sup.docTypes)}
                  {subField('docs', d, 'name', '资料名称')}
                  {subField('docs', d, 'certNo', '证书编号')}
                  {subField('docs', d, 'issuer', '发证机构')}
                  {subField('docs', d, 'issueDate', '签发日期', 'date')}
                  {subField('docs', d, 'expireDate', '到期日期', 'date')}
                  {subField('docs', d, 'scope', '认证范围')}
                  {subField('docs', d, 'verify', '核实状态', 'text', sup.verify)}
                  {subField('docs', d, 'note', '备注')}
                </div>
                <Files files={d.files} onDropPaths={(ps) => addFiles('docs', d, ps)} onAdd={() => attach('docs', d)} onRemove={(f) => removeFile('docs', d, f)} />
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn small danger" onClick={() => confirm('删除这条资料？') && setSub('docs', sub('docs').filter((x: any) => x.id !== d.id))}>删除</button>
                  <button className="btn small" onClick={() => setOpenSub(null)}>收起</button>
                </div>
                </>
                )}
              </div>
            ))}
          </>
        )}

        {tab === 'exp' && (
          <>
            <div className="row">
              <button
                className="btn small primary"
                onClick={() => {
                  const id = uid()
                  setSub('experience', [{ id, projectName: '', files: [] }, ...sub('experience')])
                  setOpenSub(id)
                }}
              >
                + 添加项目经验
              </button>
              <span className="faint" style={{ fontSize: 12 }}>点卡片展开编辑</span>
            </div>
            {sub('experience').map((x: any) => (
              <div key={x.id} className={'sub-card doc-card' + (openSub === x.id ? ' open' : '')}>
                <div className="row click" onClick={() => setOpenSub(openSub === x.id ? null : x.id)}>
                  <b style={{ flex: 1, minWidth: 0 }}>{x.projectName || '项目经验'}</b>
                  {x.amount ? <span className="tag">{Number(x.amount).toLocaleString()} {x.currency}</span> : null}
                </div>
                {openSub !== x.id && (
                  <>
                    <div className="doc-meta">{[x.role, x.owner && '业主 ' + x.owner, [x.country, x.city].filter(Boolean).join(' '), x.start && `${x.start} 至 ${x.end || '今'}`].filter(Boolean).join(' · ')}</div>
                    {x.scope && <div className="doc-note">{x.scope}</div>}
                    {(x.files || []).map((f: string) => (
                      <div key={f} className="click doc-file" title={f} onClick={() => api.call('shell:openPath', f)}>📎 {f.split(/[\\/]/).pop()}</div>
                    ))}
                  </>
                )}
                {openSub === x.id && (
                <>
                <div className="grid2">
                  {subField('experience', x, 'projectName', '项目名称')}
                  {subField('experience', x, 'owner', '业主')}
                  {subField('experience', x, 'country', '国家')}
                  {subField('experience', x, 'city', '城市')}
                  {subField('experience', x, 'amount', '合同金额', 'number')}
                  {subField('experience', x, 'currency', '币种', 'text', sup.currencies)}
                  {subField('experience', x, 'role', '承担角色')}
                  {subField('experience', x, 'scope', '工作范围')}
                  {subField('experience', x, 'start', '开始日期', 'date')}
                  {subField('experience', x, 'end', '结束日期', 'date')}
                </div>
                <Files files={x.files} onDropPaths={(ps) => addFiles('experience', x, ps)} onAdd={() => attach('experience', x)} onRemove={(f) => removeFile('experience', x, f)} />
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn small danger" onClick={() => confirm('删除这条项目经验？') && setSub('experience', sub('experience').filter((y: any) => y.id !== x.id))}>删除</button>
                  <button className="btn small" onClick={() => setOpenSub(null)}>收起</button>
                </div>
                </>
                )}
              </div>
            ))}
          </>
        )}

        {tab === 'inq' && (
          <>
            {data.inquiries.filter((q) => (q.sends || []).some((x: any) => x.companyId === c.id)).length === 0 && <div className="faint">还没有给这个单位发过询价</div>}
            {data.inquiries
              .filter((q) => (q.sends || []).some((x: any) => x.companyId === c.id))
              .map((q) => {
                const send = q.sends.find((x: any) => x.companyId === c.id)
                const quotes = (q.quotes || []).filter((x: any) => x.companyId === c.id).sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)))
                return (
                  <div key={q.id} className="list-row click" onClick={() => go({ page: 'inquiries', inquiryId: q.id })}>
                    <span className="grow">
                      <b>{q.name}</b> <span className="faint">{data.projects.find((p) => p.id === q.projectId)?.name}</span>
                    </span>
                    <span className="tag">{send?.status}</span>
                    {quotes[0] && <span className="faint">{Number(quotes[0].amount || 0).toLocaleString()} {quotes[0].currency}</span>}
                    {q.awardedCompanyId === c.id && <span className="tag good">中标</span>}
                  </div>
                )
              })}
          </>
        )}
      </div>
    </div>
  )
}

/** 拖入文件区域：把从资源管理器拖进来的文件交给 onPaths */
export function DropZone({ onPaths, children, className = '', hint }: { onPaths: (paths: string[]) => void; children: any; className?: string; hint?: string }) {
  const [over, setOver] = useState(0)
  const has = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
  return (
    <div
      className={'dropzone ' + className + (over ? ' over' : '')}
      data-hint={hint || '松开鼠标，添加这些文件'}
      onDragEnter={(e) => has(e) && (e.preventDefault(), e.stopPropagation(), setOver((n) => n + 1))}
      onDragOver={(e) => has(e) && (e.preventDefault(), e.stopPropagation(), (e.dataTransfer.dropEffect = 'copy'))}
      onDragLeave={(e) => has(e) && (e.stopPropagation(), setOver((n) => Math.max(0, n - 1)))}
      onDrop={(e) => {
        if (!has(e)) return
        e.preventDefault()
        e.stopPropagation()
        setOver(0)
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => api.pathForFile(f))
          .filter(Boolean)
        if (paths.length) onPaths(paths)
      }}
    >
      {children}
    </div>
  )
}

export function Files({ files, onAdd, onRemove, onDropPaths, dropHint }: { files?: string[]; onAdd: () => void; onRemove: (f: string) => void; onDropPaths?: (paths: string[]) => void; dropHint?: string }) {
  const body = (
    <div style={{ fontSize: 12 }}>
      {(files || []).map((f) => (
        <div key={f} className="row" style={{ gap: 4 }}>
          <span className="click" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f} onClick={() => api.call('shell:openPath', f)}>
            📎 {f.split(/[\\/]/).pop()}
          </span>
          <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => onRemove(f)}>×</button>
        </div>
      ))}
      <div className="row" style={{ gap: 8, marginTop: 2 }}>
        <button className="btn small" onClick={onAdd}>+ 附件</button>
        {onDropPaths && <span className="faint" style={{ fontSize: 11.5 }}>{dropHint || '或把文件拖到这里'}</span>}
      </div>
    </div>
  )
  return onDropPaths ? <DropZone onPaths={onDropPaths}>{body}</DropZone> : body
}
