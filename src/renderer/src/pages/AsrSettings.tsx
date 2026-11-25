import { useEffect, useState } from 'react'
import { api, errMsg, useApp } from '../lib'

/** 设置 → 语音识别：本机离线识别模型，按需安装、删除、选用 */
export default function AsrSettings() {
  const { setData, toast } = useApp()
  const [st, setSt] = useState<any>(null)
  const [prog, setProg] = useState<Record<string, any>>({})

  const load = () => api.call('asr:status').then(setSt).catch((e) => toast(errMsg(e)))
  useEffect(() => {
    load()
    return api.on('asr:progress', (p: any) => {
      // 下完或出错：去掉进度条，重新读一次状态
      if (p.error || p.finished) {
        setProg((x) => {
          const y = { ...x }
          delete y[p.id]
          return y
        })
        load()
      } else setProg((x) => ({ ...x, [p.id]: p }))
    })
  }, [])

  const apply = (r: any) => {
    setSt(r.status)
    setData({ settings: r.settings })
  }
  const install = async (m: any) => {
    setProg((x) => ({ ...x, [m.id]: { id: m.id, done: 0, total: m.size * 1048576 } }))
    try {
      apply(await api.call('asr:download', m.id))
      toast(`「${m.name}」已安装`)
    } catch (e) {
      const msg = errMsg(e)
      if (!/已取消/.test(msg)) toast(msg)
      load()
    } finally {
      setProg((x) => {
        const y = { ...x }
        delete y[m.id]
        return y
      })
    }
  }
  const remove = async (m: any) => {
    if (!confirm(`删除「${m.name}」的模型文件（约 ${m.size} MB）？\n以后要用可以重新下载。`)) return
    try {
      apply(await api.call('asr:remove', m.id))
    } catch (e) {
      toast(errMsg(e))
    }
  }
  const select = async (m: any) => {
    try {
      apply(await api.call('asr:select', m.id))
    } catch (e) {
      toast(errMsg(e))
    }
  }

  // 换位置：已下好的模型一起搬过去。不传 to 就弹窗选文件夹；传 '' 恢复默认
  const changeDir = async (to?: string) => {
    let dir = to
    if (dir === undefined) {
      const d = await api.call('dialog:pickFolder', '选择语音识别模型的存放文件夹')
      if (!d) return
      dir = d.replace(/[\\/]+$/, '') + (/[\\/]asr-models$/i.test(d) ? '' : '\\asr-models')
    }
    const target = dir || st.defaultDir
    if (!confirm(`把语音识别模型放到：\n${target}\n已下载的模型会一起搬过去。`)) return
    try {
      apply(await api.call('asr:setDir', dir))
      toast('已更改模型位置')
    } catch (e) {
      toast(errMsg(e))
    }
  }

  if (!st) return <div className="faint">读取中…</div>
  const row = (m: any) => {
    const p = prog[m.id] || m.progress
    const busy = !!p && !p.error && !p.finished
    const pct = p && p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0
    const on = st.selected === m.id
    return (
      <div key={m.id} className={'asr-row' + (on ? ' on' : '')}>
        <div className="asr-main">
          <div className="row" style={{ gap: 8 }}>
            <b>{m.name}</b>
            {on && <span className="tag good">✓ 使用中</span>}
            {m.recommended && !on && <span className="tag">推荐</span>}
            {!m.punct && m.kind === 'asr' && <span className="tag amber">无标点</span>}
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>
            {m.langs} · {m.desc}
          </div>
          {busy && (
            <div className="row" style={{ gap: 8, marginTop: 6 }}>
              <div className="pc-bar" style={{ maxWidth: 260 }}>
                <div style={{ width: pct + '%', background: 'var(--accent)' }} />
              </div>
              <span className="faint" style={{ fontSize: 12 }}>
                {pct}% · {(p.done / 1048576).toFixed(0)} / {(p.total / 1048576).toFixed(0)} MB
              </span>
            </div>
          )}
        </div>
        <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{m.size} MB</span>
        <div className="row" style={{ gap: 6, flex: 'none' }}>
          {busy ? (
            <button className="btn small" onClick={() => api.call('asr:cancel', m.id)}>取消</button>
          ) : m.installed ? (
            <>
              {m.kind === 'asr' && !on && <button className="btn small primary" onClick={() => select(m)}>选用</button>}
              {m.kind === 'punct' && <span className="faint" style={{ fontSize: 12 }}>已安装，自动用于无标点模型</span>}
              <button className="icon-btn" title="删除模型文件" onClick={() => remove(m)}>🗑</button>
            </>
          ) : (
            <button className="btn small" onClick={() => install(m)}>⤓ 安装</button>
          )}
        </div>
      </div>
    )
  }
  const asr = st.models.filter((m: any) => m.kind === 'asr')
  const extra = st.models.filter((m: any) => m.kind !== 'asr')
  return (
    <>
      <h2>语音识别</h2>
      <div className="desc">把备忘录里的录音转成文字。识别全部在本机完成，录音不会上传。模型不随安装包，用到哪个装哪个（第一次需要联网下载）。</div>
      <div className="asr-dir">
        <span className="faint" style={{ flex: 'none' }}>模型位置</span>
        <span className="asr-path" title={st.dir}>{st.dir}</span>
        {!st.custom && <span className="tag" style={{ flex: 'none' }}>默认：软件安装目录</span>}
        <button className="btn small" onClick={() => api.call('shell:openPath', st.dir).then((err: string) => err && toast('文件夹还不存在，装一个模型后就有了'))}>打开</button>
        <button className="btn small" onClick={() => changeDir()}>更改位置…</button>
        {st.custom && <button className="btn small" onClick={() => changeDir('')}>恢复默认</button>}
      </div>
      {!st.selected && <div className="tag amber" style={{ marginBottom: 10 }}>还没有可用的识别模型，装一个就能用（中文推荐 SenseVoice Small）</div>}
      <div className="asr-list">{asr.map(row)}</div>
      <h2 style={{ marginTop: 20 }}>附加模型</h2>
      <div className="asr-list">{extra.map(row)}</div>
    </>
  )
}
