import { useState } from 'react'
import { api, errMsg, LEAD_ROLES, leadsOf, parseLatLng, progressOf, uid, useApp } from '../lib'
import { Modal } from '../ui'

/** 新建 / 编辑项目。新建时可以按模板建文件夹、关联已有文件夹，或暂不关联。 */
export default function ProjectDialog({ project, onClose, onCreated }: { project?: any; onClose: () => void; onCreated?: (id: string) => void }) {
  const { data, setData, saveProject, toast } = useApp()
  const { settings, projects } = data
  const isNew = !project
  const [p, setP] = useState<any>(
    project || {
      id: uid(),
      name: '',
      description: '',
      client: '',
      code: '',
      location: '',
      stage: settings.stages[0]?.id,
      status: settings.statuses[0],
      owner: '',
      members: [],
      startDate: '',
      deadline: '',
      parentId: '',
      rootPath: ''
    }
  )
  const [folderMode, setFolderMode] = useState<'template' | 'existing' | 'none'>(settings.projectsRoot ? 'template' : 'existing')
  const [existing, setExisting] = useState('')
  const [templateId, setTemplateId] = useState<string>(settings.defaultTemplateId || settings.templates?.[0]?.id)
  const set = (k: string, v: any) => setP((x: any) => ({ ...x, [k]: v }))
  const [leads, setLeads] = useState<{ role: string; name: string }[]>(() => (project ? leadsOf(project).map((l) => ({ ...l })) : [{ role: '项目负责人', name: '' }]))
  const setLead = (i: number, patch: any) => setLeads((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const [coord, setCoord] = useState(project?.lat != null ? `${project.lat}, ${project.lng}` : '')
  const parsed = coord.trim() ? parseLatLng(coord) : null

  const pick = async () => {
    const dir = await api.call('dialog:pickFolder', '选择项目文件夹')
    if (dir) {
      setExisting(dir)
      if (!p.name) set('name', dir.split(/[\\/]/).pop())
    }
  }

  const submit = async () => {
    if (!p.name.trim()) return toast('请填写项目名称')
    // 经纬度：留空表示不定位；填了就必须能解析
    let pos: any = {}
    if (coord.trim()) {
      const ll = parseLatLng(coord)
      if (!ll) return toast('经纬度看不懂，请写成「39.7528, 37.0179」或「39°45′10″N 37°01′05″E」')
      pos = { lat: ll.lat, lng: ll.lng }
    } else if (p.lat != null) pos = { lat: null, lng: null }
    const clean = leads.map((l) => ({ role: l.role.trim(), name: l.name.trim() })).filter((l) => l.name)
    const q = { ...p, ...pos, leads: clean, owner: clean[0]?.name || '' }
    try {
      if (isNew) {
        if (folderMode === 'existing' && !existing) return toast('请选择已有文件夹，或改选「暂不关联」')
        const list = await api.call('projects:create', { ...q, name: q.name.trim() }, { mode: folderMode, path: existing, templateId })
        setData({ projects: list })
        onCreated?.(q.id)
      } else {
        await saveProject(q)
      }
      onClose()
    } catch (e) {
      toast(errMsg(e))
    }
  }

  const toggleMember = (name: string) => set('members', p.members.includes(name) ? p.members.filter((m: string) => m !== name) : [...p.members, name])

  return (
    <Modal
      title={isNew ? '新建项目' : '编辑项目信息'}
      onClose={onClose}
      width={620}
      footer={
        <>
          <span className="faint" style={{ marginRight: 'auto' }}>Ctrl+Enter 保存</span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={submit}>{isNew ? '创建项目' : '保存'}</button>
        </>
      }
    >
      <div onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && submit()}>
        <div className="field">
          <label>项目名称 *</label>
          <input autoFocus className="input" value={p.name} onChange={(e) => set('name', e.target.value)} placeholder="如：青屿河滨水廊道整治工程" />
        </div>
        <div className="field">
          <label>简介 / 备注</label>
          <textarea className="input" rows={2} value={p.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        <div className="grid3">
          <div className="field">
            <label>委托单位</label>
            <input className="input" value={p.client} onChange={(e) => set('client', e.target.value)} />
          </div>
          <div className="field">
            <label>项目编号</label>
            <input className="input" value={p.code} onChange={(e) => set('code', e.target.value)} />
          </div>
          <div className="field">
            <label>项目地点</label>
            <input className="input" value={p.location} onChange={(e) => set('location', e.target.value)} />
          </div>
          <div className="field">
            <label>阶段</label>
            <select className="input" value={p.stage} onChange={(e) => set('stage', e.target.value)}>
              {settings.stages.map((s: any) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>状态</label>
            <select className="input" value={p.status} onChange={(e) => set('status', e.target.value)}>
              {settings.statuses.map((s: string) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>开始日期</label>
            <input type="date" className="input" value={p.startDate || ''} onChange={(e) => set('startDate', e.target.value)} />
          </div>
          <div className="field">
            <label>截止日期</label>
            <input type="date" className="input" value={p.deadline || ''} onChange={(e) => set('deadline', e.target.value)} />
          </div>
          <div className="field">
            <label>进度 %（留空按时间自动算）</label>
            <input
              type="number"
              min={0}
              max={100}
              className="input"
              value={p.progress ?? ''}
              placeholder={(() => {
                const a = progressOf({ ...p, progress: null })
                return a ? `自动：${a.pct}%` : '填开始和截止日期后自动算'
              })()}
              onChange={(e) => set('progress', e.target.value === '' ? null : Math.max(0, Math.min(100, Number(e.target.value))))}
            />
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>负责人（可以添加多个，角色可自己填）</label>
            {leads.map((l, i) => (
              <div key={i} className="lead-row">
                <input className="input" style={{ width: 150 }} list="lead-roles" value={l.role} placeholder="角色，如 技术负责人" onChange={(e) => setLead(i, { role: e.target.value })} />
                <input className="input" style={{ flex: 1 }} list="lead-members" value={l.name} placeholder="姓名" onChange={(e) => setLead(i, { name: e.target.value })} />
                <button className="icon-btn" title="删除这一位" onClick={() => setLeads(leads.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button className="btn small" style={{ width: 'auto', alignSelf: 'flex-start' }} onClick={() => setLeads([...leads, { role: LEAD_ROLES.find((r) => !leads.some((l) => l.role === r)) || '', name: '' }])}>+ 添加负责人</button>
            <datalist id="lead-roles">
              {LEAD_ROLES.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <datalist id="lead-members">
              {settings.members.map((m: any) => (
                <option key={m.id} value={m.name} />
              ))}
            </datalist>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>经纬度（WGS-84，先纬度后经度，可直接粘贴谷歌地图 / 奥维的坐标）</label>
            <input className="input" value={coord} onChange={(e) => setCoord(e.target.value)} placeholder="如 39.7528, 37.0179 或 39°45′10″N 37°01′05″E" />
            {coord.trim() && (
              <div style={{ fontSize: 12, marginTop: 4, color: parsed ? 'var(--text-3)' : 'var(--danger)' }}>
                {parsed ? `纬度 ${parsed.lat}，经度 ${parsed.lng}${parsed.swapped ? '（看起来是先写了经度，已自动对调）' : ''}` : '看不懂这个坐标'}
              </div>
            )}
          </div>
          <div className="field" style={{ gridColumn: 'span 2' }}>
            <label>主项目（作为子项目挂在其下）</label>
            <select className="input" value={p.parentId || ''} onChange={(e) => set('parentId', e.target.value)}>
              <option value="">无</option>
              {projects
                .filter((x) => x.id !== p.id && !x.parentId)
                .map((x) => (
                  <option key={x.id} value={x.id}>{x.name}</option>
                ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label>参与人</label>
          {settings.members.length === 0 ? (
            <span className="faint">在「设置 → 团队成员」里添加成员后可选择</span>
          ) : (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {settings.members.map((m: any) => (
                <label key={m.id} className="chip" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={p.members.includes(m.name)} onChange={() => toggleMember(m.name)} />
                  {m.name}
                </label>
              ))}
            </div>
          )}
        </div>
        {isNew && (
          <div className="field">
            <label>项目文件夹</label>
            <label className="row">
              <input type="radio" checked={folderMode === 'template'} onChange={() => setFolderMode('template')} />
              按模板新建
              <select
                className="input"
                style={{ width: 'auto' }}
                value={templateId}
                onChange={(e) => {
                  setTemplateId(e.target.value)
                  setFolderMode('template')
                }}
              >
                {(settings.templates || []).map((t: any) => (
                  <option key={t.id} value={t.id}>
                    {t.name}（{t.folders.length} 个文件夹）
                  </option>
                ))}
              </select>
              <span className="faint">{settings.projectsRoot ? `在 ${settings.projectsRoot} 下` : '（先在设置里指定项目根目录）'}</span>
            </label>
            <label className="row">
              <input type="radio" checked={folderMode === 'existing'} onChange={() => setFolderMode('existing')} />
              关联已有文件夹
              <button className="btn small" onClick={pick}>选择…</button>
              <span className="faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>{existing}</span>
            </label>
            <label className="row">
              <input type="radio" checked={folderMode === 'none'} onChange={() => setFolderMode('none')} />
              暂不关联
            </label>
          </div>
        )}
      </div>
    </Modal>
  )
}
