import { useState } from 'react'
import { fmtLatLng, parseLatLng, stageOf, useApp } from '../lib'
import { ContactDialog } from './Contacts'
import { DeadlineTag } from './Projects'
import { QuickAdd, TodoRow } from './Todos'
import { projectFocusMinutes } from './Focus'

/** 经纬度：显示 + 直接输入定位 + 在地图上查看 */
export function CoordEdit({ project, onMap }: { project: any; onMap?: (ll: { lat: number; lng: number }) => void }) {
  const { saveProject, toast, go } = useApp()
  const [edit, setEdit] = useState(false)
  const [v, setV] = useState('')
  const has = project.lat != null && project.lng != null
  const save = async () => {
    if (!v.trim()) return setEdit(false)
    const ll = parseLatLng(v)
    if (!ll) return toast('经纬度看不懂，请写成「39.7528, 37.0179」或「39°45′10″N 37°01′05″E」')
    await saveProject({ ...project, lat: ll.lat, lng: ll.lng })
    toast(`已定位：纬度 ${ll.lat}，经度 ${ll.lng}${ll.swapped ? '（已把经纬度对调）' : ''}`)
    setEdit(false)
    onMap?.(ll)
  }
  if (edit)
    return (
      <span className="row" style={{ gap: 6 }}>
        <input
          autoFocus
          className="input"
          style={{ flex: 1, minWidth: 200 }}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => (e.key === 'Enter' ? save() : e.key === 'Escape' && setEdit(false))}
          placeholder="粘贴坐标，如 39.7528, 37.0179"
        />
        <button className="btn small primary" onClick={save}>定位</button>
        <button className="btn small" onClick={() => setEdit(false)}>取消</button>
      </span>
    )
  const f = has ? fmtLatLng(project.lat, project.lng) : null
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {f ? (
        <span title={f.dms}>
          {f.dec} <span className="faint" style={{ fontSize: 11 }}>{f.dms}</span>
        </span>
      ) : (
        <span className="faint">未定位</span>
      )}
      <button className="btn small" onClick={() => (setV(has ? `${project.lat}, ${project.lng}` : ''), setEdit(true))}>{has ? '修改' : '输入经纬度'}</button>
      {has && !onMap && <button className="btn small" onClick={() => go({ page: 'map', projectId: project.id })}>在地图上看</button>}
    </span>
  )
}

