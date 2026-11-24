import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('api', {
  call: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, cb: (...a: unknown[]) => void) => {
    const handler = (_e: unknown, ...a: unknown[]) => cb(...a)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  startDrag: (id: string, rel: string) => ipcRenderer.send('fs:startDrag', id, rel),
  startDragAbs: (p: string) => ipcRenderer.send('fs:startDragAbs', p)
})
