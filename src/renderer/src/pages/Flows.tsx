import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errMsg, flushers, uid, useApp } from '../lib'
import { Empty, Tabs } from '../ui'
import RefPicker from './RefPicker'

// 工作流程：把公司的审批流程画成流程图，记下每一步找谁审批、要交哪些附件、多长时间、注意什么，
// 下次办事直接翻出来看，不用每次去问人。数据结构见 src/main/flow.ts。

type Person = { name: string; role: string; contactId?: string }
type Att = { name: string; required: boolean; note: string; ref?: Record<string, string> }
type FNode = { id: string; type: 'step' | 'group' | 'title'; x: number; y: number; w: number; h: number; label: string; color?: string; approvers: Person[]; attachments: Att[]; duration: string; note: string }
type FEdge = { id: string; from: string; to: string; label: string; approvers: Person[]; attachments: Att[]; note: string }
type Flow = { id: string; name: string; desc: string; nodes: FNode[]; edges: FEdge[]; createdAt?: string; updatedAt?: string }
type Sel = { kind: 'node' | 'edge'; id: string } | null

const GRID = 10
const snap = (v: number) => Math.round(v / GRID) * GRID
const now = () => new Date().toISOString()

const STEP_COLORS: [string, string][] = [
  ['', '白色'],
  ['blue', '蓝色（重点）'],
  ['green', '绿色'],
  ['amber', '黄色（注意）'],
  ['red', '红色（风险）'],
  ['purple', '紫色']
]
const TITLE_COLORS: [string, string][] = [
  ['teal', '深色标题'],
  ['light', '浅色标题']
]

const node = (p: Partial<FNode>): FNode => ({ id: uid(), type: 'step', x: 0, y: 0, w: 120, h: 44, label: '', approvers: [], attachments: [], duration: '', note: '', ...p })
const edge = (from: string, to: string, label = ''): FEdge => ({ id: uid(), from, to, label, approvers: [], attachments: [], note: '' })

/** 示例：采购管理（采购订单、财务、仓库三块），按公司实际改 */
function purchaseTemplate(): Flow {
  const n: Record<string, FNode> = {}
  const add = (k: string, p: Partial<FNode>) => (n[k] = node(p))
  add('t0', { type: 'title', x: 0, y: 0, w: 960, h: 44, label: '采购管理', color: 'teal' })
  add('t1', { type: 'title', x: 0, y: 56, w: 960, h: 36, label: '采购订单管理', color: 'light' })
  add('g1', { type: 'group', x: 0, y: 104, w: 960, h: 150, label: '' })
  add('cpxx', { x: 20, y: 120, w: 100, label: '产品信息' })
  add('cpjg', { x: 170, y: 120, w: 100, label: '产品价格表' })
  add('gys', { x: 20, y: 190, w: 100, label: '供应商', color: 'blue' })
  add('cgsq', { x: 170, y: 190, w: 100, label: '采购申请' })
  add('cgdd', { x: 340, y: 190, w: 100, label: '采购订单', color: 'blue' })
  add('rk', { x: 630, y: 190, w: 120, label: '采购入库/质检' })
  add('th', { x: 830, y: 190, w: 100, label: '采购退货' })
  add('g2', { type: 'group', x: 0, y: 266, w: 440, h: 150, label: '' })
  add('fk', { x: 20, y: 282, w: 100, label: '费控报销' })
  add('fp', { x: 170, y: 282, w: 100, label: '进项发票' })
  add('fkd', { x: 320, y: 282, w: 100, label: '付款单' })
  add('skd', { x: 20, y: 352, w: 100, label: '收款单' })
  add('cw', { x: 170, y: 352, w: 100, label: '财务/账户', color: 'blue' })
  add('t2', { type: 'title', x: 0, y: 428, w: 440, h: 36, label: '财务管理', color: 'light' })
  add('g3', { type: 'group', x: 456, y: 266, w: 504, h: 150, label: '' })
  add('ck', { x: 640, y: 282, w: 100, label: '仓库', color: 'blue' })
  add('qtck', { x: 470, y: 352, w: 100, label: '其他出库单' })
  add('qtrk', { x: 590, y: 352, w: 100, label: '其他入库单' })
  add('kcdb', { x: 710, y: 352, w: 100, label: '库存调拨' })
  add('kcpd', { x: 830, y: 352, w: 100, label: '库存盘点' })
  add('t3', { type: 'title', x: 456, y: 428, w: 504, h: 36, label: '仓库管理', color: 'light' })
  const e = (a: string, b: string, l = '') => edge(n[a].id, n[b].id, l)
  return {
    id: uid(),
    name: '采购管理（示例）',
    desc: '示例流程，按公司实际改：点每一步，在右边填审批人、所需附件、时限和注意事项。',
    nodes: Object.values(n),
    edges: [e('gys', 'cgsq'), e('cgsq', 'cgdd', '合并采购'), e('cgdd', 'rk'), e('rk', 'th'), e('rk', 'ck'), e('cgdd', 'fkd'), e('fp', 'cw'), e('skd', 'cw'), e('cw', 'fk'), e('cw', 'fkd'), e('ck', 'qtck'), e('ck', 'qtrk'), e('ck', 'kcdb'), e('ck', 'kcpd')],
    createdAt: now(),
    updatedAt: now()
  }
}

const blankFlow = (): Flow => ({ id: uid(), name: '新流程', desc: '', nodes: [node({ x: 40, y: 40, label: '提出申请' })], edges: [], createdAt: now(), updatedAt: now() })

// ---------- 和主进程 flow.ts 一样的规则：分组、步骤顺序 ----------

