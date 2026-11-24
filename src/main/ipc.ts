import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, net, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import chokidar from 'chokidar'
import * as XLSX from 'xlsx'
import type { Kind, Store } from './store'
import { importPaths, previewData, safeJoin } from './files'
import { storeInquiryFiles, trashInquiryFiles } from './procure'
import { applyLibraryScan, importToLibrary, libAbs, moveLibraryDir, scanLibrary } from './library'
import { listHistory, listPages, purgePage, readVersion, savePage } from './kb'
import { exportPack, importPack, packInfo } from './pack'
import { fileIndex, norm, projectRoot, refStatus, scanProject, searchAll, upsert } from './shared'
import { aiLog, aiStatus, restartMcp, undoAiAction } from './mcp'
import { findRefs, importMedia, purgeMedia, refPath, refStatus as memoRefStatus, renameProjectRefs, saveMedia, type RefTarget } from './memo'
import { deleteSection, getProfile, moveSection, profileMarkdown, revertChange, saveSection } from './profile'

// 生成一个 16x16 的小图标，用于把文件从导图拖到微信、资源管理器
function dragIcon() {
  const buf = Buffer.alloc(16 * 16 * 4)
  for (let i = 0; i < 256; i++) buf.set([0xe0, 0x6a, 0x4f, 0xff], i * 4) // BGRA
  return nativeImage.createFromBitmap(buf, { width: 16, height: 16 })
}

