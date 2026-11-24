import path from 'path'
import type { Store } from './store'
import { readJson, writeJsonAtomic } from './store'

// AI 用户档案：用户和接入的 AI 共同维护的一份「说明书」，记录工作习惯、工作流程、偏好。
// 每个接入的 AI 连上后先读它；可读写权限下 AI 可以按节修改，每次修改留历史、可撤销；锁定的节 AI 改不了。

export interface Section {
  id: string
  title: string
  body: string
  locked?: boolean
  hint?: string // 灰色提示，不算正文
}
export interface Change {
  id: string
  time: string
  by: string // 「我」或 AI 客户端名称
  sectionId: string
  title: string
  before: Section | null // null 表示新增的节
  after: Section | null // null 表示删除的节
  reverted?: boolean
  undoOf?: string // 这条是撤销哪条修改
}
export interface Profile {
  sections: Section[]
  history: Change[]
  updatedAt: string
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

const DEFAULT_SECTIONS: [string, string][] = [
  ['角色与在手工作', '（例：总承包方项目负责人兼采购工程师；目前在手项目、负责的专业）'],
  ['工作习惯', '（例：每天上午集中处理询价和回价；习惯先列待办再动手；回复优先用中文）'],
  ['询价与定标流程', '（例：编制询价清单 → 发 3–5 家 → 截止后整理比价 → 二轮议价 → 写比选结论报批 → 定标）'],
  ['文件与命名规则', '（例：回价文件命名「单位简称_专业_轮次_日期」；询价文件按版次 V1、V2）'],
  ['比价与汇报口径', '（例：统一折算 USD，汇率取发包当日；注明是否含税；比价表列出工期和付款条件）'],
  ['偏好与禁忌', '（例：不要替我直接给供应商发邮件；改文件前先说明；数字要标单位和币种）'],
  ['学习与生活', '（例：正在学的内容、复习习惯、生活中的固定安排）']
]

function file(store: Store) {
  return path.join(store.dataDir, 'profile.json')
}

export function getProfile(store: Store): Profile {
  const p = readJson<Profile | null>(file(store), null)
  if (p && Array.isArray(p.sections)) return { sections: p.sections, history: p.history || [], updatedAt: p.updatedAt || '' }
  // 第一次用：写入默认的几节，之后 id 固定
  const fresh: Profile = { sections: DEFAULT_SECTIONS.map(([title, body], i) => ({ id: newId() + i, title, body: '', hint: body })), history: [], updatedAt: '' }
  writeJsonAtomic(file(store), fresh)
  return fresh
}

function write(store: Store, p: Profile) {
  p.updatedAt = new Date().toISOString()
  p.history = p.history.slice(-300)
  writeJsonAtomic(file(store), p)
  return p
}

/** 档案全文（Markdown），给 AI 读 */
export function profileMarkdown(store: Store) {
  const p = getProfile(store)
  const parts = p.sections.map((s) => `## ${s.title}${s.locked ? '（已锁定，AI 不能修改）' : ''}\n\n${s.body.trim() || '（还没写）'}`)
  return `# 用户档案\n\n这是用户的工作习惯、工作流程和偏好，请按这里的做法协助用户。${p.updatedAt ? `最后更新：${p.updatedAt.slice(0, 16).replace('T', ' ')}` : ''}\n\n${parts.join('\n\n')}`
}

const same = (a: Section | null, b: Section | null) => JSON.stringify(a) === JSON.stringify(b)

/**
 * 新增或修改一节。by = '我' 表示用户本人改的（不受锁定限制）；其他值为 AI 客户端名称。
 * 返回新档案和这次的修改记录（没有变化时 change 为 null）
 */
export function saveSection(store: Store, s: Partial<Section> & { title: string }, by: string) {
  const p = getProfile(store)
  const i = p.sections.findIndex((x) => (s.id ? x.id === s.id : x.title === s.title))
  const before = i >= 0 ? p.sections[i] : null
  if (before?.locked && by !== '我') throw new Error(`「${before.title}」这一节已被用户锁定，AI 不能修改。可以把建议告诉用户，由用户自己改。`)
  const after: Section = { ...(before?.hint ? { hint: before.hint } : {}), id: before?.id || newId(), title: s.title.trim() || before?.title || '未命名', body: s.body ?? before?.body ?? '', locked: by === '我' ? (s.locked ?? before?.locked) : before?.locked }
  if (!after.locked) delete after.locked
  if (same(before, after)) return { profile: p, change: null as Change | null }
  if (i >= 0) p.sections[i] = after
  else p.sections.push(after)
  const change: Change = { id: newId(), time: new Date().toISOString(), by, sectionId: after.id, title: after.title, before, after }
  p.history.push(change)
  return { profile: write(store, p), change }
}

export function deleteSection(store: Store, id: string, by: string) {
  const p = getProfile(store)
  const before = p.sections.find((x) => x.id === id)
  if (!before) return { profile: p, change: null as Change | null }
  if (before.locked && by !== '我') throw new Error(`「${before.title}」这一节已被用户锁定，AI 不能删除。`)
  p.sections = p.sections.filter((x) => x.id !== id)
  const change: Change = { id: newId(), time: new Date().toISOString(), by, sectionId: id, title: before.title, before, after: null }
  p.history.push(change)
  return { profile: write(store, p), change }
}

export function moveSection(store: Store, id: string, d: number) {
  const p = getProfile(store)
  const i = p.sections.findIndex((x) => x.id === id)
  const j = i + d
  if (i < 0 || j < 0 || j >= p.sections.length) return p
  ;[p.sections[i], p.sections[j]] = [p.sections[j], p.sections[i]]
  return write(store, p)
}

/** 撤销一次修改：把这一节恢复成修改前的样子 */
export function revertChange(store: Store, changeId: string) {
  const p = getProfile(store)
  const c = p.history.find((x) => x.id === changeId)
  if (!c) throw new Error('找不到这条修改记录')
  if (c.reverted) throw new Error('这条修改已经撤销过了')
  const cur = p.sections.find((x) => x.id === c.sectionId) || null
  if (!same(cur, c.after)) throw new Error(`「${c.title}」之后又被改过，不能直接撤销这一步。请先撤销更晚的修改，或手动改回。`)
  if (c.before) {
    const i = p.sections.findIndex((x) => x.id === c.sectionId)
    if (i >= 0) p.sections[i] = c.before
    else p.sections.push(c.before)
  } else p.sections = p.sections.filter((x) => x.id !== c.sectionId)
  c.reverted = true
  p.history.push({ id: newId(), time: new Date().toISOString(), by: '我', sectionId: c.sectionId, title: c.title, before: cur, after: c.before, undoOf: c.id })
  return write(store, p)
}
