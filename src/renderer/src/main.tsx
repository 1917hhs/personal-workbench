import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// Windows 上 confirm / alert 弹窗关掉后，输入框会打不了字（Electron 的老问题）：弹窗一关就让主进程把焦点还回来
const w = window as any
for (const k of ['confirm', 'alert'] as const) {
  const orig = w[k].bind(window)
  w[k] = (...a: any[]) => {
    const active = document.activeElement as HTMLElement | null
    const r = orig(...a)
    w.api?.send('win:refocus')
    // 焦点回来后，原来在哪个输入框里就回到哪个
    setTimeout(() => active && document.contains(active) && active !== document.body && active.focus?.(), 60)
    return r
  }
}

createRoot(document.getElementById('root')!).render(<App />)