const inside = (n: FNode, g: FNode) => {
  const cx = n.x + n.w / 2
  const cy = n.y + n.h / 2
  return cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h
}
function groupOf(f: Flow, n: FNode) {
  const g = f.nodes.filter((x) => x.type === 'group' && inside(n, x)).sort((a, b) => a.w * a.h - b.w * b.h)[0]
  if (!g) return ''
  if (g.label.trim()) return g.label.trim()
  const bars = f.nodes.filter((b) => b.type === 'title' && Math.abs(b.x - g.x) < 30 && Math.abs(b.w - g.w) < 60)
  const d = (b: FNode) => Math.min(Math.abs(b.y - (g.y + g.h)), Math.abs(b.y + b.h - g.y))
  return bars.sort((a, b) => d(a) - d(b))[0]?.label || ''
}
function orderSteps(f: Flow) {
  const steps = f.nodes.filter((n) => n.type === 'step')
  const ids = new Set(steps.map((n) => n.id))
  const edges = f.edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  const indeg = new Map<string, number>(steps.map((n) => [n.id, 0]))
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) || 0) + 1)
  const pos = (a: FNode, b: FNode) => a.y - b.y || a.x - b.x
  const out: FNode[] = []
  const seen = new Set<string>()
  let ready = steps.filter((n) => !indeg.get(n.id)).sort(pos)
  while (out.length < steps.length) {
    if (!ready.length) ready = steps.filter((n) => !seen.has(n.id)).sort(pos).slice(0, 1)
    const n = ready.shift()!
    if (seen.has(n.id)) continue
    seen.add(n.id)
    out.push(n)
    for (const e of edges.filter((e) => e.from === n.id)) {
      indeg.set(e.to, (indeg.get(e.to) || 0) - 1)
      if (!indeg.get(e.to) && !seen.has(e.to)) ready.push(steps.find((s) => s.id === e.to)!)
    }
    ready.sort(pos)
  }
  return out
}

/** 连线走法：横向或竖向的折线，返回路径和标签位置 */
function route(a: FNode, b: FNode) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const vOver = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  const hOver = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const horiz = vOver > 10 ? true : hOver > 10 ? false : Math.abs(bc.x - ac.x) > Math.abs(bc.y - ac.y)
  if (horiz) {
    const right = bc.x >= ac.x
    const y1 = vOver > 10 ? (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2 : ac.y
    const y2 = vOver > 10 ? y1 : bc.y
    const x1 = right ? a.x + a.w : a.x
    const x2 = right ? b.x : b.x + b.w
    const mx = (x1 + x2) / 2
    return { d: `M${x1},${y1} H${mx} V${y2} H${x2}`, lx: mx, ly: y1 === y2 ? y1 - 11 : (y1 + y2) / 2 }
  }
  const down = bc.y >= ac.y
  const x1 = hOver > 10 ? (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2 : ac.x
  const x2 = hOver > 10 ? x1 : bc.x
  const y1 = down ? a.y + a.h : a.y
  const y2 = down ? b.y : b.y + b.h
  const my = (y1 + y2) / 2
  return { d: `M${x1},${y1} V${my} H${x2} V${y2}`, lx: x1 === x2 ? x1 + 4 : (x1 + x2) / 2, ly: my }
}

const who = (ps: Person[]) => (ps || []).map((p) => p.name + (p.role ? `（${p.role}）` : '')).filter(Boolean)

// ================= 页面 =================

export default function Flows({ focusId }: { focusId?: string }) {
  const { data, saveItem, deleteItem } = useApp()
  const flows = useMemo(() => [...(data.flows || [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))), [data.flows])
  const [cur, setCur] = useState<string | null>(focusId || null)
  const [q, setQ] = useState('')
  useEffect(() => {
    if (!cur && flows.length) setCur(flows[0].id)
  }, [flows.length])
  const flow = flows.find((f) => f.id === cur) || null

  const create = async (f: Flow) => {
    const saved = await saveItem('flows', f)
    setCur(saved.id)
  }
  const lq = q.trim().toLowerCase()
  const text = (f: Flow) => [f.name, f.desc, ...f.nodes.flatMap((n) => [n.label, n.note, ...who(n.approvers), ...(n.attachments || []).map((a) => a.name)]), ...f.edges.flatMap((e) => [e.label, ...who(e.approvers), ...(e.attachments || []).map((a) => a.name)])].join(' ').toLowerCase()
  const list = flows.filter((f) => !lq || text(f).includes(lq))

  return (
    <div className="flow-wrap">
      <div className="flow-side">
        <div className="row" style={{ gap: 6 }}>
          <b style={{ fontSize: 16 }}>工作流程</b>
          <span className="faint" style={{ fontSize: 12 }}>{flows.length || ''}</span>
          <span className="spacer" />
          <button className="btn small primary" onClick={() => create(blankFlow())}>＋ 新建</button>
        </div>
        <input className="input" placeholder="搜流程、步骤、审批人、附件…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flow-list">
          {list.map((f) => {
            const steps = f.nodes.filter((n) => n.type === 'step').length
            const people = new Set(f.nodes.flatMap((n) => who(n.approvers)).concat(f.edges.flatMap((e) => who(e.approvers)))).size
            return (
              <div key={f.id} className={'flow-item' + (f.id === cur ? ' on' : '')} onClick={() => setCur(f.id)}>
                <div className="flow-item-t">{f.name || '未命名流程'}</div>
                <div className="flow-item-s">
                  {steps} 步{people ? ` · ${people} 位审批人` : ''}
                  {f.desc ? ' · ' + f.desc : ''}
                </div>
              </div>
            )
          })}
          {!list.length && <div className="faint" style={{ fontSize: 12, padding: 10 }}>{q ? '没有找到' : '还没有流程'}</div>}
        </div>
        <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => create(purchaseTemplate())} title="照着「采购管理」流程图建一份，可以在上面改">
          ＋ 用「采购管理」示例新建
        </button>
      </div>
      <div className="flow-main">
        {flow ? (
          <FlowEditor key={flow.id} flow={flow} onDelete={async () => confirm(`删除流程「${flow.name}」？`) && (await deleteItem('flows', flow.id), setCur(null))} />
        ) : (
          <Empty title="把公司的审批流程记下来" text="每一步找谁审批、要交哪些附件、多长时间、要注意什么，都记在流程图上。下次办事直接翻出来看，不用每次去问人。">
            <div className="row">
              <button className="btn primary" onClick={() => create(blankFlow())}>＋ 新建流程</button>
              <button className="btn" onClick={() => create(purchaseTemplate())}>用「采购管理」示例</button>
            </div>
          </Empty>
        )}
      </div>
    </div>
  )
}

