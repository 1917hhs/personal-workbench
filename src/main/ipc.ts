import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, net, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import chokidar from 'chokidar'
import * as XLSX from 'xlsx'
import type { Kind, Store } from './store'
import { importPaths, previewData, safeJoin } from './files'
import { clean as cleanName, organizeQuoteFiles, storeCompanyFiles, storeInquiryFiles, trashInquiryFiles } from './procure'
import { ASR_MODELS, asrStatus, cancelDownload, defaultAsrRoot, downloadModel, isInstalled, moveAsrRoot, removeModel, setAsrRoot, transcribe } from './asr'
import { applyLibraryScan, importToLibrary, libAbs, libraryTypeDir, moveLibraryDir, moveToTypeDir, renameLibraryType, scanLibrary } from './library'
import { listHistory, listPages, purgePage, readVersion, savePage } from './kb'
import { exportPack, importPack, packInfo } from './pack'
import { afterProjectRename, assertNotRoot, assertUnlocked, lockedProjectOf, fileIndex, folderId, listStars, norm, projectRoot, relinkProject, retargetAbs, scanProject, searchAll, setOnDataChanged, upsert } from './shared'
import { aiLog, aiStatus, restartMcp, undoAiAction } from './mcp'
import { findRefs, importMedia, purgeMedia, refPath, refStatus as memoRefStatus, renameProjectRefs, saveMedia, type RefTarget } from './memo'
import { deleteSection, getProfile, moveSection, profileMarkdown, revertChange, saveSection } from './profile'
import { buildInquiryBook, exportOptions, type ExportReq } from './inqExport'
import { buildCostBook, buildLedgerBook } from './costExport'

// 生成一个 16x16 的小图标，用于把文件从导图拖到微信、资源管理器
function dragIcon() {
  const buf = Buffer.alloc(16 * 16 * 4)
  for (let i = 0; i < 256; i++) buf.set([0xe0, 0x6a, 0x4f, 0xff], i * 4) // BGRA
  return nativeImage.createFromBitmap(buf, { width: 16, height: 16 })
}

