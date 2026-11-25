import { app } from 'electron'
import fs from 'fs'
import path from 'path'

// 所有数据都存成 JSON 文件，方便手动同步到网盘和人工查看。
// 写入时先写 .tmp 再改名，避免云盘上传半个文件。

export const DEFAULT_SETTINGS = {
  stages: [
    { id: 's1', name: '前期洽谈', color: '#64748b' },
    { id: 's2', name: '方案设计', color: '#3b82f6' },
    { id: 's3', name: '初步设计', color: '#6366f1' },
    { id: 's4', name: '施工图', color: '#8b5cf6' },
    { id: 's5', name: '施工配合', color: '#f59e0b' },
    { id: 's6', name: '竣工验收', color: '#10b981' },
    { id: 's7', name: '已归档', color: '#9ca3af' }
  ],
  statuses: ['洽谈中', '已签约', '进行中', '暂停', '未成交'],
  autoGroupVersions: true,
  // 单位与供应商库的下拉选项（设置里可改）
  supplierOptions: {
    unitTypes: ['供应商', '业主', '设计咨询', '施工单位', '政府部门', '专家单位', '其他'],
    category: ['分包类', '物资类', '服务类', '设备类'],
    role: ['专业分包商', '制造商', '劳务分包商', '经销商', '服务商', '设备租赁商'],
    specialties: ['土建', '机电', '混凝土', '桩基', '钢结构', '劳务', '道路', '总包/EPC', '地勘', '土方', '板房', '检验检测', '给排水暖通', '光伏项目', '测绘', '景观绿化', '设备'],
    countries: ['中国', '土耳其', '阿塞拜疆', '沙特', '其他'],
    status: ['名录收集', '资料收集中', '待审核', '已审核', '拟入库', '已入库', '暂做储备', '不合格'],
    stage: ['名录收集', '已接洽', '已询价／回价', '已考察', '已履约'],
    grade: ['A', 'B', 'C', 'D', '待评价'],
    docTypes: ['工商注册', '税务登记', '分供方资料审查表', '公司简介', '体系认证', '行业许可', '业绩证明', '财务资料', '其他'],
    currencies: ['CNY', 'USD', 'EUR', 'TRY', 'AZN', 'SAR']
  } as Record<string, string[]>,
  libraryTypes: [
    { id: 'std', name: '规范标准' },
    { id: 'tpl', name: '报告模板' },
    { id: 'data', name: '收集的数据' },
    { id: 'img', name: '影像资料' },
    { id: 'case', name: '地点与案例' },
    { id: 'other', name: '其他资料' }
  ],
  libraryDir: '',
  map: { provider: 'esri', key: '' },
  focus: { work: 25, shortBreak: 5, longBreak: 15, sound: true },
  // 语音识别：选用的本机识别模型 id（模型文件在用户数据目录 asr-models 下）
  asr: { model: '', dir: '' },
  ai: { level: 'off', port: 17321, token: '' },
  members: [] as { id: string; name: string; title?: string }[],
  // 项目目录模板：可以存多套，应对不同类型的工作。文件夹可以用「/」写多层，如「05 施工图/结构」
  templates: [
    {
      id: 'general',
      name: '通用（规划设计）',
      folders: ['00 甲方来件', '01 委托与任务', '02 基础资料', '03 方案与图纸', '04 专题计算与分析', '05 进度与汇报', '06 意见与回复', '07 成果与归档', '收集箱']
    },
    {
      id: 'consult',
      name: '工程咨询（可研）',
      folders: ['00 甲方来件', '01 委托与合同', '02 基础资料', '03 现场调研', '04 方案比选', '05 投资估算', '06 报告编制', '07 评审与修改', '08 成果与归档', '收集箱']
    },
    {
      id: 'cd',
      name: '施工图设计',
      folders: [
        '00 甲方来件',
        '01 任务书与合同',
        '02 基础资料/测绘',
        '02 基础资料/地勘',
        '03 方案设计',
        '04 初步设计',
        '05 施工图/建筑',
        '05 施工图/结构',
        '05 施工图/给排水',
        '05 施工图/电气',
        '06 审图意见与回复',
        '07 变更与洽商',
        '08 竣工资料',
        '收集箱'
      ]
    }
  ] as { id: string; name: string; folders: string[] }[],
  defaultTemplateId: 'general',
  hideGroups: [
    { id: 'cad', name: 'CAD 备份与临时文件', desc: 'AutoCAD 自动保存、备份、错误报告等', patterns: ['*.bak', '*.sv$', '*.ac$', '*.err', '*.dmp', 'plot.log', 'acad.err'], enabled: true },
    { id: 'cadplug', name: 'CAD 程序与插件文件', desc: 'LISP 程序、菜单、插件等', patterns: ['*.fas', '*.vlx', '*.lsp', '*.mnl', '*.arx', '*.dvb', '*.cuix'], enabled: true },
    { id: 'office', name: 'Office 临时与备份文件', desc: 'Word / Excel / WPS 临时文件和自动备份', patterns: ['~$*', '*.tmp', '*.wbk', '*.asd', '*.xlk'], enabled: true },
    { id: 'logs', name: '日志与缓存', desc: '运行日志，以及 temp / tmp / cache / 缓存 文件夹', patterns: ['*.log', 'temp/', 'tmp/', 'cache/', '缓存/', '临时文件/', 'Thumbs.db', 'desktop.ini', '.DS_Store'], enabled: true }
  ],
  customHide: [] as string[],
  colorLegend: [
    { color: '#3b82f6', label: '甲方资料' },
    { color: '#10b981', label: '已定稿' },
    { color: '#f59e0b', label: '待处理' },
    { color: '#ef4444', label: '重要' },
    { color: '#8b5cf6', label: '参考' }
  ],
  theme: 'system',
  projectsRoot: ''
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    // 去掉 BOM：用记事本等工具改过的文件开头可能带 BOM
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return fallback
  }
}

