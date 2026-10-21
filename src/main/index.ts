import { app, BrowserWindow, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from './ipc'

/**
 * 열면서 바로 띄울 .eaucs 경로.
 *  - 실행 인자: 파일 연결·드래그로 여는 보통의 경우
 *  - `EA_OPEN` 환경변수: 화면 캡처용. `npm run dev`(electron-vite)는 파일 경로 인자를
 *    제 설정 경로로 알아듣고 먹어 버려서, 인자로는 프로젝트를 띄울 길이 없다.
 */
function projectPathToOpen(argv: string[]): string | null {
  const hit = argv.slice(1).find((a) => /\.(eaucs|json)$/i.test(a) && !a.startsWith('--'))
  return hit ?? process.env.EA_OPEN ?? null
}

// EA_QA=1: 캡처용 앱은 저장 폴더를 따로 쓴다. 사람이 켠 앱과 같은 폴더를 잡으면
// 나중에 뜬 쪽이 캐시를 못 옮겨 `Unable to move the cache (0x5)`가 줄줄이 뜬다.
// app ready 전에 정해야 하고, 폴더를 먼저 만들어야 DevTools가 포트 파일을 쓴다.
if (process.env.EA_QA === '1') {
  const qaData = `${app.getPath('userData')}-qa`
  mkdirSync(qaData, { recursive: true })
  app.setPath('userData', qaData)
}

function createWindow(): void {
  // EA_QA=1: 화면 캡처 도구(scripts/cdp-shot.mjs)가 사람 작업을 방해하지 않도록
  // 창을 화면 밖에 띄운다. 최소화는 쓰지 않는다 — 최소화된 창은 그리기를 멈춰 캡처가 검게 나온다.
  const qaOffscreen = process.env.EA_QA === '1'
  const win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    ...(qaOffscreen ? { x: -4000, y: 0, skipTaskbar: true } : {}),
    title: 'EA UseCase Studio',
    // 기본 테마가 라이트다. 여기에 다크색을 두면 창이 뜨는 순간 검은 판이
    // 번쩍였다가 흰 화면으로 바뀐다.
    backgroundColor: '#f4f6f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 맞춤법 검사 끔: 한글 업무 용어·ID 전부에 빨간 밑줄이 그어지고, 사전을 외부에서 받아 온다(폐쇄망)
      spellcheck: false,
      backgroundThrottling: !qaOffscreen
    }
  })

  win.on('ready-to-show', () => (qaOffscreen ? win.showInactive() : win.show()))

  // 렌더러 오류를 메인 콘솔로 끌어올린다 (빈 화면 디버깅용)
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error('[renderer]', message, `(${sourceId}:${line})`)
  })
  win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer gone]', d.reason))

  // 인자로 프로젝트가 넘어왔으면 로드 완료 후 렌더러에 전달한다
  win.webContents.once('did-finish-load', () => {
    const p = projectPathToOpen(process.argv)
    if (!p) return
    void readFile(p, 'utf-8')
      .then((text) => win.webContents.send('project:opened', { project: JSON.parse(text), filePath: p }))
      .catch((e) => win.webContents.send('project:openFailed', String(e)))
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