export function registerIpc(store: Store, getWin: () => BrowserWindow | null) {
  const h = (ch: string, fn: (...a: any[]) => any) => ipcMain.handle(ch, (_e, ...a) => fn(...a))
  setOnDataChanged(() => getWin()?.webContents.send('data:changed'))
  // 选文件 / 保存 / 提示框关掉后，同样把焦点还给窗口，免得输入框打不了字
  for (const k of ['showOpenDialog', 'showSaveDialog', 'showMessageBox'] as const) {
    const orig = (dialog as any)[k].bind(dialog)
    ;(dialog as any)[k] = async (...a: any[]) => {
      try {
        return await orig(...a)
      } finally {
        const w = a[0] instanceof BrowserWindow ? a[0] : getWin()
        if (w && !w.isDestroyed()) {
          w.focus()
          w.webContents.focus()
        }
      }
    }
  }
  const all = () => ({
    settings: store.settings,
    projects: store.projects,
    todos: store.todos,
    stickies: store.stickies,
    contacts: store.contacts,
    library: store.library,
    focus: store.focus,
    libraryDir: store.libraryDir,
    dataDir: store.dataDir,
    root: store.root,
    companyDir: store.companyDir,
    backupDir: store.backupDir,
    migratedFrom: store.migratedFrom,
    loadProblems: store.loadProblems,
    companies: store.companies,
    inquiries: store.inquiries,
    flows: store.flows,
    costs: store.costs,
    stars: listStars(store),
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

  /** 项目文件夹不能是磁盘根目录、系统文件夹，也不能包含工作台自己的数据 */
  const checkProjectFolder = (dir?: string) => {
    if (!dir) return
    const d = norm(dir)
    if (path.parse(d).root === d || d === path.parse(d).root.replace(/\\$/, '')) throw new Error('不能把整个磁盘当作项目文件夹，请选具体的项目文件夹')
    const sys = [app.getPath('home'), app.getPath('desktop'), app.getPath('documents'), app.getPath('downloads'), process.env.WINDIR || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files'].map(norm)
    if (sys.includes(d)) throw new Error('不能把整个「' + dir + '」当作项目文件夹，请在里面选具体的项目文件夹')
    const mine = [store.root, store.dataDir, store.libraryDir, store.companyDir, store.backupDir].map(norm)
    if (mine.some((m) => m === d || m.startsWith(d + path.sep))) throw new Error('这个文件夹里有工作台自己的数据，不能当作项目文件夹')
  }

  h('projects:save', (p: any) => {
    const old = store.projects.find((x) => x.id === p.id)
    const moved = p.rootPath && p.rootPath !== old?.rootPath
    if (moved) checkProjectFolder(p.rootPath)
    upsert(store.projects, p)
    if (moved) {
      const cur = store.projects.find((x) => x.id === p.id)
      const oldId = old?.rootId || (old?.rootPath ? folderId(old.rootPath) : '')
      cur.rootId = folderId(p.rootPath)
      // 重新关联到改了名 / 挪了位置的同一个文件夹：引用、询价文件路径跟着改
      //（原文件夹还在、换成了另一个文件夹时不动，免得把指向原文件夹的引用改错）
      if (old?.rootPath && (!fs.existsSync(old.rootPath) || (oldId && oldId === cur.rootId))) retargetAbs(store, old.rootPath, p.rootPath)
    }
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

  // ---------- 项目锁定 ----------
  /** 项目文件夹里的所有文件（相对路径），跳过 node_modules / .git */
  const allFiles = (root: string) => {
    const out: string[] = []
    const walk = (dir: string, rel: string) => {
      let list: fs.Dirent[] = []
      try {
        list = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const d of list) {
        if (d.name === 'node_modules' || d.name === '.git') continue
        const r = rel ? rel + '/' + d.name : d.name
        if (d.isDirectory()) walk(path.join(dir, d.name), r)
        else if (d.isFile()) out.push(r)
      }
    }
    walk(root, '')
    return out
  }
  const isReadonly = (f: string) => (fs.statSync(f).mode & 0o200) === 0
  // 锁定：记下时间和原因；readonly 时把还可写的文件设成只读（记下是哪些，解锁时只恢复这些）
  h('projects:lock', (id: string, opt: { note?: string; readonly?: boolean } = {}) => {
    const p = store.projects.find((x) => x.id === id)
    if (!p) throw new Error('找不到项目')
    let changed = 0
    const failed: string[] = []
    const made: string[] = []
    if (opt.readonly && p.rootPath && fs.existsSync(p.rootPath)) {
      for (const r of allFiles(p.rootPath)) {
        const f = path.join(p.rootPath, r)
        try {
          if (isReadonly(f)) continue
          fs.chmodSync(f, 0o444)
          made.push(r)
          changed++
        } catch {
          failed.push(r)
        }
      }
      const meta = store.meta(id)
      meta.lockReadonly = [...new Set([...(meta.lockReadonly || []), ...made])]
      store.saveMeta(id, meta)
    }
    p.locked = { at: new Date().toISOString(), note: (opt.note || '').trim(), readonly: !!opt.readonly }
    store.save('projects')
    return { projects: store.projects, changed, failed: failed.slice(0, 20), failedCount: failed.length }
  })
  // 解锁：恢复锁定时设成只读的那些文件（原来就只读的不动）
  h('projects:unlock', (id: string) => {
    const p = store.projects.find((x) => x.id === id)
    if (!p) throw new Error('找不到项目')
    const meta = store.meta(id)
    let restored = 0
    const missing: string[] = []
    for (const r of meta.lockReadonly || []) {
      const f = p.rootPath ? path.join(p.rootPath, r) : ''
      try {
        if (f && fs.existsSync(f)) {
          if (isReadonly(f)) fs.chmodSync(f, 0o666)
          restored++
        } else missing.push(r)
      } catch {
        missing.push(r)
      }
    }
    delete meta.lockReadonly
    store.saveMeta(id, meta)
    delete p.locked
    store.save('projects')
    return { projects: store.projects, restored, missing: missing.length }
  })

  // 新建项目的文件夹：template 按模板建；empty 只建一个以项目命名的空文件夹；existing 关联已有；none 不关联
  h('projects:create', (p: any, folder: { mode: 'template' | 'empty' | 'existing' | 'none'; path?: string; templateId?: string }) => {
    if (folder.mode === 'template' || folder.mode === 'empty') {
      const base = store.settings.projectsRoot
      if (!base) throw new Error('请先在设置里指定「项目根目录」')
      const name = cleanName([p.code, p.name].filter(Boolean).join(' '))
      if (!String(p.name || '').trim()) throw new Error('请先填写项目名称')
      const dir = path.join(base, name)
      if (store.projects.some((x) => x.rootPath && norm(x.rootPath) === norm(dir))) throw new Error(`「${name}」文件夹已经是别的项目的文件夹了，换个名字`)
      fs.mkdirSync(dir, { recursive: true })
      if (folder.mode === 'template') {
        const t = templateOf(folder.templateId)
        makeFolders(dir, t.folders)
        p.templateId = t.id
      }
      p.rootPath = dir
    } else if (folder.mode === 'existing') {
      checkProjectFolder(folder.path)
      p.rootPath = folder.path
    }
    if (p.rootPath) p.rootId = folderId(p.rootPath)
    upsert(store.projects, p)
    store.save('projects')
    return store.projects
  })

  // 在软件里给项目文件夹改名：文件夹改名，项目路径、引用、询价文件路径一起改
  h('projects:renameFolder', async (id: string, name: string) => {
    assertUnlocked(store, id)
    const p = store.projects.find((x) => x.id === id)
    if (!p?.rootPath) throw new Error('项目还没有关联文件夹')
    if (!fs.existsSync(p.rootPath)) throw new Error('找不到项目文件夹：' + p.rootPath)
    const nm = cleanName(name)
    if (!nm) throw new Error('名字不能为空')
    const to = path.join(path.dirname(p.rootPath), nm)
    if (to === p.rootPath) return store.projects
    if (norm(to) !== norm(p.rootPath) && fs.existsSync(to)) throw new Error(`同一位置已经有「${nm}」了`)
    const from = p.rootPath
    // 先停掉监听再改名，改完（或失败）按当时的路径接着监听
    const wasWatching = watchedId
    await stopWatch()
    try {
      fs.renameSync(from, to)
    } catch (e: any) {
      await startWatch(wasWatching)
      if (e?.code === 'EPERM' || e?.code === 'EBUSY' || e?.code === 'EACCES')
        throw new Error('文件夹里有文件正被别的程序打开（Word、Excel、资源管理器预览窗格等），关掉后再试')
      throw e
    }
    p.rootPath = to
    store.save('projects')
    retargetAbs(store, from, to)
    if (wasWatching) await startWatch(wasWatching)
    return store.projects
  })
  h('projects:openFolder', (id: string) => {
    const p = store.projects.find((x) => x.id === id)
    if (!p?.rootPath) throw new Error('项目还没有关联文件夹')
    if (!fs.existsSync(p.rootPath)) {
      relinkProject(store, p)
      if (!fs.existsSync(p.rootPath)) throw new Error('找不到项目文件夹（可能在资源管理器里改了名或挪走了）：' + p.rootPath)
    }
    return shell.openPath(p.rootPath)
  })

  // rel 为空：补到项目根目录；否则补到项目里的这个子文件夹
  h('projects:applyTemplate', (id: string, templateId?: string, rel?: string) => {
    assertUnlocked(store, id)
    const root = projectRoot(store, id)
    const t = templateOf(templateId)
    const target = rel ? safeJoin(root, rel) : root
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error('选中的不是文件夹：' + rel)
    const created = makeFolders(target, t.folders)
    const p = store.projects.find((x) => x.id === id)
    if (!rel && p && p.templateId !== t.id) {
      p.templateId = t.id
      store.save('projects')
    }
    return { created, name: t.name, projects: store.projects }
  })

  // ---------- 询价 ----------
  // 询价文件 / 回价文件「上传」：复制进项目文件夹（见 procure.ts）
  h('inquiry:trashFiles', (paths: string[]) => {
    const lp = paths.map((p) => lockedProjectOf(store, p)).find(Boolean)
    if (lp) throw new Error(`项目「${lp.name}」已锁定，里面的询价 / 回价文件不能删除，先解锁`)
    return trashInquiryFiles(store, paths)
  })
  h('company:storeFiles', (name: string, kind: 'docs' | 'experience', paths: string[]) => storeCompanyFiles(store, name, kind, paths))
  h('company:openFolder', (name: string) => {
    const dir = path.join(store.companyDir, cleanName(name))
    fs.mkdirSync(dir, { recursive: true })
    return shell.openPath(dir)
  })
  h('inquiry:storeFiles', (inquiry: { projectId?: string; name: string }, kind: 'version' | 'quote', sub: string, paths: string[]) => {
    assertUnlocked(store, inquiry.projectId)
    return storeInquiryFiles(store, inquiry, kind, sub, paths)
  })

  // 导出：一条询价的比价表，或同一项目几条询价的汇总表（工作表、回价字段可选，见 inqExport.ts）
  h('inquiry:exportOptions', () => exportOptions())
  h('inquiry:export', async (req: ExportReq | string) => {
    const r0 = typeof req === 'string' ? { inquiryIds: [req] } : req
    const { buffer, fileName } = buildInquiryBook(store, r0)
    const r = await dialog.showSaveDialog(getWin()!, { title: r0.inquiryIds.length > 1 ? '导出询价汇总' : '导出比价表', defaultPath: fileName, filters: [{ name: 'Excel', extensions: ['xlsx'] }] })
    if (r.canceled || !r.filePath) return null
    try {
      fs.writeFileSync(r.filePath, buffer)
    } catch (e: any) {
      throw new Error(e.code === 'EBUSY' || e.code === 'EPERM' ? '这个文件正被 Excel 打开着，请先关掉再导出' : '导出失败：' + e.message)
    }
    const m = await dialog.showMessageBox(getWin()!, { type: 'info', message: '已导出', detail: r.filePath, buttons: ['打开', '在资源管理器中显示', '关闭'], cancelId: 2 })
    if (m.response === 0) shell.openPath(r.filePath)
    if (m.response === 1) shell.showItemInFolder(r.filePath)
    return r.filePath
  })

  // 履约成本表导出 Excel（见 costExport.ts）
  h('cost:export', async (arg: string | { ledger: any }) => {
    const { buffer, fileName } = typeof arg === 'string' ? buildCostBook(store, arg) : buildLedgerBook(store, arg.ledger)
    const r = await dialog.showSaveDialog(getWin()!, { title: typeof arg === 'string' ? '导出履约成本' : '导出合同台账', defaultPath: fileName, filters: [{ name: 'Excel', extensions: ['xlsx'] }] })
    if (r.canceled || !r.filePath) return null
    try {
      fs.writeFileSync(r.filePath, buffer)
    } catch (e: any) {
      throw new Error(e.code === 'EBUSY' || e.code === 'EPERM' ? '这个文件正被 Excel 打开着，请先关掉再导出' : '导出失败：' + e.message)
    }
    const m = await dialog.showMessageBox(getWin()!, { type: 'info', message: '已导出', detail: r.filePath, buttons: ['打开', '在资源管理器中显示', '关闭'], cancelId: 2 })
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
    assertUnlocked(store, id)
    store.projects = store.projects.filter((p) => p.id !== id).map((p) => (p.parentId === id ? { ...p, parentId: null } : p))
    store.todos = store.todos.map((t) => (t.projectId === id ? { ...t, projectId: null } : t))
    // 询价保留，改成「未关联项目」，不留指向已删项目的 id
    store.inquiries = store.inquiries.map((x) => (x.projectId === id ? { ...x, projectId: null } : x))
    store.save('projects')
    store.save('todos')
    store.save('inquiries')
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

  for (const kind of ['companies', 'inquiries', 'flows', 'costs'] as Kind[]) {
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

  for (const kind of ['contacts', 'focus', 'companies', 'inquiries', 'flows', 'costs'] as Kind[]) {
    h(`${kind}:save`, (x: any) => {
      // 联系人的 org 字段跟着所属单位名走，搜索和 AI 助手直接用
      if (kind === 'contacts' && x.companyId) x = { ...x, org: store.companies.find((c) => c.id === x.companyId)?.name || x.org || '' }
      if (!x?.id) throw new Error('数据缺少 id，没有保存')
      upsert(store[kind] as any[], x)
      store.save(kind)
      if (kind === 'inquiries') organizeQuoteFiles(store, [x.id]) // 回价文件挪到「第N轮」文件夹
      // 界面可能只传改动的字段，按合并后的记录来判断
      const merged = (store[kind] as any[]).find((y) => y.id === x.id)
      if (kind === 'companies' && merged?.name && store.contacts.some((c) => c.companyId === x.id && c.org !== merged.name)) {
        store.contacts = store.contacts.map((c) => (c.companyId === x.id ? { ...c, org: merged.name } : c))
        store.save('contacts')
      }
      return store[kind]
    })
  }
  // 删除联系人时，从项目联系人里一并去掉
  h('contacts:delete', (id: string) => {
    store.contacts = store.contacts.filter((c) => c.id !== id)
    store.projects = store.projects.map((p) => (p.contacts ? { ...p, contacts: p.contacts.filter((x: any) => x.contactId !== id) } : p))
    store.save('contacts')
    store.save('projects')
    return all()
  })

  // ---------- 项目导图 ----------
  h('project:tree', (id: string, showHidden: boolean) => scanProject(store, id, showHidden))

  h('project:addRefs', (id: string, parentRel: string, paths: string[]) => {
    assertUnlocked(store, id)
    const meta = store.meta(id)
    for (const p of paths) {
      if (meta.refs.some((r) => r.parentRel === parentRel && norm(r.path) === norm(p))) continue
      meta.refs.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), parentRel, path: p, name: path.basename(p) })
    }
    store.saveMeta(id, meta)
    return meta
  })

  h('project:removeRef', (id: string, refId: string) => {
    assertUnlocked(store, id)
    const meta = store.meta(id)
    meta.refs = meta.refs.filter((r) => r.id !== refId)
    store.saveMeta(id, meta)
    return meta
  })

  const patchNode = (meta: any, rel: string, patch: any) => {
    const cur = { ...(meta.nodes[rel] || {}), ...patch }
    for (const k of Object.keys(cur)) if (cur[k] === null || cur[k] === '' || cur[k] === undefined) delete cur[k]
    if (Object.keys(cur).length) meta.nodes[rel] = cur
    else delete meta.nodes[rel]
  }
  h('project:meta', (id: string, rel: string, patch: any) => {
    const meta = store.meta(id)
    patchNode(meta, rel, patch)
    store.saveMeta(id, meta)
    return meta
  })
  // 一次改多个节点（如收起 / 展开所有子文件夹），只写一次文件
  h('stars:list', () => listStars(store))
  h('project:metaMany', (id: string, list: { rel: string; patch: any }[]) => {
    const meta = store.meta(id)
    for (const x of list || []) patchNode(meta, x.rel, x.patch)
    store.saveMeta(id, meta)
    return meta
  })

  // 用系统自带的递归监听：只占项目文件夹一个句柄，资源管理器里照样能给项目文件夹 / 子文件夹改名、删除
  //（chokidar 会给每个子文件夹各开一个句柄，Windows 就提示「文件夹正在使用」不让改名）
  let watcher: { close(): any } | null = null
  let watchedId: string | null = null
  let debounce: NodeJS.Timeout | null = null
  const stopWatch = async () => {
    try {
      await watcher?.close()
    } catch {}
    watcher = null
  }
  const startWatch = async (id: string | null) => {
    await stopWatch()
    watchedId = id
    if (!id) return
    const root = projectRoot(store, id)
    if (!fs.existsSync(root)) return
    const notify = () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => getWin()?.webContents.send('project:changed', id), 400)
    }
    try {
      const w = fs.watch(root, { recursive: true }, (_e, f) => {
        if (f && /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(String(f))) return
        notify()
      })
      w.on('error', notify) // 文件夹被改名 / 删除：让界面重新读一遍（会自动找回）
      watcher = w
    } catch {
      const w = chokidar.watch(root, { ignoreInitial: true, depth: 30, ignored: /node_modules|\.git[\\/]/ })
      w.on('all', notify)
      watcher = w
    }
  }
  h('project:watch', (id: string | null) => startWatch(id))

  // ---------- 文件操作 ----------
  const abs = (id: string, rel: string) => safeJoin(projectRoot(store, id), rel)

  h('fs:mkdir', (id: string, rel: string, name: string) => {
    assertUnlocked(store, id)
    const dir = path.join(abs(id, rel), name.replace(/[\\/:*?"<>|]/g, '_'))
    if (fs.existsSync(dir)) throw new Error('同名文件夹已存在')
    fs.mkdirSync(dir)
    return path.relative(projectRoot(store, id), dir).split(path.sep).join('/')
  })

  h('fs:rename', (id: string, rel: string, newName: string) => {
    assertUnlocked(store, id)
    const from = abs(id, rel)
    assertNotRoot(store, id, from)
    const name = String(newName || '').replace(/[\\/:*?"<>|]/g, '_').trim().replace(/[. ]+$/, '')
    if (!name) throw new Error('名字不能为空')
    const to = path.join(path.dirname(from), name)
    // 只改大小写（a.pdf → A.pdf）时 Windows 认为同名文件已存在，要允许
    if (fs.existsSync(to) && norm(to) !== norm(from)) throw new Error('同名文件已存在')
    fs.renameSync(from, to)
    const newRel = path.relative(projectRoot(store, id), to).split(path.sep).join('/')
    renameProjectRefs(store, id, rel, newRel)
    afterProjectRename(store, id, rel, newRel, from, to)
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
    assertUnlocked(store, id)
    if (!rel) throw new Error('不能删除项目根文件夹')
    const target = abs(id, rel)
    assertNotRoot(store, id, target)
    await shell.trashItem(target)
    return true
  })

  h('fs:import', async (id: string, destRel: string, paths: string[]) => {
    assertUnlocked(store, id)
    // 从别的已锁定项目里「移动」出来也不行
    const lockedSrc = paths.map((p) => lockedProjectOf(store, p)).find(Boolean)
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
    if (r.response === 0 && lockedSrc) throw new Error(`这些文件在已锁定的项目「${lockedSrc.name}」里，不能移动，可以选「复制过来」`)
    return importPaths(dest, paths, r.response === 0 ? 'move' : 'copy')
  })

  // 打开前先确认还在，免得弹 Windows「找不到文件」的对话框
  const existing = (id: string, rel: string) => {
    const a = abs(id, rel)
    if (!fs.existsSync(a)) throw new Error('找不到：' + a + '（可能在资源管理器里改了名或挪走了，点「刷新」看看）')
    return a
  }
  h('fs:open', (id: string, rel: string) => shell.openPath(existing(id, rel)))
  h('fs:reveal', (id: string, rel: string) => shell.showItemInFolder(existing(id, rel)))
  h('fs:copyPath', (id: string, rel: string) => clipboard.writeText(abs(id, rel)))
  h('shell:openPath', (p: string) => shell.openPath(p))
  h('shell:reveal', (p: string) => shell.showItemInFolder(p))
  // 一组完整路径各自还在不在（待办里关联的文件，找不到的标出来）
  h('fs:existsMany', (paths: string[]) => (paths || []).map((p) => !!p && fs.existsSync(p)))
  h('clipboard:text', (t: string) => clipboard.writeText(t))

  // Windows 上 confirm / alert 弹窗关掉后，网页里的输入框会打不了字（要切到别的软件再切回来才好）：
  // 弹窗关掉后由界面通知这里，把窗口焦点重新给回去
  ipcMain.on('win:refocus', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w || w.isDestroyed()) return
    w.blur()
    w.focus()
    w.webContents.focus()
  })

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
      负责人: (Array.isArray(p.leads) ? p.leads.filter((l: any) => l?.name).map((l: any) => (l.role ? l.role + ' ' : '') + l.name).join('；') : p.owner || ''),
      参与人: (p.members || []).join('、'),
      委托单位: p.client || '',
      项目地点: p.location || '',
      开始日期: p.startDate || '',
      截止日期: p.deadline || '',
      未完成待办: store.todos.filter((t) => t.projectId === p.id && !t.done).length,
      询价: store.inquiries.filter((x) => x.projectId === p.id).length,
      项目文件夹: p.rootPath || '',
      备注: p.description || ''
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [6, 14, 34, 24, 10, 8, 30, 18, 22, 16, 12, 12, 10, 8, 50, 30].map((w) => ({ wch: w }))
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
    const old = store.library.find((x) => x.id === item.id)
    const oldType = old?.type
    upsert(store.library, item)
    // 改了类型：文件跟着挪到新类型的子文件夹
    const cur = store.library.find((x) => x.id === item.id)
    let moveErr = ''
    if (old && cur && item.type !== undefined && item.type !== oldType) {
      try {
        moveToTypeDir(store, cur, oldType)
      } catch (e: any) {
        moveErr = e?.code === 'EBUSY' || e?.code === 'EPERM' ? '文件正被别的程序打开' : String(e?.message || e)
      }
    }
    store.save('library')
    if (moveErr) throw new Error(`类型已改，但文件没能挪到新类型的文件夹（${moveErr}）。关掉文件后在资料库点「刷新」可按文件夹重新归类。`)
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
  h('library:applyScan', (removeIds: string[], addRels: string[], retypeIds?: string[]) => applyLibraryScan(store, removeIds, addRels, retypeIds))
  h('library:abs', (id: string) => {
    const item = store.library.find((x) => x.id === id)
    return item ? libAbs(store, item) : null
  })
  h('library:renameType', (id: string, name: string) => renameLibraryType(store, id, name))
  h('library:openTypeDir', (id: string) => shell.openPath(libraryTypeDir(store, id)))
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
  // ---------- 语音识别（本机离线） ----------
  const asrSel = () => store.settings.asr?.model || ''
  const setAsr = (id: string) => {
    store.settings.asr = { ...(store.settings.asr || {}), model: id }
    store.save('settings')
  }
  setAsrRoot(store.settings.asr?.dir || '')
  h('asr:status', () => asrStatus(asrSel()))
  // 换模型存放位置（空 = 恢复默认：软件安装目录）
  h('asr:setDir', (dir: string) => {
    const to = moveAsrRoot(dir)
    const custom = dir && path.resolve(to).toLowerCase() !== path.resolve(defaultAsrRoot()).toLowerCase() ? to : ''
    store.settings.asr = { ...(store.settings.asr || {}), dir: custom }
    store.save('settings')
    setAsrRoot(custom)
    return { status: asrStatus(asrSel()), settings: store.settings }
  })
  h('asr:download', async (id: string) => {
    await downloadModel(id, (p) => getWin()?.webContents.send('asr:progress', p))
    // 装好第一个识别模型时自动选用
    if (ASR_MODELS.find((m) => m.id === id)?.kind === 'asr' && !isInstalled(asrSel())) setAsr(id)
    return { status: asrStatus(asrSel()), settings: store.settings }
  })
  h('asr:cancel', (id: string) => cancelDownload(id))
  h('asr:remove', (id: string) => {
    removeModel(id)
    if (asrSel() === id) setAsr(ASR_MODELS.find((m) => m.kind === 'asr' && isInstalled(m.id))?.id || '')
    return { status: asrStatus(asrSel()), settings: store.settings }
  })
  h('asr:select', (id: string) => {
    if (!isInstalled(id)) throw new Error('先安装这个模型')
    setAsr(id)
    return { status: asrStatus(asrSel()), settings: store.settings }
  })
  h('asr:transcribe', (samples: Float32Array) => {
    const id = asrSel()
    if (!id || !isInstalled(id)) throw new Error('还没有可用的识别模型，请先到 设置 → 语音识别 里安装一个')
    return transcribe(id, samples, (done, total) => getWin()?.webContents.send('asr:part', done, total))
  })

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
