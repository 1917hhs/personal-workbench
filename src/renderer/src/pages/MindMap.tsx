import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, catOf, extOf, fmtSize, fmtTime } from '../lib'

export const NODE_W = 240
export const NODE_H = 50
const GAP_X = 64
const GAP_Y = 10

export interface TNode {
  name: string
  rel: string
  dir: boolean
  mtime: number
  size?: number
  fileCount?: number
  hiddenCount?: number
  hidden?: boolean
  children?: TNode[]
  /** 虚拟节点：版本组 / 引用。它们不对应磁盘上的文件夹 */
  virtual?: 'versions' | 'ref'
  version?: number
  finalVersion?: number
  refId?: string
  refPath?: string
  refExists?: boolean
}

interface Item {
  n: TNode
  x: number
  y: number
  depth: number
  expanded: boolean
  kids: number
}

function layout(root: TNode, isExpanded: (n: TNode, depth: number) => boolean) {
  const heights = new Map<string, number>()
  const measure = (n: TNode, d: number): number => {
    let h = NODE_H
    if (n.dir && n.children?.length && isExpanded(n, d)) {
      let s = 0
      n.children.forEach((c, i) => (s += measure(c, d + 1) + (i ? GAP_Y : 0)))
      h = Math.max(NODE_H, s)
    }
    heights.set(n.rel, h)
    return h
  }
  measure(root, 0)
  const items: Item[] = []
  const links: string[] = []
  const place = (n: TNode, d: number, top: number): number => {
    const h = heights.get(n.rel)!
    const y = top + h / 2 - NODE_H / 2
    const x = d * (NODE_W + GAP_X)
    const expanded = !!(n.dir && n.children?.length && isExpanded(n, d))
    items.push({ n, x, y, depth: d, expanded, kids: n.children?.length || 0 })
    if (expanded) {
      const total = n.children!.reduce((s, c, i) => s + heights.get(c.rel)! + (i ? GAP_Y : 0), 0)
      let t = top + (h - total) / 2
      for (const c of n.children!) {
        const cy = place(c, d + 1, t)
        const x1 = x + NODE_W + 12
        const y1 = y + NODE_H / 2
        const x2 = (d + 1) * (NODE_W + GAP_X)
        const y2 = cy + NODE_H / 2
        links.push(`M${x1} ${y1}C${x1 + GAP_X / 2} ${y1},${x2 - GAP_X / 2} ${y2},${x2} ${y2}`)
        t += heights.get(c.rel)! + GAP_Y
      }
    }
    return y
  }
  place(root, 0, 0)
  const width = Math.max(...items.map((i) => i.x)) + NODE_W + 40
  const height = heights.get(root.rel)! + 40
  return { items, links, width, height }
}

export function FileBadge({ name, stack }: { name: string; stack?: boolean }) {
  const c = catOf(name)
  const e = extOf(name).slice(0, 4).toUpperCase() || 'FILE'
  return (
    <span className={'ext' + (stack ? ' stack' : '')} style={{ background: c?.color || '#94a3b8' }}>
      {e}
    </span>
  )
}

export function FolderIcon({ color }: { color?: string }) {
  return (
    <span className="folder-ico">
      <svg width="22" height="18" viewBox="0 0 22 18">
        <path d="M1 3a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z" fill={color || '#f5b942'} />
      </svg>
    </span>
  )
}