/** 读数据文件。文件在、但内容坏了（同步冲突、写一半断电）时，先把坏文件另存一份，免得下次保存把它覆盖掉 */
export function readDataFile<T>(file: string, fallback: T, problems: string[]): T {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    if (!text.trim()) return fallback
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const saved = file.replace(/\.json$/, '') + `.损坏-${stamp}.json`
    try {
      fs.copyFileSync(file, saved)
    } catch {}
    problems.push(`${path.basename(file)} 内容损坏，无法读取，已另存为 ${path.basename(saved)}`)
    return fallback
  }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  // 网盘客户端、杀毒软件偶尔会短暂占用文件，改名失败时稍等重试几次
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (e: any) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
      sleepSync(60 * (i + 1))
    }
  }
}

export type Kind = 'projects' | 'todos' | 'stickies' | 'settings' | 'contacts' | 'library' | 'focus' | 'companies' | 'inquiries' | 'flows'

const KINDS: Kind[] = ['projects', 'todos', 'stickies', 'settings', 'contacts', 'library', 'focus', 'companies', 'inquiries', 'flows']

/** 数据文件夹里软件认识的全部内容。备份、搬家、导出都只处理这些，别的文件一概不碰 */
export const DATA_FILES = [...KINDS.map((k) => k + '.json'), 'ai-log.json', 'profile.json']
export const DATA_DIRS = ['meta', 'kb', 'ai-backup']

/** 工作台根目录下的子文件夹 */
export const SUB = { data: '数据', library: '资料库', projects: '项目', backup: '备份', companies: '供应商与联系人' }

/** 默认根目录：有 D 盘就放 D:\个人工作台，否则放「文档\个人工作台」。不放安装目录，升级、卸载会清空那里 */
function defaultRoot() {
  if (process.env.PROJECT_DESK_USERDATA) return path.join(app.getPath('userData'), 'workspace')
  if (fs.existsSync('D:\\')) return 'D:\\个人工作台'
  return path.join(app.getPath('documents'), '个人工作台')
}

/** 只复制软件认识的数据；目标里已有的不覆盖。返回复制了几项 */
export function copyDataItems(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true })
  let n = 0
  for (const f of DATA_FILES) {
    const s = path.join(from, f)
    if (fs.existsSync(s) && !fs.existsSync(path.join(to, f))) {
      fs.copyFileSync(s, path.join(to, f))
      n++
    }
  }
  for (const d of DATA_DIRS) {
    const s = path.join(from, d)
    if (fs.existsSync(s) && !fs.existsSync(path.join(to, d))) {
      fs.cpSync(s, path.join(to, d), { recursive: true })
      n++
    }
  }
  return n
}

