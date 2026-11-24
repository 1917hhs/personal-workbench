import fs from 'fs'
import path from 'path'
import type { Store } from './store'
import { compileHide, scanTree } from './files'
import { listPages } from './kb'
import { flowText } from './flow'

// 界面（ipc.ts）和 AI 接口（mcp.ts）共用的辅助函数

/** 每个项目的文件名清单，用于全局搜索 */
export const fileIndex = new Map<string, { rel: string; name: string; dir: boolean }[]>()

export function hidePatterns(store: Store) {
  const s = store.settings
  return [...s.hideGroups.filter((g: any) => g.enabled).flatMap((g: any) => g.patterns), ...(s.customHide || [])]
}

export function upsert(list: any[], item: any) {
  const now = new Date().toISOString()
  const i = list.findIndex((x) => x.id === item.id)
  if (i >= 0) list[i] = { ...list[i], ...item, updatedAt: now }
  else list.push({ createdAt: now, ...item, updatedAt: now })
}

export function projectRoot(store: Store, id: string) {
  const p = store.projects.find((x) => x.id === id)
  if (!p) throw new Error('找不到项目：' + id)
  if (!p.rootPath) throw new Error('项目还没有关联文件夹')
  return p.rootPath as string
}

/** 引用指向的文件现在还在不在、多大、什么时候改的 */
export function refStatus(refs: any[]) {
  return refs.map((r) => {
    try {
      const st = fs.statSync(r.path)
      return { ...r, exists: true, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }
    } catch {
      return { ...r, exists: false }
    }
  })
}

export function scanProject(store: Store, id: string, showHidden = false) {
  const root = projectRoot(store, id)
  if (!fs.existsSync(root)) return { exists: false, root }
  const meta = store.meta(id)
  const r = scanTree(root, compileHide(hidePatterns(store)), meta.nodes, showHidden)
  fileIndex.set(id, r.flat)
  return { exists: true, root, meta, refs: refStatus(meta.refs), ...r }
}

export const norm = (p: string) => path.resolve(p).toLowerCase()

export const stripHtml = (h: string) =>
  String(h || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

export function searchAll(store: Store, query: string) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return { projects: [], todos: [], files: [], notes: [], contacts: [], reviews: [], library: [], pages: [], flows: [] }
  const has = (s: any) => String(s || '').toLowerCase().includes(q)
  const projects = store.projects.filter((p) => has(p.name) || has(p.code) || has(p.client) || has(p.location) || has(p.description)).slice(0, 10)
  const todos = store.todos.filter((t) => has(t.title)).slice(0, 10)
  const contacts = store.contacts.filter((c) => has(c.name) || has(c.org) || has(c.title) || has(c.phone) || (c.tags || []).some(has)).slice(0, 10)
  const reviews = store.reviews.filter((r) => has(r.type) || has(r.conclusion) || has(r.title)).slice(0, 10)
  const files: any[] = []
  const notes: any[] = []
  for (const p of store.projects) {
    for (const f of fileIndex.get(p.id) || []) {
      if (files.length >= 40) break
      if (has(f.name)) files.push({ projectId: p.id, projectName: p.name, ...f })
    }
    const meta = store.meta(p.id)
    for (const [rel, m] of Object.entries<any>(meta.nodes)) {
      if (m.note && has(m.note)) notes.push({ projectId: p.id, projectName: p.name, rel, note: m.note })
    }
  }
  const library = store.library.filter((x) => has(x.name) || has(x.code) || has(x.note) || (x.tags || []).some(has)).slice(0, 10)
  const pages = listPages(store)
    .filter((p) => !p.deletedAt)
    .map((p) => ({ id: p.id, title: p.title, text: stripHtml(p.html) }))
    .filter((p) => has(p.title) || has(p.text))
    .slice(0, 10)
    .map((p) => {
      const i = p.text.toLowerCase().indexOf(q)
      return { id: p.id, title: p.title, snippet: i >= 0 ? p.text.slice(Math.max(0, i - 15), i + 40).trim() : '' }
    })
  const flows = store.flows
    .map((f) => ({ f, text: flowText(f) }))
    .filter((x) => has(x.text))
    .slice(0, 10)
    .map(({ f, text }) => {
      const i = text.toLowerCase().indexOf(q)
      return { id: f.id, name: f.name || '未命名流程', snippet: i >= 0 ? text.slice(Math.max(0, i - 15), i + 40).trim() : '' }
    })
  return { projects, todos, files, notes: notes.slice(0, 20), contacts, reviews, library, pages, flows }
}