// ================= 编辑器 =================

function FlowEditor({ flow, onDelete }: { flow: Flow; onDelete: () => void }) {
  const { saveItem, toast } = useApp()
  const [f, setF] = useState<Flow>(() => normalize(flow))
  const [sel, setSel] = useState<Sel>(null)
  const [tab, setTab] = useState<'chart' | 'list'>(() => (localStorage.getItem('flowTab') as any) || 'chart')
  const hist = useRef<Flow[]>([])
  const fRef = useRef(f)
  fRef.current = f
  const saveTimer = useRef<any>(null)
  const pendingRef = useRef<Flow | null>(null)
  const lastSaved = useRef(flow.updatedAt)

  // 保存：改完停 0.5 秒再存
  const saveNow = async () => {
    if (!saveTimer.current) return
    clearTimeout(saveTimer.current)
    saveTimer.current = null
    const x = { ...(pendingRef.current || fRef.current), updatedAt: now() }
    pendingRef.current = null
    lastSaved.current = x.updatedAt
    try {
      await saveItem('flows', x)
    } catch {}
  }
  const persist = (next: Flow) => {
    pendingRef.current = next
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(saveNow, 500)
  }
  useEffect(() => {
    // 关窗口前、离开时把没存的存掉
    flushers.add(saveNow)
    return () => {
      flushers.delete(saveNow)
      void saveNow()
    }
  }, [])
  // 别处改了（如项目文件改名后引用路径更新），没在编辑时就同步过来
  useEffect(() => {
    if (flow.updatedAt !== lastSaved.current && !saveTimer.current) setF(normalize(flow))
  }, [flow.updatedAt])

  const snapshot = () => {
    hist.current.push(structuredClone(fRef.current))
    if (hist.current.length > 80) hist.current.shift()
  }
  const update = (fn: (d: Flow) => void, commit = true) => {
    if (commit) snapshot()
    const d = structuredClone(fRef.current)
    fn(d)
    fRef.current = d
    setF(d)
    persist(d)
  }
  const undo = () => {
    const prev = hist.current.pop()
    if (!prev) return toast('没有可以撤销的了')
    fRef.current = prev
    setF(prev)
    persist(prev)
  }

  const selNode = sel?.kind === 'node' ? f.nodes.find((n) => n.id === sel.id) : undefined
  const selEdge = sel?.kind === 'edge' ? f.edges.find((e) => e.id === sel.id) : undefined
  const removeSel = () => {
    if (!sel) return
    update((d) => {
      if (sel.kind === 'node') {
        d.nodes = d.nodes.filter((n) => n.id !== sel.id)
        d.edges = d.edges.filter((e) => e.from !== sel.id && e.to !== sel.id)
      } else d.edges = d.edges.filter((e) => e.id !== sel.id)
    })
    setSel(null)
  }

  return (
    <div className="flow-editor">
      <div className="flow-head">
        <input className="flow-name" value={f.name} placeholder="流程名称，如：采购付款审批" onFocus={snapshot} onChange={(e) => update((d) => void (d.name = e.target.value), false)} />
        <Tabs
          value={tab}
          onChange={(v: any) => (setTab(v), localStorage.setItem('flowTab', v))}
          options={[
            { id: 'chart', label: '流程图' },
            { id: 'list', label: '步骤清单' }
          ]}
        />
        <button className="btn small danger" onClick={onDelete}>删除流程</button>
      </div>
      {tab === 'chart' ? (
        <div className="flow-body">
          <Canvas f={f} sel={sel} setSel={setSel} update={update} snapshot={snapshot} undo={undo} removeSel={removeSel} />
          <div className="flow-panel">
            {selNode ? (
              <NodePanel key={selNode.id} n={selNode} f={f} update={update} snapshot={snapshot} onRemove={removeSel} />
            ) : selEdge ? (
              <EdgePanel key={selEdge.id} e={selEdge} f={f} update={update} snapshot={snapshot} onRemove={removeSel} />
            ) : (
              <FlowInfo f={f} update={update} snapshot={snapshot} />
            )}
          </div>
        </div>
      ) : (
        <StepList f={f} onPick={(id) => (setSel({ kind: 'node', id }), setTab('chart'))} />
      )}
    </div>
  )
}

const normalize = (f: any): Flow => ({
  ...f,
  name: f.name || '',
  desc: f.desc || '',
  nodes: (f.nodes || []).map((n: any) => ({ approvers: [], attachments: [], duration: '', note: '', label: '', type: 'step', ...n })),
  edges: (f.edges || []).map((e: any) => ({ approvers: [], attachments: [], note: '', label: '', ...e }))
})

// ---------- 画布 ----------