export class Store {
  configFile = path.join(app.getPath('userData'), 'config.json')
  /** 工作台根目录：下面有 数据 / 资料库 / 项目 / 备份 */
  root: string
  dataDir: string
  /** 第一次升级时从哪里搬的数据（只用于在设置里提示） */
  migratedFrom: string | null = null
  projects: any[] = []
  todos: any[] = []
  stickies: any[] = []
  contacts: any[] = []
  library: any[] = []
  focus: any[] = []
  companies: any[] = []
  inquiries: any[] = []
  /** 工作流程图（审批流程）：节点、连线、审批人、所需附件 */
  flows: any[] = []
  settings: any = structuredClone(DEFAULT_SETTINGS)
  /** 启动时读数据遇到的问题（文件损坏等），界面上提示一次 */
  loadProblems: string[] = []

  constructor() {
    const cfg = readJson<any>(this.configFile, {})
    let justMigrated = false
    if (cfg.workspaceRoot) {
      this.root = cfg.workspaceRoot
      this.migratedFrom = cfg.migratedFrom || null
    } else {
      // 旧版本：数据在 userData\data，或者用户改过的 dataDir。搬到新的根目录下（只搬软件认识的数据，旧位置保留）
      this.root = defaultRoot()
      const oldData = cfg.dataDir || path.join(app.getPath('userData'), 'data')
      const target = path.join(this.root, SUB.data)
      if (path.resolve(oldData) !== path.resolve(target) && fs.existsSync(oldData)) {
        copyDataItems(oldData, target)
        this.migratedFrom = oldData
      }
      const oldSettings = readJson<any>(path.join(oldData, 'settings.json'), {})
      const oldLib = oldSettings.libraryDir || path.join(app.getPath('userData'), 'library')
      const newLib = path.join(this.root, SUB.library)
      if (fs.existsSync(oldLib) && path.resolve(oldLib) !== path.resolve(newLib)) fs.cpSync(oldLib, newLib, { recursive: true, force: false })
      writeJsonAtomic(this.configFile, { workspaceRoot: this.root, migratedFrom: this.migratedFrom })
      justMigrated = true
    }
    this.dataDir = path.join(this.root, SUB.data)
    for (const d of Object.values(SUB)) fs.mkdirSync(path.join(this.root, d), { recursive: true })
    this.load()
    // 资料库和项目根目录默认放在工作台根目录下
    let changed = false
    // 搬迁那一次：旧的资料库已复制进新根目录，改用新位置；以后用户自己再指定的位置保留不动
    if (justMigrated && this.settings.libraryDir) {
      this.settings.libraryDir = ''
      changed = true
    }
    if (!this.settings.projectsRoot) {
      this.settings.projectsRoot = path.join(this.root, SUB.projects)
      changed = true
    }
    if (changed) this.save('settings')
  }

  get backupDir() {
    return path.join(this.root, SUB.backup)
  }

