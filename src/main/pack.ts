import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { pipeline } from 'stream/promises'
import type { Store } from './store'
import { readJson, writeJsonAtomic } from './store'

// 备份 / 数据包：按类别选择要带的数据（项目、备忘录、资料库……），
// 默认放在工作台根目录的「备份」文件夹，也可以导出到 U 盘；可以再打成一个 .zip 方便发给别人。
// 结构：<目标>/个人工作台数据包-日期/ 下有 manifest.json、data/、library/、projects/<项目id>/。
// 设了密码时每个文件用 AES-256-GCM 加密（密钥由 scrypt 从密码派生），文件名后加 .enc。
// 再次导出到同一个数据包时，只更新改动过的文件。
// 只处理软件认识的数据项，数据文件夹里别的东西一概不带。

const MAGIC = '个人工作台数据包'
// 改名前导出的数据包仍然可以导入
// 旧版本的数据包标识：「项目台数据包」，或以「个人工作台数据包」结尾（早期版本前面带了用户名）
const isPack = (m: any) => m && (m.magic === MAGIC || m.magic === '项目台数据包' || /个人工作台数据包$/.test(String(m.magic || '')))
const CHECK_TEXT = 'project-desk-pack-ok'

/** 备份类别 → 数据文件夹里对应的文件和子文件夹 */
export const CATEGORIES: Record<string, { label: string; files: string[]; dirs: string[] }> = {
  projects: { label: '项目信息（项目、导图备注与引用）', files: ['projects.json'], dirs: ['meta'] },
  projectFiles: { label: '项目文件夹（图纸、报告、照片等文件本身）', files: [], dirs: [] },
  tasks: { label: '待办、便签、专注记录', files: ['todos.json', 'stickies.json', 'focus.json'], dirs: [] },
  kb: { label: '备忘录', files: [], dirs: ['kb'] },
  flows: { label: '工作流程', files: ['flows.json'], dirs: [] },
  contacts: { label: '通讯录、单位与供应商、询价', files: ['contacts.json', 'companies.json', 'inquiries.json'], dirs: [] },
  library: { label: '资料库（目录和文件）', files: ['library.json'], dirs: [] },
  settings: { label: '设置与 AI 用户档案', files: ['settings.json', 'profile.json'], dirs: [] }
}
const DATA_CATS = Object.keys(CATEGORIES).filter((c) => c !== 'projectFiles')

export interface PackOptions {
  dest?: string
  categories: string[]
  includeKbHistory?: boolean
  password?: string
  zip?: boolean
}

function stamp(withTime = false) {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` + (withTime ? `_${p(d.getHours())}${p(d.getMinutes())}` : '')
}

function walk(root: string, prefix: string, out: { src: string; rel: string }[], skip?: (rel: string) => boolean) {
  if (!fs.existsSync(root)) return
  const go = (dir: string, rel: string) => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name
      if (skip?.(r)) continue
      if (e.isDirectory()) go(path.join(dir, e.name), r)
      else if (e.isFile() && !e.name.endsWith('.tmp') && !e.name.endsWith('.partial')) out.push({ src: path.join(dir, e.name), rel: prefix + '/' + r })
    }
  }
  go(root, '')
}

const keyOf = (password: string, salt: Buffer) => crypto.scryptSync(password, salt, 32)

async function encryptFile(src: string, dest: string, key: Buffer) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const tmp = dest + '.partial'
  await fs.promises.writeFile(tmp, iv)
  await pipeline(fs.createReadStream(src), cipher, fs.createWriteStream(tmp, { flags: 'a' }))
  await fs.promises.appendFile(tmp, cipher.getAuthTag())
  await fs.promises.rename(tmp, dest)
}

async function decryptFile(src: string, dest: string, key: Buffer) {
  const size = (await fs.promises.stat(src)).size
  const fd = await fs.promises.open(src, 'r')
  const iv = Buffer.alloc(12)
  const tag = Buffer.alloc(16)
  await fd.read(iv, 0, 12, 0)
  await fd.read(tag, 0, 16, size - 16)
  await fd.close()
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })
  const tmp = dest + '.partial'
  if (size <= 28) {
    // 空文件：只有 iv 和校验标签
    await fs.promises.writeFile(tmp, decipher.final())
  } else {
    await pipeline(fs.createReadStream(src, { start: 12, end: size - 17 }), decipher, fs.createWriteStream(tmp))
  }
  await fs.promises.rename(tmp, dest)
}

function checkToken(key: Buffer) {
  const iv = crypto.createHash('sha256').update('check').digest().subarray(0, 12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([c.update(CHECK_TEXT), c.final(), c.getAuthTag()])
  return enc.toString('base64')
}

function zipFolder(dir: string, zipPath: string) {
  return new Promise<void>((resolve, reject) => {
    const ps = `Compress-Archive -Path '${dir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, (err, _o, stderr) =>
      err ? reject(new Error('打 zip 失败：' + (stderr || err.message))) : resolve()
    )
  })
}