function Canvas({ f, sel, setSel, update, snapshot, undo, removeSel }: any) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 40, y: 40, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const [link, setLink] = useState<{ from: string; x: number; y: number } | null>(null)
  const [panning, setPanning] = useState(false)

  const toContent = (cx: number, cy: number) => {
    const r = wrapRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k }
  }
  const fit = () => {
    const el = wrapRef.current
    if (!el || !f.nodes.length) return
    const x0 = Math.min(...f.nodes.map((n: FNode) => n.x))
    const y0 = Math.min(...f.nodes.map((n: FNode) => n.y))
    const x1 = Math.max(...f.nodes.map((n: FNode) => n.x + n.w))
    const y1 = Math.max(...f.nodes.map((n: FNode) => n.y + n.h))
    const k = Math.min(1.4, Math.max(0.25, Math.min((el.clientWidth - 80) / (x1 - x0 || 1), (el.clientHeight - 100) / (y1 - y0 || 1))))
    setView({ k, x: (el.clientWidth - (x1 - x0) * k) / 2 - x0 * k, y: 60 + (el.clientHeight - 100 - (y1 - y0) * k) / 2 - y0 * k })
  }
  useEffect(() => {
    fit()
  }, [])

  // 滚轮直接缩放（以鼠标位置为中心）；Shift+滚轮上下移动；触控板横向滑动左右移动（需要非 passive 监听才能阻止默认滚动）
  useEffect(() => {
    const el = wrapRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.shiftKey) return setView((v) => ({ ...v, y: v.y - (e.deltaY || e.deltaX) }))
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return setView((v) => ({ ...v, x: v.x - e.deltaX }))
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      // 按滚动量缩放：鼠标滚一格约 12%，触控板捏合更细腻
      const f = Math.exp(-Math.max(-60, Math.min(60, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY)) * 0.0019)
      setView((v) => {
        const k = Math.min(2.5, Math.max(0.2, v.k * f))
        return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  const zoom = (m: number) => {
    const el = wrapRef.current!
    const mx = el.clientWidth / 2
    const my = el.clientHeight / 2
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.2, v.k * m))
      return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) }
    })
  }

  const drag = (e: React.PointerEvent, onMove: (dx: number, dy: number, ev: PointerEvent) => void, onUp?: (moved: boolean, ev: PointerEvent) => void) => {
    const sx = e.clientX
    const sy = e.clientY
    let moved = false
    let done = false
    const move = (ev: PointerEvent) => {
      // 鼠标键已经松开（松开事件没收到，比如在窗口外松手）：立刻结束，免得节点一直跟着鼠标跑
      if (ev.buttons === 0) return up(ev)
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true
      if (moved) onMove((ev.clientX - sx) / viewRef.current.k, (ev.clientY - sy) / viewRef.current.k, ev)
    }
    const up = (ev: PointerEvent) => {
      if (done) return
      done = true
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', blur)
      onUp?.(moved, ev)
    }
    const blur = () => up(new PointerEvent('pointerup'))
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', blur)
  }

  const onBgDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.fnode, .fedge-label, .flow-tools, .fedge-hit')) return
    const start = viewRef.current
    setPanning(true)
    drag(
      e,
      (dx, dy) => setView({ ...start, x: start.x + dx * start.k, y: start.y + dy * start.k }),
      (moved) => {
        setPanning(false)
        if (!moved) setSel(null)
      }
    )
  }

  const onNodeDown = (e: React.PointerEvent, n: FNode) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setSel({ kind: 'node', id: n.id })
    // 拖分组框时，框里的东西一起走
    const members = n.type === 'group' ? f.nodes.filter((m: FNode) => m.id !== n.id && m.type !== 'group' && inside(m, n)).map((m: FNode) => m.id) : []
    const ids = [n.id, ...members]
    const start = new Map<string, { x: number; y: number }>(f.nodes.filter((m: FNode) => ids.includes(m.id)).map((m: FNode) => [m.id, { x: m.x, y: m.y }]))
    let first = true
    drag(
      e,
      (dx, dy) => {
        if (first) snapshot()
        first = false
        update((d: Flow) => {
          for (const m of d.nodes) {
            const s = start.get(m.id)
            if (s) (m.x = snap(s.x + dx)), (m.y = snap(s.y + dy))
          }
        }, false)
      }
    )
  }
  const onResizeDown = (e: React.PointerEvent, n: FNode) => {
    e.stopPropagation()
    const s = { w: n.w, h: n.h }
    snapshot()
    drag(e, (dx, dy) =>
      update((d: Flow) => {
        const m = d.nodes.find((x) => x.id === n.id)!
        m.w = Math.max(60, snap(s.w + dx))
        m.h = Math.max(30, snap(s.h + dy))
      }, false)
    )
  }
  // 从节点右边的小圆点拖出一条线，松开在另一个节点上就连上
  const onLinkDown = (e: React.PointerEvent, n: FNode) => {
    e.stopPropagation()
    const p = toContent(e.clientX, e.clientY)
    setLink({ from: n.id, ...p })
    drag(
      e,
      (_dx, _dy, ev) => setLink({ from: n.id, ...toContent(ev.clientX, ev.clientY) }),
      (_moved, ev) => {
        setLink(null)
        const q = toContent(ev.clientX, ev.clientY)
        const hit = [...f.nodes].reverse().find((m: FNode) => m.id !== n.id && m.type !== 'group' && q.x >= m.x && q.x <= m.x + m.w && q.y >= m.y && q.y <= m.y + m.h)
        if (!hit) return
        if (f.edges.some((x: FEdge) => x.from === n.id && x.to === hit.id)) return
        const ne = edge(n.id, hit.id)
        update((d: Flow) => void d.edges.push(ne))
        setSel({ kind: 'edge', id: ne.id })
      }
    )
  }

  const addNode = (type: FNode['type'], at?: { x: number; y: number }) => {
    const el = wrapRef.current!
    const c = at || toContent(el.getBoundingClientRect().left + el.clientWidth / 2, el.getBoundingClientRect().top + el.clientHeight / 2)
    const p = type === 'group' ? { w: 360, h: 160, label: '' } : type === 'title' ? { w: 360, h: 36, label: '标题', color: 'light' } : { w: 120, h: 44, label: '新步骤' }
    const n = node({ type, ...p, x: snap(c.x - p.w / 2), y: snap(c.y - p.h / 2) })
    update((d: Flow) => void (type === 'group' ? d.nodes.unshift(n) : d.nodes.push(n)))
    setSel({ kind: 'node', id: n.id })
  }

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return
    if (e.key === 'Delete' || e.key === 'Backspace') removeSel()
    else if (e.ctrlKey && e.key.toLowerCase() === 'z') (e.preventDefault(), undo())
    else if (e.ctrlKey && e.key.toLowerCase() === 'd' && sel?.kind === 'node') {
      e.preventDefault()
      const src = f.nodes.find((n: FNode) => n.id === sel.id)
      if (!src) return
      const n = { ...structuredClone(src), id: uid(), x: src.x + 20, y: src.y + src.h + 20 }
      update((d: Flow) => void d.nodes.push(n))
      setSel({ kind: 'node', id: n.id })
    }
  }

  const byId = (id: string) => f.nodes.find((n: FNode) => n.id === id)
  const order = [...f.nodes.filter((n: FNode) => n.type === 'group'), ...f.nodes.filter((n: FNode) => n.type !== 'group')]

  return (
    <div
      ref={wrapRef}
      className={'flow-canvas' + (panning ? ' panning' : '')}
      tabIndex={0}
      style={{ backgroundSize: `${20 * view.k}px ${20 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onPointerDown={onBgDown}
      onKeyDown={onKey}
      onDoubleClick={(e) => !(e.target as HTMLElement).closest('.fnode, .fedge-label, .flow-tools') && addNode('step', toContent(e.clientX, e.clientY))}
    >
      <div className="flow-inner" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        {order.filter((n: FNode) => n.type === 'group').map((n: FNode) => (
          <NodeBox key={n.id} n={n} sel={sel?.id === n.id} onDown={onNodeDown} onResize={onResizeDown} onLink={onLinkDown} />
        ))}
        <svg className="flow-edges" width="1" height="1">
          <defs>
            <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#14a89a" />
            </marker>
            <marker id="flow-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
            </marker>
          </defs>
          {f.edges.map((e: FEdge) => {
            const a = byId(e.from)
            const b = byId(e.to)
            if (!a || !b) return null
            const r = route(a, b)
            const on = sel?.id === e.id
            return (
              <g key={e.id}>
                <path className="fedge-hit" d={r.d} onPointerDown={(ev) => (ev.stopPropagation(), setSel({ kind: 'edge', id: e.id }))} />
                <path d={r.d} fill="none" stroke={on ? 'var(--accent)' : '#14a89a'} strokeWidth={on ? 2.2 : 1.4} markerEnd={`url(#${on ? 'flow-arrow-on' : 'flow-arrow'})`} pointerEvents="none" />
              </g>
            )
          })}
          {link && byId(link.from) && (() => {
            const a = byId(link.from)!
            return <path d={`M${a.x + a.w},${a.y + a.h / 2} L${link.x},${link.y}`} stroke="var(--accent)" strokeWidth={1.6} strokeDasharray="5 4" fill="none" markerEnd="url(#flow-arrow-on)" />
          })()}
        </svg>
        {f.edges.map((e: FEdge) => {
          const a = byId(e.from)
          const b = byId(e.to)
          if (!a || !b) return null
          const extra = (e.approvers?.length || 0) + (e.attachments?.length || 0)
          if (!e.label && !extra) return null
          const r = route(a, b)
          return (
            <div key={e.id} className={'fedge-label' + (sel?.id === e.id ? ' on' : '')} style={{ left: r.lx, top: r.ly }} onPointerDown={(ev) => (ev.stopPropagation(), setSel({ kind: 'edge', id: e.id }))}>
              {e.label}
              {e.approvers?.length ? <span className="fb">👤{e.approvers.length}</span> : null}
              {e.attachments?.length ? <span className="fb">📎{e.attachments.length}</span> : null}
            </div>
          )
        })}
        {order.filter((n: FNode) => n.type !== 'group').map((n: FNode) => (
          <NodeBox key={n.id} n={n} sel={sel?.id === n.id} onDown={onNodeDown} onResize={onResizeDown} onLink={onLinkDown} />
        ))}
      </div>

      <div className="flow-tools" onPointerDown={(e) => e.stopPropagation()}>
        <button onClick={() => addNode('step')} title="加一个步骤（也可以双击空白处）">＋ 步骤</button>
        <button onClick={() => addNode('group')} title="虚线框，把一组步骤圈起来">＋ 分组框</button>
        <button onClick={() => addNode('title')} title="横条标题，如「财务管理」">＋ 标题栏</button>
        <span className="sep" />
        <button onClick={undo} title="撤销 Ctrl+Z">↶ 撤销</button>
        <span className="sep" />
        <button onClick={() => zoom(1 / 1.2)} title="缩小">−</button>
        <button className="pct" onClick={() => setView((v) => ({ ...v, k: 1 }))} title="100%">{Math.round(view.k * 100)}%</button>
        <button onClick={() => zoom(1.2)} title="放大">＋</button>
        <button onClick={fit} title="适应窗口">⛶</button>
      </div>
      <div className="flow-help">双击空白处加步骤 · 拖节点右边的小圆点连到下一步 · 点步骤或连线，在右边填审批人和附件 · Delete 删除 · Ctrl+Z 撤销 · Ctrl+D 复制</div>
    </div>
  )
}