export function registerIpc(store: Store, getWin: () => BrowserWindow | null) {
  const h = (ch: string, fn: (...a: any[]) => any) => ipcMain.handle(ch, (_e, ...a) => fn(...a))
  const all = () => ({
    settings: store.settings,
    projects: store.projects,
    todos: store.todos,
    stickies: store.stickies,
    contacts: store.contacts,
    reviews: store.reviews,
    library: store.library,
    focus: store.focus,
    libraryDir: store.libraryDir,
    dataDir: store.dataDir,
    root: store.root,
    backupDir: store.backupDir,
    migratedFrom: store.migratedFrom,
    cards: store.cards,
    companies: store.companies,
    inquiries: store.inquiries,
    version: app.getVersion()
  })

  nativeTheme.themeSource = store.settings.theme || 'system'

  h('app:init', all)

  h('settings:save', (s: any) => {
    const aiChanged = JSON.stringify(s.ai) !== JSON.stringify(store.settings.ai)
    store.settings = s
    store.save('settings')
    nativeTheme.themeSource = s.theme || 'system'
    if (aiChanged) restartMcp(store, getWin)
    return store.settings
  })

  h('projects:save', (p: any) => {
    upsert(store.projects, p)
    store.save('projects')
    return store.projects
  })

  const templateOf = (templateId?: string) => {
    const list = store.settings.templates || []
    const t = list.find((x: any) => x.id === templateId) || list.find((x: any) => x.id === store.settings.defaultTemplateId) || list[0]
    if (!t) throw new Error('还没有目录模板，请先在 设置 → 项目目录模板 里添加')
    return t
  }

  /** 按模板建文件夹（支持「a/b」多层），返回新建了几个 */
  const makeFolders = (root: string, folders: string[]) => {
    let n = 0
    for (const f of folders) {
      const parts = String(f)
        .split(/[\\/]+/)
        .map((s) => s.trim().replace(/[:*?"<>|]/g, '_'))
        .filter((s) => s && s !== '.' && s !== '..')
      if (!parts.length) continue
      const dir = path.join(root, ...parts)
      if (!fs.existsSync(dir)) n++
      fs.mkdirSync(dir, { recursive: true })
    }
    return n
  }

  h('projects:create', (p: any, folder: { mode: 'template' | 'existing' | 'none'; path?: string; templateId?: string }) => {
    if (folder.mode === 'template') {
      const base = store.settings.projectsRoot
      if (!base) throw new Error('请先在设置里指定「项目根目录」')
      const name = [p.code, p.name].filter(Boolean).join(' ').replace(/[\\/:*?"<>|]/g, '_')
      const dir = path.join(base, name)
      const t = templateOf(folder.templateId)
      fs.mkdirSync(dir, { recursive: true })
      makeFolders(dir, t.folders)
      p.rootPath = dir
      p.templateId = t.id
    } else if (folder.mode === 'existing') {
      p.rootPath = folder.path
    }
    upsert(store.projects, p)
    store.save('projects')
    return store.projects
  })

  h('projects:applyTemplate', (id: string, templateId?: string) => {
    const root = projectRoot(store, id)
    const t = templateOf(templateId)
    const created = makeFolders(root, t.folders)
    const p = store.projects.find((x) => x.id === id)
    if (p && p.templateId !== t.id) {
      p.templateId = t.id
      store.save('projects')
    }
    return { created, name: t.name, projects: store.projects }
  })

  // ---------- 询价：导出比价表 ----------
  // 询价文件 / 回价文件「上传」：复制进项目文件夹（见 procure.ts）
  h('inquiry:trashFiles', (paths: string[]) => trashInquiryFiles(store, paths))
  h('inquiry:storeFiles', (inquiry: { projectId?: string; name: string }, kind: 'version' | 'quote', sub: string, paths: string[]) =>
    storeInquiryFiles(store, inquiry, kind, sub, paths)
  )

  h('inquiry:export', async (id: string) => {
    const x = store.inquiries.find((i) => i.id === id)
    if (!x) throw new Error('找不到这条询价')
    const co = (cid: string) => store.companies.find((c) => c.id === cid)?.name || ''
    const usd = (q: any) => (q.currency === 'USD' ? Number(q.amount) : q.rate ? Number(q.amount) * Number(q.rate) : '')
    const r = await dialog.showSaveDialog(getWin()!, { title: '导出比价表', defaultPath: `比价表 ${x.name} ${new Date().toISOString().slice(0, 10)}.xlsx`.replace(/[\\/:*?"<>|]/g, '_'), filters: [{ name: 'Excel', extensions: ['xlsx'] }] })
    if (r.canceled || !r.filePath) return null
    const latest = new Map<string, any>()
    for (const q of [...(x.quotes || [])].sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0))) latest.set(q.companyId, q)
    const cmp = [...latest.values()]
      .map((q) => ({
        单位: co(q.companyId),
        轮次: q.round || 1,
        报价金额: Number(q.amount),
        币种: q.currency,
        汇率_USD: q.rate ?? '',
        折合USD: usd(q),
        是否含税: q.tax || '',
        税率: q.taxRate ? q.taxRate + '%' : '',
        含税总价: q.amountWithTax ?? '',
        比控制价: x.budget ? `${(((Number(q.amount) - x.budget) / x.budget) * 100).toFixed(1)}%` : '',
        报价编号: q.quoteNo || '',
        报价范围: q.scopeNote || '',
        核实状态: q.verify || '',
        疑点: q.issues || '',
        '工期/交货期（天）': q.leadDays || '',
        付款条件: q.payment || '',
        报价有效期至: q.validTo || '',
        技术偏差: q.deviation || '',
        收到日期: q.date || '',
        定标: x.awardedCompanyId === q.companyId ? '是' : ''
      }))
      .sort((a, b) => (Number(a.折合USD) || a.报价金额) - (Number(b.折合USD) || b.报价金额))
    const sendRows = (x.sends || []).map((s: any) => ({ 单位: co(s.companyId), 发送日期: s.date || '', 发送渠道: s.channel || '', 回价截止: s.deadline || '', 状态: s.status || '', 回价轮数: (x.quotes || []).filter((q: any) => q.companyId === s.companyId).length }))
    const allQuotes = (x.quotes || []).map((q: any) => ({ 单位: co(q.companyId), 轮次: q.round || 1, 收到日期: q.date || '', 报价金额: Number(q.amount), 币种: q.currency, 是否含税: q.tax || '', 备注: q.note || '' }))
    const info = [
      ['询价（专业包）', x.name],
      ['项目', store.projects.find((p) => p.id === x.projectId)?.name || ''],
      ['询价专业', x.discipline || ''],
      ['状态', x.status || ''],
      ['工作范围', x.scope || ''],
      ['交货地点', x.location || ''],
      ['启动时间', x.startDate || ''],
      ['回价截止', x.deadline || ''],
      ['采购负责人', x.buyer || ''],
      ['控制价（不含税）', x.budget ? `${x.budget} ${x.currency || ''}` : ''],
      ['控制价说明', x.budgetNote || ''],
      ['定标单位', co(x.awardedCompanyId) || ''],
      ['比选结论', x.conclusion || '']
    ]
    const wb = XLSX.utils.book_new()
    const ws1 = XLSX.utils.json_to_sheet(cmp)
    ws1['!cols'] = [30, 6, 14, 8, 10, 14, 8, 14, 30, 12, 30, 12, 6].map((w) => ({ wch: w }))
    XLSX.utils.book_append_sheet(wb, ws1, '比价')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sendRows), '发包记录')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allQuotes), '全部回价')
    const ws4 = XLSX.utils.aoa_to_sheet(info)
    ws4['!cols'] = [{ wch: 14 }, { wch: 60 }]
    XLSX.utils.book_append_sheet(wb, ws4, '基本信息')
    try {
      XLSX.writeFile(wb, r.filePath)
    } catch (e: any) {
      throw new Error(e.code === 'EBUSY' ? '这个文件正被 Excel 打开着，请先关掉再导出' : '导出失败：' + e.message)
    }
    const m = await dialog.showMessageBox(getWin()!, { type: 'info', message: '已导出比价表', detail: r.filePath, buttons: ['打开', '在资源管理器中显示', '关闭'], cancelId: 2 })
    if (m.response === 0) shell.openPath(r.filePath)
    if (m.response === 1) shell.showItemInFolder(r.filePath)
    return r.filePath
  })

  // 从一个整理好的文件夹生成模板：读出它的子文件夹（最多两层）
  h('templates:fromFolder', async () => {
    const r = await dialog.showOpenDialog(getWin()!, { title: '选择一个整理好的项目文件夹，按它的子文件夹生成模板', properties: ['openDirectory'] })
    if (r.canceled) return null
    const root = r.filePaths[0]
    const out: string[] = []
    const subdirs = (d: string) =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
    for (const a of subdirs(root)) {
      const kids = subdirs(path.join(root, a))
      if (!kids.length) out.push(a)
      else for (const b of kids) out.push(a + '/' + b)
    }
    return { name: path.basename(root), folders: out }
  })

  h('projects:delete', (id: string) => {
    store.projects = store.projects.filter((p) => p.id !== id).map((p) => (p.parentId === id ? { ...p, parentId: null } : p))
    store.todos = store.todos.map((t) => (t.projectId === id ? { ...t, projectId: null } : t))
    store.reviews = store.reviews.filter((r) => r.projectId !== id)
    store.save('projects')
    store.save('todos')
    store.save('reviews')
    fileIndex.delete(id)
    return all()
  })

  h('todos:save', (t: any) => {
    upsert(store.todos, t)
    store.save('todos')
    return store.todos
  })
  h('todos:delete', (id: string) => {
    store.todos = store.todos.filter((t) => t.id !== id)
    store.save('todos')
    return store.todos
  })
  h('stickies:save', (s: any) => {
    upsert(store.stickies, s)
    store.save('stickies')
    return store.stickies
  })
  h('stickies:delete', (id: string) => {
    store.stickies = store.stickies.filter((s) => s.id !== id)
    store.save('stickies')
    return store.stickies
  })

  h('focus:delete', (id: string) => {
    store.focus = store.focus.filter((f) => f.id !== id)
    store.save('focus')
    return store.focus
  })

  for (const kind of ['cards', 'companies', 'inquiries'] as Kind[]) {
    h(`${kind}:delete`, (id: string) => {
      ;(store as any)[kind] = (store[kind] as any[]).filter((x) => x.id !== id)
      store.save(kind)
      if (kind === 'companies') {
        // 单位删掉后，联系人解除绑定
        store.contacts = store.contacts.map((c) => (c.companyId === id ? { ...c, companyId: null } : c))
        store.save('contacts')
      }
      return all()
    })
  }

  // 单位与供应商选项改名 / 删除：同步改已有单位上的值（nw 为 null 表示删除，币种删除时不动已有记录）
  h('supplierOption:apply', (key: string, old: string, nw: string | null) => {
    const one = (v: any) => (v === old ? nw || '' : v)
    const many = (a: any) => (Array.isArray(a) ? [...new Set(a.map((v) => (v === old ? nw : v)).filter(Boolean))] : a)
    const field: Record<string, string> = { unitTypes: 'unitType', category: 'category', role: 'role', status: 'status', stage: 'stage', grade: 'grade' }
    let n = 0
    store.companies = store.companies.map((c) => {
      let x = { ...c }
      if (field[key]) x[field[key]] = one(c[field[key]])
      if (key === 'specialties') x.specialties = many(c.specialties)
      if (key === 'countries') x = { ...x, serviceCountries: many(c.serviceCountries), regCountry: one(c.regCountry) }
      if (key === 'docTypes') x.docs = (c.docs || []).map((d: any) => ({ ...d, type: one(d.type) }))
      if (key === 'currencies' && nw) x.experience = (c.experience || []).map((d: any) => ({ ...d, currency: one(d.currency) }))
      if (JSON.stringify(x) !== JSON.stringify(c)) n++
      return x
    })
    store.save('companies')
    if (nw && (key === 'specialties' || key === 'currencies')) {
      store.inquiries = store.inquiries.map((q) =>
        key === 'specialties' ? { ...q, discipline: one(q.discipline) } : { ...q, currency: one(q.currency), quotes: (q.quotes || []).map((r: any) => ({ ...r, currency: one(r.currency) })) }
      )
      store.save('inquiries')
    }
    return { changed: n, data: all() }
  })

  // AI 用户档案（用户本人改的不受锁定限制）
  h('profile:get', () => getProfile(store))
  h('profile:markdown', () => profileMarkdown(store))
  h('profile:save', (s: any) => saveSection(store, s, '我').profile)
  h('profile:delete', (id: string) => deleteSection(store, id, '我').profile)
  h('profile:move', (id: string, d: number) => moveSection(store, id, d))
  h('profile:revert', (changeId: string) => revertChange(store, changeId))

  // 漫步用：所有项目导图上的备注
  h('wander:notes', () => {
    const out: any[] = []
    for (const p of store.projects) {
      const meta = store.meta(p.id)
      for (const [rel, m] of Object.entries<any>(meta.nodes)) if (m.note) out.push({ projectId: p.id, projectName: p.name, rel, note: m.note })
    }
    return out
  })

  for (const kind of ['contacts', 'reviews', 'focus', 'cards', 'companies', 'inquiries'] as Kind[]) {
    h(`${kind}:save`, (x: any) => {
      // 联系人的 org 字段跟着所属单位名走，搜索和 AI 助手直接用
      if (kind === 'contacts' && x.companyId) x = { ...x, org: store.companies.find((c) => c.id === x.companyId)?.name || x.org || '' }
      upsert(store[kind] as any[], x)
      store.save(kind)
      if (kind === 'companies' && store.contacts.some((c) => c.companyId === x.id && c.org !== x.name)) {
        store.contacts = store.contacts.map((c) => (c.companyId === x.id ? { ...c, org: x.name } : c))
        store.save('contacts')
      }
      return store[kind]
    })
  }
  h('reviews:delete', (id: string) => {
    store.reviews = store.reviews.filter((r) => r.id !== id)
    store.save('reviews')
    return store.reviews
  })
  // 删除联系人时，从项目和审查记录里一并去掉
  h('contacts:delete', (id: string) => {
    store.contacts = store.contacts.filter((c) => c.id !== id)
    store.projects = store.projects.map((p) => (p.contacts ? { ...p, contacts: p.contacts.filter((x: any) => x.contactId !== id) } : p))
    store.reviews = store.reviews.map((r) => ({ ...r, participants: (r.participants || []).filter((x: any) => x.contactId !== id) }))
    store.save('contacts')
    store.save('projects')
    store.save('reviews')
    return all()
  })

  // ---------- 项目导图 ----------
  h('project:tree', (id: string, showHidden: boolean) => scanProject(store, id, showHidden))

  h('project:addRefs', (id: string, parentRel: string, paths: string[]) => {
    const meta = store.meta(id)
    for (const p of paths) {
      if (meta.refs.some((r) => r.parentRel === parentRel && norm(r.path) === norm(p))) continue
      meta.refs.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), parentRel, path: p, name: path.basename(p) })
    }
    store.saveMeta(id, meta)
    return meta
  })

  h('project:removeRef', (id: string, refId: string) => {
    const meta = store.meta(id)
    meta.refs = meta.refs.filter((r) => r.id !== refId)
    store.saveMeta(id, meta)
    return meta
  })

  h('project:meta', (id: string, rel: string, patch: any) => {
    const meta = store.meta(id)
    const cur = { ...(meta.nodes[rel] || {}), ...patch }
    for (const k of Object.keys(cur)) if (cur[k] === null || cur[k] === '' || cur[k] === undefined) delete cur[k]
    if (Object.keys(cur).length) meta.nodes[rel] = cur
    else delete meta.nodes[rel]
    store.saveMeta(id, meta)
    return meta
  })

  let watcher: chokidar.FSWatcher | null = null
  let debounce: NodeJS.Timeout | null = null
  h('project:watch', async (id: string | null) => {
    if (watcher) await watcher.close()
    watcher = null
    if (!id) return
    const root = projectRoot(store, id)
    if (!fs.existsSync(root)) return
    watcher = chokidar.watch(root, { ignoreInitial: true, depth: 30, ignored: /node_modules|\.git[\\/]/ })
    watcher.on('all', () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => getWin()?.webContents.send('project:changed', id), 400)
    })
  })

  // ---------- 文件操作 ----------
  const abs = (id: string, rel: string) => safeJoin(projectRoot(store, id), rel)

  h('fs:mkdir', (id: string, rel: string, name: string) => {
    const dir = path.join(abs(id, rel), name.replace(/[\\/:*?"<>|]/g, '_'))
    if (fs.existsSync(dir)) throw new Error('同名文件夹已存在')
    fs.mkdirSync(dir)
    return path.relative(projectRoot(store, id), dir).split(path.sep).join('/')
  })

  h('fs:rename', (id: string, rel: string, newName: string) => {
    const from = abs(id, rel)
    const to = path.join(path.dirname(from), newName.replace(/[\\/:*?"<>|]/g, '_'))
    if (fs.existsSync(to)) throw new Error('同名文件已存在')
    fs.renameSync(from, to)
    const newRel = path.relative(projectRoot(store, id), to).split(path.sep).join('/')
    renameProjectRefs(store, id, rel, newRel)
    // 备注、颜色跟着改名走
    const meta = store.meta(id)
    for (const k of Object.keys(meta.nodes)) {
      if (k === rel || k.startsWith(rel + '/')) {
        meta.nodes[newRel + k.slice(rel.length)] = meta.nodes[k]
        delete meta.nodes[k]
      }
    }
    for (const r of meta.refs) {
      if (r.parentRel === rel || r.parentRel.startsWith(rel + '/')) r.parentRel = newRel + r.parentRel.slice(rel.length)
    }
    store.saveMeta(id, meta)
    // 所有项目里指向这个文件（或这个文件夹里文件）的引用，跟着改路径
    const oldAbs = norm(from)
    for (const p of store.projects) {
      const m = store.meta(p.id)
      let changed = false
      for (const r of m.refs) {
        const n = norm(r.path)
        if (n === oldAbs || n.startsWith(oldAbs + path.sep)) {
          r.path = to + r.path.slice(from.length)
          r.name = path.basename(r.path)
          changed = true
        }
      }
      if (changed) store.saveMeta(p.id, m)
    }
    return newRel
  })

  // 备忘录：插入图片 / 录音 / 视频 / 附件，引用资料库和项目文件
  h('memo:import', (owner: string, paths: string[]) => importMedia(store, owner, paths))
  h('memo:save', (owner: string, name: string, data: ArrayBuffer, kind?: string) => saveMedia(store, owner, name, data, kind))
  h('memo:findRefs', (t: RefTarget) => findRefs(store, t))
  h('memo:refStatus', (refs: any[]) => memoRefStatus(store, refs))
  h('memo:openRef', (r: any) => shell.openPath(refPath(store, r)))
  h('memo:revealRef', (r: any) => shell.showItemInFolder(refPath(store, r)))

  h('fs:trash', async (id: string, rel: string) => {
    if (!rel) throw new Error('不能删除项目根文件夹')
    await shell.trashItem(abs(id, rel))
    return true
  })

  h('fs:import', async (id: string, destRel: string, paths: string[]) => {
    const win = getWin()
    const dest = abs(id, destRel)
    const r = await dialog.showMessageBox(win!, {
      type: 'question',
      title: '归档文件',
      message: `把 ${paths.length} 项放到「${destRel || '项目根目录'}」`,
      detail: paths.slice(0, 6).map((p) => path.basename(p)).join('\n') + (paths.length > 6 ? '\n…' : ''),
      buttons: ['移动过来', '复制过来', '只建引用（文件不动）', '取消'],
      defaultId: 0,
      cancelId: 3
    })
    if (r.response === 3) return []
    if (r.response === 2) {
      const meta = store.meta(id)
      for (const p of paths) meta.refs.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), parentRel: destRel, path: p, name: path.basename(p) })
      store.saveMeta(id, meta)
      return paths
    }
    return importPaths(dest, paths, r.response === 0 ? 'move' : 'copy')
  })

  h('fs:open', (id: string, rel: string) => shell.openPath(abs(id, rel)))
  h('fs:reveal', (id: string, rel: string) => shell.showItemInFolder(abs(id, rel)))
  h('fs:copyPath', (id: string, rel: string) => clipboard.writeText(abs(id, rel)))
  h('shell:openPath', (p: string) => shell.openPath(p))
  h('shell:reveal', (p: string) => shell.showItemInFolder(p))
  h('clipboard:text', (t: string) => clipboard.writeText(t))

  ipcMain.on('fs:startDrag', (e, id: string, rel: string) => {
    try {
      e.sender.startDrag({ file: abs(id, rel), icon: dragIcon() })
    } catch {}
  })
  ipcMain.on('fs:startDragAbs', (e, p: string) => {
    try {
      e.sender.startDrag({ file: p, icon: dragIcon() })
    } catch {}
  })

  h('preview', (id: string, rel: string) => previewData(abs(id, rel)))
  h('previewAbs', (p: string) => previewData(p))

  // ---------- 导出项目台账 ----------
  h('export:ledger', async (ids: string[]) => {
    const d = new Date()
    const name = `项目台账 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.xlsx`
    const r = await dialog.showSaveDialog(getWin()!, { title: '导出项目台账', defaultPath: name, filters: [{ name: 'Excel', extensions: ['xlsx'] }] })
    if (r.canceled || !r.filePath) return null
    const stageName = (sid: string) => store.settings.stages.find((s: any) => s.id === sid)?.name || ''
    const list = store.projects.filter((p) => ids.includes(p.id))
    const rows = list.map((p, i) => ({
      序号: i + 1,
      项目编号: p.code || '',
      项目名称: p.name,
      主项目: store.projects.find((x) => x.id === p.parentId)?.name || '',
      阶段: stageName(p.stage),
      状态: p.status || '',
      负责人: p.owner || '',
      参与人: (p.members || []).join('、'),
      委托单位: p.client || '',
      项目地点: p.location || '',
      截止日期: p.deadline || '',
      未完成待办: store.todos.filter((t) => t.projectId === p.id && !t.done).length,
      审查次数: store.reviews.filter((x) => x.projectId === p.id).length,
      项目文件夹: p.rootPath || '',
      备注: p.description || ''
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [6, 14, 34, 24, 10, 8, 8, 18, 22, 16, 12, 10, 8, 50, 30].map((w) => ({ wch: w }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '项目台账')
    try {
      XLSX.writeFile(wb, r.filePath)
    } catch (e: any) {
      throw new Error(e.code === 'EBUSY' ? '这个文件正被 Excel 打开着，请先关掉再导出' : '导出失败：' + e.message)
    }
    const m = await dialog.showMessageBox(getWin()!, {
      type: 'info',
      message: `已导出 ${rows.length} 个项目`,
      detail: r.filePath,
      buttons: ['打开', '在资源管理器中显示', '关闭'],
      cancelId: 2
    })
    if (m.response === 0) shell.openPath(r.filePath)
    if (m.response === 1) shell.showItemInFolder(r.filePath)
    return r.filePath
  })

  h('dialog:pickFiles', async (title: string, defaultPath?: string, filters?: Electron.FileFilter[]) => {
    const r = await dialog.showOpenDialog(getWin()!, { title, defaultPath, filters: filters?.length ? [...filters, { name: '所有文件', extensions: ['*'] }] : undefined, properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })

  h('dialog:pickFolder', async (title: string) => {
    const r = await dialog.showOpenDialog(getWin()!, { title, properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // ---------- 资料库 ----------
  h('library:import', (paths: string[], typeId: string) => {
    importToLibrary(store, paths, typeId)
    return store.library
  })
  h('library:pickImport', async (typeId: string) => {
    const r = await dialog.showOpenDialog(getWin()!, { title: '导入资料', properties: ['openFile', 'multiSelections'] })
    if (r.canceled || !r.filePaths.length) return store.library
    importToLibrary(store, r.filePaths, typeId)
    return store.library
  })
  h('library:save', (item: any) => {
    upsert(store.library, item)
    store.save('library')
    return store.library
  })
  h('library:delete', async (id: string) => {
    const item = store.library.find((x) => x.id === id)
    if (item) {
      try {
        await shell.trashItem(libAbs(store, item))
      } catch {}
    }
    store.library = store.library.filter((x) => x.id !== id)
    store.save('library')
    return store.library
  })
  h('library:scan', () => scanLibrary(store))
  h('library:applyScan', (removeIds: string[], addRels: string[]) => applyLibraryScan(store, removeIds, addRels))
  h('library:abs', (id: string) => {
    const item = store.library.find((x) => x.id === id)
    return item ? libAbs(store, item) : null
  })
  h('library:setDir', (dir: string) => {
    moveLibraryDir(store, dir)
    return all()
  })
  // 用模板在项目里新建文件：选项目里的文件夹和文件名，复制过去
  h('library:useTemplate', async (id: string, projectId: string) => {
    const item = store.library.find((x) => x.id === id)
    if (!item) throw new Error('找不到这份资料')
    const root = projectRoot(store, projectId)
    const src = libAbs(store, item)
    const r = await dialog.showSaveDialog(getWin()!, {
      title: '用模板新建文件（选择放在项目的哪个文件夹）',
      defaultPath: path.join(root, path.basename(src)),
      filters: [{ name: '同类型文件', extensions: [path.extname(src).slice(1) || '*'] }]
    })
    if (r.canceled || !r.filePath) return null
    const base = norm(root)
    if (norm(r.filePath) !== base && !norm(r.filePath).startsWith(base + path.sep)) throw new Error('请把新文件放在这个项目的文件夹里')
    fs.copyFileSync(src, r.filePath)
    const m = await dialog.showMessageBox(getWin()!, { type: 'info', message: '已新建文件', detail: r.filePath, buttons: ['打开', '在资源管理器中显示', '关闭'], cancelId: 2 })
    if (m.response === 0) shell.openPath(r.filePath)
    if (m.response === 1) shell.showItemInFolder(r.filePath)
    return path.relative(root, r.filePath).split(path.sep).join('/')
  })

  // ---------- 知识库 ----------
  h('kb:list', () => listPages(store))
  h('kb:save', (page: any, versionName?: string) => savePage(store, page, versionName))
  h('kb:history', (id: string) => listHistory(store, id))
  h('kb:version', (id: string, file: string) => readVersion(store, id, file))
  h('kb:purge', (id: string) => {
    purgePage(store, id)
    purgeMedia(store, id)
    return listPages(store)
  })

  // ---------- 数据包 ----------
  h('pack:export', (o: any) => exportPack(store, o, (done, total) => getWin()?.webContents.send('pack:progress', done, total)))
  h('pack:pick', async () => {
    const r = await dialog.showOpenDialog(getWin()!, { title: '选择数据包文件夹（里面有 manifest.json）', properties: ['openDirectory'] })
    if (r.canceled) return null
    return { dir: r.filePaths[0], info: packInfo(r.filePaths[0]) }
  })
  h('pack:import', async (dir: string, o: any) => {
    const r = await importPack(store, dir, o)
    fileIndex.clear()
    return { ...r, data: all() }
  })

  // ---------- 全局搜索 ----------
  h('search', (q: string) => searchAll(store, q))

  // 地名搜索：OpenStreetMap 的 Nominatim，不需要 Key。
  // 它的使用规则要求带上标明应用的 User-Agent、每秒不超过 1 次，这里只在用户点「搜索」时请求。
  let lastGeo = 0
  h('geo:search', async (q: string) => {
    const wait = 1100 - (Date.now() - lastGeo)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastGeo = Date.now()
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=zh-CN,zh,en&q=${encodeURIComponent(q)}`
    const r = await net.fetch(url, { headers: { 'User-Agent': `ProjectDesk/${app.getVersion()} (desktop app)` } })
    if (!r.ok) throw new Error(`地名搜索失败（HTTP ${r.status}）`)
    const list: any[] = await r.json()
    return list.map((x) => ({ name: x.name || x.display_name.split(',')[0], address: x.display_name, lat: Number(x.lat), lng: Number(x.lon) }))
  })

  // ---------- AI 接入（MCP） ----------
  h('ai:status', () => aiStatus())
  h('ai:restart', () => restartMcp(store, getWin))
  h('ai:log', () => aiLog())
  h('ai:undo', async (id: string) => {
    await undoAiAction(store, id)
    return { log: aiLog(), data: all() }
  })

  h('workspace:move', async (dir: string) => {
    await store.moveRoot(dir)
    fileIndex.clear()
    return all()
  })

  restartMcp(store, getWin)

  // 启动后在后台把所有项目扫一遍，建立文件名搜索索引
  setTimeout(() => {
    for (const p of store.projects) {
      try {
        if (p.rootPath) scanProject(store, p.id)
      } catch {}
    }
  }, 1500)
}
