import { app, net } from 'electron'
import fs from 'fs'
import path from 'path'

// 本机离线语音识别（sherpa-onnx）。模型不随安装包，在 设置 → 语音识别 里按需下载到用户数据目录；
// 识别在本机完成，录音不出电脑。长录音先用 VAD 按停顿切成小段，再逐段识别。

type FileSpec = { repo: string; path: string; as?: string }
export interface AsrModel {
  id: string
  name: string
  desc: string
  langs: string
  size: number // MB，约数
  punct: boolean // 自带标点
  recommended?: boolean
  kind: 'asr' | 'punct'
  files: FileSpec[]
  config?: (dir: string) => any
}

const VAD: FileSpec = { repo: 'csukuangfj/vad', path: 'silero_vad.onnx' }

export const ASR_MODELS: AsrModel[] = [
  {
    id: 'sensevoice',
    name: 'SenseVoice Small',
    desc: '阿里开源，中文效果好、速度快，自带标点',
    langs: '中文 / 英语 / 日语 / 韩语 / 粤语',
    size: 230,
    punct: true,
    recommended: true,
    kind: 'asr',
    files: [
      { repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17', path: 'model.int8.onnx' },
      { repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17', path: 'tokens.txt' },
      VAD
    ],
    config: (d) => ({ senseVoice: { model: path.join(d, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 }, tokens: path.join(d, 'tokens.txt') })
  },
  {
    id: 'paraformer-small',
    name: 'Paraformer 中文（小）',
    desc: '体积最小，适合普通话；不带标点，可另装「中文标点」',
    langs: '中文（普通话）',
    size: 80,
    punct: false,
    kind: 'asr',
    files: [
      { repo: 'csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09', path: 'model.int8.onnx' },
      { repo: 'csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09', path: 'tokens.txt' },
      VAD
    ],
    config: (d) => ({ paraformer: { model: path.join(d, 'model.int8.onnx') }, tokens: path.join(d, 'tokens.txt') })
  },
  {
    id: 'paraformer',
    name: 'Paraformer 中文',
    desc: '普通话识别准确率高；不带标点，可另装「中文标点」',
    langs: '中文（普通话）/ 少量英语',
    size: 220,
    punct: false,
    kind: 'asr',
    files: [
      { repo: 'csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09', path: 'model.int8.onnx' },
      { repo: 'csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09', path: 'tokens.txt' },
      VAD
    ],
    config: (d) => ({ paraformer: { model: path.join(d, 'model.int8.onnx') }, tokens: path.join(d, 'tokens.txt') })
  },
  {
    id: 'whisper-base',
    name: 'Whisper Base',
    desc: 'OpenAI 开源，多语种；中文可能输出繁体，速度较慢',
    langs: '多语种（近百种）',
    size: 155,
    punct: true,
    kind: 'asr',
    files: [
      { repo: 'csukuangfj/sherpa-onnx-whisper-base', path: 'base-encoder.int8.onnx' },
      { repo: 'csukuangfj/sherpa-onnx-whisper-base', path: 'base-decoder.int8.onnx' },
      { repo: 'csukuangfj/sherpa-onnx-whisper-base', path: 'base-tokens.txt' },
      VAD
    ],
    config: (d) => ({ whisper: { encoder: path.join(d, 'base-encoder.int8.onnx'), decoder: path.join(d, 'base-decoder.int8.onnx'), language: '', task: 'transcribe' }, tokens: path.join(d, 'base-tokens.txt') })
  },
  {
    id: 'whisper-small',
    name: 'Whisper Small',
    desc: '比 Base 准，但更大更慢',
    langs: '多语种（近百种）',
    size: 360,
    punct: true,
    kind: 'asr',
    files: [
      { repo: 'csukuangfj/sherpa-onnx-whisper-small', path: 'small-encoder.int8.onnx' },
      { repo: 'csukuangfj/sherpa-onnx-whisper-small', path: 'small-decoder.int8.onnx' },
      { repo: 'csukuangfj/sherpa-onnx-whisper-small', path: 'small-tokens.txt' },
      VAD
    ],
    config: (d) => ({ whisper: { encoder: path.join(d, 'small-encoder.int8.onnx'), decoder: path.join(d, 'small-decoder.int8.onnx'), language: '', task: 'transcribe' }, tokens: path.join(d, 'small-tokens.txt') })
  },
  {
    id: 'punct-zh',
    name: '中文标点',
    desc: '给不带标点的模型（Paraformer）的识别结果自动加标点',
    langs: '中文 / 英语',
    size: 285,
    punct: true,
    kind: 'punct',
    files: [
      { repo: 'csukuangfj/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12', path: 'model.onnx' },
      { repo: 'csukuangfj/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12', path: 'tokens.json' }
    ]
  }
]

// 下载源：国内镜像优先，不通再用官方
const HOSTS = ['https://hf-mirror.com', 'https://huggingface.co']

// 模型放哪：默认在软件安装目录下的 asr-models（安装程序升级时会保留它，见 build/installer.nsh）；
// 开发时没有安装目录，放用户数据目录。可在设置里改到别处（settings.asr.dir）
export const defaultAsrRoot = () => (app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'asr-models') : path.join(app.getPath('userData'), 'asr-models'))
let customRoot = ''
export const setAsrRoot = (dir: string) => {
  customRoot = dir || ''
  recognizers.clear()
  punctuator = null
}
const root = () => customRoot || defaultAsrRoot()

/** 把模型文件夹搬到新位置（已下好的模型一起搬过去） */
export function moveAsrRoot(to: string) {
  const from = root()
  const target = to || defaultAsrRoot()
  if (downloading.size) throw new Error('有模型正在下载，等下完或取消后再换位置')
  const a = path.resolve(from).toLowerCase() + path.sep
  const b = path.resolve(target).toLowerCase() + path.sep
  if (a === b) return target
  if (b.startsWith(a) || a.startsWith(b)) throw new Error('新位置不能在原模型文件夹里面，也不能是它的上级文件夹')
  fs.mkdirSync(target, { recursive: true })
  recognizers.clear()
  punctuator = null
  if (fs.existsSync(from)) {
    for (const e of fs.readdirSync(from)) {
      const src = path.join(from, e)
      const dst = path.join(target, e)
      if (fs.existsSync(dst)) continue
      try {
        fs.renameSync(src, dst)
      } catch {
        // 跨磁盘不能直接改名：先复制再删
        fs.cpSync(src, dst, { recursive: true })
        fs.rmSync(src, { recursive: true, force: true })
      }
    }
    try {
      if (!fs.readdirSync(from).length) fs.rmdirSync(from)
    } catch {}
  }
  return target
}
const dirOf = (id: string) => path.join(root(), id)
const fileOf = (id: string, f: FileSpec) => path.join(dirOf(id), f.as || path.basename(f.path))
const modelOf = (id: string) => {
  const m = ASR_MODELS.find((x) => x.id === id)
  if (!m) throw new Error('没有这个识别模型：' + id)
  return m
}
export const isInstalled = (id: string) => {
  const m = ASR_MODELS.find((x) => x.id === id)
  return !!m && m.files.every((f) => fs.existsSync(fileOf(id, f)))
}

type Progress = { id: string; done: number; total: number; error?: string; finished?: boolean }
const downloading = new Map<string, { abort: AbortController; p: Progress }>()

export function asrStatus(selected?: string) {
  return {
    dir: root(),
    custom: !!customRoot,
    defaultDir: defaultAsrRoot(),
    selected: selected && isInstalled(selected) ? selected : '',
    models: ASR_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      desc: m.desc,
      langs: m.langs,
      size: m.size,
      punct: m.punct,
      kind: m.kind,
      recommended: !!m.recommended,
      installed: isInstalled(m.id),
      progress: downloading.get(m.id)?.p || null
    }))
  }
}