/** 项目详情：项目信息、待办、项目联系人 */
export default function ProjectDetail({ project }: { project: any }) {
  const { data, saveProject, go } = useApp()
  const { settings, todos, contacts, projects } = data
  const [contactNew, setContactNew] = useState(false)
  const [addId, setAddId] = useState('')
  const [addRole, setAddRole] = useState('')

  const stage = stageOf(settings, project.stage)
  const pTodos = todos.filter((t) => t.projectId === project.id).sort((a, b) => Number(!!a.done) - Number(!!b.done) || String(a.due || '9').localeCompare(String(b.due || '9')))
  const pContacts = (project.contacts || []).map((x: any) => ({ ...x, c: contacts.find((c) => c.id === x.contactId) })).filter((x: any) => x.c)
  const subs = projects.filter((p) => p.parentId === project.id)
  const parent = projects.find((p) => p.id === project.parentId)

  const linkContact = async (contactId: string, role: string) => {
    if (!contactId) return
    const list = (project.contacts || []).filter((x: any) => x.contactId !== contactId)
    await saveProject({ ...project, contacts: [...list, { contactId, role: role.trim() }] })
    setAddId('')
    setAddRole('')
  }
  const unlink = (contactId: string) => saveProject({ ...project, contacts: (project.contacts || []).filter((x: any) => x.contactId !== contactId) })
  const setRole = (contactId: string, role: string) => saveProject({ ...project, contacts: (project.contacts || []).map((x: any) => (x.contactId === contactId ? { ...x, role } : x)) })


  return (
    <div className="page">
      <div className="home-grid" style={{ gridTemplateColumns: '1fr 380px', maxWidth: 1180, margin: '0 auto' }}>
        <div className="home-col">
          <div className="card">
            <div className="card-head">项目信息</div>
            <div className="card-body">
              {project.description && <p style={{ marginTop: 0, lineHeight: 1.7 }}>{project.description}</p>}
              <div className="kv" style={{ gridTemplateColumns: '72px 1fr 72px 1fr', fontSize: 13 }}>
                <span className="k">阶段</span>
                <span className="v">
                  <span className="stage-dot" style={{ background: stage.color }} /> {stage.name}
                </span>
                <span className="k">状态</span>
                <span className="v">{project.status}</span>
                <span className="k">项目编号</span>
                <span className="v">{project.code || '—'}</span>
                <span className="k">委托单位</span>
                <span className="v">{project.client || '—'}</span>
                <span className="k">地点</span>
                <span className="v">{project.location || '—'}</span>
                <span className="k">截止日期</span>
                <span className="v">
                  {project.deadline || '—'} <DeadlineTag date={project.deadline} />
                </span>
                <span className="k">经纬度</span>
                <span className="v" style={{ gridColumn: 'span 3' }}>
                  <CoordEdit project={project} />
                </span>
                <span className="k">负责人</span>
                <span className="v">{project.owner || '—'}</span>
                <span className="k">参与人</span>
                <span className="v">{project.members?.join('、') || '—'}</span>
                <span className="k">累计专注</span>
                <span className="v">
                  {(() => {
                    const m = projectFocusMinutes(data.focus, project.id)
                    return m ? (m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`) : '—'
                  })()}
                </span>
                {parent && (
                  <>
                    <span className="k">主项目</span>
                    <span className="v click" onClick={() => go({ page: 'project', projectId: parent.id, tab: 'detail' })}>{parent.name}</span>
                  </>
                )}
              </div>
              {subs.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div className="faint" style={{ fontSize: 12 }}>子项目</div>
                  {subs.map((s) => (
                    <div key={s.id} className="list-row">
                      <span className="grow click" onClick={() => go({ page: 'project', projectId: s.id, tab: 'detail' })}>↳ {s.name}</span>
                      <span className="faint">{stageOf(settings, s.stage).name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>


          <div className="card">
            <div className="card-head">
              待办 <span className="faint">{pTodos.filter((t) => !t.done).length}</span>
            </div>
            <div className="card-body">
              <QuickAdd key={project.id} projectId={project.id} />
              {pTodos.length === 0 ? <div className="faint">这个项目还没有待办</div> : pTodos.map((t) => <TodoRow key={t.id} t={t} showProject={false} />)}
            </div>
          </div>
        </div>

        <div className="home-col">
          <div className="card">
            <div className="card-head">
              项目联系人 <span className="faint">{pContacts.length}</span>
              <span className="spacer" />
              <button className="btn small" onClick={() => setContactNew(true)}>+ 新建</button>
            </div>
            <div className="card-body">
              {pContacts.length === 0 && <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>业主、甲方对接人、专家……同一个人在不同项目里可以有不同角色。</div>}
              {pContacts.map((x: any) => (
                <div key={x.contactId} className="list-row">
                  <div className="grow">
                    <div className="click" onClick={() => go({ page: 'contacts', contactId: x.contactId })}>
                      {x.c.name} <span className="faint" style={{ fontSize: 12 }}>{x.c.org}</span>
                    </div>
                    <div className="faint" style={{ fontSize: 12 }}>{x.c.phone}</div>
                  </div>
                  <input className="input" style={{ width: 96 }} defaultValue={x.role} placeholder="角色" onBlur={(e) => e.target.value !== x.role && setRole(x.contactId, e.target.value.trim())} />
                  <button className="icon-btn" title="从项目中移除" onClick={() => unlink(x.contactId)}>×</button>
                </div>
              ))}
              {contacts.length > 0 && (
                <div className="row" style={{ marginTop: 10 }}>
                  <select className="input" value={addId} onChange={(e) => setAddId(e.target.value)}>
                    <option value="">从通讯录添加…</option>
                    {contacts
                      .filter((c) => !(project.contacts || []).some((x: any) => x.contactId === c.id))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}{c.org ? ' · ' + c.org : ''}
                        </option>
                      ))}
                  </select>
                  <input className="input" style={{ width: 90 }} placeholder="角色" value={addRole} onChange={(e) => setAddRole(e.target.value)} />
                  <button className="btn small" disabled={!addId} onClick={() => linkContact(addId, addRole)}>添加</button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {contactNew && <ContactDialog onClose={() => setContactNew(false)} onSaved={(c) => linkContact(c.id, '')} />}
    </div>
  )
}
