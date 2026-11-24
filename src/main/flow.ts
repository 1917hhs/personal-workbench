// 工作流程（审批流程图）的公共逻辑：把图整理成按顺序的步骤清单。界面（清单视图）和 AI 助手（MCP）都用同样的规则：
// - 只有「步骤」节点算步骤；「分组框」「标题栏」只用来分区，步骤落在哪个分组框里就属于哪个分组
// - 顺序：按连线的先后（拓扑顺序），同一层按位置从上到下、从左到右
//
// 数据结构 flows.json：
// { id, name, desc, nodes: [Node], edges: [Edge], createdAt, updatedAt }
// Node = { id, type: 'step' | 'group' | 'title', x, y, w, h, label, color,
//          approvers: [{ name, role, contactId? }], attachments: [{ name, required, note, ref? }], duration, note }
// Edge = { id, from, to, label, approvers, attachments, note }   （label 写条件，如「金额 > 5 万」）

export type FlowStep = {
  no: number
  id: string
  name: string
  group: string
  approvers: { name: string; role: string; contactId?: string }[]
  attachments: { name: string; required: boolean; note: string; template?: string }[]
  duration: string
  note: string
  next: { to: string; condition: string; approvers: any[]; attachments: any[]; note: string }[]
}

const inside = (n: any, g: any) => {
  const cx = n.x + n.w / 2
  const cy = n.y + n.h / 2
  return cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h
}

/** 步骤所在的分组：包含它的最小分组框；没有标签的分组框往下找标题栏（如「财务管理」在框的下面） */
export function groupOf(fl: any, n: any) {
  const groups = (fl.nodes || []).filter((g: any) => g.type === 'group' && inside(n, g)).sort((a: any, b: any) => a.w * a.h - b.w * b.h)
  const g = groups[0]
  if (!g) return ''
  if ((g.label || '').trim()) return g.label.trim()
  // 紧贴在分组框上方或下方、宽度差不多的标题栏
  const bars = (fl.nodes || []).filter((b: any) => b.type === 'title' && Math.abs(b.x - g.x) < 30 && Math.abs(b.w - g.w) < 60)
  const bar = bars.sort((a: any, b: any) => Math.min(Math.abs(a.y - (g.y + g.h)), Math.abs(a.y + a.h - g.y)) - Math.min(Math.abs(b.y - (g.y + g.h)), Math.abs(b.y + b.h - g.y)))[0]
  return bar ? bar.label || '' : ''
}

const attOut = (a: any) => ({ name: a.name || '', required: !!a.required, note: a.note || '', ...(a.ref ? { template: a.ref['data-name'] || a.name } : {}) })

export function flowSteps(fl: any): FlowStep[] {
  const steps = (fl.nodes || []).filter((n: any) => (n.type || 'step') === 'step')
  const ids = new Set(steps.map((n: any) => n.id))
  const edges = (fl.edges || []).filter((e: any) => ids.has(e.from) && ids.has(e.to))
  const indeg = new Map<string, number>(steps.map((n: any) => [n.id, 0]))
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) || 0) + 1)
  const pos = (a: any, b: any) => a.y - b.y || a.x - b.x
  const order: any[] = []
  const seen = new Set<string>()
  let ready = steps.filter((n: any) => !indeg.get(n.id)).sort(pos)
  while (order.length < steps.length) {
    if (!ready.length) ready = steps.filter((n: any) => !seen.has(n.id)).sort(pos).slice(0, 1) // 有回环时按位置接着排
    const n = ready.shift()
    if (seen.has(n.id)) continue
    seen.add(n.id)
    order.push(n)
    for (const e of edges.filter((e: any) => e.from === n.id)) {
      indeg.set(e.to, (indeg.get(e.to) || 0) - 1)
      if (!indeg.get(e.to) && !seen.has(e.to)) ready.push(steps.find((s: any) => s.id === e.to))
    }
    ready.sort(pos)
  }
  const name = (id: string) => steps.find((s: any) => s.id === id)?.label || ''
  return order.map((n, i) => ({
    no: i + 1,
    id: n.id,
    name: n.label || '',
    group: groupOf(fl, n),
    approvers: (n.approvers || []).map((p: any) => ({ name: p.name || '', role: p.role || '', ...(p.contactId ? { contactId: p.contactId } : {}) })),
    attachments: (n.attachments || []).map(attOut),
    duration: n.duration || '',
    note: n.note || '',
    next: edges
      .filter((e: any) => e.from === n.id)
      .map((e: any) => ({ to: name(e.to), condition: e.label || '', approvers: e.approvers || [], attachments: (e.attachments || []).map(attOut), note: e.note || '' }))
  }))
}

/** 搜索用：流程里出现的所有文字 */
export function flowText(fl: any) {
  return [fl.name, fl.desc, ...(fl.nodes || []).flatMap((n: any) => [n.label, n.note, n.duration, ...(n.approvers || []).flatMap((p: any) => [p.name, p.role]), ...(n.attachments || []).map((a: any) => a.name)]), ...(fl.edges || []).flatMap((e: any) => [e.label, e.note, ...(e.approvers || []).flatMap((p: any) => [p.name, p.role]), ...(e.attachments || []).map((a: any) => a.name)])]
    .filter(Boolean)
    .join(' ')
}