async function fetchOne(f: FileSpec, target: string, signal: AbortSignal, onBytes: (n: number, total: number) => void) {
  let lastErr: any
  for (const host of HOSTS) {
    const url = `${host}/${f.repo}/resolve/main/${f.path}`
    try {
      const res = await net.fetch(url, { signal })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length') || 0)
      const part = target + '.part'
      const out = fs.createWriteStream(part)
      let got = 0
      try {
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          got += value.length
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
          onBytes(got, total)
        }
        await new Promise<void>((r, j) => out.end((e: any) => (e ? j(e) : r())))
      } catch (e) {
        out.destroy()
        try {
          fs.rmSync(part, { force: true })
        } catch {}
        throw e
      }
      if (total && got !== total) throw new Error('下载不完整')
      fs.renameSync(part, target)
      return
    } catch (e: any) {
      if (signal.aborted) throw new Error('已取消')
      lastErr = e
    }
  }
  throw new Error(`下载 ${path.basename(f.path)} 失败：${lastErr?.message || lastErr}。检查网络后重试`)
}

/** 下载模型（已下好的文件跳过）。进度通过 send 推给界面 */
export async function downloadModel(id: string, send: (p: Progress) => void) {
  const m = modelOf(id)
  if (downloading.has(id)) return
  const abort = new AbortController()
  const p: Progress = { id, done: 0, total: m.size * 1024 * 1024 }
  downloading.set(id, { abort, p })
  fs.mkdirSync(dirOf(id), { recursive: true })
  let base = 0
  let last = 0
  try {
    for (const f of m.files) {
      const target = fileOf(id, f)
      if (fs.existsSync(target)) continue
      await fetchOne(f, target, abort.signal, (n) => {
        p.done = base + n
        if (p.done > p.total) p.total = p.done
        if (Date.now() - last > 300) {
          last = Date.now()
          send({ ...p })
        }
      })
      base = p.done
    }
    downloading.delete(id)
    send({ id, done: p.total, total: p.total, finished: true })
  } catch (e: any) {
    downloading.delete(id)
    send({ id, done: 0, total: p.total, error: e?.message || String(e) })
    throw e
  }
}