/** 列出某些类别要带的文件 */
function collect(store: Store, cats: string[], includeKbHistory: boolean) {
  const files: { src: string; rel: string }[] = []
  const skipped: string[] = []
  for (const c of cats) {
    const def = CATEGORIES[c]
    if (!def) continue
    for (const f of def.files) if (fs.existsSync(path.join(store.dataDir, f))) files.push({ src: path.join(store.dataDir, f), rel: 'data/' + f })
    for (const d of def.dirs) walk(path.join(store.dataDir, d), 'data/' + d, files, (r) => !includeKbHistory && d === 'kb' && r.startsWith('history'))
    if (c === 'library') walk(store.libraryDir, 'library', files)
    if (c === 'projectFiles') {
      for (const p of store.projects) {
        if (!p.rootPath) continue
        if (!fs.existsSync(p.rootPath)) {
          skipped.push(`${p.name}：找不到项目文件夹 ${p.rootPath}`)
          continue
        }
        walk(p.rootPath, 'projects/' + p.id, files, (r) => /(^|\/)(node_modules|\.git)(\/|$)/.test(r))
      }
    }
  }
  return { files, skipped }
}

export async function exportPack(store: Store, o: PackOptions, onProgress?: (done: number, total: number) => void) {
  const cats = (o.categories || []).filter((c) => CATEGORIES[c])
  if (!cats.length) throw new Error('请至少选一类要备份的数据')
  const dest = o.dest || store.backupDir
  fs.mkdirSync(dest, { recursive: true })
  // 选中的就是一个已有数据包时，直接在里面更新
  const pkg = fs.existsSync(path.join(dest, 'manifest.json')) ? dest : path.join(dest, `${MAGIC}-${stamp(true)}`)
  fs.mkdirSync(pkg, { recursive: true })
  const old = readJson<any>(path.join(pkg, 'manifest.json'), null)

  const { files, skipped } = collect(store, cats, !!o.includeKbHistory)
  const projects = store.projects.map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath || '' }))

  const encrypted = !!o.password
  // 密码变了（或加密状态变了）就整包重写
  let salt = old?.salt && old.encrypted === encrypted ? Buffer.from(old.salt, 'base64') : crypto.randomBytes(16)
  let key = encrypted ? keyOf(o.password!, salt) : null
  const sameKey = old && old.encrypted === encrypted && (!encrypted || old.check === checkToken(key!))
  if (!sameKey && old && encrypted) {
    salt = crypto.randomBytes(16)
    key = keyOf(o.password!, salt)
  }
  const prev: Record<string, any> = sameKey ? old.files || {} : {}

  const index: Record<string, any> = {}
  let copied = 0
  let i = 0
  const failed: string[] = []
  for (const f of files) {
    onProgress?.(++i, files.length)
    try {
      const st = fs.statSync(f.src)
      const info = { size: st.size, mtime: Math.round(st.mtimeMs) }
      const out = path.join(pkg, ...(f.rel + (encrypted ? '.enc' : '')).split('/'))
      if (prev[f.rel] && prev[f.rel].size === info.size && prev[f.rel].mtime === info.mtime && fs.existsSync(out)) {
        index[f.rel] = info
        continue
      }
      fs.mkdirSync(path.dirname(out), { recursive: true })
      if (encrypted) await encryptFile(f.src, out, key!)
      else {
        fs.copyFileSync(f.src, out + '.partial')
        fs.renameSync(out + '.partial', out)
      }
      index[f.rel] = info
      copied++
    } catch (e: any) {
      // 文件被占用、没有权限、路径太长等：跳过这一个，继续导出，最后列出来
      failed.push(`${f.src}：${e.code || e.message}`)
    }
  }
  // 删掉这次不再包含的旧文件
  for (const rel of Object.keys(old?.files || {})) {
    if (!index[rel]) for (const ext of ['', '.enc']) fs.rmSync(path.join(pkg, ...(rel + ext).split('/')), { force: true })
  }

  writeJsonAtomic(path.join(pkg, 'manifest.json'), {
    magic: MAGIC,
    createdAt: new Date().toISOString(),
    encrypted,
    salt: salt.toString('base64'),
    check: encrypted ? checkToken(key!) : null,
    categories: cats,
    options: { includeKbHistory: !!o.includeKbHistory },
    projects,
    files: index
  })

  let zipPath: string | null = null
  if (o.zip) {
    zipPath = pkg + '.zip'
    await zipFolder(pkg, zipPath)
  }
  return { path: pkg, zipPath, total: files.length, copied, failed: failed.slice(0, 50), failedCount: failed.length, skipped }
}