function NodeBox({ n, sel, onDown, onResize, onLink }: { n: FNode; sel: boolean; onDown: any; onResize: any; onLink: any }) {
  const people = who(n.approvers)
  const atts = n.attachments || []
  const req = atts.filter((a) => a.required).length
  const badges = n.type === 'step' && (people.length || atts.length || n.duration)
  return (
    <div
      className={`fnode fnode-${n.type}${n.color ? ' c-' + n.color : ''}${sel ? ' sel' : ''}`}
      style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
      onPointerDown={(e) => onDown(e, n)}
      title={n.type === 'step' ? [n.label, people.length ? '审批：' + people.join('、') : '', atts.length ? '附件：' + atts.map((a) => a.name + (a.required ? '（必交）' : '')).join('、') : '', n.duration ? '时限：' + n.duration : '', n.note].filter(Boolean).join('\n') : n.label}
    >
      {n.type === 'group' ? <span className="fnode-glabel">{n.label}</span> : <span className="fnode-label">{n.label || (n.type === 'step' ? '（未命名）' : '')}</span>}
      {badges ? (
        <div className="fnode-badges">
          {people.length ? <span>👤 {people.length > 2 ? `${people.slice(0, 2).join('、')} 等${people.length}人` : people.join('、')}</span> : null}
          {atts.length ? <span>📎 {atts.length}{req ? `（必交${req}）` : ''}</span> : null}
          {n.duration ? <span>⏱ {n.duration}</span> : null}
        </div>
      ) : null}
      {sel && <span className="fnode-resize" onPointerDown={(e) => onResize(e, n)} title="拖动改大小" />}
      {n.type !== 'group' && <span className="fnode-link" onPointerDown={(e) => onLink(e, n)} title="拖到下一步，连一条线" />}
    </div>
  )
}