export function cancelDownload(id: string) {
  downloading.get(id)?.abort.abort()
}

export function removeModel(id: string) {
  modelOf(id)
  cancelDownload(id)
  dropCache(id)
  fs.rmSync(dirOf(id), { recursive: true, force: true })
}

// ---------- 识别 ----------
let sherpa: any = null
const lib = () => (sherpa ||= require('sherpa-onnx-node'))
const recognizers = new Map<string, any>()
let punctuator: any = null
const dropCache = (id: string) => {
  recognizers.delete(id)
  if (id === 'punct-zh') punctuator = null
}

const threads = () => Math.max(1, Math.min(4, require('os').cpus().length - 1))

async function recognizerOf(id: string) {
  if (recognizers.has(id)) return recognizers.get(id)
  const m = modelOf(id)
  const r = await lib().OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { ...m.config!(dirOf(id)), numThreads: threads(), provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search'
  })
  recognizers.set(id, r)
  return r
}

/** 按停顿把整段录音切成小段（每段不超过 20 秒），太长的整段模型吃不下 */
function segments(id: string, samples: Float32Array): Float32Array[] {
  const vadPath = fileOf(id, VAD)
  if (!fs.existsSync(vadPath)) return [samples]
  const win = 512
  const vad = new (lib().Vad)(
    { sileroVad: { model: vadPath, threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: win }, sampleRate: 16000, debug: 0, numThreads: 1 },
    Math.ceil(samples.length / 16000) + 60
  )
  const out: Float32Array[] = []
  const drain = () => {
    while (!vad.isEmpty()) {
      out.push(Float32Array.from(vad.front(false).samples))
      vad.pop()
    }
  }
  for (let i = 0; i + win <= samples.length; i += win) {
    vad.acceptWaveform(samples.subarray(i, i + win))
    drain()
  }
  vad.flush()
  drain()
  return out
}

/**
 * 识别一段 16kHz 单声道音频。onPart 每识别完一小段回调一次（界面显示进度）。
 * 模型不带标点、又装了「中文标点」时自动加标点。
 */
export async function transcribe(id: string, samples: Float32Array, onPart?: (done: number, total: number) => void) {
  if (!isInstalled(id)) throw new Error('这个识别模型还没下载，请到 设置 → 语音识别 里安装')
  const m = modelOf(id)
  const rec = await recognizerOf(id)
  const segs = segments(id, samples)
  const texts: string[] = []
  for (let i = 0; i < segs.length; i++) {
    const s = rec.createStream()
    s.acceptWaveform({ samples: segs[i], sampleRate: 16000 })
    await rec.decodeAsync(s)
    const t = String(rec.getResult(s).text || '').trim()
    if (t) texts.push(t)
    onPart?.(i + 1, segs.length)
  }
  let text = texts.join(m.punct ? '' : '，')
  if (!m.punct && text && isInstalled('punct-zh')) {
    try {
      punctuator ||= new (lib().OfflinePunctuation)({ model: { ctTransformer: fileOf('punct-zh', { repo: '', path: 'model.onnx' }), numThreads: threads(), debug: 0, provider: 'cpu' } })
      text = punctuator.addPunct(texts.join(' '))
    } catch {}
  }
  return text
}
