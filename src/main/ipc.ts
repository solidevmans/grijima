import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  AppSettings,
  BundleSummary,
  ExportSummary,
  IpcResult,
  Project,
  ProviderId,
  RawAnalysis,
  ValidationIssue,
  VaultSummary,
  WorkbookData
} from '@shared/types'
import { PROJECT_FILE_EXT } from '@shared/constants'
import { readWorkbook } from './core/excel'
import { getProvider } from './core/llm'
import { resolveModel, unloadEmbeddedModel } from './core/llm/embedded'
import { extractJson } from './core/json-repair'
import { generateProject } from './core/generate'
import { emptyProject, normalizeToProject } from './core/normalize'
import { buildXmi } from './core/xmi'
import { toPlantUml } from './core/plantuml'
import { toVault } from './core/markdown'
import { validateProject } from './core/validate'
import { loadSettings, saveSettings } from './core/settings'
import { writeZip } from './core/zip'
import { bundleEntries, readProjectFromZip } from './core/bundle'
import { hwpToText } from './hwp'

const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })
const fail = (e: unknown): IpcResult<never> => ({
  ok: false,
  error: e instanceof Error ? e.message : String(e)
})

/** 진행 중인 LLM 호출 취소용 */
let currentAbort: AbortController | null = null

function win(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

export function registerIpc(): void {
  /* ------------------------------------------------------------------ */
  /* 설정                                                                */
  /* ------------------------------------------------------------------ */

  ipcMain.handle('settings:get', () => ok(loadSettings()))

  ipcMain.handle('settings:save', (_e, next: AppSettings) => {
    try {
      /*
       * 임베디드 모델은 한 번 올리면 계속 들고 있다(1.9GB). 설정이 바뀌면
       * 그 자리에서 내린다 — 경로나 num_ctx 를 바꿨는데 예전 모델이 계속
       * 답하면 사용자는 설정이 안 먹었다고 생각한다.
       */
      void unloadEmbeddedModel()
      return ok(saveSettings(next))
    } catch (e) {
      return fail(e)
    }
  })

  /** 임베디드 모델 파일(.gguf) 고르기 */
  /** 지금 쓰는 모델 — 동봉된 것인지, 사용자가 바꾼 것인지 */
  ipcMain.handle('llm:modelInfo', () => {
    try {
      return ok(resolveModel(loadSettings().providers.embedded))
    } catch (e) {
      return fail(e)
    }
  })


  /* ------------------------------------------------------------------ */
  /* LLM                                                                 */
  /* ------------------------------------------------------------------ */

  ipcMain.handle('llm:ping', async (_e, id: ProviderId) => {
    try {
      const s = loadSettings()
      const msg = await getProvider(id).ping(s.providers[id])
      return ok(msg)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('llm:cancel', () => {
    currentAbort?.abort()
    currentAbort = null
    return ok(true)
  })

  ipcMain.handle(
    'llm:generate',
    async (
      _e,
      args: {
        requirementText: string
        systemName: string
        projectId: string
        author?: string
        team?: { code: string; name: string }
        actors?: string[]
      }
    ): Promise<
      IpcResult<{
        project: Project
        rawText: string
        calls: number
        strategy: string
        warnings: string[]
      }>
    > => {
      try {
        const settings = loadSettings()
        currentAbort = new AbortController()
        const target = win()

        const result = await generateProject({
          ...args,
          settings,
          signal: currentAbort.signal,
          onProgress: (p) =>
            target?.webContents.send('llm:progress', {
              chars: p.chars,
              chunkIndex: p.index,
              chunkTotal: p.total,
              label: p.label
            })
        })
        currentAbort = null
        return ok(result)
      } catch (e) {
        currentAbort = null
        return fail(e)
      }
    }
  )

  /** 이미 가지고 있는 JSON 텍스트를 프로젝트로 변환 (LLM 없이) */
  ipcMain.handle(
    'llm:fromJson',
    (_e, args: { jsonText: string; systemName: string; projectId: string }) => {
      try {
        const raw = extractJson<RawAnalysis>(args.jsonText)
        return ok(
          normalizeToProject(raw, { systemName: args.systemName, projectId: args.projectId })
        )
      } catch (e) {
        return fail(e)
      }
    }
  )

  /* ------------------------------------------------------------------ */
  /* 엑셀                                                                */
  /* ------------------------------------------------------------------ */

  ipcMain.handle('excel:open', async (): Promise<IpcResult<WorkbookData | null>> => {
    try {
      const w = win()
      if (!w) return ok(null)
      const res = await dialog.showOpenDialog(w, {
        title: '요구사항 정의서 열기',
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xlsm'] }],
        properties: ['openFile']
      })
      if (res.canceled || !res.filePaths[0]) return ok(null)
      return ok(await readWorkbook(res.filePaths[0]))
    } catch (e) {
      return fail(e)
    }
  })

  /* ------------------------------------------------------------------ */
  /* 프로젝트 파일                                                        */
  /* ------------------------------------------------------------------ */

  ipcMain.handle('project:new', () => ok(emptyProject()))

  /**
   * 프로젝트 열기. 꾸러미 zip 도 받는다 — 받은 사람이 풀지 않고 바로 이어서 고칠 수 있게.
   * zip 에서 열면 `filePath` 가 null 이다: 저장이 zip 을 JSON 으로 덮어쓰면 안 되므로
   * 어디에 둘지 다시 묻는다.
   */
  ipcMain.handle(
    'project:open',
    async (): Promise<IpcResult<{ project: Project; filePath: string | null } | null>> => {
      try {
        const w = win()
        if (!w) return ok(null)
        const res = await dialog.showOpenDialog(w, {
          title: '프로젝트 열기',
          filters: [{ name: 'EA UseCase Studio', extensions: [PROJECT_FILE_EXT, 'zip', 'json'] }],
          properties: ['openFile']
        })
        if (res.canceled || !res.filePaths[0]) return ok(null)
        const picked = res.filePaths[0]

        if (picked.toLowerCase().endsWith('.zip')) {
          return ok({ project: readProjectFromZip(await readFile(picked)), filePath: null })
        }

        const project = JSON.parse(await readFile(picked, 'utf-8')) as Project
        return ok({ project, filePath: picked })
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(
    'project:save',
    async (
      _e,
      args: { project: Project; filePath: string | null; saveAs?: boolean }
    ): Promise<IpcResult<string | null>> => {
      try {
        const w = win()
        let path = args.filePath
        if (!path || args.saveAs) {
          if (!w) return ok(null)
          const res = await dialog.showSaveDialog(w, {
            title: '프로젝트 저장',
            defaultPath: `${sanitizeFileName(args.project.metadata.systemName)}.${PROJECT_FILE_EXT}`,
            filters: [{ name: 'EA UseCase Studio', extensions: [PROJECT_FILE_EXT] }]
          })
          if (res.canceled || !res.filePath) return ok(null)
          path = res.filePath
        }
        await writeFile(path, JSON.stringify(args.project, null, 2), 'utf-8')
        return ok(path)
      } catch (e) {
        return fail(e)
      }
    }
  )

  /* ------------------------------------------------------------------ */
  /* 내보내기                                                            */
  /* ------------------------------------------------------------------ */

  ipcMain.handle(
    'export:xmi',
    async (_e, args: { project: Project }): Promise<IpcResult<ExportSummary | null>> => {
      try {
        const w = win()
        if (!w) return ok(null)
        const defaultName = `${sanitizeFileName(args.project.metadata.systemName)}_usecase.xmi`
        const res = await dialog.showSaveDialog(w, {
          title: 'EA XMI 내보내기',
          defaultPath: defaultName,
          filters: [{ name: 'EA XMI', extensions: ['xmi', 'xml'] }]
        })
        if (res.canceled || !res.filePath) return ok(null)

        const { xml, stats } = buildXmi(args.project)
        // 모든 비ASCII 문자는 &#nnn; 로 치환되어 있으므로 latin1 로 써도 안전하며,
        // EA가 기대하는 windows-1252 선언과 실제 바이트가 일치한다.
        const buf = Buffer.from(xml, 'latin1')
        await writeFile(res.filePath, buf)
        return ok({ filePath: res.filePath, ...stats, bytes: buf.length })
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(
    'export:plantuml',
    async (
      _e,
      args: { project: Project; packageUid?: string | null }
    ): Promise<IpcResult<string | null>> => {
      try {
        const w = win()
        if (!w) return ok(null)
        const pkg = args.packageUid
          ? args.project.packages.find((p) => p.uid === args.packageUid)
          : undefined
        const res = await dialog.showSaveDialog(w, {
          title: 'PlantUML 내보내기',
          defaultPath: `${sanitizeFileName(pkg ? pkg.name : args.project.metadata.systemName)}.puml`,
          filters: [{ name: 'PlantUML', extensions: ['puml', 'txt'] }]
        })
        if (res.canceled || !res.filePath) return ok(null)
        await writeFile(res.filePath, toPlantUml(args.project, pkg), 'utf-8')
        return ok(res.filePath)
      } catch (e) {
        return fail(e)
      }
    }
  )

  /**
   * 마크다운 볼트 내보내기 (옵시디언 등에서 열람).
   * 파일 하나가 아니라 폴더 트리라서 저장 대화상자 대신 폴더를 고르게 한다.
   * 고른 폴더 **아래에** 시스템명 폴더를 하나 만들고 그 안에만 쓴다
   * (사용자의 기존 볼트 루트에 노트를 흩뿌리지 않기 위해).
   */
  ipcMain.handle(
    'export:vault',
    async (_e, args: { project: Project }): Promise<IpcResult<VaultSummary | null>> => {
      try {
        const w = win()
        if (!w) return ok(null)
        const res = await dialog.showOpenDialog(w, {
          title: '마크다운 볼트를 만들 위치 선택 (옵시디언 볼트 폴더)',
          buttonLabel: '이 폴더에 만들기',
          properties: ['openDirectory', 'createDirectory']
        })
        if (res.canceled || !res.filePaths[0]) return ok(null)

        const { files, stats } = toVault(args.project)
        const root = join(
          res.filePaths[0],
          sanitizeFileName(args.project.metadata.systemName)
        )

        let bytes = 0
        for (const f of files) {
          const abs = join(root, ...f.path.split('/'))
          await mkdir(dirname(abs), { recursive: true })
          const buf = Buffer.from(f.content, 'utf-8')
          await writeFile(abs, buf)
          bytes += buf.length
        }
        return ok({ dirPath: root, ...stats, bytes })
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(
    'export:json',
    async (_e, args: { project: Project }): Promise<IpcResult<string | null>> => {
      try {
        const w = win()
        if (!w) return ok(null)
        const res = await dialog.showSaveDialog(w, {
          title: 'JSON 내보내기',
          defaultPath: `${sanitizeFileName(args.project.metadata.systemName)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
        if (res.canceled || !res.filePath) return ok(null)
        await writeFile(res.filePath, JSON.stringify(args.project, null, 2), 'utf-8')
        return ok(res.filePath)
      } catch (e) {
        return fail(e)
      }
    }
  )

  /**
   * 다이어그램 그림 저장 (PNG·SVG).
   * 그림 자체는 렌더러가 캔버스로 구워서 보낸다 — 메인에는 글꼴도 캔버스도 없다.
   * 여기서는 고른 폴더 아래 `png/`, `svg/` 에 같은 이름으로 **덮어쓴다**
   * (한글 문서의 그림만 바꿔 끼울 수 있어야 한다).
   */
  ipcMain.handle(
    'export:images',
    async (
      _e,
      args: { images: { name: string; svg: string; pngBase64: string }[]; indexMd?: string | null }
    ): Promise<IpcResult<{ dirPath: string; count: number } | null>> => {
      try {
        const w = win()
        if (!w || args.images.length === 0) return ok(null)
        const res = await dialog.showOpenDialog(w, {
          title: '그림을 저장할 폴더 선택 (png/, svg/ 를 만듭니다)',
          buttonLabel: '이 폴더에 저장',
          properties: ['openDirectory', 'createDirectory']
        })
        if (res.canceled || !res.filePaths[0]) return ok(null)
        const root = res.filePaths[0]
        await mkdir(join(root, 'png'), { recursive: true })
        await mkdir(join(root, 'svg'), { recursive: true })
        for (const img of args.images) {
          const file = sanitizeFileName(img.name)
          await writeFile(join(root, 'png', `${file}.png`), Buffer.from(img.pngBase64, 'base64'))
          await writeFile(join(root, 'svg', `${file}.svg`), img.svg, 'utf-8')
        }
        if (args.indexMd) await writeFile(join(root, 'index.md'), args.indexMd, 'utf-8')
        return ok({ dirPath: root, count: args.images.length })
      } catch (e) {
        return fail(e)
      }
    }
  )

  /**
   * 프로젝트 통째로 — 꾸러미(xmi·png·svg·index.md) + 프로젝트 원본을 zip **한 파일**로.
   * 담는 내용은 core/bundle 이 정하고, 그림은 export:images 와 마찬가지로 렌더러가 구워서 보낸다.
   */
  ipcMain.handle(
    'export:bundle',
    async (
      _e,
      args: {
        project: Project
        images: { name: string; svg: string; pngBase64: string }[]
        indexMd?: string | null
      }
    ): Promise<IpcResult<BundleSummary | null>> => {
      try {
        const w = win()
        if (!w) return ok(null)
        const base = sanitizeFileName(args.project.metadata.systemName)
        const res = await dialog.showSaveDialog(w, {
          title: '프로젝트 통째로 내보내기 (zip)',
          defaultPath: `${base}_산출물.zip`,
          filters: [{ name: 'zip 꾸러미', extensions: ['zip'] }]
        })
        if (res.canceled || !res.filePath) return ok(null)

        const entries = bundleEntries(
          args.project,
          args.images.map((img) => ({ ...img, name: sanitizeFileName(img.name) })),
          args.indexMd ?? null,
          base
        )
        const zip = writeZip(entries)
        await writeFile(res.filePath, zip)
        return ok({
          filePath: res.filePath,
          files: entries.length,
          images: args.images.length,
          bytes: zip.length
        })
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle('export:preview', (_e, args: { project: Project }) => {
    try {
      const { xml, stats } = buildXmi(args.project)
      return ok({ xml, stats })
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('export:plantumlText', (_e, args: { project: Project; packageUid?: string | null }) => {
    try {
      const pkg = args.packageUid
        ? args.project.packages.find((p) => p.uid === args.packageUid)
        : undefined
      return ok(toPlantUml(args.project, pkg))
    } catch (e) {
      return fail(e)
    }
  })

  /* ------------------------------------------------------------------ */
  /* 검증 / 기타                                                         */
  /* ------------------------------------------------------------------ */

  ipcMain.handle('validate:run', (_e, project: Project): IpcResult<ValidationIssue[]> => {
    try {
      return ok(validateProject(project))
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('shell:showItem', (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
    return ok(true)
  })

  ipcMain.handle('shell:openPath', (_e, filePath: string) => {
    void shell.openPath(filePath)
    return ok(true)
  })

  /** 텍스트 파일(요구사항 .txt/.md) 열기 */
  ipcMain.handle('text:open', async (): Promise<IpcResult<{ name: string; text: string } | null>> => {
    try {
      const w = win()
      if (!w) return ok(null)
      const res = await dialog.showOpenDialog(w, {
        title: '요구사항 텍스트 열기',
        filters: [{ name: '텍스트', extensions: ['txt', 'md', 'csv'] }],
        properties: ['openFile']
      })
      if (res.canceled || !res.filePaths[0]) return ok(null)
      const text = await readFile(res.filePaths[0], 'utf-8')
      return ok({ name: basename(res.filePaths[0]), text })
    } catch (e) {
      return fail(e)
    }
  })

  /** HWP 정의서 열기 — 경로가 없으면 고르는 창. 끌어다 놓기는 경로를 넘긴다 */
  ipcMain.handle(
    'hwp:open',
    async (_e, filePath?: string): Promise<IpcResult<{ name: string; text: string } | null>> => {
      try {
        let p = filePath
        if (!p) {
          const w = win()
          if (!w) return ok(null)
          const res = await dialog.showOpenDialog(w, {
            title: '요구사항 정의서(HWP) 열기',
            filters: [{ name: '한글 문서', extensions: ['hwp'] }],
            properties: ['openFile']
          })
          if (res.canceled || !res.filePaths[0]) return ok(null)
          p = res.filePaths[0]
        }
        // 기다림 판의 `취소`(llm:cancel)가 이것도 끊는다
        currentAbort = new AbortController()
        const { signal } = currentAbort
        try {
          return ok({ name: basename(p), text: await hwpToText(p, signal) })
        } catch (e) {
          if (signal.aborted) return ok(null)
          throw e
        }
      } catch (e) {
        return fail(e)
      }
    }
  )

  /** LLM 원시 응답 덤프 (디버깅용) */
  ipcMain.handle(
    'debug:dumpRaw',
    async (_e, args: { text: string; hint: string }): Promise<IpcResult<string | null>> => {
      try {
        const w = win()
        if (!w) return ok(null)
        const res = await dialog.showSaveDialog(w, {
          title: '원시 응답 저장',
          defaultPath: join(dirname(''), `${sanitizeFileName(args.hint || 'llm-raw')}.txt`)
        })
        if (res.canceled || !res.filePath) return ok(null)
        await writeFile(res.filePath, args.text, 'utf-8')
        return ok(res.filePath)
      } catch (e) {
        return fail(e)
      }
    }
  )
}

function sanitizeFileName(name: string): string {
  return (name || 'project').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_')
}