// ---------- 右侧面板 ----------

function FlowInfo({ f, update, snapshot }: any) {
  const steps = f.nodes.filter((n: FNode) => n.type === 'step')
  const noWho = steps.filter((n: FNode) => !n.approvers?.length).length
  return (
    <>
      <div className="fp-title">流程说明</div>
      <textarea className="input" rows={4} value={f.desc} placeholder="这个流程什么时候走、在哪个系统里提（如 OA → 采购 → 付款申请）、整体要多久……" onFocus={snapshot} onChange={(e) => update((d: Flow) => void (d.desc = e.target.value), false)} />
      <div className="faint" style={{ fontSize: 12, lineHeight: 1.8, marginTop: 10 }}>
        共 {steps.length} 个步骤、{f.edges.length} 条连线
        {noWho ? `，其中 ${noWho} 步还没填审批人` : ''}。
      </div>
      <div className="fp-tip">
        <b>怎么画</b>
        <div>· 双击空白处加一个步骤，或用上面的「＋ 步骤」</div>
        <div>· 把鼠标放到步骤上，拖它右边的小圆点到下一步，就连上了</div>
        <div>· 用「分组框」圈出一块（如财务、仓库），拖分组框时里面的步骤一起移动</div>
        <div>· 点一个步骤：填找谁审批、要交哪些附件（可以引用资料库里的模板）、时限和注意事项</div>
        <div>· 点一条连线：可以写条件（如「金额 &gt; 5 万」），也能加这一段的审批人和附件</div>
        <div>· 上面切到「步骤清单」，按顺序看每一步找谁、交什么，也能复制成文字发给别人</div>
      </div>
    </>
  )
}

function NodePanel({ n, f, update, snapshot, onRemove }: any) {
  const set = (patch: Partial<FNode>, commit = false) => update((d: Flow) => Object.assign(d.nodes.find((x) => x.id === n.id)!, patch), commit)
  const label = n.type === 'step' ? '步骤名称' : n.type === 'group' ? '分组名称（可不填）' : '标题文字'
  const colors = n.type === 'title' ? TITLE_COLORS : n.type === 'step' ? STEP_COLORS : []
  const group = n.type === 'step' ? groupOf(f, n) : ''
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="fp-title" style={{ margin: 0 }}>{n.type === 'step' ? '步骤' : n.type === 'group' ? '分组框' : '标题栏'}</span>
        {group && <span className="tag">{group}</span>}
        <span className="spacer" />
        <button className="btn small danger" onClick={onRemove}>删除</button>
      </div>
      <div className="field">
        <label>{label}</label>
        <input autoFocus={!n.label || n.label === '新步骤'} className="input" value={n.label} onFocus={snapshot} onChange={(e) => set({ label: e.target.value })} />
      </div>
      {colors.length > 0 && (
        <div className="field">
          <label>颜色</label>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {colors.map(([c, name]) => (
              <button key={c || 'none'} className={`fp-swatch c-${c || 'none'}${(n.color || '') === c ? ' on' : ''}`} title={name} onClick={() => set({ color: c }, true)} />
            ))}
          </div>
        </div>
      )}
      {n.type === 'step' && (
        <>
          <People list={n.approvers} onFocus={snapshot} onChange={(approvers: Person[], commit?: boolean) => set({ approvers }, commit)} />
          <Attachments list={n.attachments} onFocus={snapshot} onChange={(attachments: Att[], commit?: boolean) => set({ attachments }, commit)} />
          <div className="field">
            <label>时限</label>
            <input className="input" value={n.duration} placeholder="如：2 个工作日；每周二统一审" onFocus={snapshot} onChange={(e) => set({ duration: e.target.value })} />
          </div>
          <div className="field">
            <label>怎么办 / 注意事项</label>
            <textarea className="input" rows={4} value={n.note} placeholder="在哪个系统提交、找谁签字、常被退回的原因……" onFocus={snapshot} onChange={(e) => set({ note: e.target.value })} />
          </div>
        </>
      )}
    </>
  )
}