/** 读取数据包信息。旧版数据包没有 categories，按当时的选项推算 */
function catsOf(m: any): string[] {
  if (Array.isArray(m.categories)) return m.categories
  const o = m.options || {}
  return [...DATA_CATS.filter((c) => c !== 'contacts' || o.includeContacts !== false), ...(o.includeProjects ? ['projectFiles'] : [])]
}

export function packInfo(dir: string) {
  const m = readJson<any>(path.join(dir, 'manifest.json'), null)
  if (!isPack(m)) throw new Error('这个文件夹不是本软件的数据包（找不到 manifest.json）。如果是 .zip，请先解压')
  return {
    createdAt: m.createdAt,
    encrypted: m.encrypted,
    categories: catsOf(m),
    categoryLabels: catsOf(m).map((c) => CATEGORIES[c]?.label || c),
    projects: m.projects,
    fileCount: Object.keys(m.files).length
  }
}

/**
 * 导入数据包：只替换数据包里带了的那几类，其余数据不动。被替换的部分先另存一份到「备份」文件夹。
 * 项目文件夹放到 projectsTarget 下，并改写项目路径。
 */
export async function importPack(store: Store, dir: string, o: { password?: string; projectsTarget?: string }) {
  const m = readJson<any>(path.join(dir, 'manifest.json'), null)
  if (!isPack(m)) throw new Error('不是本软件的数据包')
  let key: Buffer | null = null
  if (m.encrypted) {
    if (!o.password) throw new Error('这个数据包设了密码')
    key = keyOf(o.password, Buffer.from(m.salt, 'base64'))
    if (checkToken(key) !== m.check) throw new Error('密码不对')
  }
  const cats = catsOf(m)
  const withFiles = cats.includes('projectFiles') && Object.keys(m.files).some((r) => r.startsWith('projects/'))
  if (withFiles && !o.projectsTarget) throw new Error('请选择项目文件夹要放到哪里')

  // 先把要被替换的那几类另存一份
  const saved = path.join(store.backupDir, '导入前-' + stamp(true))
  fs.mkdirSync(saved, { recursive: true })
  const replaced: { files: string[]; dirs: string[] } = { files: [], dirs: [] }
  for (const c of cats) {
    const def = CATEGORIES[c]
    if (!def) continue
    replaced.files.push(...def.files)
    replaced.dirs.push(...def.dirs)
  }
  for (const f of replaced.files) if (fs.existsSync(path.join(store.dataDir, f))) fs.copyFileSync(path.join(store.dataDir, f), path.join(saved, f))
  for (const d of replaced.dirs) if (fs.existsSync(path.join(store.dataDir, d))) fs.cpSync(path.join(store.dataDir, d), path.join(saved, d), { recursive: true })

  const keepSettings = { libraryDir: store.settings.libraryDir, projectsRoot: store.settings.projectsRoot, ai: store.settings.ai }
  for (const f of replaced.files) fs.rmSync(path.join(store.dataDir, f), { force: true })
  for (const d of replaced.dirs) fs.rmSync(path.join(store.dataDir, d), { recursive: true, force: true })

  const projectDirs: Record<string, string> = {}
  if (withFiles && o.projectsTarget) {
    for (const p of m.projects) projectDirs[p.id] = path.join(o.projectsTarget, (p.rootPath ? path.basename(p.rootPath) : p.name).replace(/[\\/:*?"<>|]/g, '_'))
  }
  const target = (rel: string) => {
    const [head, ...rest] = rel.split('/')
    if (head === 'data') return path.join(store.dataDir, ...rest)
    if (head === 'library') return path.join(store.libraryDir, ...rest)
    if (head === 'projects') {
      const [pid, ...r] = rest
      return projectDirs[pid] ? path.join(projectDirs[pid], ...r) : null
    }
    return null
  }
  // 数据包里的路径不能跳出目标文件夹（「../」之类），防止被改过的数据包写到别处
  const inside = (t: string) => [store.dataDir, store.libraryDir, ...Object.values(projectDirs)].some((b) => path.resolve(t).toLowerCase().startsWith(path.resolve(b).toLowerCase() + path.sep))
  for (const rel of Object.keys(m.files)) {
    const t = target(rel)
    if (!t || !inside(t)) continue
    const src = path.join(dir, ...(rel + (m.encrypted ? '.enc' : '')).split('/'))
    if (!fs.existsSync(src)) continue
    if (m.encrypted) await decryptFile(src, t, key!)
    else {
      await fs.promises.mkdir(path.dirname(t), { recursive: true })
      await fs.promises.copyFile(src, t)
    }
  }

  store.load()
  // 本机自己的资料库和项目位置、AI 设置不被数据包覆盖
  Object.assign(store.settings, keepSettings)
  store.save('settings')
  if (Object.keys(projectDirs).length) {
    store.projects = store.projects.map((p) => (projectDirs[p.id] ? { ...p, rootPath: projectDirs[p.id] } : p))
    store.save('projects')
  }
  return { savedTo: saved, categories: cats }
}
