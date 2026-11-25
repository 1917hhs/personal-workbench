import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { api, errMsg, parseLatLng, stageOf, useApp, useRemember } from '../lib'
import { StageDot, Tabs } from '../ui'
import { CoordEdit } from './ProjectDetail'

// 项目地图：每个项目一个点（颜色 = 阶段），可画红线范围（多边形）。
// 坐标统一按 WGS-84（经纬度）保存。
// 默认底图不需要任何 Key：卫星图用 Esri World Imagery（叠加 Esri 的地名和边界），
// 道路图用 OpenStreetMap，地形图用 Esri World Topo Map。它们都是 WGS-84 / 球面墨卡托，没有偏移。
// 天地图（需要免费 Key）作为国内项目的备选，同样没有偏移。

type Layer = 'vec' | 'img' | 'ter'
const ANNO: Record<Layer, string> = { vec: 'cva', img: 'cia', ter: 'cta' }
const ESRI = (service: string) => `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`

function baseLayers(provider: string, key: string, layer: Layer): L.TileLayer[] {
  if (provider === 'tianditu') {
    if (!key) return []
    const url = (t: string) => `https://t{s}.tianditu.gov.cn/DataServer?T=${t}_w&x={x}&y={y}&l={z}&tk=${key}`
    const opt = { subdomains: '01234567', maxZoom: 18, attribution: '天地图' }
    return [L.tileLayer(url(layer), opt), L.tileLayer(url(ANNO[layer]), opt)]
  }
  if (provider === 'none') return []
  // esri（默认）。旧设置里的 osm 也走这里
  if (layer === 'vec') return [L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap 贡献者' })]
  if (layer === 'ter') return [L.tileLayer(ESRI('World_Topo_Map'), { maxZoom: 19, attribution: '地形图 © Esri' })]
  return [
    L.tileLayer(ESRI('World_Imagery'), { maxZoom: 19, attribution: '影像 © Esri, Maxar, Earthstar Geographics' }),
    L.tileLayer(ESRI('Reference/World_Boundaries_and_Places'), { maxZoom: 19 })
  ]
}

export default function MapPage({ focusId }: { focusId?: string }) {
  const { data, saveProject, go, toast } = useApp()
  const { settings, projects } = data
  const mapDiv = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const baseRef = useRef<L.TileLayer[]>([])
  const shapesRef = useRef<L.LayerGroup | null>(null)
  const drawRef = useRef<L.Polyline | null>(null)
  const [layer, setLayer] = useState<Layer>(() => (settings.map?.provider === 'tianditu' ? 'vec' : 'img'))
  const [sel, setSel] = useState<string | null>(focusId || null)
  useRemember({ projectId: sel || undefined })
  const pinRef = useRef<L.Marker | null>(null)
  const [mode, setMode] = useState<null | 'place' | 'draw'>(null)
  const [pts, setPts] = useState<[number, number][]>([])
  const [q, setQ] = useState('')
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [places, setPlaces] = useState<any[]>([])
  const modeRef = useRef(mode)
  modeRef.current = mode
  const selRef = useRef(sel)
  selRef.current = sel
  // 地图事件只注册一次，用 ref 拿最新的数据和函数
  const projRef = useRef(projects)
  projRef.current = projects
  const saveRef = useRef(saveProject)
  saveRef.current = saveProject
  const ptsRef = useRef(pts)
  ptsRef.current = pts

  const raw = settings.map?.provider || 'esri'
  const provider = raw === 'osm' ? 'esri' : raw
  const key = settings.map?.key || ''
  const noBase = provider === 'tianditu' && !key

  const cur = projects.find((p) => p.id === sel)
  const located = projects.filter((p) => p.lat != null && p.lng != null)
  const list = useMemo(() => {
    const has = (s: any) => String(s || '').toLowerCase().includes(q.trim().toLowerCase())
    return projects.filter((p) => !q || has(p.name) || has(p.location) || has(p.code))
  }, [projects, q])

  // 初始化地图
  useEffect(() => {
    const map = L.map(mapDiv.current!, { center: [34.5, 108], zoom: 5, zoomControl: false, doubleClickZoom: false, worldCopyJump: true })
    L.control.zoom({ position: 'bottomright', zoomInTitle: '放大', zoomOutTitle: '缩小' }).addTo(map)
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map)
    shapesRef.current = L.layerGroup().addTo(map)
    map.on('click', (e: L.LeafletMouseEvent) => {
      const m = modeRef.current
      if (m === 'place') placeAt(e.latlng)
      else if (m === 'draw') setPts((p) => [...p, [e.latlng.lat, e.latlng.lng]])
    })
    map.on('dblclick', () => modeRef.current === 'draw' && finishDraw())
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // 底图
  useEffect(() => {
    const map = mapRef.current!
    baseRef.current.forEach((l) => map.removeLayer(l))
    baseRef.current = baseLayers(provider, key, layer)
    baseRef.current.forEach((l) => l.addTo(map).bringToBack())
  }, [provider, key, layer])

  // 项目点位与红线
  useEffect(() => {
    const g = shapesRef.current!
    g.clearLayers()
    for (const p of projects) {
      const s = stageOf(settings, p.stage)
      if (hidden.has(s.id)) continue
      if (p.boundary?.length >= 3) {
        L.polygon(p.boundary, { color: '#dc2626', weight: p.id === sel ? 3 : 2, fillColor: s.color, fillOpacity: 0.15 })
          .bindTooltip(p.name)
          .on('click', () => setSel(p.id))
          .addTo(g)
      }
      if (p.lat != null && p.lng != null) {
        L.circleMarker([p.lat, p.lng], { radius: p.id === sel ? 10 : 7, color: '#fff', weight: 2, fillColor: s.color, fillOpacity: 1 })
          .bindTooltip(p.name, { direction: 'top', offset: [0, -6] })
          .on('click', (e) => {
            L.DomEvent.stopPropagation(e)
            setSel(p.id)
          })
          .addTo(g)
      }
    }
  }, [projects, settings.stages, sel, hidden])

  // 正在画的红线
  useEffect(() => {
    const map = mapRef.current!
    drawRef.current?.remove()
    drawRef.current = pts.length ? L.polyline(pts, { color: '#dc2626', dashArray: '6 4' }).addTo(map) : null
  }, [pts])

  // 第一次进来时把所有项目框进视野
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || !mapRef.current) return
    // 从项目详情点「在地图上看」进来：直接定位到这个项目
    const fp = focusId && projects.find((p) => p.id === focusId)
    if (fp && (fp.lat != null || fp.boundary?.length >= 3)) {
      focus(fp)
      fitted.current = true
      return
    }
    const pts = located.map((p) => [p.lat, p.lng] as [number, number])
    if (pts.length) {
      mapRef.current.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 13 })
      fitted.current = true
    }
  }, [located.length])

  function placeAt(ll: L.LatLng) {
    const p = projRef.current.find((x) => x.id === selRef.current)
    if (!p) return
    saveRef.current({ ...p, lat: Number(ll.lat.toFixed(6)), lng: Number(ll.lng.toFixed(6)) })
    setMode(null)
    toast('已标注位置')
  }

  function finishDraw() {
    // 双击会先触发两次单击，去掉末尾重复的点
    const cur = ptsRef.current.filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1])
    const p = projRef.current.find((x) => x.id === selRef.current)
    if (p && cur.length >= 3) {
      const c = cur.reduce((a, b) => [a[0] + b[0] / cur.length, a[1] + b[1] / cur.length], [0, 0])
      saveRef.current({ ...p, boundary: cur, ...(p.lat == null ? { lat: Number(c[0].toFixed(6)), lng: Number(c[1].toFixed(6)) } : {}) })
      toast('已保存红线范围')
    } else if (cur.length) toast('至少要点 3 个点')
    setPts([])
    setMode(null)
  }

  const focus = (p: any) => {
    setSel(p.id)
    const map = mapRef.current!
    if (p.boundary?.length >= 3) map.fitBounds(L.latLngBounds(p.boundary).pad(0.4))
    else if (p.lat != null) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 14))
  }

  // 跳到一个坐标，并放一个临时标记
  const jumpTo = (ll: { lat: number; lng: number }) => {
    const map = mapRef.current!
    pinRef.current?.remove()
    pinRef.current = L.marker([ll.lat, ll.lng], {
      icon: L.divIcon({ className: 'coord-pin', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] })
    })
      .bindTooltip(`${ll.lat}, ${ll.lng}`, { direction: 'top', offset: [0, -8], permanent: true })
      .addTo(map)
    map.setView([ll.lat, ll.lng], Math.max(map.getZoom(), 15))
  }

  // 地名搜索：天地图（有 Key 时）或 OpenStreetMap Nominatim；输入的是经纬度就直接跳过去
  const searchPlace = async () => {
    if (!q.trim()) return
    const ll = parseLatLng(q)
    if (ll && /\d/.test(q) && !/[一-龥]{3,}/.test(q.replace(/北纬|南纬|东经|西经/g, ''))) {
      setPlaces([{ name: `坐标 ${ll.lat}, ${ll.lng}`, address: ll.swapped ? '已把经纬度对调' : 'WGS-84', lat: ll.lat, lng: ll.lng, coord: true }])
      jumpTo(ll)
      return
    }
    if (provider !== 'tianditu' || !key) {
      try {
        const pois = await api.call('geo:search', q.trim())
        setPlaces(pois)
        if (!pois.length) toast('没有找到这个地点')
      } catch (e) {
        toast(errMsg(e) + '，请检查网络')
      }
      return
    }
    try {
      const post = { keyWord: q.trim(), level: 12, mapBound: '73,3,136,54', queryType: 1, start: 0, count: 8 }
      const r = await fetch(`https://api.tianditu.gov.cn/v2/search?postStr=${encodeURIComponent(JSON.stringify(post))}&type=query&tk=${key}`).then((x) => x.json())
      const pois = (r.pois || []).map((p: any) => ({ name: p.name, address: p.address, lng: Number(p.lonlat.split(/[ ,]/)[0]), lat: Number(p.lonlat.split(/[ ,]/)[1]) }))
      setPlaces(pois)
      if (!pois.length) toast('没有找到这个地点')
    } catch (e) {
      toast('地名搜索失败，请检查网络和天地图 Key')
    }
  }

  const stageCount = (id: string) => projects.filter((p) => p.stage === id).length

  return (
    <div className="map-page">
      <div className="map-side">
        <div className="row" style={{ gap: 6 }}>
          <input className="input" placeholder="搜索项目、地名，或输入经纬度回车" value={q} onChange={(e) => (setQ(e.target.value), setPlaces([]))} onKeyDown={(e) => e.key === 'Enter' && searchPlace()} />
          <button className="btn small" title="搜索地名或经纬度并跳过去（回车）" onClick={searchPlace}>定位</button>
        </div>
        {places.length > 0 && (
          <div className="card" style={{ padding: 4 }}>
            {places.map((p, i) => (
              <div key={i}>
                <div className="kb-node" onClick={() => jumpTo(p)}>
                  <span className="kb-title">
                    📍 {p.name} <span className="faint" style={{ fontSize: 11 }}>{p.address}</span>
                  </span>
                </div>
                {cur && (
                  <div style={{ padding: '0 8px 6px 26px' }}>
                    <button
                      className="btn small"
                      onClick={async () => {
                        await saveProject({ ...cur, lat: p.lat, lng: p.lng })
                        pinRef.current?.remove()
                        toast(`已设为「${cur.name}」的位置`)
                      }}
                    >
                      设为「{cur.name}」的位置
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="faint" style={{ fontSize: 12, margin: '6px 0 2px' }}>
          项目 {projects.length} · 已定位 {located.length}
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {list.map((p) => {
            const s = stageOf(settings, p.stage)
            return (
              <div key={p.id} className={'kb-node' + (sel === p.id ? ' on' : '')} onClick={() => focus(p)}>
                <StageDot color={s.color} />
                <span className="kb-title" style={{ marginLeft: 6 }}>{p.name}</span>
                {p.lat == null && <span className="faint" style={{ fontSize: 11 }}>未定位</span>}
              </div>
            )
          })}
        </div>
        <div className="faint" style={{ fontSize: 12, margin: '8px 0 4px' }}>图例（点击隐藏 / 显示）</div>
        {settings.stages.map((s: any) => (
          <div key={s.id} className="kb-node" style={{ opacity: hidden.has(s.id) ? 0.4 : 1 }} onClick={() => setHidden((h) => (h.has(s.id) ? new Set([...h].filter((x) => x !== s.id)) : new Set([...h, s.id])))}>
            <StageDot color={s.color} />
            <span className="kb-title" style={{ marginLeft: 6 }}>{s.name}</span>
            <span className="faint" style={{ fontSize: 11 }}>{stageCount(s.id)}</span>
          </div>
        ))}
        <div className="kb-node" style={{ cursor: 'default' }}>
          <span style={{ width: 14, height: 0, borderTop: '2px solid #dc2626', display: 'inline-block' }} />
          <span className="kb-title" style={{ marginLeft: 6 }}>红线范围</span>
        </div>
      </div>

      <div className="map-main">
        <div ref={mapDiv} className={'leaflet-host' + (mode ? ' picking' : '')} />
        <div className="map-float right">
          {provider === 'tianditu' && key ? (
            <Tabs value={layer} onChange={setLayer} options={[{ id: 'vec', label: '矢量' }, { id: 'img', label: '影像' }, { id: 'ter', label: '地形' }]} />
          ) : provider === 'esri' ? (
            <Tabs value={layer} onChange={setLayer} options={[{ id: 'img', label: '卫星' }, { id: 'vec', label: '道路' }, { id: 'ter', label: '地形' }]} />
          ) : null}
        </div>
        {noBase && (
          <div className="map-float bottom">
            天地图还没有 Key：在 <span className="click" style={{ color: 'var(--accent)' }} onClick={() => go({ page: 'settings', settingsSection: 'map' })}>设置 → 地图</span> 里填写，或改用默认的 Esri 卫星图 + OpenStreetMap（不需要 Key）。
          </div>
        )}
        {mode && (
          <div className="map-float top">
            {mode === 'place' ? '在地图上点击项目所在的位置' : `依次点击红线范围的各个拐点，双击或点「完成」结束（已点 ${pts.length} 个）`}
            {mode === 'draw' && (
              <button className="btn small primary" style={{ marginLeft: 8 }} onClick={finishDraw}>完成</button>
            )}
            <button className="btn small" style={{ marginLeft: 8 }} onClick={() => (setMode(null), setPts([]))}>取消</button>
          </div>
        )}
        {cur && !mode && (
          <div className="map-card card">
            <div className="row">
              <StageDot color={stageOf(settings, cur.stage).color} />
              <b style={{ flex: 1 }}>{cur.name}</b>
              <button className="icon-btn" onClick={() => setSel(null)}>×</button>
            </div>
            <div className="faint" style={{ fontSize: 12, margin: '4px 0 8px' }}>
              {stageOf(settings, cur.stage).name} · {cur.status}
              {cur.location ? ' · ' + cur.location : ''}
              {cur.boundary?.length >= 3 ? ` · 红线 ${cur.boundary.length} 个拐点` : ''}
            </div>
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              <CoordEdit project={cur} onMap={(ll) => mapRef.current!.setView([ll.lat, ll.lng], Math.max(mapRef.current!.getZoom(), 15))} />
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              <button className="btn small primary" onClick={() => go({ page: 'project', projectId: cur.id })}>打开项目</button>
              <button className="btn small" onClick={() => setMode('place')}>{cur.lat != null ? '重新定位' : '标注位置'}</button>
              <button className="btn small" onClick={() => (setPts([]), setMode('draw'))}>{cur.boundary?.length ? '重画红线' : '画红线范围'}</button>
              {(cur.lat != null || cur.boundary?.length) && (
                <button className="btn small danger" onClick={() => confirm('清除这个项目的位置和红线？') && saveProject({ ...cur, lat: null, lng: null, boundary: null })}>
                  清除
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
