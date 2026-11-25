import { useEffect, useState } from 'react'
import { api, errMsg, uid, useApp } from '../lib'
import { ask } from '../ui'
import { SUP_DEFAULT, useSup } from './Companies'
import AiProfile from './AiProfile'

const SECTIONS = [
  ['stages', '项目阶段'],
  ['statuses', '项目状态'],
  ['members', '团队成员'],
  ['template', '项目目录模板'],
  ['files', '文件显示'],
  ['colors', '颜色含义'],
  ['look', '外观'],
  ['focus', '番茄钟'],
  ['map', '地图'],
  ['ai', '智能体（AI）'],
  ['aiProfile', 'AI 用户档案'],
  ['librarySet', '资料库'],
  ['supplier', '单位与供应商选项'],
  ['storage', '存储位置'],
  ['pack', '备份与分享']
] as const

export default function Settings({ section }: { section?: string }) {
  const { data, saveSettings, setData, toast } = useApp()
  const s = data.settings
  const [sec, setSec] = useState<string>(section || 'stages')
  const save = (patch: any) => saveSettings({ ...s, ...patch })

  const move = <T,>(arr: T[], i: number, d: number) => {
    const a = [...arr]
    const j = i + d
    if (j < 0 || j >= a.length) return a
    ;[a[i], a[j]] = [a[j], a[i]]
    return a
  }

  return (
    <>
      <div className="topbar">
        <h1>设置</h1>
      </div>
      <div className="page">
        <div className="set-wrap">
          <div className="set-nav">
            {SECTIONS.map(([id, name]) => (
              <button key={id} className={'nav' + (sec === id ? ' on' : '')} onClick={() => setSec(id)}>
                {name}
              </button>
            ))}
          </div>
          <div className="set-body set-sec">
            {sec === 'stages' && (
              <>
                <h2>项目阶段</h2>
                <div className="desc">按实际工作流程设置阶段和顺序。点击色块换颜色，直接改名。最后一个阶段视为「已完成」。删除阶段后，原来在该阶段的项目会显示为第一个阶段。</div>
                <div className="set-list">
                  {s.stages.map((st: any, i: number) => (
                    <div key={st.id} className="set-item">
                      <span className="faint" style={{ width: 16 }}>{i + 1}</span>
                      <input type="color" value={st.color} onChange={(e) => save({ stages: s.stages.map((x: any) => (x.id === st.id ? { ...x, color: e.target.value } : x)) })} />
                      <input className="input" defaultValue={st.name} onBlur={(e) => e.target.value.trim() && save({ stages: s.stages.map((x: any) => (x.id === st.id ? { ...x, name: e.target.value.trim() } : x)) })} />
                      {i === s.stages.length - 1 && <span className="tag">完成阶段</span>}
                      <button className="icon-btn" onClick={() => save({ stages: move(s.stages, i, -1) })}>↑</button>
                      <button className="icon-btn" onClick={() => save({ stages: move(s.stages, i, 1) })}>↓</button>
                      <button
                        className="icon-btn"
                        onClick={() => {
                          const used = data.projects.filter((p) => p.stage === st.id).length
                          if (s.stages.length <= 2) return toast('至少保留两个阶段')
                          if (used && !confirm(`有 ${used} 个项目在「${st.name}」阶段，仍然删除？`)) return
                          save({ stages: s.stages.filter((x: any) => x.id !== st.id) })
                        }}
                      >
                        🗑
                      </button>
                    </div>
                  ))}
                  <div className="set-item">
                    <button
                      className="btn small"
                      onClick={async () => {
                        const name = await ask('新阶段名称')
                        if (name) save({ stages: [...s.stages.slice(0, -1), { id: uid(), name, color: '#0ea5e9' }, s.stages[s.stages.length - 1]] })
                      }}
                    >
                      + 添加阶段
                    </button>
                    <span className="faint">新加的阶段排在完成阶段前面</span>
                  </div>
                </div>
              </>
            )}

            {sec === 'statuses' && (
              <ListEditor title="项目状态" desc="项目在当前阶段的状态，例如洽谈中、已签约、暂停。「暂停」和「未成交」的项目不计入进行中。" items={s.statuses} onChange={(statuses) => save({ statuses })} />
            )}

            {sec === 'members' && (
              <>
                <h2>团队成员</h2>
                <div className="desc">可以被指定为项目负责人或参与人的成员。</div>
                <div className="set-list">
                  {s.members.length === 0 && <div className="set-item faint">还没有成员</div>}
                  {s.members.map((m: any) => (
                    <div key={m.id} className="set-item">
                      <input className="input" defaultValue={m.name} onBlur={(e) => e.target.value.trim() && save({ members: s.members.map((x: any) => (x.id === m.id ? { ...x, name: e.target.value.trim() } : x)) })} />
                      <input className="input" placeholder="职务（可选）" defaultValue={m.title || ''} onBlur={(e) => save({ members: s.members.map((x: any) => (x.id === m.id ? { ...x, title: e.target.value.trim() } : x)) })} />
                      <button className="icon-btn" onClick={() => save({ members: s.members.filter((x: any) => x.id !== m.id) })}>🗑</button>
                    </div>
                  ))}
                  <div className="set-item">
                    <button
                      className="btn small"
                      onClick={async () => {
                        const name = await ask('成员姓名')
                        if (name) save({ members: [...s.members, { id: uid(), name }] })
                      }}
                    >
                      + 添加成员
                    </button>
                  </div>
                </div>
              </>
            )}

            {sec === 'template' && (
              <>
                <h2>项目目录模板</h2>
                <div className="desc">
                  可以存多套模板，应对不同类型的工作（规划设计、工程咨询、施工图……）。新建项目时选用哪一套；已有项目可以在项目页点「按模板补齐目录」，只补缺的文件夹，不动已有内容；先选中某个子文件夹（或在它上面右键）就补到它下面。
                </div>
                <div className="field">
                  <label>项目根目录（新项目的文件夹建在这里）</label>
                  <div className="row">
                    <div className="path-box" style={{ flex: 1 }}>{s.projectsRoot || '未设置'}</div>
                    <button
                      className="btn"
                      onClick={async () => {
                        const d = await api.call('dialog:pickFolder', '选择项目根目录')
                        if (d) save({ projectsRoot: d })
                      }}
                    >
                      选择…
                    </button>
                  </div>
                </div>
                <TemplatesEditor />
              </>
            )}

            {sec === 'files' && (
              <>
                <h2>文件显示</h2>
                <div className="set-list" style={{ marginBottom: 20 }}>
                  <div className="set-item">
                    <div style={{ flex: 1 }}>
                      <div>自动归组版本</div>
                      <div className="faint" style={{ fontSize: 12 }}>
                        同一文件夹里「方案.docx」「方案最终版.docx」「方案修改稿 v3.docx」这类文件，自动收进一个版本组节点，按修改时间编号。只影响显示，不改动文件。
                      </div>
                    </div>
                    <button className={'switch' + (s.autoGroupVersions !== false ? ' on' : '')} onClick={() => save({ autoGroupVersions: s.autoGroupVersions === false })} />
                  </div>
                </div>
                <div className="desc">下面这些文件不会出现在项目导图上，但不会被删除。需要时可以在项目页勾选「显示隐藏文件」。在节点上右键「隐藏」只影响那一个文件。</div>
                <div className="set-list">
                  {s.hideGroups.map((g: any) => (
                    <div key={g.id} className="set-item" style={{ alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <div>{g.name}</div>
                        <div className="faint" style={{ fontSize: 12 }}>{g.desc}</div>
                        <div>
                          {g.patterns.map((p: string) => (
                            <span key={p} className="pat">{p}</span>
                          ))}
                        </div>
                      </div>
                      <button className={'switch' + (g.enabled ? ' on' : '')} onClick={() => save({ hideGroups: s.hideGroups.map((x: any) => (x.id === g.id ? { ...x, enabled: !x.enabled } : x)) })} />
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 20 }}>
                  <ListEditor title="自定义规则" desc="*.bak 隐藏所有 bak 文件；备份/ 隐藏名为「备份」的文件夹；也可以直接填完整文件名。" items={s.customHide || []} onChange={(customHide) => save({ customHide })} />
                </div>
              </>
            )}

            {sec === 'colors' && (
              <>
                <h2>颜色含义</h2>
                <div className="desc">导图节点可以着色，这里定义每种颜色代表什么（右键菜单和侧栏里会显示）。</div>
                <div className="set-list">
                  {s.colorLegend.map((c: any, i: number) => (
                    <div key={i} className="set-item">
                      <input type="color" value={c.color} onChange={(e) => save({ colorLegend: s.colorLegend.map((x: any, j: number) => (j === i ? { ...x, color: e.target.value } : x)) })} />
                      <input className="input" defaultValue={c.label} onBlur={(e) => save({ colorLegend: s.colorLegend.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value.trim() } : x)) })} />
                      <button className="icon-btn" onClick={() => save({ colorLegend: s.colorLegend.filter((_: any, j: number) => j !== i) })}>🗑</button>
                    </div>
                  ))}
                  <div className="set-item">
                    <button className="btn small" onClick={() => save({ colorLegend: [...s.colorLegend, { color: '#64748b', label: '新颜色' }] })}>+ 添加颜色</button>
                  </div>
                </div>
              </>
            )}

            {sec === 'look' && (
              <>
                <h2>外观</h2>
                <div className="desc">选择浅色或深色界面。</div>
                <div className="row">
                  {[
                    ['system', '跟随系统'],
                    ['light', '浅色'],
                    ['dark', '深色']
                  ].map(([id, name]) => (
                    <button key={id} className={'btn' + (s.theme === id ? ' primary' : '')} onClick={() => save({ theme: id })}>
                      {name}
                    </button>
                  ))}
                </div>
              </>
            )}

            {sec === 'storage' && <StorageSection />}

            {sec === 'supplier' && <SupplierOptions />}
            {sec === 'aiProfile' && <AiProfile />}
            {sec === 'librarySet' && (
              <>
                <h2>资料库</h2>
                <div className="desc">
                  导入资料库的文件会复制到这个文件夹，按类型放在子文件夹里，原文件以后移动、删除都不影响。可以放在公司共享盘上，方便备份和大家查阅。
                </div>
                <div className="field">
                  <label>资料库文件夹</label>
                  <div className="row">
                    <div className="path-box" style={{ flex: 1 }}>{data.libraryDir}</div>
                    <button className="btn" onClick={() => api.call('shell:openPath', data.libraryDir)}>打开</button>
                    <button
                      className="btn"
                      onClick={async () => {
                        const d = await api.call('dialog:pickFolder', '选择新的资料库文件夹')
                        if (d && confirm(`把资料库改到：\n${d}\n现有 ${data.library.length} 份资料的文件会复制过去，原文件夹保留不动。`)) setData(await api.call('library:setDir', d))
                      }}
                    >
                      更改位置…
                    </button>
                  </div>
                </div>
                <ListEditor
                  title="资料类型"
                  desc="资料库左侧的分类。改名会影响新导入文件放的子文件夹；已有资料不受影响。"
                  items={s.libraryTypes.map((t: any) => t.name)}
                  onChange={(names) =>
                    save({
                      libraryTypes: names.map((n) => s.libraryTypes.find((t: any) => t.name === n) || { id: uid(), name: n })
                    })
                  }
                />
              </>
            )}

            {sec === 'pack' && <PackSection />}

            {sec === 'ai' && <AiSection />}

            {sec === 'focus' && (
              <>
                <h2>番茄钟</h2>
                <div className="desc">侧栏左下角「开始专注」。专注结束后自动进入休息，每 4 个番茄一次长休息。每段专注都会记下来，可关联项目和待办，在工作台和项目详情里统计。</div>
                <div className="grid3">
                  {[
                    ['work', '专注（分钟）'],
                    ['shortBreak', '短休息（分钟）'],
                    ['longBreak', '长休息（分钟）']
                  ].map(([k, label]) => (
                    <div key={k} className="field">
                      <label>{label}</label>
                      <input type="number" min={1} max={240} className="input" defaultValue={s.focus[k]} onBlur={(e) => save({ focus: { ...s.focus, [k]: Math.max(1, Math.min(240, Number(e.target.value) || s.focus[k])) } })} />
                    </div>
                  ))}
                </div>
                <label className="row" style={{ cursor: 'pointer' }}>
                  <button className={'switch' + (s.focus.sound ? ' on' : '')} onClick={() => save({ focus: { ...s.focus, sound: !s.focus.sound } })} />
                  结束时响提示音
                </label>
              </>
            )}

            {sec === 'map' && (
              <>
                <h2>地图</h2>
                <div className="desc">
                  默认底图不需要任何 Key：卫星图用 Esri World Imagery（叠加地名和边界），道路图用 OpenStreetMap，地形图用 Esri 地形图，全球覆盖。
                  地名搜索用 OpenStreetMap 的 Nominatim。坐标统一按 WGS-84（经纬度）保存，这几种底图都没有偏移。
                  <br />
                  国内项目也可以改用国家官方的「天地图」（需要免费 Key，国内访问更快、地名更全）。没有网络时可以选「不用底图」，只标注位置。
                  <br />
                  Esri 影像供个人和非商业使用免费；商业用途请留意 Esri 的使用条款。
                </div>
                <div className="field">
                  <label>底图</label>
                  <div className="row">
                    {[
                      ['esri', 'Esri 卫星图 + OpenStreetMap'],
                      ['tianditu', '天地图'],
                      ['none', '不用底图']
                    ].map(([id, name]) => (
                      <button
                        key={id}
                        className={'btn' + ((s.map.provider === 'osm' ? 'esri' : s.map.provider) === id ? ' primary' : '')}
                        onClick={() => save({ map: { ...s.map, provider: id } })}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label>天地图 Key（只有选天地图时需要）</label>
                  <input className="input" defaultValue={s.map.key} placeholder="粘贴天地图控制台里的 Key" onBlur={(e) => e.target.value.trim() !== s.map.key && save({ map: { ...s.map, key: e.target.value.trim() } })} />
                </div>
                <div className="desc">
                  如何申请：
                  <br />1. 打开天地图控制台（console.tianditu.gov.cn），用手机号注册并登录（免费）
                  <br />2. 进入「应用管理」→「创建新应用」，应用类型选「浏览器端」，白名单留空
                  <br />3. 创建后复制 Key，粘贴到上面
                </div>
                <button className="btn" onClick={() => window.open('https://console.tianditu.gov.cn/', '_blank')}>打开天地图控制台</button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

/** 多套项目目录模板 */
function TemplatesEditor() {
  const { data, saveSettings, toast } = useApp()
  const s = data.settings
  const list: any[] = s.templates || []
  const [sel, setSel] = useState<string>(s.defaultTemplateId || list[0]?.id)
  const cur = list.find((t) => t.id === sel) || list[0]
  const used = (id: string) => data.projects.filter((p) => p.templateId === id).length

  const saveList = (templates: any[], extra: any = {}) => saveSettings({ ...s, templates, ...extra })
  const update = (patch: any) => saveList(list.map((t) => (t.id === cur.id ? { ...t, ...patch } : t)))

  const add = async (base?: { name: string; folders: string[] }) => {
    const name = await ask('模板名称', base?.name || '', '如：市政道路、景观设计、可研报告')
    if (!name) return
    const t = { id: uid(), name, folders: base?.folders || [] }
    await saveList([...list, t])
    setSel(t.id)
  }

  const fromFolder = async () => {
    const r = await api.call('templates:fromFolder')
    if (!r) return
    if (!r.folders.length) return toast('这个文件夹里没有子文件夹')
    await add({ name: r.name, folders: r.folders })
  }

  const remove = () => {
    if (list.length <= 1) return toast('至少保留一套模板')
    if (!confirm(`删除模板「${cur.name}」？已经建好的项目文件夹不受影响。`)) return
    const rest = list.filter((t) => t.id !== cur.id)
    saveList(rest, s.defaultTemplateId === cur.id ? { defaultTemplateId: rest[0].id } : {})
    setSel(rest[0].id)
  }

  // 预览：把「a/b」画成两层
  const preview = (folders: string[]) => {
    const rows: { depth: number; name: string }[] = []
    const seen = new Set<string>()
    for (const f of folders) {
      const parts = f.split(/[\\/]+/).filter(Boolean)
      parts.forEach((p, i) => {
        const key = parts.slice(0, i + 1).join('/')
        if (!seen.has(key)) {
          seen.add(key)
          rows.push({ depth: i, name: p })
        }
      })
    }
    return rows
  }

  return (
    <div className="tpl-wrap">
      <div className="tpl-list">
        {list.map((t) => (
          <div key={t.id} className={'tpl-item' + (t.id === cur?.id ? ' on' : '')} onClick={() => setSel(t.id)}>
            <div style={{ fontWeight: 600 }}>
              {t.name}
              {t.id === s.defaultTemplateId && <span className="tag" style={{ marginLeft: 6 }}>默认</span>}
            </div>
            <div className="faint" style={{ fontSize: 11 }}>
              {t.folders.length} 个文件夹{used(t.id) ? ` · ${used(t.id)} 个项目在用` : ''}
            </div>
          </div>
        ))}
        <button className="btn small" style={{ marginTop: 8 }} onClick={() => add()}>+ 新建模板</button>
        <button className="btn small" onClick={fromFolder} title="选一个整理好的项目文件夹，按它的子文件夹（最多两层）生成模板">从文件夹生成…</button>
      </div>
      {cur && (
        <div className="tpl-body">
          <div className="row" style={{ marginBottom: 10 }}>
            <input key={cur.id} className="input" style={{ fontWeight: 600 }} defaultValue={cur.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== cur.name && update({ name: e.target.value.trim() })} />
            {cur.id !== s.defaultTemplateId ? (
              <button className="btn small" onClick={() => saveSettings({ ...s, defaultTemplateId: cur.id })}>设为默认</button>
            ) : (
              <span className="tag">默认模板</span>
            )}
            <button className="btn small" onClick={() => add({ name: cur.name + ' 副本', folders: [...cur.folders] })}>复制</button>
            <button className="btn small danger" onClick={remove}>删除</button>
          </div>
          <div className="tpl-cols">
            <div style={{ flex: 1, minWidth: 0 }}>
              <ListEditor key={cur.id} title="" desc="" items={cur.folders} onChange={(folders) => update({ folders })} />
              <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>用「/」写子文件夹，如「05 施工图/结构」。</div>
            </div>
            <div className="tpl-preview">
              <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>预览</div>
              {preview(cur.folders).map((r, i) => (
                <div key={i} style={{ paddingLeft: r.depth * 16 }}>
                  📁 {r.name}
                </div>
              ))}
              {!cur.folders.length && <div className="faint">还没有文件夹</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 智能体（AI）：本机 MCP 服务 */
export function AiSection() {
  const { data, saveSettings, setData, toast } = useApp()
  const s = data.settings
  const ai = s.ai
  const [status, setStatus] = useState<any>(null)
  const [log, setLog] = useState<any[]>([])
  const [client, setClient] = useState('generic')

  const refresh = () => {
    api.call('ai:status').then(setStatus)
    api.call('ai:log').then(setLog)
  }
  useEffect(() => {
    refresh()
    const off1 = api.on('ai:status', setStatus)
    const off2 = api.on('ai:action', () => api.call('ai:log').then(setLog))
    return () => {
      off1()
      off2()
    }
  }, [])
  useEffect(() => {
    const t = setTimeout(refresh, 400)
    return () => clearTimeout(t)
  }, [ai.level, ai.port, ai.token])

  const setAi = (patch: any) => saveSettings({ ...s, ai: { ...ai, ...patch } })
  const url = `http://127.0.0.1:${ai.port}/mcp`
  const token = ai.token || '（开启后自动生成）'

  const configs: Record<string, { name: string; tip: string; text: string }> = {
    generic: {
      name: 'Cursor / Cherry Studio / Trae / WorkBuddy 等',
      tip: '支持「Streamable HTTP」的客户端：在 MCP 设置里粘贴下面的 JSON（或分别填写 URL 和请求头）。',
      text: JSON.stringify({ mcpServers: { 'project-desk': { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
    },
    claudeDesktop: {
      name: 'Claude 桌面版',
      tip: '设置 → 开发者 → 编辑配置（claude_desktop_config.json），加入下面内容后重启 Claude。需要电脑上装有 Node.js。',
      text: JSON.stringify({ mcpServers: { 'project-desk': { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${token}`] } } }, null, 2)
    },
    claudeCode: {
      name: 'Claude Code',
      tip: '在终端运行：',
      text: `claude mcp add --transport http project-desk ${url} --header "Authorization: Bearer ${token}"`
    },
    codex: {
      name: 'Codex',
      tip: '加到 ~/.codex/config.toml：',
      text: `[mcp_servers.project-desk]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "${url}", "--header", "Authorization: Bearer ${token}"]`
    }
  }

  const levels: [string, string, string][] = [
    ['off', '关闭', '不对外开放'],
    ['read', '只读', '可以查看项目、读取文件内容和备忘录、资料库、通讯录，不能修改'],
    ['write', '可读写', '还可以整理项目文件夹（新建、移动、改名、移入回收站）、生成 Word / Excel、写备忘录、录入通讯录、资料库、询价回价和待办；每次修改都会提示，可以撤销']
  ]

  return (
    <>
      <h2>智能体（AI）</h2>
      <div className="desc">
        让 WorkBuddy、Codex、Claude、豆包、千问、Cursor、Cherry Studio 等支持 MCP 的 AI 助手直接使用个人工作台：查项目、读文件、按要求整理文件夹、归档资料、录入询价回价和待办。
        只接受本机（127.0.0.1）的连接，并且需要令牌；网页里的请求一律拒绝。
      </div>
      <div className="row" style={{ alignItems: 'stretch', marginBottom: 16 }}>
        {levels.map(([id, name, desc]) => (
          <div key={id} className={'card ai-level' + (ai.level === id ? ' on' : '')} onClick={() => setAi({ level: id })}>
            <div style={{ fontWeight: 600 }}>
              <input type="radio" readOnly checked={ai.level === id} /> {name}
            </div>
            <div className="faint" style={{ fontSize: 12, lineHeight: 1.6 }}>{desc}</div>
          </div>
        ))}
      </div>

      {ai.level !== 'off' && (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <span className={'tag ' + (status?.running ? '' : 'red')} style={status?.running ? { background: '#dcfce7', color: '#166534' } : undefined}>
              {status?.running ? `运行中 · ${url}` : status?.error || '未运行'}
            </span>
          </div>
          <div className="grid2">
            <div className="field">
              <label>端口</label>
              <input type="number" className="input" defaultValue={ai.port} onBlur={(e) => Number(e.target.value) !== ai.port && setAi({ port: Math.min(65535, Math.max(1024, Number(e.target.value) || 17321)) })} />
            </div>
            <div className="field">
              <label>令牌（相当于密码，不要发给别人）</label>
              <div className="row">
                <div className="path-box" style={{ flex: 1 }}>{ai.token ? ai.token.slice(0, 6) + '••••••••' + ai.token.slice(-4) : '—'}</div>
                <button className="btn small" onClick={() => api.call('clipboard:text', ai.token).then(() => toast('令牌已复制'))}>复制</button>
                <button
                  className="btn small"
                  onClick={() => confirm('重新生成令牌后，已经配置好的 AI 客户端需要换成新令牌。继续？') && setAi({ token: '' })}
                >
                  重新生成
                </button>
              </div>
            </div>
          </div>

          <h2 style={{ fontSize: 14, marginTop: 8 }}>连接到 AI 客户端</h2>
          <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
            {Object.entries(configs).map(([id, c]) => (
              <button key={id} className={'btn small' + (client === id ? ' primary' : '')} onClick={() => setClient(id)}>
                {c.name}
              </button>
            ))}
          </div>
          <div className="desc">{configs[client].tip}</div>
          <pre className="code-box">{configs[client].text}</pre>
          <button className="btn small" onClick={() => api.call('clipboard:text', configs[client].text).then(() => toast('已复制，含令牌，请勿外传'))}>
            复制配置
          </button>

          <h2 style={{ fontSize: 14, marginTop: 20 }}>AI 操作记录</h2>
          <div className="desc">AI 助手做的每一次修改都记在这里。软件重启前可以撤销（移到回收站的文件请在系统回收站里还原）。完整记录保存在数据文件夹的 ai-log.json。</div>
          <div className="set-list">
            {log.length === 0 && <div className="set-item faint">还没有操作</div>}
            {log.map((a) => (
              <div key={a.id} className="set-item">
                <span className="faint" style={{ fontSize: 12, width: 130 }}>{new Date(a.time).toLocaleString('zh-CN')}</span>
                <span style={{ flex: 1, textDecoration: a.undone ? 'line-through' : undefined, color: a.undone ? 'var(--text-3)' : undefined }}>{a.summary}</span>
                {a.canUndo && !a.undone && (
                  <button
                    className="btn small"
                    onClick={async () => {
                      try {
                        const r = await api.call('ai:undo', a.id)
                        setLog(r.log)
                        setData(r.data)
                        toast('已撤销')
                      } catch (e) {
                        toast(errMsg(e))
                      }
                    }}
                  >
                    撤销
                  </button>
                )}
                {a.undone && <span className="faint" style={{ fontSize: 12 }}>已撤销</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

/** 存储位置：全部数据都在一个根目录下，方便打包、备份、分享 */
function StorageSection() {
  const { data, setData, toast } = useApp()
  const [busy, setBusy] = useState(false)
  const row = (label: string, p: string) => (
    <div className="set-item">
      <span style={{ width: 90 }}>{label}</span>
      <div className="path-box" style={{ flex: 1 }}>{p || '—'}</div>
      {p && <button className="btn small" onClick={() => api.call('shell:openPath', p)}>打开</button>}
    </div>
  )
  const sep = data.root.includes('\\') ? '\\' : '/'
  const under = (p: string) => p && p.toLowerCase().startsWith(data.root.toLowerCase())
  const moveRoot = async () => {
    const d = await api.call('dialog:pickFolder', '选择新的根目录（会在里面建 数据/资料库/项目/备份/供应商与联系人）')
    if (!d) return
    if (!confirm(`把全部数据搬到：\n${d}\n\n会复制 数据、资料库、项目、备份、供应商与联系人 五个文件夹过去，并改写项目路径。原位置的文件保留不动，确认无误后可以自己删除。\n项目文件多时需要一点时间。继续？`)) return
    setBusy(true)
    try {
      setData(await api.call('workspace:move', d))
      toast('已搬到新位置')
    } catch (e) {
      toast('搬移失败：' + errMsg(e))
    }
    setBusy(false)
  }
  return (
    <>
      <h2>存储位置</h2>
      <div className="desc">
        软件的全部内容默认放在同一个根目录下：<b>数据</b>（项目信息、待办、备忘录、通讯录、询价……）、<b>资料库</b>、<b>项目</b>（新建项目的文件夹）、<b>供应商与联系人</b>（单位附件）、<b>备份</b>。
        整个根目录拷走就是完整的一份，也可以在「备份与分享」里按类别打包。
      </div>
      <div className="field">
        <label>根目录</label>
        <div className="row">
          <div className="path-box" style={{ flex: 1 }}>{data.root}</div>
          <button className="btn" onClick={() => api.call('shell:openPath', data.root)}>打开</button>
          <button className="btn" disabled={busy} onClick={moveRoot}>{busy ? '正在搬移…' : '更改根目录…'}</button>
        </div>
      </div>
      <div className="set-list">
        {row('数据', data.dataDir)}
        {row('资料库', data.libraryDir)}
        {row('项目', data.settings.projectsRoot)}
        {row('供应商与联系人', data.companyDir)}
        {row('备份', data.backupDir)}
      </div>
      {(!under(data.libraryDir) || !under(data.settings.projectsRoot)) && (
        <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
          资料库或项目文件夹不在根目录{sep}下（之前单独改过）。可以在「资料库」「项目目录模板」里改回来。
        </div>
      )}
      {data.migratedFrom && (
        <div className="faint" style={{ fontSize: 12, marginTop: 10 }}>
          数据已从旧位置复制过来：{data.migratedFrom}。确认这里一切正常后，旧位置的数据文件可以自己删除。
        </div>
      )}
    </>
  )
}

const PACK_CATS: [string, string, string][] = [
  ['projects', '项目信息', '项目、阶段、导图备注与引用'],
  ['projectFiles', '项目文件夹', '每个项目文件夹里的图纸、报告、照片原样复制，文件多时会很大'],
  ['tasks', '待办与便签', '待办、便签、专注记录'],
  ['kb', '备忘录', '备忘录正文和里面的图片、录音、视频（历史版本可另选）'],
  ['flows', '工作流程', '审批流程图、审批人、所需附件'],
  ['contacts', '通讯录与询价', '联系人、单位与供应商、询价记录。有别人的电话，建议设密码'],
  ['library', '资料库', '资料目录和文件本身'],
  ['settings', '设置', '阶段、模板、外观等']
]
const PRESETS: [string, string[]][] = [
  ['全部', PACK_CATS.map((c) => c[0])],
  ['全部（不含项目文件）', PACK_CATS.map((c) => c[0]).filter((c) => c !== 'projectFiles')],
  ['只要项目', ['projects', 'projectFiles', 'tasks']],
  ['备忘录与资料库', ['kb', 'flows', 'library']]
]

/** 备份与分享：按类别一键备份，或导出给别人 / 带到另一台电脑 */
export function PackSection() {
  const { data, setData, toast } = useApp()
  const [cats, setCats] = useState<string[]>(PRESETS[1][1])
  const [kbHistory, setKbHistory] = useState(false)
  const [zip, setZip] = useState(false)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState<any>(null)
  const [incoming, setIncoming] = useState<any>(null)

  useEffect(() => api.on('pack:progress', (d: number, t: number) => setBusy(`正在导出 ${d} / ${t}`)), [])

  const doExport = async (pick: boolean) => {
    if (!cats.length) return toast('请至少选一类')
    if (pw !== pw2) return toast('两次输入的密码不一致')
    let dest: string | undefined
    if (pick) {
      dest = await api.call('dialog:pickFolder', '导出到哪里（选已有的数据包文件夹则只更新改动过的文件）')
      if (!dest) return
    }
    setBusy('正在导出…')
    setResult(null)
    try {
      const r = await api.call('pack:export', { dest, categories: cats, includeKbHistory: kbHistory, zip, password: pw || undefined })
      setResult(r)
      toast(`已导出 ${r.total} 个文件${r.failedCount ? `，${r.failedCount} 个失败` : ''}`)
    } catch (e) {
      toast('导出失败：' + errMsg(e))
    }
    setBusy('')
  }

  const pickImport = async () => {
    try {
      const r = await api.call('pack:pick')
      if (r) setIncoming({ ...r, password: '', target: data.settings.projectsRoot || '' })
    } catch (e) {
      toast(errMsg(e))
    }
  }

  const doImport = async () => {
    if (!confirm(`导入会用数据包替换这几类数据：\n${incoming.info.categoryLabels.join('、')}\n\n其余数据不动；被替换的部分会先另存到「备份」文件夹。继续？`)) return
    setBusy('正在导入…')
    try {
      const r = await api.call('pack:import', incoming.dir, { password: incoming.password || undefined, projectsTarget: incoming.target || undefined })
      setData(r.data)
      setIncoming(null)
      toast('导入完成。导入前的数据另存在：' + r.savedTo)
    } catch (e) {
      toast('导入失败：' + errMsg(e))
    }
    setBusy('')
  }

  const toggle = (c: string, on: boolean) => setCats((x) => (on ? [...new Set([...x, c])] : x.filter((y) => y !== c)))
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

  return (
    <>
      <h2>备份与分享</h2>
      <div className="desc">
        选好要带的数据类别，一键备份到「备份」文件夹（{data.backupDir}），或者导出到 U 盘、移动硬盘、共享盘，交给同事或带到另一台电脑导入。导出的是一个文件夹，也可以顺带压成 .zip。
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        <span className="faint">常用：</span>
        {PRESETS.map(([name, list]) => (
          <button key={name} className={'btn small' + (same(cats, list) ? ' primary' : '')} onClick={() => setCats(list)}>{name}</button>
        ))}
      </div>
      <div className="pack-cats">
        {PACK_CATS.map(([id, label, desc]) => (
          <label key={id} className="set-item" style={{ cursor: 'pointer', alignItems: 'flex-start' }}>
            <input type="checkbox" checked={cats.includes(id)} onChange={(e) => toggle(id, e.target.checked)} style={{ marginTop: 3 }} />
            <div>
              <div>
                {label}
                {id === 'projects' && <span className="faint"> · {data.projects.length} 个</span>}
                {id === 'library' && <span className="faint"> · {data.library.length} 份</span>}
              </div>
              {desc && <div className="faint" style={{ fontSize: 12 }}>{desc}</div>}
            </div>
          </label>
        ))}
      </div>
      <div className="row" style={{ gap: 16, margin: '8px 0 12px' }}>
        <label className="row" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={kbHistory} disabled={!cats.includes('kb')} onChange={(e) => setKbHistory(e.target.checked)} />
          带上备忘录历史版本
        </label>
        <label className="row" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={zip} onChange={(e) => setZip(e.target.checked)} />
          另外压缩成 .zip（方便发给别人）
        </label>
      </div>
      <div className="grid2">
        <div className="field">
          <label>密码（可不设）</label>
          <input type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="设了密码，U 盘丢了别人也打不开" />
        </div>
        <div className="field">
          <label>再输一遍</label>
          <input type="password" className="input" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </div>
      </div>
      <div className="row" style={{ marginBottom: 6 }}>
        <button className="btn primary" disabled={!!busy} onClick={() => doExport(false)}>一键备份</button>
        <button className="btn" disabled={!!busy} onClick={() => doExport(true)}>导出到…</button>
        <button className="btn" onClick={() => api.call('shell:openPath', data.backupDir)}>打开备份文件夹</button>
        <span className="faint">{busy}</span>
      </div>
      <div className="faint" style={{ fontSize: 12, marginBottom: 12 }}>忘了密码就导入不了，软件也找不回。选已有的数据包文件夹时，只写入改动过的文件。</div>
      {result && (
        <div className="set-list" style={{ marginBottom: 24 }}>
          <div className="set-item">
            <div style={{ flex: 1 }}>
              <div>已导出：{result.path}</div>
              <div className="faint" style={{ fontSize: 12 }}>
                共 {result.total} 个文件，本次写入 {result.copied} 个{result.skipped ? `，跳过 ${result.skipped} 个` : ''}
                {result.zipPath ? ` · 压缩包：${result.zipPath}` : ''}
              </div>
            </div>
            <button className="btn small" onClick={() => api.call('shell:reveal', result.zipPath || result.path)}>打开位置</button>
          </div>
          {result.failedCount > 0 && (
            <div className="set-item" style={{ display: 'block' }}>
              <div style={{ color: 'var(--danger)' }}>{result.failedCount} 个文件没导出（可能被其他软件占用，关掉后再导出一次即可补上）：</div>
              {result.failed.map((f: any, i: number) => (
                <div key={i} className="faint" style={{ fontSize: 12 }}>{typeof f === 'string' ? f : `${f.rel || f.path}：${f.error || ''}`}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <h2 style={{ fontSize: 14, marginTop: 20 }}>导入数据包</h2>
      <div className="desc">选择数据包文件夹（.zip 请先解压）。只替换数据包里带了的那几类数据，其余不动；被替换的部分先另存到「备份」文件夹。</div>
      {!incoming ? (
        <button className="btn" onClick={pickImport}>选择数据包…</button>
      ) : (
        <div className="set-list">
          <div className="set-item">
            <div style={{ flex: 1 }}>
              <div>{incoming.dir}</div>
              <div className="faint" style={{ fontSize: 12 }}>
                导出于 {new Date(incoming.info.createdAt).toLocaleString('zh-CN')} · {incoming.info.projects.length} 个项目 · {incoming.info.fileCount} 个文件
                {incoming.info.encrypted ? ' · 已加密' : ''}
              </div>
              <div className="faint" style={{ fontSize: 12 }}>包含：{incoming.info.categoryLabels.join('、')}</div>
            </div>
            <button className="btn small" onClick={() => setIncoming(null)}>换一个</button>
          </div>
          {incoming.info.encrypted && (
            <div className="set-item">
              <span style={{ width: 120 }}>数据包密码</span>
              <input type="password" className="input" value={incoming.password} onChange={(e) => setIncoming({ ...incoming, password: e.target.value })} />
            </div>
          )}
          {incoming.info.categories.includes('projectFiles') && (
            <div className="set-item">
              <span style={{ width: 120 }}>项目文件夹放到</span>
              <div className="path-box" style={{ flex: 1 }}>{incoming.target || '未选择'}</div>
              <button
                className="btn small"
                onClick={async () => {
                  const d = await api.call('dialog:pickFolder', '项目文件夹放在哪里')
                  if (d) setIncoming({ ...incoming, target: d })
                }}
              >
                选择…
              </button>
            </div>
          )}
          <div className="set-item">
            <button className="btn primary" disabled={!!busy} onClick={doImport}>开始导入</button>
            <span className="faint">{busy}</span>
          </div>
        </div>
      )}
    </>
  )
}

/** 单位与供应商库的下拉选项：类别、专业、服务国家、入库状态、等级…… */
const SUP_LISTS: [string, string, string][] = [
  ['unitTypes', '单位类型', '通讯录「单位与供应商」顶部的分类。「供应商」带有类别、入库状态等专用字段，不能删除或改名。'],
  ['category', '供应商类别', '如 分包类、物资类、服务类、设备类'],
  ['specialties', '专业分类', '供应商的专业标签（可多选），也用作询价专业的候选'],
  ['countries', '服务国家', '服务国家（可多选）和注册国家共用'],
  ['status', '入库状态', '按流程先后排列'],
  ['grade', '综合等级', ''],
  ['role', '经营角色', ''],
  ['stage', '开发阶段', ''],
  ['docTypes', '入库资料类型', ''],
  ['currencies', '币种', '询价、回价和项目经验用。删除币种不会改动已有记录']
]

function SupplierOptions() {
  const { data, saveSettings, setData, toast } = useApp()
  const sup = useSup()
  const [key, setKey] = useState('category')
  const usedBy = (k: string, v: string) =>
    data.companies.filter((c) => {
      if (k === 'unitTypes') return c.unitType === v
      if (k === 'specialties') return (c.specialties || []).includes(v)
      if (k === 'countries') return (c.serviceCountries || []).includes(v) || c.regCountry === v
      if (k === 'docTypes') return (c.docs || []).some((d: any) => d.type === v)
      if (k === 'currencies') return (c.experience || []).some((d: any) => d.currency === v)
      return c[k] === v
    })
  const inqUsing = (k: string, v: string) =>
    k === 'currencies' ? data.inquiries.filter((q) => q.currency === v || (q.quotes || []).some((r: any) => r.currency === v)).length : k === 'specialties' ? data.inquiries.filter((q) => q.discipline === v).length : 0
  const saveList = (k: string, list: string[]) => saveSettings({ ...data.settings, supplierOptions: { ...sup, [k]: list } })
  const [title, desc] = SUP_LISTS.find((x) => x[0] === key)!.slice(1)

  const remove = async (v: string) => {
    if (key === 'unitTypes' && v === '供应商') return toast('「供应商」不能删除')
    const cos = usedBy(key, v)
    const inq = inqUsing(key, v)
    if (cos.length || inq) {
      const names = cos.slice(0, 5).map((c) => c.name).join('、') + (cos.length > 5 ? ` 等` : '')
      const tail = key === 'currencies' ? '已有记录里的币种保持不变。' : `删除后，这 ${cos.length} 家单位上的「${v}」会一并清除。`
      if (!confirm(`「${v}」已关联 ${cos.length} 家单位${inq ? `、${inq} 条询价` : ''}${names ? `：\n${names}` : ''}\n\n${tail}确定删除？`)) return false
      if (key !== 'currencies' && cos.length) setData((await api.call('supplierOption:apply', key, v, null)).data)
    }
    return true
  }
  const rename = async (old: string, nw: string) => {
    if (key === 'unitTypes' && old === '供应商') {
      toast('「供应商」不能改名')
      return false
    }
    const n = usedBy(key, old).length + inqUsing(key, old)
    if (n) {
      const r = await api.call('supplierOption:apply', key, old, nw)
      setData(r.data)
      toast(`已改名，同步更新了 ${r.changed} 家单位${inqUsing(key, old) ? '和相关询价' : ''}`)
    }
    return true
  }

  return (
    <>
      <h2>单位与供应商选项</h2>
      <div className="desc">通讯录「单位与供应商」里各个下拉选项的条目。双击改名会同步改已有单位；删除已被使用的条目时会提示关联了几家单位。</div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {SUP_LISTS.map(([k, name]) => (
          <button key={k} className={'btn small' + (k === key ? ' primary' : '')} onClick={() => setKey(k)}>{name}</button>
        ))}
      </div>
      <ListEditor
        key={key}
        title={title}
        desc={desc}
        items={sup[key] || []}
        onChange={(list) => saveList(key, list)}
        countOf={(v) => usedBy(key, v).length}
        onRemove={remove}
        onRename={rename}
      />
      <button
        className="btn small"
        style={{ marginTop: 8 }}
        onClick={() => confirm(`把「${title}」恢复成默认条目？已有单位上的值不变。`) && saveList(key, SUP_DEFAULT[key])}
      >
        恢复默认
      </button>
    </>
  )
}

function ListEditor({
  title,
  desc,
  items,
  onChange,
  countOf,
  onRemove,
  onRename
}: {
  title: string
  desc: string
  items: string[]
  onChange: (v: string[]) => void
  countOf?: (v: string) => number
  onRemove?: (v: string) => Promise<boolean | void> | boolean | void
  onRename?: (old: string, nw: string) => Promise<boolean> | boolean
}) {
  const [v, setV] = useState('')
  const add = () => {
    if (v.trim() && !items.includes(v.trim())) onChange([...items, v.trim()])
    setV('')
  }
  return (
    <>
      {title && <h2>{title}</h2>}
      {desc && <div className="desc">{desc}</div>}
      <div className="set-list">
        {items.map((it, i) => (
          <div key={it + i} className="set-item">
            <span
              style={{ flex: 1, cursor: 'text' }}
              title="双击修改"
              onDoubleClick={async () => {
                const v = (await ask('修改', it))?.trim()
                if (!v || v === it) return
                if (items.includes(v)) return alert(`已经有「${v}」了`)
                if (onRename && (await onRename(it, v)) === false) return
                onChange(items.map((x, j) => (j === i ? v : x)))
              }}
            >
              {it}
              {countOf && countOf(it) > 0 && <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>{countOf(it)} 家单位</span>}
            </span>
            <button
              className="icon-btn"
              onClick={() => {
                const a = [...items]
                if (i > 0) [a[i - 1], a[i]] = [a[i], a[i - 1]]
                onChange(a)
              }}
            >
              ↑
            </button>
            <button
              className="icon-btn"
              onClick={async () => {
                if (onRemove && (await onRemove(it)) === false) return
                onChange(items.filter((_, j) => j !== i))
              }}
            >
              🗑
            </button>
          </div>
        ))}
        <div className="set-item">
          <input className="input" placeholder="输入后回车添加" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="btn small" onClick={add}>添加</button>
        </div>
      </div>
    </>
  )
}
