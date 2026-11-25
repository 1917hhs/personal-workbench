import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app, BrowserWindow, shell } from 'electron'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import type { Store } from './store'
import { writeJsonAtomic, readJson } from './store'
import { compileHide, extOf, safeJoin, scanTree, uniqueTarget } from './files'
import { afterProjectRename, assertNotRoot, hidePatterns, norm, projectRoot, searchAll, stripHtml, upsert } from './shared'
import { listPages, purgePage, savePage } from './kb'
import { refsWarning, renameProjectRefs } from './memo'
import { flowSteps, flowText } from './flow'
import { importToLibrary, libAbs } from './library'
import { getProfile, profileMarkdown, revertChange, saveSection } from './profile'
import { afterQuote, companyStats, INQ_STATUS, latestQuotes, normName, QUOTE_FIELDS, SEND_STATUS, storeInquiryFiles, TAX, toUsd, validToFrom } from './procure'
import PROCUREMENT_GUIDE from '../../docs/AI-采购录入指南.md?raw'

// 让 WorkBuddy、Codex、Claude、Cursor、Cherry Studio 等支持 MCP 的 AI 助手直接使用个人工作台。
// 采用 MCP 的 Streamable HTTP 方式：只监听本机 127.0.0.1，必须带令牌（Bearer token），
// 拒绝带 Origin 头的请求（防止网页偷偷调用）。
// 访问权限：关闭 / 只读 / 可读写。可读写时，每次修改都会在软件里提示，并且可以撤销。

type Level = 'off' | 'read' | 'write'

interface Tool {
  name: string
  description: string
  write?: boolean
  inputSchema: any
  run: (args: any) => Promise<any> | any
}

interface Action {
  id: string
  time: string
  tool: string
  summary: string
  canUndo: boolean
  undone?: boolean
}

let server: http.Server | null = null
let status: { running: boolean; port: number; error: string | null; level: Level } = { running: false, port: 0, error: null, level: 'off' }
const actions: Action[] = []
const undoers = new Map<string, () => Promise<void> | void>()
let win: () => BrowserWindow | null = () => null
// 最近一次连接的 AI 客户端名称（initialize 时带来），用于在档案历史里标明是谁改的
let clientName = ''

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

export function aiStatus() {
  return status
}
export function aiLog() {
  return actions.slice().reverse()
}

function logPath(store: Store) {
  return path.join(store.dataDir, 'ai-log.json')
}

/** 记一条写操作：通知界面刷新、弹提示，并保存撤销方法（撤销只在本次运行期间有效） */
function record(store: Store, tool: string, summary: string, undo?: () => Promise<void> | void) {
  const a: Action = { id: newId(), time: new Date().toISOString(), tool, summary, canUndo: !!undo }
  actions.push(a)
  if (actions.length > 200) actions.shift()
  if (undo) undoers.set(a.id, undo)
  const log = readJson<any[]>(logPath(store), [])
  log.push({ time: a.time, tool, summary })
  writeJsonAtomic(logPath(store), log.slice(-1000))
  win()?.webContents.send('ai:action', a)
  win()?.webContents.send('data:changed')
  return a
}

export async function undoAiAction(store: Store, id: string) {
  const a = actions.find((x) => x.id === id)
  const fn = undoers.get(id)
  if (!a || !fn || a.undone) throw new Error('这一步不能撤销（可能已经撤销过，或软件重启过）')
  await fn()
  a.undone = true
  undoers.delete(id)
  win()?.webContents.send('data:changed')
}

// ---------- 文本提取 ----------
async function extractText(abs: string, max: number) {
  const e = extOf(abs)
  let text = ''
  if (['txt', 'md', 'csv', 'json', 'xml', 'log', 'ini', 'yaml', 'yml', 'geojson', 'html', 'htm'].includes(e)) {
    text = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '')
  } else if (e === 'docx') {
    text = (await mammoth.extractRawText({ path: abs })).value
  } else if (['xlsx', 'xls', 'xlsm', 'et', 'ods'].includes(e)) {
    const wb = XLSX.readFile(abs, { sheetRows: 500 })
    text = wb.SheetNames.slice(0, 10)
      .map((n) => `## 工作表：${n}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n]))
      .join('\n\n')
  } else {
    const st = fs.statSync(abs)
    return `（这种格式（.${e}）不能提取文字。文件大小 ${st.size} 字节，修改时间 ${new Date(st.mtimeMs).toLocaleString('zh-CN')}。可以让用户在个人工作台里打开查看。）`
  }
  return text.length > max ? text.slice(0, max) + `\n\n……（内容过长，只返回前 ${max} 个字符，共 ${text.length} 个）` : text
}

function htmlToText(html: string) {
  return stripHtml(
    String(html || '')
      .replace(/<h1[^>]*>/g, '\n# ')
      .replace(/<h2[^>]*>/g, '\n## ')
      .replace(/<h3[^>]*>/g, '\n### ')
      .replace(/<li[^>]*data-checked="true"[^>]*>/g, '\n- [x] ')
      .replace(/<li[^>]*data-checked="false"[^>]*>/g, '\n- [ ] ')
      .replace(/<li[^>]*>/g, '\n- ')
      .replace(/<\/(p|h\d|blockquote|tr)>/g, '\n')
      .replace(/<\/t[dh]>/g, ' | ')
      .replace(/<br\s*\/?>/g, '\n')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 简单的 Markdown → 知识库 HTML（标题、列表、待办、引用、段落） */
function markdownToHtml(md: string) {
  const out: string[] = []
  let list: 'ul' | 'ol' | 'task' | null = null
  const close = () => {
    if (list) out.push(list === 'ol' ? '</ol>' : '</ul>')
    list = null
  }
  const open = (k: 'ul' | 'ol' | 'task') => {
    if (list === k) return
    close()
    out.push(k === 'ol' ? '<ol>' : k === 'task' ? '<ul data-type="taskList">' : '<ul>')
    list = k
  }
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>')
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trimEnd()
    let m: RegExpMatchArray | null
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      close()
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`)
    } else if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) {
      open('task')
      out.push(`<li data-type="taskItem" data-checked="${m[1] !== ' '}"><p>${inline(m[2])}</p></li>`)
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      open('ul')
      out.push(`<li><p>${inline(m[1])}</p></li>`)
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      open('ol')
      out.push(`<li><p>${inline(m[1])}</p></li>`)
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      close()
      out.push(`<blockquote><p>${inline(m[1])}</p></blockquote>`)
    } else if (!line.trim()) {
      close()
    } else {
      close()
      out.push(`<p>${inline(line)}</p>`)
    }
  }
  close()
  return out.join('') || '<p></p>'
}

