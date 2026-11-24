import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { Store } from './store'
import { registerIpc } from './ipc'
import { migrateCompanyFiles, repairInquiryPaths } from './procure'
import { mediaAbs } from './memo'

// lf://file/?p=<绝对路径>：让界面能显示本地图片、PDF、视频
protocol.registerSchemesAsPrivileged([
  { scheme: 'lf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
])

// 测试时可用环境变量把数据放到别处，不影响正式数据
if (process.env.PROJECT_DESK_USERDATA) app.setPath('userData', process.env.PROJECT_DESK_USERDATA)

let win: BrowserWindow | null = null
let store: Store

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: '个人工作台',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      plugins: true
    }
  })
  win.once('ready-to-show', () => {
    win!.maximize()
    win!.show()
  })
  // 界面里的外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

app.whenReady().then(() => {
  protocol.handle('lf', (req) => {
    const u = new URL(req.url)
    let p = u.searchParams.get('p')
    if (!p) return new Response('missing path', { status: 400 })
    // 备忘录里的图片、录音、视频：lf://kbmedia/?p=<归属>/<文件名>，相对于数据文件夹
    if (u.host === 'kbmedia') {
      try {
        p = mediaAbs(store, p)
      } catch {
        return new Response('bad path', { status: 400 })
      }
    }
    return net.fetch(pathToFileURL(p).toString())
  })
  store = new Store()
  try {
    repairInquiryPaths(store)
  } catch (e) {
    console.error(e)
  }
  try {
    migrateCompanyFiles(store)
  } catch (e) {
    console.error('迁移供应商附件失败', e)
  }
  registerIpc(store, () => win)
  createWindow()
})

app.on('window-all-closed', () => app.quit())
