import { useEffect, useState } from 'react'
import { api, errMsg, useApp } from '../lib'
import { ask } from '../ui'

/** AI 用户档案：每个接入的 AI 先读它；AI 可以按节修改，每次修改留历史、可撤销；锁定的节 AI 改不了 */
export default function AiProfile() {
  const { data, toast, go } = useApp()
  const [p, setP] = useState<any>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  const load = () => api.call('profile:get').then(setP)
  useEffect(() => {
    load()
    // AI 改了档案时刷新
    return api.on('data:changed', load)
  }, [])

  const run = async (fn: () => Promise<any>) => {
    try {
      setP(await fn())
    } catch (e) {
      toast(errMsg(e))
    }
  }
  const save = (s: any, patch: any) => run(() => api.call('profile:save', { ...s, ...patch }))

  if (!p) return null
  const level = data.settings.ai?.level || 'off'
  const history = [...p.history].reverse()
  const kind = (c: any) => (c.undoOf ? '撤销' : !c.before ? '新增' : !c.after ? '删除' : '修改')

  return (
    <>
      <h2>AI 用户档案</h2>
      <div className="desc">
        记录你的工作习惯、工作流程和偏好。每个接入的 AI 连上后会先读这份档案（随连接说明一起发给 AI，也可用 get_user_profile 读取）。
        AI 在「可读写」权限下可以按节修改，每次修改都记在下面的历史里，可以撤销；锁定的节 AI 改不了。
        {level === 'off' && (
          <>
            {' '}当前 AI 接入是关闭的，
            <span className="click" style={{ color: 'var(--accent)' }} onClick={() => go({ page: 'settings', settingsSection: 'ai' })}>去开启</span>。
          </>
        )}
      </div>

      {p.sections.map((s: any, i: number) => (
        <div key={s.id + '|' + s.title + '|' + s.body} className="sub-card profile-sec">
          <div className="row" style={{ marginBottom: 6 }}>
            <input className="input" style={{ fontWeight: 600, flex: 1 }} defaultValue={s.title} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== s.title && save(s, { title: e.target.value.trim() })} />
            <button className={'btn small' + (s.locked ? ' primary' : '')} title={s.locked ? '已锁定：AI 不能修改这一节' : '点一下锁定，AI 就不能改这一节'} onClick={() => save(s, { locked: !s.locked })}>
              {s.locked ? '🔒 已锁定' : '🔓 AI 可改'}
            </button>
            <button className="icon-btn" title="上移" disabled={i === 0} onClick={() => run(() => api.call('profile:move', s.id, -1))}>↑</button>
            <button className="icon-btn" title="下移" disabled={i === p.sections.length - 1} onClick={() => run(() => api.call('profile:move', s.id, 1))}>↓</button>
            <button className="icon-btn" title="删除这一节" onClick={() => confirm(`删除「${s.title}」这一节？可以在下面的修改历史里撤销。`) && run(() => api.call('profile:delete', s.id))}>🗑</button>
          </div>
          <textarea
            className="input"
            rows={Math.min(14, Math.max(3, (s.body || '').split('\n').length + 1))}
            defaultValue={s.body}
            placeholder={s.hint || '写下你的做法，一条一行'}
            onBlur={(e) => e.target.value !== s.body && save(s, { body: e.target.value })}
          />
        </div>
      ))}
      <div className="row" style={{ marginBottom: 20 }}>
        <button
          className="btn"
          onClick={async () => {
            const title = await ask('新的一节叫什么', '', '如：常用供应商联系方式习惯、周报格式')
            if (title) save({ title }, { body: '' })
          }}
        >
          + 添加一节
        </button>
        <button className="btn" onClick={async () => setPreview(preview === null ? await api.call('profile:markdown') : null)}>
          {preview === null ? '预览 AI 读到的全文' : '收起预览'}
        </button>
      </div>
      {preview !== null && <pre className="profile-preview">{preview}</pre>}

      <h2 style={{ fontSize: 14 }}>修改历史</h2>
      <div className="set-list">
        {history.length === 0 && <div className="set-item faint">还没有修改</div>}
        {history.slice(0, 100).map((c: any) => (
          <div key={c.id} className="set-item" style={{ display: 'block' }}>
            <div className="row">
              <span className="faint" style={{ width: 120, fontSize: 12 }}>{new Date(c.time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span className={'tag' + (c.by === '我' ? '' : ' amber')}>{c.by}</span>
              <span className="grow click" onClick={() => setOpen(open === c.id ? null : c.id)}>
                {kind(c)}「{c.title}」{c.reverted && <span className="faint">（已撤销）</span>}
              </span>
              {!c.reverted && !c.undoOf && (
                <button
                  className="btn small"
                  onClick={() => confirm(`撤销这次对「${c.title}」的${kind(c)}？`) && run(() => api.call('profile:revert', c.id))}
                >
                  撤销
                </button>
              )}
            </div>
            {open === c.id && (
              <div className="profile-diff">
                <div>
                  <div className="faint">修改前</div>
                  <pre>{c.before ? c.before.body || '（空）' : '（没有这一节）'}</pre>
                </div>
                <div>
                  <div className="faint">修改后</div>
                  <pre>{c.after ? c.after.body || '（空）' : '（已删除）'}</pre>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