// ---------- 工具 ----------
function tools(store: Store): Tool[] {
  const stageName = (id: string) => store.settings.stages.find((s: any) => s.id === id)?.name || ''
  const projectBrief = (p: any) => ({
    id: p.id,
    name: p.name,
    code: p.code || '',
    client: p.client || '',
    location: p.location || '',
    stage: stageName(p.stage),
    status: p.status || '',
    owner: (Array.isArray(p.leads) ? p.leads.filter((l: any) => l?.name).map((l: any) => (l.role ? l.role + ' ' : '') + l.name).join('；') : p.owner || ''),
    startDate: p.startDate || '',
    deadline: p.deadline || '',
    progress: p.progress ?? null,
    parentProject: store.projects.find((x) => x.id === p.parentId)?.name || '',
    folder: p.rootPath || '',
    openTodos: store.todos.filter((t) => t.projectId === p.id && !t.done).length
  })
  const abs = (projectId: string, rel: string) => safeJoin(projectRoot(store, projectId), (rel || '').replace(/\\/g, '/').replace(/^\/+/, ''))
  const relOf = (projectId: string, a: string) => path.relative(projectRoot(store, projectId), a).split(path.sep).join('/')
  const str = { type: 'string' }
  const obj = (props: any, required: string[] = []) => ({ type: 'object', properties: props, required })

  /** 写文件：已存在的文件先备份，撤销时恢复 */
  const writeWithUndo = (target: string, write: () => void, tool: string, summary: string) => {
    let backup: string | null = null
    if (fs.existsSync(target)) {
      backup = path.join(store.dataDir, 'ai-backup', newId() + path.extname(target))
      fs.mkdirSync(path.dirname(backup), { recursive: true })
      fs.copyFileSync(target, backup)
    }
    write()
    return record(store, tool, summary, async () => {
      if (backup) fs.copyFileSync(backup, target)
      else await shell.trashItem(target)
    })
  }

  return [
    // ===== 用户档案（先读） =====
    {
      name: 'get_user_profile',
      description: '【开始工作前先调用】读取用户档案：用户的角色、工作习惯、询价与定标流程、文件命名规则、比价与汇报口径、偏好与禁忌。按档案里的做法协助用户。',
      inputSchema: obj({}),
      run: () => profileMarkdown(store)
    },
    {
      name: 'update_user_profile',
      write: true,
      description:
        '修改用户档案的一节（没有这一节就新建）。在对话中发现用户新的工作习惯、流程或偏好，并且用户认可时使用。mode=append 在该节末尾追加，mode=replace 用 content 替换整节。被用户锁定的节不能改。每次修改用户都能看到并撤销。',
      inputSchema: obj(
        {
          section: { ...str, description: '节标题，如「询价与定标流程」「偏好与禁忌」' },
          content: { ...str, description: '要写入的内容（Markdown）' },
          mode: { type: 'string', enum: ['append', 'replace'], description: '默认 append' }
        },
        ['section', 'content']
      ),
      run: ({ section, content, mode }) => {
        const cur = getProfile(store).sections.find((s) => s.title === String(section).trim())
        const body = mode === 'replace' || !cur ? String(content) : `${cur.body.trimEnd()}\n${String(content)}`
        const { change } = saveSection(store, { id: cur?.id, title: String(section).trim(), body }, clientName || 'AI 助手')
        if (!change) return '内容没有变化'
        record(store, 'update_user_profile', `修改了用户档案「${change.title}」`, () => {
          revertChange(store, change.id)
        })
        return `已更新用户档案「${change.title}」`
      }
    },
    // ===== 只读 =====
    {
      name: 'list_projects',
      description: '列出个人工作台里的项目（名称、编号、委托单位、阶段、状态、负责人、截止日期、项目文件夹、未完成待办数）。可按关键词或阶段名筛选。',
      inputSchema: obj({ query: { ...str, description: '关键词，匹配名称、编号、单位、地点' }, stage: { ...str, description: '阶段名称，如「方案设计」' } }),
      run: ({ query, stage }) => {
        const has = (s: any) => !query || String(s || '').toLowerCase().includes(String(query).toLowerCase())
        return store.projects.filter((p) => (has(p.name) || has(p.code) || has(p.client) || has(p.location)) && (!stage || stageName(p.stage) === stage)).map(projectBrief)
      }
    },
    {
      name: 'get_project',
      description: '查看一个项目的完整信息：基本信息、子项目、待办、项目联系人。',
      inputSchema: obj({ projectId: { ...str, description: '项目 id（从 list_projects 获得）' } }, ['projectId']),
      run: ({ projectId }) => {
        const p = store.projects.find((x) => x.id === projectId)
        if (!p) throw new Error('找不到项目：' + projectId)
        const cname = (id: string) => store.contacts.find((c) => c.id === id)?.name || ''
        return {
          ...projectBrief(p),
          description: p.description || '',
          members: p.members || [],
          subProjects: store.projects.filter((x) => x.parentId === p.id).map((x) => ({ id: x.id, name: x.name })),
          todos: store.todos.filter((t) => t.projectId === p.id).map((t) => ({ id: t.id, title: t.title, due: t.due || '', done: !!t.done })),
          contacts: (p.contacts || []).map((x: any) => {
            const c = store.contacts.find((c) => c.id === x.contactId)
            return c ? { name: c.name, org: c.org, title: c.title, phone: c.phone, role: x.role || '' } : null
          }).filter(Boolean)
        }
      }
    },
    {
      name: 'list_files',
      description: '列出项目文件夹里的文件夹和文件（树形文本），带备注和标签。已按设置隐藏 CAD 备份、临时文件等。path 是相对项目文件夹的路径，留空表示整个项目。',
      inputSchema: obj({ projectId: str, path: { ...str, description: '相对路径，如「03 方案与图纸」，留空为项目根目录' }, depth: { type: 'number', description: '展开层数，默认 3，最多 8' } }, ['projectId']),
      run: ({ projectId, path: rel = '', depth = 3 }) => {
        const root = abs(projectId, rel)
        const meta = store.meta(projectId)
        const base = relOf(projectId, root)
        const prefixed: Record<string, any> = {}
        for (const [k, v] of Object.entries(meta.nodes)) if (!base || k.startsWith(base + '/')) prefixed[base ? k.slice(base.length + 1) : k] = v
        const r = scanTree(root, compileHide(hidePatterns(store)), prefixed, false)
        const lines: string[] = []
        const walk = (n: any, d: number) => {
          for (const c of n.children || []) {
            if (lines.length > 600) return
            const m = prefixed[c.rel] || {}
            const extra = [m.tag, m.note && '备注：' + m.note].filter(Boolean).join('；')
            lines.push(`${'  '.repeat(d)}${c.dir ? '📁 ' + c.name + `/（${c.fileCount} 个文件）` : c.name}${extra ? '  —— ' + extra : ''}`)
            if (c.dir && d + 1 < Math.min(8, depth)) walk(c, d + 1)
          }
        }
        walk(r.tree, 0)
        return `项目文件夹：${root}\n${lines.join('\n')}${lines.length > 600 ? '\n……（太多，已截断）' : ''}`
      }
    },
    {
      name: 'read_file',
      description: '读取项目里一个文件的文字内容。支持 txt、md、csv、json、docx（Word）、xlsx/xls（Excel，按工作表转成 CSV）。PDF、图纸、图片只返回文件信息。',
      inputSchema: obj({ projectId: str, path: { ...str, description: '相对项目文件夹的路径' }, maxChars: { type: 'number', description: '最多返回多少字，默认 20000' } }, ['projectId', 'path']),
      run: ({ projectId, path: rel, maxChars = 20000 }) => extractText(abs(projectId, rel), Math.min(200000, maxChars))
    },
    {
      name: 'search',
      description: '全局搜索：项目、文件名、导图备注、待办、联系人、资料库、知识库正文。',
      inputSchema: obj({ query: str }, ['query']),
      run: ({ query }) => searchAll(store, query)
    },
    {
      name: 'list_todos',
      description: '列出待办。默认只列未完成的。',
      inputSchema: obj({ projectId: { ...str, description: '只看某个项目的待办' }, includeDone: { type: 'boolean' } }),
      run: ({ projectId, includeDone }) =>
        store.todos
          .filter((t) => (!projectId || t.projectId === projectId) && (includeDone || !t.done))
          .map((t) => ({ id: t.id, title: t.title, due: t.due || '', done: !!t.done, project: store.projects.find((p) => p.id === t.projectId)?.name || '' }))
    },
    {
      name: 'list_contacts',
      description: '查询通讯录（姓名、单位、职务、电话、标签、参与的项目及角色）。',
      inputSchema: obj({ query: str }),
      run: ({ query }) => {
        const has = (s: any) => !query || String(s || '').toLowerCase().includes(String(query).toLowerCase())
        return store.contacts
          .filter((c) => has(c.name) || has(c.org) || has(c.title) || (c.tags || []).some(has))
          .map((c) => ({
            id: c.id,
            name: c.name,
            org: c.org,
            title: c.title,
            phone: c.phone,
            email: c.email,
            tags: c.tags,
            projects: store.projects.filter((p) => (p.contacts || []).some((x: any) => x.contactId === c.id)).map((p) => ({ name: p.name, role: (p.contacts || []).find((x: any) => x.contactId === c.id)?.role || '' }))
          }))
      }
    },
    {
      name: 'list_library',
      description: '列出资料库里的资料（规范标准、报告模板、收集的数据等），含编号、状态（现行 / 已废止）和替代版本。',
      inputSchema: obj({ query: str, type: { ...str, description: '资料类型名称，如「规范标准」' } }),
      run: ({ query, type }) => {
        const has = (s: any) => !query || String(s || '').toLowerCase().includes(String(query).toLowerCase())
        const tname = (id: string) => store.settings.libraryTypes.find((t: any) => t.id === id)?.name || ''
        return store.library
          .filter((x) => (has(x.name) || has(x.code) || (x.tags || []).some(has)) && (!type || tname(x.type) === type))
          .map((x) => ({ id: x.id, code: x.code, name: x.name, type: tname(x.type), status: x.status, supersededBy: x.supersededBy, date: x.date, tags: x.tags, file: libAbs(store, x) }))
      }
    },
    {
      name: 'read_library_item',
      description: '读取资料库里一份资料的文字内容（支持格式同 read_file）。',
      inputSchema: obj({ id: str, maxChars: { type: 'number' } }, ['id']),
      run: ({ id, maxChars = 20000 }) => {
        const x = store.library.find((i) => i.id === id)
        if (!x) throw new Error('找不到资料：' + id)
        return extractText(libAbs(store, x), Math.min(200000, maxChars))
      }
    },
    {
      name: 'list_kb_pages',
      description: '列出知识库的页面（标题、上级页面、更新时间）。',
      inputSchema: obj({}),
      run: () => listPages(store).filter((p) => !p.deletedAt).map((p) => ({ id: p.id, title: p.title, parentId: p.parentId || null, updatedAt: p.updatedAt }))
    },
    {
      name: 'read_kb_page',
      description: '读取一个知识库页面的正文（转成 Markdown 风格的文本）。',
      inputSchema: obj({ id: str }, ['id']),
      run: ({ id }) => {
        const p = listPages(store).find((x) => x.id === id)
        if (!p) throw new Error('找不到页面：' + id)
        return `# ${p.title || '无标题'}\n\n${htmlToText(p.html)}`
      }
    },

    // ===== 写入（需要「可读写」权限） =====
    {
      name: 'create_folder',
      write: true,
      description: '在项目文件夹里新建文件夹（可多层，如「06 意见与回复/专家评审」）。',
      inputSchema: obj({ projectId: str, path: { ...str, description: '相对项目文件夹的新文件夹路径' } }, ['projectId', 'path']),
      run: ({ projectId, path: rel }) => {
        const target = abs(projectId, rel)
        if (fs.existsSync(target)) return '文件夹已存在：' + rel
        fs.mkdirSync(target, { recursive: true })
        record(store, 'create_folder', `新建文件夹「${rel}」`, async () => {
          if (fs.existsSync(target) && fs.readdirSync(target).length === 0) fs.rmdirSync(target)
          else await shell.trashItem(target)
        })
        return '已新建：' + rel
      }
    },
    {
      name: 'move_path',
      write: true,
      description: '把项目里的文件或文件夹移动到项目里的另一个文件夹（目标文件夹不存在会自动新建）。',
      inputSchema: obj({ projectId: str, from: { ...str, description: '要移动的文件或文件夹（相对路径）' }, toFolder: { ...str, description: '目标文件夹（相对路径），空字符串表示项目根目录' } }, ['projectId', 'from', 'toFolder']),
      run: ({ projectId, from, toFolder }) => {
        const src = abs(projectId, from)
        if (!fs.existsSync(src)) throw new Error('找不到：' + from)
        assertNotRoot(store, projectId, src)
        const dir = abs(projectId, toFolder)
        if (norm(dir) === norm(src) || norm(dir).startsWith(norm(src) + path.sep)) throw new Error('不能把文件夹移到它自己里面')
        if (norm(path.dirname(src)) === norm(dir)) return '已经在这个文件夹里了：' + from
        fs.mkdirSync(dir, { recursive: true })
        const dest = uniqueTarget(dir, path.basename(src))
        fs.renameSync(src, dest)
        const oldRel = relOf(projectId, src)
        const newRel = relOf(projectId, dest)
        renameProjectRefs(store, projectId, oldRel, newRel)
        afterProjectRename(store, projectId, oldRel, newRel, src, dest)
        record(store, 'move_path', `把「${from}」移到「${newRel}」`, () => {
          if (fs.existsSync(src)) throw new Error('原位置已有同名文件，不能撤销')
          fs.mkdirSync(path.dirname(src), { recursive: true })
          fs.renameSync(dest, src)
          renameProjectRefs(store, projectId, newRel, oldRel)
          afterProjectRename(store, projectId, newRel, oldRel, dest, src)
        })
        return '已移动到：' + newRel
      }
    },
    {
      name: 'rename_path',
      write: true,
      description: '给项目里的文件或文件夹改名（只改名字，不移动位置）。',
      inputSchema: obj({ projectId: str, path: str, newName: { ...str, description: '新名字（含扩展名）' } }, ['projectId', 'path', 'newName']),
      run: ({ projectId, path: rel, newName }) => {
        const src = abs(projectId, rel)
        if (!fs.existsSync(src)) throw new Error('找不到：' + rel)
        assertNotRoot(store, projectId, src)
        const name = String(newName || '').replace(/[\\/:*?"<>|]/g, '_').trim().replace(/[. ]+$/, '')
        if (!name) throw new Error('新名字不能为空')
        const dest = path.join(path.dirname(src), name)
        if (fs.existsSync(dest) && norm(dest) !== norm(src)) throw new Error('已有同名文件：' + newName)
        fs.renameSync(src, dest)
        const oldRel = relOf(projectId, src)
        const newRel = relOf(projectId, dest)
        renameProjectRefs(store, projectId, oldRel, newRel)
        afterProjectRename(store, projectId, oldRel, newRel, src, dest)
        record(store, 'rename_path', `把「${rel}」改名为「${path.basename(dest)}」`, () => {
          fs.renameSync(dest, src)
          renameProjectRefs(store, projectId, newRel, oldRel)
          afterProjectRename(store, projectId, newRel, oldRel, dest, src)
        })
        return '已改名为：' + relOf(projectId, dest)
      }
    },
    {
      name: 'trash_path',
      write: true,
      description: '把项目里的文件或文件夹移到系统回收站（可以在回收站里还原，软件内不能撤销）。',
      inputSchema: obj({ projectId: str, path: str }, ['projectId', 'path']),
      run: async ({ projectId, path: rel }) => {
        if (!rel) throw new Error('不能删除项目根文件夹')
        const target = abs(projectId, rel)
        assertNotRoot(store, projectId, target)
        const warn = refsWarning(store, { kind: 'proj', pid: projectId, rel: relOf(projectId, target) })
        await shell.trashItem(target)
        record(store, 'trash_path', `把「${rel}」移到了系统回收站（可在回收站还原）`)
        return '已移到回收站：' + rel + (warn ? '。' + warn + '请告诉用户。' : '')
      }
    },
    {
      name: 'write_text_file',
      write: true,
      description: '在项目里写一个文本文件（.md / .txt / .csv / .json）。已存在的文件需要 overwrite=true 才会覆盖，覆盖前会备份，可撤销。',
      inputSchema: obj({ projectId: str, path: str, content: str, overwrite: { type: 'boolean' } }, ['projectId', 'path', 'content']),
      run: ({ projectId, path: rel, content, overwrite }) => {
        if (!['md', 'txt', 'csv', 'json'].includes(extOf(rel))) throw new Error('只能写 .md / .txt / .csv / .json 文件')
        const target = abs(projectId, rel)
        if (fs.existsSync(target) && !overwrite) throw new Error('文件已存在，如需覆盖请设置 overwrite=true')
        fs.mkdirSync(path.dirname(target), { recursive: true })
        writeWithUndo(target, () => fs.writeFileSync(target, (extOf(rel) === 'csv' ? '﻿' : '') + content, 'utf8'), 'write_text_file', `写入文件「${rel}」`)
        return '已写入：' + rel
      }
    },
    {
      name: 'create_excel',
      write: true,
      description: '在项目里生成 Excel 文件（.xlsx）。sheets 是工作表数组，每个工作表的 rows 是二维数组，第一行通常是表头。',
      inputSchema: obj(
        {
          projectId: str,
          path: { ...str, description: '相对路径，以 .xlsx 结尾' },
          sheets: { type: 'array', items: obj({ name: str, rows: { type: 'array', items: { type: 'array', items: {} } } }, ['rows']) },
          overwrite: { type: 'boolean' }
        },
        ['projectId', 'path', 'sheets']
      ),
      run: ({ projectId, path: rel, sheets, overwrite }) => {
        if (extOf(rel) !== 'xlsx') throw new Error('文件名要以 .xlsx 结尾')
        const target = abs(projectId, rel)
        if (fs.existsSync(target) && !overwrite) throw new Error('文件已存在，如需覆盖请设置 overwrite=true')
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const wb = XLSX.utils.book_new()
        ;(sheets || []).forEach((s: any, i: number) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows || []), String(s.name || `Sheet${i + 1}`).slice(0, 31)))
        writeWithUndo(target, () => XLSX.writeFile(wb, target), 'create_excel', `生成 Excel「${rel}」`)
        return '已生成：' + rel
      }
    },
    {
      name: 'create_word',
      write: true,
      description: '在项目里生成 Word 可直接打开的文档（.doc）。content 用 Markdown 写（# 标题、- 列表、段落）。',
      inputSchema: obj({ projectId: str, path: { ...str, description: '相对路径，以 .doc 结尾' }, title: str, content: str, overwrite: { type: 'boolean' } }, ['projectId', 'path', 'content']),
      run: ({ projectId, path: rel, title, content, overwrite }) => {
        if (extOf(rel) !== 'doc') throw new Error('文件名要以 .doc 结尾')
        const target = abs(projectId, rel)
        if (fs.existsSync(target) && !overwrite) throw new Error('文件已存在，如需覆盖请设置 overwrite=true')
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(title || '')}</title><style>body{font-family:宋体,SimSun;font-size:12pt;line-height:1.6}h1{font-size:18pt;text-align:center}h2{font-size:15pt}h3{font-size:13pt}</style></head><body>${title ? `<h1>${esc(title)}</h1>` : ''}${markdownToHtml(content)}</body></html>`
        writeWithUndo(target, () => fs.writeFileSync(target, html, 'utf8'), 'create_word', `生成 Word 文档「${rel}」`)
        return '已生成：' + rel
      }
    },
    {
      name: 'set_note',
      write: true,
      description: '给项目里的文件或文件夹写备注（会显示在导图节点上）。note 为空字符串表示清除备注。',
      inputSchema: obj({ projectId: str, path: { ...str, description: '相对路径，空字符串表示项目本身' }, note: str }, ['projectId', 'path', 'note']),
      run: ({ projectId, path: rel, note }) => {
        abs(projectId, rel)
        const key = (rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        const meta = store.meta(projectId)
        const old = meta.nodes[key]?.note
        meta.nodes[key] = { ...(meta.nodes[key] || {}), note: note || undefined }
        if (!note) delete meta.nodes[key].note
        store.saveMeta(projectId, meta)
        record(store, 'set_note', `给「${key || '项目'}」${note ? '写了备注' : '清除了备注'}`, () => {
          const m = store.meta(projectId)
          m.nodes[key] = { ...(m.nodes[key] || {}), note: old }
          if (!old) delete m.nodes[key].note
          store.saveMeta(projectId, m)
        })
        return '已保存备注'
      }
    },
    {
      name: 'add_todo',
      write: true,
      description: '添加一条待办，可设截止日期（YYYY-MM-DD）并关联项目。',
      inputSchema: obj({ title: str, due: { ...str, description: 'YYYY-MM-DD' }, projectId: str }, ['title']),
      run: ({ title, due, projectId }) => {
        if (projectId && !store.projects.some((p) => p.id === projectId)) throw new Error('找不到项目：' + projectId)
        const t = { id: newId(), title, due: due || null, projectId: projectId || null, done: false }
        upsert(store.todos, t)
        store.save('todos')
        record(store, 'add_todo', `添加待办「${title}」`, () => {
          store.todos = store.todos.filter((x) => x.id !== t.id)
          store.save('todos')
        })
        return '已添加待办'
      }
    },
    {
      name: 'add_contact',
      write: true,
      description: '在通讯录里添加联系人。companyId 绑定到单位（用 list_companies 查 id）；只给 org 时按单位名自动匹配。给了 projectId 时同时关联到项目并设置角色。',
      inputSchema: obj({ name: str, companyId: str, org: str, title: str, phone: str, email: str, primary: { type: 'boolean', description: '是否该单位的主要联系人' }, tags: { type: 'array', items: str }, projectId: str, role: str }, ['name']),
      run: ({ name, companyId, org, title, phone, email, primary, tags, projectId, role }) => {
        const co = companyId ? store.companies.find((x) => x.id === companyId) : org ? store.companies.find((x) => normName(x.name) === normName(org)) : null
        if (companyId && !co) throw new Error('找不到单位：' + companyId)
        const c = { id: newId(), name, companyId: co?.id || null, org: co?.name || org || '', title: title || '', phone: phone || '', email: email || '', primary: !!primary, tags: tags || [], note: '' }
        upsert(store.contacts, c)
        store.save('contacts')
        const p = projectId ? store.projects.find((x) => x.id === projectId) : null
        if (p) {
          p.contacts = [...(p.contacts || []), { contactId: c.id, role: role || '' }]
          store.save('projects')
        }
        record(store, 'add_contact', `添加联系人「${name}」${p ? `，关联到「${p.name}」` : ''}`, () => {
          store.contacts = store.contacts.filter((x) => x.id !== c.id)
          store.projects = store.projects.map((x) => (x.contacts ? { ...x, contacts: x.contacts.filter((y: any) => y.contactId !== c.id) } : x))
          store.save('contacts')
          store.save('projects')
        })
        return '已添加联系人'
      }
    },
    {
      name: 'create_kb_page',
      write: true,
      description: '在知识库里新建页面，正文用 Markdown（# 标题、- 列表、- [ ] 待办、> 引用）。可指定上级页面 parentId。',
      inputSchema: obj({ title: str, markdown: str, parentId: str }, ['title', 'markdown']),
      run: ({ title, markdown, parentId }) => {
        const p = savePage(store, { id: newId(), title, parentId: parentId || null, html: markdownToHtml(markdown), order: Date.now() })
        record(store, 'create_kb_page', `在知识库新建页面「${title}」`, () => purgePage(store, p.id))
        return '已新建页面，id=' + p.id
      }
    },
    {
      name: 'add_library_item',
      write: true,
      description: '把电脑上的一个文件（绝对路径）导入资料库，文件会被复制进资料库文件夹。',
      inputSchema: obj({ path: { ...str, description: '文件的绝对路径' }, type: { ...str, description: '资料类型名称，如「规范标准」，默认第一个类型' } }, ['path']),
      run: ({ path: p, type }) => {
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error('找不到文件：' + p)
        const t = store.settings.libraryTypes.find((x: any) => x.name === type) || store.settings.libraryTypes[0]
        const added = importToLibrary(store, [p], t?.id)
        record(store, 'add_library_item', `导入资料「${added.map((a) => a.name).join('、')}」`, async () => {
          for (const a of added) {
            try {
              await shell.trashItem(libAbs(store, a))
            } catch {}
          }
          store.library = store.library.filter((x) => !added.some((a) => a.id === x.id))
          store.save('library')
        })
        return '已导入资料库'
      }
    },

    // ===== 采购：单位 / 供应商、询价、发包、回价 =====
    {
      name: 'list_companies',
      description:
        '查单位库（供应商、业主、设计咨询、施工单位等）。可按关键词（名称 / 英文名 / 产品 / 专业）、单位类型、专业、服务国家、入库状态筛选。返回 id、类别、专业、入库状态、等级、联系方式、发包 / 回价次数。录回价前先用它确认供应商是否已存在。',
      inputSchema: obj({
        query: str,
        unitType: { ...str, description: '供应商 / 业主 / 设计咨询 / 施工单位 / 政府部门 / 专家单位 / 其他' },
        specialty: { ...str, description: '专业标签，如 土建、桩基' },
        country: { ...str, description: '服务国家，如 土耳其' },
        status: { ...str, description: '入库状态，如 已入库、名录收集' }
      }),
      run: ({ query, unitType, specialty, country, status }) => {
        const q = normName(query)
        return store.companies
          .filter((c) => !q || [c.name, c.enName, c.products, ...(c.specialties || [])].some((v) => normName(v).includes(q)))
          .filter((c) => (!unitType || c.unitType === unitType) && (!specialty || (c.specialties || []).includes(specialty)) && (!country || (c.serviceCountries || []).includes(country)) && (!status || c.status === status))
          .slice(0, 200)
          .map((c) => ({
            id: c.id,
            name: c.name,
            enName: c.enName || '',
            unitType: c.unitType,
            category: c.category || '',
            specialties: c.specialties || [],
            serviceCountries: c.serviceCountries || [],
            status: c.status || '',
            grade: c.grade || '',
            phone: c.phone || '',
            email: c.email || '',
            contacts: store.contacts.filter((x) => x.companyId === c.id).length,
            ...companyStats(store, c.id)
          }))
      }
    },
    {
      name: 'get_company',
      description: '查看一个单位的全部信息：基本信息、联系人、入库资料（含到期日、核实状态、附件路径）、项目经验、参与过的询价及报价。',
      inputSchema: obj({ companyId: str }, ['companyId']),
      run: ({ companyId }) => {
        const c = store.companies.find((x) => x.id === companyId)
        if (!c) throw new Error('找不到单位：' + companyId)
        const inq = store.inquiries
          .filter((q) => (q.sends || []).some((s: any) => s.companyId === c.id) || (q.quotes || []).some((r: any) => r.companyId === c.id))
          .map((q) => ({
            inquiryId: q.id,
            name: q.name,
            project: store.projects.find((p) => p.id === q.projectId)?.name || '',
            send: (q.sends || []).find((s: any) => s.companyId === c.id) || null,
            quotes: (q.quotes || []).filter((r: any) => r.companyId === c.id),
            awarded: q.awardedCompanyId === c.id
          }))
        return { ...c, contacts: store.contacts.filter((x) => x.companyId === c.id), inquiries: inq, stats: companyStats(store, c.id) }
      }
    },
    {
      name: 'add_company',
      write: true,
      description:
        '新建单位（默认是供应商）。同名（忽略大小写、空格和标点）的单位已存在时不会重复创建，而是返回已有的 id。新供应商的入库状态默认「名录收集」、等级「待评价」。',
      inputSchema: obj(
        {
          name: str,
          enName: str,
          unitType: { ...str, description: '默认 供应商' },
          category: { ...str, description: '分包类 / 物资类 / 服务类 / 设备类' },
          role: { ...str, description: '经营角色，如 专业分包商、制造商、经销商' },
          specialties: { type: 'array', items: str },
          serviceCountries: { type: 'array', items: str },
          regCountry: str,
          status: { ...str, description: '入库状态' },
          phone: str,
          email: str,
          website: str,
          city: str,
          address: str,
          products: { ...str, description: '供应产品 / 服务' },
          source: { ...str, description: '供应商来源，如「XX 项目回价」' },
          note: str
        },
        ['name']
      ),
      run: (a) => {
        const name = String(a.name || '').trim()
        if (!name) throw new Error('单位名称不能为空')
        const exist = store.companies.find((c) => normName(c.name) === normName(name) || (a.enName && normName(c.enName) === normName(a.enName)))
        if (exist) return { created: false, id: exist.id, name: exist.name, message: '这个单位已经存在，没有重复创建' }
        const opts = store.settings.supplierOptions || {}
        const unitType = a.unitType || '供应商'
        const c: any = {
          id: newId(),
          name,
          unitType,
          createdAt: new Date().toISOString(),
          docs: [],
          experience: [],
          ...(unitType === '供应商' ? { status: (opts.status || [])[0] || '名录收集', stage: (opts.stage || [])[0] || '', grade: '待评价' } : {})
        }
        for (const k of ['enName', 'category', 'role', 'regCountry', 'status', 'phone', 'email', 'website', 'city', 'address', 'products', 'source', 'note']) if (a[k]) c[k] = String(a[k])
        for (const k of ['specialties', 'serviceCountries']) if (Array.isArray(a[k])) c[k] = a[k].map(String)
        store.companies.push(c)
        store.save('companies')
        record(store, 'add_company', `新建单位「${name}」`, () => {
          store.companies = store.companies.filter((x) => x.id !== c.id)
          store.save('companies')
        })
        return { created: true, id: c.id, name }
      }
    },
    {
      name: 'update_company',
      write: true,
      description: '修改单位信息。只改传入的字段；specialties / serviceCountries 会与已有的合并；appendNote 追加到备注末尾（不覆盖原备注）。',
      inputSchema: obj(
        {
          companyId: str,
          enName: str,
          category: str,
          role: str,
          specialties: { type: 'array', items: str },
          serviceCountries: { type: 'array', items: str },
          regCountry: str,
          status: str,
          grade: str,
          phone: str,
          email: str,
          website: str,
          city: str,
          address: str,
          products: str,
          appendNote: str
        },
        ['companyId']
      ),
      run: (a) => {
        const i = store.companies.findIndex((x) => x.id === a.companyId)
        if (i < 0) throw new Error('找不到单位：' + a.companyId)
        const before = structuredClone(store.companies[i])
        const c = { ...store.companies[i] }
        for (const k of ['enName', 'category', 'role', 'regCountry', 'status', 'grade', 'phone', 'email', 'website', 'city', 'address', 'products']) if (a[k] !== undefined && a[k] !== '') c[k] = String(a[k])
        for (const k of ['specialties', 'serviceCountries']) if (Array.isArray(a[k])) c[k] = [...new Set([...(c[k] || []), ...a[k].map(String)])]
        if (a.appendNote) c.note = [c.note, String(a.appendNote)].filter(Boolean).join('\n')
        store.companies[i] = c
        store.save('companies')
        record(store, 'update_company', `修改单位「${c.name}」`, () => {
          store.companies = store.companies.map((x) => (x.id === before.id ? before : x))
          store.save('companies')
        })
        return '已修改'
      }
    },
    {
      name: 'list_flows',
      description: '列出用户记录的工作流程 / 审批流程（如采购付款审批、合同用印、报销）。返回名称、说明、步骤数。用户问「XX 要找谁审批」「要交什么材料」时先用它找到流程，再用 get_flow 看详情。',
      inputSchema: obj({ query: { ...str, description: '关键词，会在流程名、步骤名、审批人、附件名里找' } }),
      run: ({ query }) => {
        const q = String(query || '').trim().toLowerCase()
        return store.flows
          .filter((f) => !q || flowText(f).toLowerCase().includes(q))
          .map((f) => ({ id: f.id, name: f.name || '', desc: f.desc || '', steps: flowSteps(f).length, updatedAt: f.updatedAt || '' }))
      }
    },
    {
      name: 'get_flow',
      description: '查看一个工作流程的完整步骤清单（按先后顺序）：每一步属于哪个分组、找谁审批（姓名、岗位，通讯录里有的附电话）、要交哪些附件（是否必交、模板文件）、时限、注意事项，以及下一步和走向下一步的条件。',
      inputSchema: obj({ flowId: str }, ['flowId']),
      run: ({ flowId }) => {
        const f = store.flows.find((x) => x.id === flowId)
        if (!f) throw new Error('找不到流程：' + flowId + '。先用 list_flows 查')
        const who = (p: any) => {
          const c = p.contactId ? store.contacts.find((x) => x.id === p.contactId) : null
          return { name: p.name, role: p.role, ...(c ? { org: c.org || '', phone: c.phone || '', email: c.email || '' } : {}) }
        }
        return {
          name: f.name || '',
          desc: f.desc || '',
          steps: flowSteps(f).map((s) => ({ ...s, approvers: s.approvers.map(who), next: s.next.map((n) => ({ ...n, approvers: n.approvers.map(who) })) }))
        }
      }
    },    {
      name: 'list_inquiries',
      description: '列出询价（一条询价 = 一个项目的一个专业包）。返回所属项目、专业、状态、币种、回价截止、发包家数、回价家数、目前最低价。可按项目、状态、关键词筛选。',
      inputSchema: obj({ projectId: str, status: { ...str, description: INQ_STATUS.join(' / ') }, query: str }),
      run: ({ projectId, status, query }) => {
        const q = normName(query)
        return store.inquiries
          .filter((x) => (!projectId || x.projectId === projectId) && (!status || x.status === status) && (!q || [x.name, x.discipline, x.scope].some((v) => normName(v).includes(q))))
          .map((x) => {
            const best = latestQuotes(x)[0]
            return {
              id: x.id,
              name: x.name,
              project: store.projects.find((p) => p.id === x.projectId)?.name || '',
              projectId: x.projectId || null,
              discipline: x.discipline || '',
              status: x.status,
              currency: x.currency || '',
              deadline: x.deadline || '',
              versions: (x.versions || []).length,
              sends: (x.sends || []).length,
              replied: (x.sends || []).filter((s: any) => s.status === '已回价').length,
              lowest: best ? { company: coName(best.companyId), amount: best.amount, currency: best.currency, usd: toUsd(best) } : null
            }
          })
      }
    },
    {
      name: 'get_inquiry',
      description: '查看一条询价的全部内容：基本信息、询价文件各版次、发给了哪些单位（状态）、每家各轮回价（金额、币种、折合 USD、含税、工期、付款条件、有效期、技术偏差、文件），以及按最新一轮排好的比价。',
      inputSchema: obj({ inquiryId: str }, ['inquiryId']),
      run: ({ inquiryId }) => {
        const x = store.inquiries.find((i) => i.id === inquiryId)
        if (!x) throw new Error('找不到询价：' + inquiryId)
        return {
          ...x,
          project: store.projects.find((p) => p.id === x.projectId)?.name || '',
          sends: (x.sends || []).map((s: any) => ({ ...s, company: coName(s.companyId) })),
          quotes: (x.quotes || []).map((r: any) => ({ ...r, company: coName(r.companyId), usd: toUsd(r) })),
          comparison: latestQuotes(x).map((r) => ({
            company: coName(r.companyId),
            round: r.round,
            amount: r.amount,
            currency: r.currency,
            usd: toUsd(r),
            tax: r.tax,
            amountWithTax: r.amountWithTax ?? null,
            vsBudget: x.budget ? `${(((Number(r.amount) - x.budget) / x.budget) * 100).toFixed(1)}%` : null,
            leadDays: r.leadDays,
            validTo: r.validTo,
            expired: r.validTo ? r.validTo < new Date().toISOString().slice(0, 10) : false,
            verify: r.verify || '',
            issues: r.issues || ''
          })),
          awarded: x.awardedCompanyId ? coName(x.awardedCompanyId) : ''
        }
      }
    },
    {
      name: 'add_inquiry',
      write: true,
      description:
        '新建一条询价（一个项目的一个专业包，如「示例光伏项目 桩基 POT 试桩」）。范围或轮次口径不同的报价应分开建询价，不要混进同一条。状态默认「编制中」。',
      inputSchema: obj(
        {
          name: str,
          projectId: str,
          discipline: { ...str, description: '询价专业，如 桩基、土建' },
          currency: { ...str, description: '主币种，默认 USD' },
          startDate: { ...str, description: 'YYYY-MM-DD' },
          deadline: { ...str, description: '回价截止 YYYY-MM-DD' },
          buyer: { ...str, description: '采购负责人' },
          location: { ...str, description: '交货 / 施工地点' },
          scope: { ...str, description: '工作范围简介' },
          status: { ...str, description: INQ_STATUS.join(' / ') },
          budget: { type: 'number', description: '我方控制价 / 测算价（不含税，按询价币种）' },
          budgetNote: str
        },
        ['name']
      ),
      run: (a) => {
        if (a.projectId && !store.projects.some((p) => p.id === a.projectId)) throw new Error('找不到项目：' + a.projectId)
        if (a.status && !INQ_STATUS.includes(a.status)) throw new Error('状态只能是：' + INQ_STATUS.join('、'))
        const x: any = {
          id: newId(),
          createdAt: new Date().toISOString(),
          name: String(a.name).trim(),
          projectId: a.projectId || null,
          discipline: a.discipline || '',
          currency: a.currency || 'USD',
          startDate: a.startDate || new Date().toISOString().slice(0, 10),
          deadline: a.deadline || '',
          buyer: a.buyer || '',
          location: a.location || '',
          scope: a.scope || '',
          status: a.status || '编制中',
          ...(a.budget ? { budget: Number(a.budget), budgetNote: a.budgetNote || '' } : {}),
          versions: [],
          sends: [],
          quotes: []
        }
        store.inquiries.push(x)
        store.save('inquiries')
        record(store, 'add_inquiry', `新建询价「${x.name}」`, () => {
          store.inquiries = store.inquiries.filter((y) => y.id !== x.id)
          store.save('inquiries')
        })
        return { id: x.id, name: x.name }
      }
    },
    {
      name: 'update_inquiry',
      write: true,
      description: '修改询价的基本信息、状态、比选结论或定标单位（awardedCompanyId，定标后状态自动改为「已定标」）。只改传入的字段。',
      inputSchema: obj(
        {
          inquiryId: str,
          name: str,
          projectId: str,
          discipline: str,
          currency: str,
          startDate: str,
          deadline: str,
          buyer: str,
          location: str,
          scope: str,
          status: { ...str, description: INQ_STATUS.join(' / ') },
          conclusion: { ...str, description: '比选结论' },
          awardedCompanyId: str,
          budget: { type: 'number', description: '我方控制价 / 测算价（不含税）' },
          budgetNote: str
        },
        ['inquiryId']
      ),
      run: (a) => mutateInquiry(a.inquiryId, 'update_inquiry', (x) => {
        if (a.status && !INQ_STATUS.includes(a.status)) throw new Error('状态只能是：' + INQ_STATUS.join('、'))
        if (a.projectId && !store.projects.some((p) => p.id === a.projectId)) throw new Error('找不到项目：' + a.projectId)
        for (const k of ['name', 'projectId', 'discipline', 'currency', 'startDate', 'deadline', 'buyer', 'location', 'scope', 'status', 'conclusion', 'budgetNote']) if (a[k] !== undefined) x[k] = a[k]
        if (a.budget !== undefined) x.budget = Number(a.budget) || null
        if (a.awardedCompanyId) {
          if (!store.companies.some((c) => c.id === a.awardedCompanyId)) throw new Error('找不到单位：' + a.awardedCompanyId)
          x.awardedCompanyId = a.awardedCompanyId
          x.status = '已定标'
        }
        return `修改询价「${x.name}」`
      })
    },
    {
      name: 'add_inquiry_version',
      write: true,
      description: '给询价加一版询价文件（工程量清单、图纸、技术要求）。files 是电脑上的绝对路径，会复制到项目文件夹「03 询价文件/<询价名>/V<版次>」。新版成为「当前版本」，旧版自动标为「已作废」。',
      inputSchema: obj({ inquiryId: str, files: { type: 'array', items: str }, summary: { ...str, description: '清单内容简介 / 改了什么' }, author: str, date: { ...str, description: 'YYYY-MM-DD，默认今天' } }, ['inquiryId', 'files']),
      run: (a) => mutateInquiry(a.inquiryId, 'add_inquiry_version', (x) => {
        const v = (x.versions || []).reduce((m: number, y: any) => Math.max(m, Number(y.version) || 0), 0) + 1
        const files = storeInquiryFiles(store, x, 'version', 'V' + v, a.files || [])
        x.versions = [{ id: newId(), version: v, date: a.date || new Date().toISOString().slice(0, 10), author: a.author || '', summary: a.summary || '', files, status: '当前版本' }, ...(x.versions || []).map((y: any) => ({ ...y, status: '已作废' }))]
        return `给「${x.name}」新增询价文件第 ${v} 版（${files.length} 个文件）`
      })
    },
    {
      name: 'add_send',
      write: true,
      description: '记录把询价发给了某家单位（发包）。同一家已经发过就只更新传入的字段。',
      inputSchema: obj(
        {
          inquiryId: str,
          companyId: str,
          date: { ...str, description: '发送日期 YYYY-MM-DD，默认今天' },
          channel: { ...str, description: '邮件 / 微信 / WhatsApp / 电话 / 现场 / 其他' },
          deadline: { ...str, description: '回价截止 YYYY-MM-DD' },
          status: { ...str, description: SEND_STATUS.join(' / ') },
          note: str
        },
        ['inquiryId', 'companyId']
      ),
      run: (a) => mutateInquiry(a.inquiryId, 'add_send', (x) => {
        if (!store.companies.some((c) => c.id === a.companyId)) throw new Error('找不到单位：' + a.companyId + '。先用 list_companies 查，没有就用 add_company 新建')
        if (a.status && !SEND_STATUS.includes(a.status)) throw new Error('状态只能是：' + SEND_STATUS.join('、'))
        x.sends = x.sends || []
        const s = x.sends.find((y: any) => y.companyId === a.companyId)
        const patch = Object.fromEntries(['date', 'channel', 'deadline', 'status', 'note'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))
        if (s) Object.assign(s, patch)
        else x.sends.push({ id: newId(), companyId: a.companyId, date: new Date().toISOString().slice(0, 10), channel: '', deadline: x.deadline || '', status: '已发送', ...patch })
        if (x.status === '编制中') x.status = '询价中'
        return `${s ? '更新' : '记录'}发包：「${x.name}」→ ${coName(a.companyId)}`
      })
    },
    {
      name: 'add_quote',
      write: true,
      description:
        '记录一家单位的回价（录入前先读 get_procurement_guide）。amount 填不含税净价；不含税时用 taxRate（如土耳其 KDV 20）和 amountWithTax（含税总价）。有效期写成天数时用 validDays + validDaysType，自动算出 validTo。files 是回价原件的绝对路径，会复制到项目文件夹「04 回价与比价/<询价名>/<单位名>」。没有发包记录时自动补一条，对应发包改为「已回价」，全部回齐后询价改为「比价中」。同一家同一日期同一金额的报价已录过时不会重复录。有疑点（大小写金额不符、抬头客户不是我方、条款与别家雷同等）照常录入，verify 填「待核实」、issues 写明。',
      inputSchema: obj(quoteSchema(true), ['inquiryId', 'companyId', 'amount']),
      run: (a) => mutateInquiry(a.inquiryId, 'add_quote', (x) => {
        const co = store.companies.find((c) => c.id === a.companyId)
        if (!co) throw new Error('找不到单位：' + a.companyId + '。先用 list_companies 查，没有就用 add_company 新建')
        if (!(Number(a.amount) > 0)) throw new Error('报价金额要大于 0')
        x.sends = x.sends || []
        x.quotes = x.quotes || []
        const date = a.date || new Date().toISOString().slice(0, 10)
        const dup = x.quotes.find((r: any) => r.companyId === co.id && Number(r.amount) === Number(a.amount) && r.date === date && (r.quoteNo || '') === (a.quoteNo || ''))
        if (dup) throw new Error(`这条回价已经录过了（${co.name} ${date} ${Number(a.amount).toLocaleString()}，id=${dup.id}）。要改内容请用 update_quote`)
        if (!x.sends.some((s: any) => s.companyId === co.id)) x.sends.push({ id: newId(), companyId: co.id, date, channel: a.channel || '', deadline: x.deadline || '', status: '已发送', note: '录回价时自动补的发包记录' })
        const files = a.files?.length ? storeInquiryFiles(store, x, 'quote', co.name, a.files) : []
        const round = Number(a.round) || x.quotes.filter((r: any) => r.companyId === co.id).length + 1
        const q: any = { id: newId(), companyId: co.id, sendId: x.sends.find((s: any) => s.companyId === co.id)?.id, round, date, currency: x.currency || 'USD', tax: '未说明', files }
        applyQuote(q, { ...a, date })
        x.quotes.push(q)
        afterQuote(x, co.id)
        return `记录回价：「${x.name}」${co.name} 第 ${round} 轮 ${q.amount.toLocaleString()} ${q.currency}${q.verify === '待核实' ? '（待核实）' : ''}`
      })
    },
    {
      name: 'update_quote',
      write: true,
      description: '修改一条已录的回价（quoteId 用 get_inquiry 查）。只改传入的字段；files 会追加（复制进项目文件夹），不会删原有附件。核实完疑点后把 verify 改为「已核实」。',
      inputSchema: obj({ quoteId: str, ...quoteSchema(false) }, ['inquiryId', 'quoteId']),
      run: (a) => mutateInquiry(a.inquiryId, 'update_quote', (x) => {
        const q = (x.quotes || []).find((r: any) => r.id === a.quoteId)
        if (!q) throw new Error('这条询价里找不到回价：' + a.quoteId)
        applyQuote(q, a)
        if (a.files?.length) q.files = [...new Set([...(q.files || []), ...storeInquiryFiles(store, x, 'quote', coName(q.companyId), a.files)])]
        return `修改回价：「${x.name}」${coName(q.companyId)} 第 ${q.round} 轮`
      })
    },
    {
      name: 'get_procurement_guide',
      description: '【录询价 / 回价前先读】采购录入指南：数据结构、标准流程、怎样判断询价文件和回价、回价各字段怎么填（不含税净价、KDV、有效期工作日）、常见疑点，以及一个完整示例。',
      inputSchema: obj({}),
      run: () => PROCUREMENT_GUIDE
    }
  ]

  /** add_quote / update_quote 的参数 */
  function quoteSchema(forAdd: boolean) {
    return {
      inquiryId: str,
      ...(forAdd ? { companyId: str } : {}),
      amount: { type: 'number', description: '不含税净价' },
      currency: { ...str, description: '如 USD、TRY、CNY（TL 写 TRY）' },
      rate: { type: 'number', description: '1 单位币种 = 多少 USD；USD 不用填' },
      date: { ...str, description: '报价日期 YYYY-MM-DD（有修订日期用修订日期），默认今天' },
      round: { type: 'number', description: '第几轮，默认这家的下一轮' },
      versionNo: { type: 'number', description: '响应的是第几版询价文件' },
      quoteNo: { ...str, description: '报价编号，如 DNM-2026-017 REV1' },
      tax: { ...str, description: TAX.join(' / ') },
      taxRate: { type: 'number', description: '税率 %，如 20' },
      amountWithTax: { type: 'number', description: '含税总价（GENEL TOPLAM）' },
      leadDays: { type: 'number', description: '工期 / 交货期（天）' },
      validTo: { ...str, description: '报价有效期至 YYYY-MM-DD' },
      validDays: { type: 'number', description: '有效期天数（代替 validTo）' },
      validDaysType: { type: 'string', enum: ['工作日', '日历日'], description: '默认 日历日' },
      payment: { ...str, description: '付款条件简述' },
      scopeNote: { ...str, description: '报价范围、包含与不包含，以及与询价范围的差异' },
      deviation: { ...str, description: '技术偏差' },
      channel: { ...str, description: '接收渠道' },
      verify: { type: 'string', enum: ['待核实', '已核实'] },
      issues: { ...str, description: '待核实的疑点' },
      note: { ...str, description: '运费、原报价日期等其他说明' },
      files: { type: 'array', items: str }
    }
  }

  /** 把参数写进回价：校验含税、自动算有效期、币种 TL 统一成 TRY */
  function applyQuote(q: any, a: any) {
    if (a.amount !== undefined) {
      if (!(Number(a.amount) > 0)) throw new Error('报价金额要大于 0')
      q.amount = Number(a.amount)
    }
    if (a.tax !== undefined && !TAX.includes(a.tax)) throw new Error('是否含税只能是：' + TAX.join('、'))
    for (const k of QUOTE_FIELDS) if (a[k] !== undefined && k !== 'amount') q[k] = a[k]
    if (q.currency === 'TL') q.currency = 'TRY'
    if (a.validDays) q.validTo = validToFrom(q.date, Number(a.validDays), a.validDaysType === '工作日' ? '工作日' : '日历日')
    if (q.taxRate && !q.amountWithTax && q.tax === '不含税') q.amountWithTax = Math.round(q.amount * (1 + q.taxRate / 100) * 100) / 100
    // 含税总价和税率对不上时提醒（差 1% 以上）
    if (q.taxRate && q.amountWithTax && q.tax === '不含税') {
      const expect = q.amount * (1 + q.taxRate / 100)
      if (Math.abs(expect - q.amountWithTax) / expect > 0.01) {
        q.verify = '待核实'
        const msg = `含税总价 ${q.amountWithTax} 与 净价×(1+${q.taxRate}%) = ${Math.round(expect)} 对不上`
        if (!String(q.issues || '').includes('含税总价')) q.issues = [q.issues, msg].filter(Boolean).join('；')
      }
    }
    if (q.issues && !q.verify) q.verify = '待核实'
  }

  function coName(id: string) {
    return store.companies.find((c) => c.id === id)?.name || ''
  }

  /** 改一条询价：先存一份修改前的，改完保存、记录，撤销时整条恢复 */
  function mutateInquiry(id: string, tool: string, fn: (x: any) => string) {
    const i = store.inquiries.findIndex((x) => x.id === id)
    if (i < 0) throw new Error('找不到询价：' + id + '。先用 list_inquiries 查，没有就用 add_inquiry 新建')
    const before = structuredClone(store.inquiries[i])
    const x = structuredClone(store.inquiries[i])
    const summary = fn(x)
    store.inquiries[i] = x
    store.save('inquiries')
    record(store, tool, summary, () => {
      store.inquiries = store.inquiries.map((y) => (y.id === before.id ? before : y))
      store.save('inquiries')
    })
    return summary
  }
}

// ---------- HTTP / JSON-RPC ----------
function json(res: http.ServerResponse, code: number, body: any) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function handleRpc(store: Store, msg: any) {
  const level: Level = store.settings.ai.level
  const list = tools(store).filter((t) => level === 'write' || !t.write)
  const ok = (result: any) => ({ jsonrpc: '2.0', id: msg.id, result })
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
  switch (msg.method) {
    case 'initialize': {
      const ci = msg.params?.clientInfo
      if (ci?.name) clientName = [ci.title || ci.name, ci.version].filter(Boolean).join(' ')
      const prof = profileMarkdown(store)
      return ok({
        protocolVersion: msg.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'project-desk', title: '个人工作台', version: app.getVersion() },
        instructions:
          '这是「个人工作台」——总承包项目负责人兼采购工程师的项目、采购询价、资料与日常管理软件。' +
          '【开始前先读用户档案】下面附了用户档案全文（也可随时用 get_user_profile 重新读取），请按其中的工作习惯、流程和偏好协助用户。' +
          (level === 'write'
            ? '对话中发现用户新的习惯、流程或偏好，且用户认可时，用 update_user_profile 记进档案。写入类工具会修改用户的文件和数据，用户能在软件里看到并撤销；动手前先说明打算做什么。'
            : '当前只读，不能修改任何内容（包括用户档案）。') +
          '查项目先用 list_projects 拿到 id，再用 list_files / read_file 看文件，get_project 看待办和联系人。' +
          '采购相关：录询价文件或回价之前，先调用 get_procurement_guide 读采购录入指南。供应商用 list_companies / get_company 查，没有就 add_company；询价用 list_inquiries / get_inquiry 查，没有就 add_inquiry（范围或轮次口径不同的报价分开建）；' +
          '录回价用 add_quote（附回价文件绝对路径，会复制进项目文件夹），询价文件用 add_inquiry_version，发包用 add_send。数据有疑点（报价方不明、大小写金额不一致等）先问用户，确认后再写入。\n\n' +
          (prof.length > 8000 ? prof.slice(0, 8000) + '\n\n（档案较长，以上为前 8000 字，完整内容用 get_user_profile 读取）' : prof)
      })
    }
    case 'ping':
      return ok({})
    case 'resources/list':
      return ok({
        resources: [
          { uri: 'profile://user', name: 'user-profile', title: '用户档案（开始工作前先读）', mimeType: 'text/markdown', description: '用户的工作习惯、工作流程和偏好' },
          { uri: 'guide://procurement', name: 'procurement-guide', title: '采购录入指南（录询价 / 回价前先读）', mimeType: 'text/markdown', description: '数据结构、标准流程、字段填法、常见疑点和示例' }
        ]
      })
    case 'resources/read':
      if (msg.params?.uri === 'profile://user') return ok({ contents: [{ uri: 'profile://user', mimeType: 'text/markdown', text: profileMarkdown(store) }] })
      if (msg.params?.uri === 'guide://procurement') return ok({ contents: [{ uri: 'guide://procurement', mimeType: 'text/markdown', text: PROCUREMENT_GUIDE }] })
      return err(-32002, 'Resource not found: ' + msg.params?.uri)
    case 'resources/templates/list':
      return ok({ resourceTemplates: [] })
    case 'tools/list':
      return ok({ tools: list.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: !t.write } })) })
    case 'tools/call': {
      const t = list.find((x) => x.name === msg.params?.name)
      if (!t) {
        const exists = tools(store).some((x) => x.name === msg.params?.name)
        return ok({ content: [{ type: 'text', text: exists ? '个人工作台当前是只读权限，不能执行写入操作。请让用户在「设置 → 智能体（AI）」里改为「可读写」。' : '没有这个工具：' + msg.params?.name }], isError: true })
      }
      try {
        const r = await t.run(msg.params?.arguments || {})
        return ok({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) }] })
      } catch (e: any) {
        return ok({ content: [{ type: 'text', text: '出错了：' + String(e?.message || e) }], isError: true })
      }
    }
    default:
      return err(-32601, 'Method not found: ' + msg.method)
  }
}

export function stopMcp() {
  server?.close()
  server = null
  status = { ...status, running: false }
}

export function restartMcp(store: Store, getWin: () => BrowserWindow | null) {
  win = getWin
  stopMcp()
  const ai = store.settings.ai
  status = { running: false, port: ai.port, error: null, level: ai.level }
  if (ai.level === 'off') return status
  if (!ai.token) {
    ai.token = crypto.randomBytes(24).toString('base64url')
    store.save('settings')
  }
  const srv = http.createServer((req, res) => {
    const host = String(req.headers.host || '')
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(res, 403, { error: 'forbidden host' })
    // 浏览器里的网页调用会带 Origin，一律拒绝
    if (req.headers.origin) return json(res, 403, { error: 'browser requests are not allowed' })
    const url = (req.url || '').split('?')[0]
    if (url !== '/mcp') return json(res, 404, { error: 'not found, use /mcp' })
    const auth = String(req.headers.authorization || '')
    const given = Buffer.from(auth.replace(/^Bearer\s+/i, ''))
    const want = Buffer.from(store.settings.ai.token)
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return json(res, 401, { error: 'invalid token' })
    if (req.method === 'GET') return json(res, 405, { error: 'SSE stream not supported' })
    if (req.method === 'DELETE') return json(res, 200, {})
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => {
      body += c
      if (body.length > 5 * 1024 * 1024) req.destroy()
    })
    req.on('end', async () => {
      let msg: any
      try {
        msg = JSON.parse(body)
      } catch {
        return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      }
      const batch = Array.isArray(msg) ? msg : [msg]
      const replies = []
      for (const m of batch) if (m && m.id !== undefined && m.method) replies.push(await handleRpc(store, m))
      if (!replies.length) {
        res.writeHead(202)
        return res.end()
      }
      json(res, 200, Array.isArray(msg) ? replies : replies[0])
    })
  })
  srv.on('error', (e: any) => {
    status = { ...status, running: false, error: e.code === 'EADDRINUSE' ? `端口 ${ai.port} 被占用，请换一个端口` : String(e.message) }
    win()?.webContents.send('ai:status', status)
  })
  srv.listen(ai.port, '127.0.0.1', () => {
    status = { ...status, running: true, error: null }
    win()?.webContents.send('ai:status', status)
  })
  server = srv
  return status
}