function EdgePanel({ e, f, update, snapshot, onRemove }: any) {
  const set = (patch: Partial<FEdge>, commit = false) => update((d: Flow) => Object.assign(d.edges.find((x) => x.id === e.id)!, patch), commit)
  const name = (id: string) => f.nodes.find((n: FNode) => n.id === id)?.label || '?'
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="fp-title" style={{ margin: 0 }}>连线</span>
        <span className="spacer" />
        <button className="btn small" title="把箭头方向反过来" onClick={() => update((d: Flow) => { const x = d.edges.find((y) => y.id === e.id)!; [x.from, x.to] = [x.to, x.from] })}>⇄ 反向</button>
        <button className="btn small danger" onClick={onRemove}>删除</button>
      </div>
      <div className="faint" style={{ fontSize: 12.5, marginBottom: 8 }}>
        {name(e.from)} → {name(e.to)}
      </div>
      <div className="field">
        <label>条件 / 说明（显示在线上）</label>
        <input autoFocus className="input" value={e.label} placeholder="如：金额 > 5 万；合并采购；退回修改" onFocus={snapshot} onChange={(ev) => set({ label: ev.target.value })} />
      </div>
      <People list={e.approvers} title="这一段的审批人" onFocus={snapshot} onChange={(approvers: Person[], commit?: boolean) => set({ approvers }, commit)} />
      <Attachments list={e.attachments} title="这一段要交的附件" onFocus={snapshot} onChange={(attachments: Att[], commit?: boolean) => set({ attachments }, commit)} />
      <div className="field">
        <label>备注</label>
        <textarea className="input" rows={3} value={e.note} onFocus={snapshot} onChange={(ev) => set({ note: ev.target.value })} />
      </div>
    </>
  )
}

/** 审批人：可以直接写名字 / 岗位，也可以从通讯录里选（选了能看到单位和电话） */
function People({ list, onChange, onFocus, title = '审批人' }: { list: Person[]; onChange: (l: Person[], commit?: boolean) => void; onFocus: () => void; title?: string }) {
  const { data, go } = useApp()
  const names = useMemo(() => [...new Set([...data.contacts.map((c) => c.name), ...(data.settings.members || []).map((m: any) => m.name)])].filter(Boolean), [data.contacts, data.settings.members])
  const setAt = (i: number, patch: Partial<Person>) => onChange(list.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <div className="field">
      <label>{title}</label>
      <datalist id="flow-people">
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {list.map((p, i) => {
        const c = p.contactId ? data.contacts.find((x) => x.id === p.contactId) : null
        return (
          <div key={i} className="fp-row">
            <div className="row" style={{ gap: 4 }}>
              <input
                className="input"
                list="flow-people"
                style={{ flex: 1 }}
                value={p.name}
                placeholder="姓名，或写岗位如「部门经理」"
                onFocus={onFocus}
                onChange={(e) => {
                  const hit = data.contacts.find((x) => x.name === e.target.value)
                  setAt(i, { name: e.target.value, contactId: hit?.id })
                }}
              />
              <input className="input" style={{ width: 96 }} value={p.role} placeholder="岗位/角色" onFocus={onFocus} onChange={(e) => setAt(i, { role: e.target.value })} />
              <button className="icon-btn" title="移除" onClick={() => onChange(list.filter((_, j) => j !== i), true)}>×</button>
            </div>
            {c && (
              <div className="fp-contact click" onClick={() => go({ page: 'contacts', contactId: c.id })} title="打开通讯录">
                {[c.org, c.title, c.phone].filter(Boolean).join(' · ') || '通讯录里的人'}
              </div>
            )}
          </div>
        )
      })}
      <button className="btn small" onClick={() => onChange([...list, { name: '', role: '' }], true)}>＋ 添加审批人</button>
    </div>
  )
}

const openRef = (r: Record<string, string>, toast: (s: string) => void) =>
  api.call('memo:openRef', { kind: r['data-ref'], id: r['data-id'], pid: r['data-pid'], rel: r['data-rel'], src: r['data-src'], name: r['data-name'] }).catch((e: any) => toast(errMsg(e)))

/** 所需附件：名称、是否必交、模板（引用资料库或项目里的文件，点一下就能打开） */
function Attachments({ list, onChange, onFocus, title = '所需附件' }: { list: Att[]; onChange: (l: Att[], commit?: boolean) => void; onFocus: () => void; title?: string }) {
  const { toast } = useApp()
  const [pickFor, setPickFor] = useState<number | null>(null)
  const setAt = (i: number, patch: Partial<Att>, commit = false) => onChange(list.map((a, j) => (j === i ? { ...a, ...patch } : a)), commit)
  return (
    <div className="field">
      <label>{title}</label>
      {list.map((a, i) => (
        <div key={i} className="fp-row">
          <div className="row" style={{ gap: 4 }}>
            <input className="input" style={{ flex: 1 }} value={a.name} placeholder="如：合同扫描件、发票、入库单" onFocus={onFocus} onChange={(e) => setAt(i, { name: e.target.value })} />
            <label className="fp-check" title="必须交">
              <input type="checkbox" checked={a.required} onChange={(e) => setAt(i, { required: e.target.checked }, true)} />
              必交
            </label>
            <button className="icon-btn" title="移除" onClick={() => onChange(list.filter((_, j) => j !== i), true)}>×</button>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            {a.ref ? (
              <>
                <span className="fp-ref click" title="打开模板" onClick={() => openRef(a.ref!, toast)}>
                  {a.ref['data-ref'] === 'lib' ? '📚' : '📁'} {a.ref['data-name']}
                </span>
                <button className="icon-btn" title="取消引用" onClick={() => setAt(i, { ref: undefined }, true)}>×</button>
              </>
            ) : (
              <button className="btn small" onClick={() => setPickFor(i)} title="引用资料库或项目里的模板 / 样表">🔗 引用模板</button>
            )}
            <input className="input" style={{ flex: 1, fontSize: 12 }} value={a.note} placeholder="说明，如：盖公章、原件" onFocus={onFocus} onChange={(e) => setAt(i, { note: e.target.value })} />
          </div>
        </div>
      ))}
      <button className="btn small" onClick={() => onChange([...list, { name: '', required: true, note: '' }], true)}>＋ 添加附件</button>
      {pickFor !== null && (
        <RefPicker
          onClose={() => setPickFor(null)}
          onPick={(refs) => {
            const r = refs[0]
            if (r) setAt(pickFor, { ref: r, name: list[pickFor].name || (r['data-name'] || '').replace(/\.[^.]+$/, '') }, true)
            setPickFor(null)
          }}
        />
      )}
    </div>
  )
}