export default function MindMap(props: {
  projectId: string
  rootName: string
  tree: TNode
  meta: Record<string, any>
  refCount: (rel: string) => number
  selected: string | null
  forceExpand: Set<string>
  expandAll: boolean
  centerOn: string | null
  onCentered: () => void
  onSelect: (rel: string | null) => void
  onToggle: (rel: string, expanded: boolean) => void
  onOpen: (n: TNode) => void
  onContext: (n: TNode, x: number, y: number) => void
  onNewFolder: (rel: string) => void
  onDropFiles: (destRel: string, paths: string[]) => void
  onKey: (e: React.KeyboardEvent) => void
}) {
  const { tree, meta } = props
  const viewRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 40, y: 40, k: 1 })
  const [panning, setPanning] = useState(false)
  const [dropRel, setDropRel] = useState<string | null>(null)
  const fitted = useRef(false)

  const isExpanded = (n: TNode, d: number) => {
    if (d === 0) return true
    if (props.forceExpand.has(n.rel)) return true
    const c = meta[n.rel]?.collapsed
    if (c === true) return false
    if (c === false) return true
    if (n.virtual === 'versions') return false // 版本组默认收起，只显示最新版
    return props.expandAll || d <= 1
  }

  const { items, links, width, height } = useMemo(() => layout(tree, isExpanded), [tree, meta, props.forceExpand, props.expandAll])

  // 首次打开：根节点放在左侧、垂直居中
  useLayoutEffect(() => {
    if (fitted.current || !viewRef.current) return
    const root = items[0]
    const vh = viewRef.current.clientHeight
    setView({ x: 40, y: vh / 2 - root.y - NODE_H / 2, k: 1 })
    fitted.current = true
  }, [items])

  // 从搜索跳过来时，把目标节点移到视图中央
  useEffect(() => {
    if (!props.centerOn || !viewRef.current) return
    const it = items.find((i) => i.n.rel === props.centerOn)
    if (!it) return
    const { clientWidth: vw, clientHeight: vh } = viewRef.current
    setView((v) => ({ ...v, x: vw / 2 - (it.x + NODE_W / 2) * v.k, y: vh / 2 - (it.y + NODE_H / 2) * v.k }))
    props.onCentered()
  }, [props.centerOn, items])

  // 滚轮直接缩放（以鼠标位置为中心）；Shift+滚轮上下移动；触控板横向滑动左右移动（需要非 passive 监听才能阻止默认滚动）
  useEffect(() => {
    const el = viewRef.current!
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
        const k = Math.min(2.5, Math.max(0.15, v.k * f))
        return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.mnode, .zoom-box, .minimap')) return
    const sx = e.clientX
    const sy = e.clientY
    const start = view
    let moved = false
    setPanning(true)
    const move = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true
      setView({ ...start, x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy })
    }
    const up = () => {
      setPanning(false)
      if (!moved) props.onSelect(null)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const zoom = (f: number) => {
    const el = viewRef.current!
    const mx = el.clientWidth / 2
    const my = el.clientHeight / 2
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.15, v.k * f))
      return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) }
    })
  }

  // 视图大小（缩略图里的取景框要用）
  const [size, setSize] = useState({ w: 800, h: 600 })
  useEffect(() => {
    const el = viewRef.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const [showMini, setShowMini] = useState(() => localStorage.getItem('mapMini') !== '0')
  const toggleMini = () => setShowMini((v) => (localStorage.setItem('mapMini', v ? '0' : '1'), !v))

  // 缩略图：整张图缩小放进右下角，蓝框是当前看到的范围，按住拖动就能移动视图
  const MW = 200
  const MH = 130
  const ms = Math.min((MW - 16) / Math.max(width, 1), (MH - 16) / Math.max(height, 1))
  const mox = (MW - width * ms) / 2
  const moy = (MH - height * ms) / 2
  const vr = { x: -view.x / view.k, y: -view.y / view.k, w: size.w / view.k, h: size.h / view.k }
  const onMiniDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const toContent = (cx: number, cy: number) => ({ x: (cx - box.left - mox) / ms, y: (cy - box.top - moy) / ms })
    const p0 = toContent(e.clientX, e.clientY)
    const inside = p0.x >= vr.x && p0.x <= vr.x + vr.w && p0.y >= vr.y && p0.y <= vr.y + vr.h
    // 按在取景框里：保持按下位置不跳；按在框外：先把视图中心移到这里
    const off = inside ? { x: p0.x - (vr.x + vr.w / 2), y: p0.y - (vr.y + vr.h / 2) } : { x: 0, y: 0 }
    const moveTo = (cx: number, cy: number) => {
      const p = toContent(cx, cy)
      setView((v) => ({ ...v, x: size.w / 2 - (p.x - off.x) * v.k, y: size.h / 2 - (p.y - off.y) * v.k }))
    }
    moveTo(e.clientX, e.clientY)
    setPanning(true)
    const move = (ev: MouseEvent) => moveTo(ev.clientX, ev.clientY)
    const up = () => {
      setPanning(false)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  // 适应窗口：整张图缩放到刚好放进视图
  const fit = () => {
    const k = Math.min(1.5, Math.max(0.15, Math.min((size.w - 80) / width, (size.h - 80) / height)))
    setView({ k, x: (size.w - width * k) / 2, y: (size.h - height * k) / 2 })
  }

  const pathsOf = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.files)
      .map((f) => api.pathForFile(f))
      .filter(Boolean)

  const parentRel = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')

  return (
    <div
      ref={viewRef}
      className={'map' + (panning ? ' panning' : '')}
      style={{ backgroundSize: `${20 * view.k}px ${20 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={props.onKey}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          if (!(e.target as HTMLElement).closest('.mnode')) setDropRel('')
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropRel(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        const paths = pathsOf(e)
        const dest = dropRel ?? ''
        setDropRel(null)
        if (paths.length) props.onDropFiles(dest, paths)
      }}
    >
      <div className="map-inner" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width, height }}>
        <svg className="map-links" width={width} height={height}>
          {links.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="var(--line-2)" strokeWidth={1.5} />
          ))}
        </svg>
        {items.map(({ n, x, y, depth, expanded, kids }) => {
          const m = meta[n.rel] || {}
          const isRoot = depth === 0
          const realDir = n.dir && !n.virtual
          const target = realDir ? n.rel : parentRel(n.rel)
          const refs = !n.dir && !n.virtual ? props.refCount(n.rel) : 0
          const sub =
            n.virtual === 'versions'
              ? `最新 v${n.fileCount} · 共 ${n.fileCount} 版${n.finalVersion ? ` · 定稿 v${n.finalVersion}` : ''}`
              : n.virtual === 'ref'
                ? n.refExists
                  ? `引用 · ${fmtTime(n.mtime)}`
                  : '引用 · 原文件找不到'
                : n.dir
                  ? `${n.fileCount || 0} 个文件${n.mtime ? ' · ' + fmtTime(n.mtime) : ''}${n.hiddenCount ? ` · 隐藏 ${n.hiddenCount}` : ''}`
                  : `${refs ? `+${refs} 引用 · ` : ''}${m.tag ? m.tag + ' · ' : ''}${fmtSize(n.size)} · ${fmtTime(n.mtime)}`
          return (
            <div
              key={n.rel || '__root'}
              className={
                'mnode' +
                (isRoot ? ' root' : '') +
                (props.selected === n.rel ? ' sel' : '') +
                (dropRel === target && realDir ? ' drop' : '') +
                (n.hidden ? ' ghost' : '') +
                (n.virtual === 'ref' ? ' ref' : '') +
                (n.virtual === 'ref' && !n.refExists ? ' missing' : '') +
                (n.virtual === 'versions' ? ' vgroup' : '')
              }
              style={{ left: x, top: y, width: NODE_W, height: NODE_H, borderLeftColor: m.color || (isRoot ? 'var(--accent)' : undefined) }}
              title={m.note || n.name}
              onClick={(e) => {
                e.stopPropagation()
                props.onSelect(n.rel)
              }}
              onDoubleClick={() => (n.dir ? props.onToggle(n.rel, expanded) : props.onOpen(n))}
              onContextMenu={(e) => {
                e.preventDefault()
                props.onSelect(n.rel)
                props.onContext(n, e.clientX, e.clientY)
              }}
              draggable={!isRoot && n.virtual !== 'versions' && !(n.virtual === 'ref' && !n.refExists)}
              onDragStart={(e) => {
                e.preventDefault()
                if (n.virtual === 'ref') api.startDragAbs(n.refPath!)
                else api.startDrag(props.projectId, n.rel)
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('Files')) {
                  e.preventDefault()
                  e.stopPropagation()
                  setDropRel(target)
                }
              }}
            >
              {realDir ? <FolderIcon color={m.color} /> : <FileBadge name={n.name} stack={n.virtual === 'versions'} />}
              <div className="txt">
                <div className="nm">
                  {n.version && <span className="ver">v{n.version}</span>}
                  {n.virtual === 'ref' && <span className="ver">↗</span>}
                  {isRoot ? props.rootName : n.name}
                </div>
                <div className="sub">{sub}</div>
              </div>
              {m.note && <span className="note-mark">✎</span>}
              {realDir && (
                <button
                  className="plus"
                  title="新建子文件夹"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onNewFolder(n.rel)
                  }}
                >
                  +
                </button>
              )}
              {!isRoot && n.dir && kids > 0 && (
                <button
                  className="toggle"
                  title={expanded ? '收起' : '展开'}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onToggle(n.rel, expanded)
                  }}
                >
                  {expanded ? '−' : kids}
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div className="map-help">拖动空白处平移 · 滚轮缩放 · Shift+滚轮上下移动 · 文件拖到文件夹上即可归档 · 节点拖出去可发到微信 / 桌面</div>
      <div className="zoom-box">
        <button className="zb" title="缩小" onClick={() => zoom(1 / 1.2)}>−</button>
        <button className="zb pct" title="恢复 100%" onClick={() => setView((v) => ({ ...v, k: 1 }))}>{Math.round(view.k * 100)}%</button>
        <button className="zb" title="放大" onClick={() => zoom(1.2)}>+</button>
        <span className="zb-sep" />
        <button className="zb" title="适应窗口，看到整张图" onClick={fit}>⛶</button>
        <button className={'zb' + (showMini ? ' on' : '')} title={showMini ? '隐藏缩略图' : '显示缩略图'} onClick={toggleMini}>▣</button>
      </div>
      {showMini && (
        <div className="minimap" title="按住拖动，移动视图" onMouseDown={onMiniDown} onWheel={(e) => e.stopPropagation()}>
          <svg width={MW} height={MH}>
            {items.map(({ n, x, y, depth }) => {
              const m = meta[n.rel] || {}
              const fill = depth === 0 ? 'var(--accent)' : m.color || (n.dir && !n.virtual ? '#f5b638' : 'var(--mini-file)')
              return <rect key={n.rel || '__root'} x={mox + x * ms} y={moy + y * ms} width={Math.max(2, NODE_W * ms)} height={Math.max(1.5, NODE_H * ms)} rx={1} fill={fill} />
            })}
            <rect className="mini-view" x={mox + vr.x * ms} y={moy + vr.y * ms} width={vr.w * ms} height={vr.h * ms} rx={3} />
          </svg>
        </div>
      )}
    </div>
  )
}
