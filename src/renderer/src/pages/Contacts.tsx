import { useMemo, useState } from 'react'
import { api, uid, useApp } from '../lib'
import { Empty, Modal, Tabs } from '../ui'
import Companies, { Avatar, CompanyPicker, Copyable, statusCls } from './Companies'

export function ContactDialog({ contact, onClose, onSaved, companyId }: { contact?: any; onClose: () => void; onSaved?: (c: any) => void; companyId?: string }) {
  const { saveContact, toast } = useApp()
  const [c, setC] = useState<any>(contact || { id: uid(), name: '', companyId: companyId || null, title: '', phone: '', email: '', tags: [], note: '' })
  const [tags, setTags] = useState((c.tags || []).join('，'))
  const set = (k: string, v: any) => setC((x: any) => ({ ...x, [k]: v }))
  const submit = async () => {
    if (!c.name.trim()) return toast('请填写姓名')
    const saved = { ...c, name: c.name.trim(), tags: tags.split(/[，,、\s]+/).filter(Boolean) }
    await saveContact(saved)
    onSaved?.(saved)
    onClose()
  }
  return (
    <Modal
      title={contact ? '编辑联系人' : '新建联系人'}
      onClose={onClose}
      width={540}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={submit}>保存</button>
        </>
      }
    >
      <div onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && submit()}>
        <div className="grid2">
          <div className="field">
            <label>姓名 *</label>
            <input autoFocus className="input" value={c.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="field">
            <label>所属单位（可搜索，没有就新建）</label>
            <CompanyPicker value={c.companyId} onChange={(id) => set('companyId', id)} />
          </div>
          <div className="field">
            <label>职务</label>
            <input className="input" value={c.title} onChange={(e) => set('title', e.target.value)} />
          </div>
          <div className="field">
            <label>电话</label>
            <input className="input" value={c.phone} onChange={(e) => set('phone', e.target.value)} />
          </div>
          <div className="field">
            <label>邮箱</label>
            <input className="input" value={c.email} onChange={(e) => set('email', e.target.value)} />
          </div>
          <div className="field">
            <label>标签（逗号分隔）</label>
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="业主，水利专家" />
          </div>
        </div>
        <label className="row" style={{ cursor: 'pointer', marginBottom: 10 }}>
          <input type="checkbox" checked={!!c.primary} onChange={(e) => set('primary', e.target.checked)} />
          这个单位的主要联系人
        </label>
        <div className="field">
          <label>备注</label>
          <textarea className="input" rows={3} value={c.note} onChange={(e) => set('note', e.target.value)} />
        </div>
      </div>
    </Modal>
  )
}

export default function Contacts({ focusId, companyId }: { focusId?: string; companyId?: string }) {
  const [tab, setTab] = useState<'people' | 'units'>(companyId ? 'units' : 'people')
  return (
    <>
      <div className="topbar">
        <h1>供应商与联系人</h1>
        <Tabs value={tab} onChange={setTab} options={[{ id: 'people', label: '联系人' }, { id: 'units', label: '单位与供应商' }]} />
      </div>
      <div className="main" style={{ flex: 1, minHeight: 0 }}>
        {tab === 'people' ? <People focusId={focusId} /> : <Companies focusId={companyId} />}
      </div>
    </>
  )
}

