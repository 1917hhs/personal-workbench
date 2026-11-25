import { api } from './lib'

/** 把一段音频（任意格式，浏览器能播的就行）解码成 16kHz 单声道，交给本机识别模型转成文字 */
export async function transcribeUrl(src: string, onPart?: (done: number, total: number) => void): Promise<string> {
  const buf = await (await fetch(src)).arrayBuffer()
  const ctx = new AudioContext()
  let audio: AudioBuffer
  try {
    audio = await ctx.decodeAudioData(buf)
  } catch {
    throw new Error('这段音频的格式读不出来')
  } finally {
    ctx.close().catch(() => {})
  }
  const rate = 16000
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * rate)), rate)
  const s = off.createBufferSource()
  s.buffer = audio
  s.connect(off.destination)
  s.start()
  const out = await off.startRendering()
  const off2 = onPart ? api.on('asr:part', onPart) : null
  try {
    return await api.call('asr:transcribe', out.getChannelData(0))
  } finally {
    off2?.()
  }
}