// ---------- 步骤清单 ----------

function StepList({ f, onPick }: { f: Flow; onPick: (id: string) => void }) {
  const { data, toast } = useApp()
  const steps = useMemo(() => orderSteps(f), [f])
  const name = (id: string) => f.nodes.find((n) => n.id === id)?.label || '?'
  const contact = (p: Person) => (p.contactId ? data.contacts.find((c) => c.id === p.contactId) : null)
  const personText = (p: Person) => {
    const c = contact(p)
    return p.name + (p.role ? `（${p.role}）` : '') + (c?.phone ? ` ${c.phone}` : '')
  }
  const attText = (a: Att) => a.name + (a.required ? '（必交）' : '（如有）') + (a.note ? `，${a.note}` : '') + (a.ref ? `，模板：${a.ref['data-name']}` : '')

  const copy = () => {
    const lines = [`【${f.name}】`, f.desc, '']
    steps.forEach((n, i) => {
      const g = groupOf(f, n)
      lines.push(`${i + 1}. ${n.label}${g ? `（${g}）` : ''}`)
      if (n.approvers.length) lines.push(`   审批：${n.approvers.map(personText).join('；')}`)
      if (n.attachments.length) lines.push(`   附件：${n.attachments.map(attText).join('；')}`)
      if (n.duration) lines.push(`   时限：${n.duration}`)
      if (n.note) lines.push(`   注意：${n.note.replace(/\n/g, ' ')}`)
      for (const e of f.edges.filter((e) => e.from === n.id)) {
        const extra = [e.label && `条件：${e.label}`, e.approvers.length && `审批：${e.approvers.map(personText).join('；')}`, e.attachments.length && `附件：${e.attachments.map(attText).join('；')}`].filter(Boolean).join('，')
        lines.push(`   → ${name(e.to)}${extra ? `（${extra}）` : ''}`)
      }
    })
    api.call('clipboard:text', lines.filter((l, i) => l || i < 3).join('\n')).then(() => toast('已复制，可以直接粘贴到微信 / 邮件'))
  }

  if (!steps.length) return <Empty title="还没有步骤" text="切回「流程图」，双击空白处加步骤。" />
  return (
    <div className="flow-list-view">
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="faint">按连线先后排列，共 {steps.length} 步。点步骤名回到流程图编辑。</span>
        <span className="spacer" />
        <button className="btn small" onClick={copy}>复制为文字</button>
      </div>
      {f.desc && <div className="flow-desc">{f.desc}</div>}
      {steps.map((n, i) => {
        const outs = f.edges.filter((e) => e.from === n.id)
        const g = groupOf(f, n)
        return (
          <div key={n.id} className="flow-step">
            <div className="flow-step-no">{i + 1}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <b className="click" onClick={() => onPick(n.id)}>{n.label || '（未命名）'}</b>
                {g && <span className="tag">{g}</span>}
                {n.duration && <span className="tag amber">⏱ {n.duration}</span>}
              </div>
              {n.approvers.length > 0 && (
                <div className="flow-step-line">
                  <span className="k">审批</span>
                  <span>{n.approvers.map(personText).join('；')}</span>
                </div>
              )}
              {n.attachments.length > 0 && (
                <div className="flow-step-line">
                  <span className="k">附件</span>
                  <span>
                    {n.attachments.map((a, j) => (
                      <span key={j} className="flow-att">
                        {a.required ? <b>{a.name}</b> : a.name}
                        <span className="faint">{a.required ? '（必交）' : '（如有）'}</span>
                        {a.note && <span className="faint">{a.note}</span>}
                        {a.ref && (
                          <span className="fp-ref click" onClick={() => openRef(a.ref!, toast)}>
                            {a.ref['data-ref'] === 'lib' ? '📚' : '📁'} {a.ref['data-name']}
                          </span>
                        )}
                      </span>
                    ))}
                  </span>
                </div>
              )}
              {n.note && (
                <div className="flow-step-line">
                  <span className="k">注意</span>
                  <span style={{ whiteSpace: 'pre-wrap' }}>{n.note}</span>
                </div>
              )}
              {!n.approvers.length && !n.attachments.length && !n.note && <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>还没填审批人和附件</div>}
              {outs.map((e) => (
                <div key={e.id} className="flow-step-next">
                  → {name(e.to)}
                  {e.label && <span className="tag" style={{ marginLeft: 6 }}>{e.label}</span>}
                  {e.approvers.length > 0 && <span className="faint">　审批：{e.approvers.map(personText).join('；')}</span>}
                  {e.attachments.length > 0 && <span className="faint">　附件：{e.attachments.map(attText).join('；')}</span>}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