function People({ focusId }: { focusId?: string }) {
  const { data, setData, go } = useApp()
  const { contacts, projects, companies } = data
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<any>(null)
  const [sel, setSel] = useState<string | null>(focusId || null)
  const [onlyPrimary, setOnlyPrimary] = useState(false)
  const coName = (c: any) => companies.find((x) => x.id === c.companyId)?.name || c.org || ''

  const list = useMemo(() => {
    const has = (s: any) => String(s || '').toLowerCase().includes(q.trim().toLowerCase())
    return contacts.filter((c) => (!onlyPrimary || c.primary) && (!q || has(c.name) || has(coName(c)) || has(c.title) || has(c.phone) || has(c.email) || (c.tags || []).some(has)))
  }, [contacts, companies, q, onlyPrimary])

  // 按单位归类
  const groups = useMemo(() => {
    const m = new Map<string, any[]>()
    for (const c of list) {
      const k = coName(c) || '未绑定单位'
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(c)
    }
    return [...m.entries()]
      .map(([k, cs]) => [k, [...cs].sort((a, b) => Number(!!b.primary) - Number(!!a.primary) || a.name.localeCompare(b.name, 'zh-CN'))] as [string, any[]])
      .sort((a, b) => (a[0] === '未绑定单位' ? 1 : b[0] === '未绑定单位' ? -1 : a[0].localeCompare(b[0], 'zh-CN')))
  }, [list])

  const cur = contacts.find((c) => c.id === sel)
  const curCo = cur && companies.find((x) => x.id === cur.companyId)
  const curProjects = cur ? projects.filter((p) => (p.contacts || []).some((x: any) => x.contactId === cur.id)) : []

  const remove = async (c: any) => {
    if (!confirm(`删除联系人「${c.name}」？\n会同时从项目联系人里去掉此人。`)) return
    setData(await api.call('contacts:delete', c.id))
    setSel(null)
  }

  return (
    <div className="page">
      <div className="row" style={{ maxWidth: 1240, margin: '0 auto 12px' }}>
        <input className="input" style={{ width: 280 }} placeholder="搜索姓名、单位、电话、邮箱、标签…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="row faint" style={{ cursor: 'pointer', gap: 4 }}>
          <input type="checkbox" checked={onlyPrimary} onChange={(e) => setOnlyPrimary(e.target.checked)} /> 只看主要联系人
        </label>
        <span className="faint">共 {list.length} 人 · {groups.length} 家单位</span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => setEditing({})}>+ 新建联系人</button>
      </div>
      {contacts.length === 0 ? (
        <Empty title="业主、专家、供应商的联系方式" text="每个人绑定到所属单位，单位里能看到全部联系人。同一个人可以关联多个项目，并在每个项目里设置不同的角色。">
          <button className="btn primary" onClick={() => setEditing({})}>+ 新建联系人</button>
        </Empty>
      ) : (
        <div className="people-wrap">
          <div className="card people-list">
            {groups.length === 0 && <div className="faint" style={{ padding: 16 }}>没有符合条件的联系人</div>}
            {groups.map(([org, cs]) => {
              const co = companies.find((x) => x.name === org)
              return (
                <div key={org} className="people-group">
                  <div className="people-group-head">
                    <span className={co ? 'click' : ''} onClick={() => co && go({ page: 'contacts', companyId: co.id })} title={co ? '查看单位' : ''}>
                      {org}
                    </span>
                    {co?.status && <span className={'tag' + statusCls(co.status)}>{co.status}</span>}
                    {co?.category && <span className="faint">{co.category}</span>}
                    <span className="faint" style={{ marginLeft: 'auto' }}>{cs.length} 人</span>
                  </div>
                  {cs.map((c) => (
                    <div key={c.id} className={'person-row' + (sel === c.id ? ' on' : '')} onClick={() => setSel(c.id)}>
                      <Avatar name={c.name} size={30} />
                      <div className="person-name">
                        <div>
                          {c.name}
                          {c.primary && <span className="tag blue" style={{ marginLeft: 6 }}>主要</span>}
                        </div>
                        {c.title && <div className="faint" style={{ fontSize: 12 }}>{c.title}</div>}
                      </div>
                      <div className="person-phone"><Copyable text={c.phone} /></div>
                      <div className="person-email">{c.email ? <Copyable text={c.email} /> : <span className="faint">—</span>}</div>
                      <div className="person-tags">
                        {(c.tags || []).map((t: string) => (
                          <span key={t} className="tag">{t}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
          <div className="card people-detail">
            {!cur ? (
              <div className="card-body faint">点左边的联系人查看详情。电话、邮箱点一下就能复制。</div>
            ) : (
              <>
                <div className="people-detail-head">
                  <Avatar name={cur.name} size={52} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 18, fontWeight: 600 }}>
                      {cur.name}
                      {cur.primary && <span className="tag blue" style={{ marginLeft: 8, verticalAlign: 'middle' }}>主要联系人</span>}
                    </div>
                    <div className="faint">{[cur.title, curCo?.name || cur.org].filter(Boolean).join(' · ') || '—'}</div>
                  </div>
                </div>
                <div className="row" style={{ padding: '0 14px 10px', gap: 6 }}>
                  <button className="btn small" onClick={() => setEditing(cur)}>编辑</button>
                  <button className="btn small danger" onClick={() => remove(cur)}>删除</button>
                </div>
                <div className="card-body" style={{ borderTop: '1px solid var(--line)' }}>
                  <div className="kv" style={{ marginBottom: 12 }}>
                    <span className="k">单位</span>
                    <span className="v">
                      {curCo ? (
                        <>
                          <span className="click" onClick={() => go({ page: 'contacts', companyId: curCo.id })}>{curCo.name}</span>
                          {curCo.status && <span className={'tag' + statusCls(curCo.status)} style={{ marginLeft: 6 }}>{curCo.status}</span>}
                        </>
                      ) : (
                        cur.org || '—'
                      )}
                    </span>
                    <span className="k">职务</span>
                    <span className="v">{cur.title || '—'}</span>
                    <span className="k">电话</span>
                    <span className="v"><Copyable text={cur.phone} href={cur.phone ? `tel:${cur.phone}` : undefined} /></span>
                    <span className="k">邮箱</span>
                    <span className="v"><Copyable text={cur.email} href={cur.email ? `mailto:${cur.email}` : undefined} /></span>
                    {(cur.tags || []).length > 0 && (
                      <>
                        <span className="k">标签</span>
                        <span className="v">{cur.tags.map((t: string) => <span key={t} className="tag" style={{ marginRight: 4 }}>{t}</span>)}</span>
                      </>
                    )}
                    {cur.note && (
                      <>
                        <span className="k">备注</span>
                        <span className="v">{cur.note}</span>
                      </>
                    )}
                  </div>
                  <div className="faint" style={{ marginBottom: 4 }}>参与的项目</div>
                  {curProjects.length === 0 && <div className="faint" style={{ fontSize: 12 }}>还没有关联项目（在项目「详情」里添加）</div>}
                  {curProjects.map((p) => (
                    <div key={p.id} className="list-row">
                      <span className="grow click" onClick={() => go({ page: 'project', projectId: p.id, tab: 'detail' })}>{p.name}</span>
                      <span className="tag">{(p.contacts || []).find((x: any) => x.contactId === cur.id)?.role || '—'}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {editing && <ContactDialog contact={editing.id ? editing : undefined} onClose={() => setEditing(null)} onSaved={(c) => setSel(c.id)} />}
    </div>
  )
}