  file(name: string) {
    return path.join(this.dataDir, name)
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true })
    this.loadProblems = []
    const rd = (k: Kind) => {
      const v = readDataFile<any>(this.file(k + '.json'), [], this.loadProblems)
      return Array.isArray(v) ? v : []
    }
    this.projects = rd('projects')
    this.todos = rd('todos')
    this.stickies = rd('stickies')
    this.contacts = rd('contacts')
    this.library = rd('library')
    this.focus = rd('focus')
    this.companies = rd('companies')
    this.inquiries = rd('inquiries')
    this.flows = rd('flows')
    this.migrateContacts()
    const s = readDataFile<any>(this.file('settings.json'), {}, this.loadProblems)
    // 已删除功能（云盘同步、审查）留下的设置项
    delete s.backup
    delete s.reviewStages
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...s,
      map: { ...DEFAULT_SETTINGS.map, ...(s.map || {}) },
      ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai || {}) },
      focus: { ...DEFAULT_SETTINGS.focus, ...(s.focus || {}) },
      supplierOptions: { ...structuredClone(DEFAULT_SETTINGS.supplierOptions), ...(s.supplierOptions || {}) }
    }
    // 旧版本只有一套模板（settings.template），升级为多套：原来那套作为「通用」，另外补上预置模板
    const migrate = !s.templates && Array.isArray(s.template)
    if (migrate) {
      const preset = structuredClone(DEFAULT_SETTINGS.templates)
      preset[0].folders = s.template
      this.settings.templates = preset
      this.settings.defaultTemplateId = 'general'
    }
    delete this.settings.template
    // 升级后立刻写回，设置文件里不再留旧格式
    if (migrate) this.save('settings')
    if (!this.settings.templates?.length) this.settings.templates = structuredClone(DEFAULT_SETTINGS.templates)
    if (!this.settings.templates.some((t: any) => t.id === this.settings.defaultTemplateId)) this.settings.defaultTemplateId = this.settings.templates[0].id
    if (!fs.existsSync(this.file('settings.json'))) this.save('settings')
  }

  save(kind: Kind) {
    writeJsonAtomic(this.file(kind + '.json'), this[kind])
  }

  /** nodes：节点备注/颜色/折叠/隐藏/标签；refs：引用（一个文件挂在多个位置） */
  meta(projectId: string): { nodes: Record<string, any>; refs: any[] } {
    const m = readJson<any>(this.file(`meta/${projectId}.json`), {})
    return { nodes: m.nodes || {}, refs: m.refs || [] }
  }

  saveMeta(projectId: string, meta: any) {
    writeJsonAtomic(this.file(`meta/${projectId}.json`), meta)
  }

  /** 通讯录里只写了单位名称、还没绑定单位的人：按名称找到或建好单位，再绑定 */
  migrateContacts() {
    let changed = false
    for (const c of this.contacts) {
      if (c.companyId || !c.org?.trim()) continue
      let co = this.companies.find((x) => x.name === c.org.trim())
      if (!co) {
        co = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), name: c.org.trim(), unitType: '其他', createdAt: new Date().toISOString() }
        this.companies.push(co)
      }
      c.companyId = co.id
      changed = true
    }
    if (changed) {
      this.save('companies')
      this.save('contacts')
    }
  }

  /** 资料库文件放在这里（不放进数据文件夹，数据文件夹保持小巧） */
  get libraryDir() {
    return this.settings.libraryDir || path.join(this.root, SUB.library)
  }

  /** 供应商与联系人：每个单位一个子文件夹，放入库资料、项目经验等附件 */
  get companyDir() {
    return path.join(this.root, SUB.companies)
  }

  /**
   * 换工作台根目录：把 数据 / 资料库 / 项目 / 备份 四个子文件夹复制到新位置（旧位置保留），
   * 放在旧根目录「项目」下的项目文件夹，路径一并改过去。
   */
  async moveRoot(newRoot: string) {
    const old = this.root
    if (path.resolve(newRoot) === path.resolve(old)) return
    const inside = (p: string) => path.resolve(p).toLowerCase().startsWith(path.resolve(old).toLowerCase() + path.sep)
    if (inside(newRoot)) throw new Error('新位置不能放在当前根目录里面')
    fs.mkdirSync(newRoot, { recursive: true })
    copyDataItems(path.join(old, SUB.data), path.join(newRoot, SUB.data))
    for (const d of [SUB.library, SUB.projects, SUB.backup, SUB.companies]) {
      const s = path.join(old, d)
      if (fs.existsSync(s)) await fs.promises.cp(s, path.join(newRoot, d), { recursive: true, force: false, errorOnExist: false })
    }
    writeJsonAtomic(this.configFile, { workspaceRoot: newRoot })
    this.root = newRoot
    this.dataDir = path.join(newRoot, SUB.data)
    this.migratedFrom = null
    this.load()
    const swap = (p: string) => (p && inside(p) ? path.join(newRoot, path.relative(old, p)) : p)
    this.projects = this.projects.map((p) => ({ ...p, rootPath: swap(p.rootPath) }))
    this.save('projects')
    // 单位的入库资料、项目经验附件路径跟着换
    const swapFiles = (rows: any[]) => (rows || []).map((r: any) => ({ ...r, files: (r.files || []).map(swap) }))
    this.companies = this.companies.map((c) => ({ ...c, docs: swapFiles(c.docs), experience: swapFiles(c.experience) }))
    this.save('companies')
    if (this.settings.projectsRoot && (inside(this.settings.projectsRoot) || path.resolve(this.settings.projectsRoot) === path.resolve(old, SUB.projects))) {
      this.settings.projectsRoot = swap(this.settings.projectsRoot)
    }
    if (this.settings.libraryDir && inside(this.settings.libraryDir)) this.settings.libraryDir = ''
    this.save('settings')
  }
}
