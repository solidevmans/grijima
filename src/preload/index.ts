import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppSettings,
  BundleSummary,
  ExportSummary,
  IpcResult,
  Project,
  ProviderId,
  ValidationIssue,
  VaultSummary,
  WorkbookData
} from '@shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>

const api = {
  settings: {
    get: () => invoke<AppSettings>('settings:get'),
    save: (s: AppSettings) => invoke<AppSettings>('settings:save', s)
  },

  llm: {
    ping: (id: ProviderId) => invoke<string>('llm:ping', id),
    /** 지금 쓰는 모델 정보. 없으면 null */
    modelInfo: () =>
      invoke<{
        path: string
        name: string
        sizeGb: string
        source: 'bundled' | 'custom'
      } | null>('llm:modelInfo'),
    generate: (args: {
      requirementText: string
      systemName: string
      projectId: string
      author?: string
      /** 정의서에 요구사항 ID가 없을 때 채번에 넣을 수행 팀 */
      team?: { code: string; name: string }
      /** 액터 사전 — 주면 유스케이스 액터를 이 이름 중에서 고른다 */
      actors?: string[]
    }) =>
      invoke<{
        project: Project
        rawText: string
        calls: number
        strategy: string
        warnings: string[]
      }>('llm:generate', args),
    fromJson: (args: { jsonText: string; systemName: string; projectId: string }) =>
      invoke<Project>('llm:fromJson', args),
    cancel: () => invoke<boolean>('llm:cancel'),
    onProgress: (
      cb: (p: {
        chars?: number
        chunkIndex?: number
        chunkTotal?: number
        label?: string
      }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        p: { chars?: number; chunkIndex?: number; chunkTotal?: number; label?: string }
      ): void => cb(p)
      ipcRenderer.on('llm:progress', listener)
      return (): void => {
        ipcRenderer.removeListener('llm:progress', listener)
      }
    }
  },

  excel: {
    open: () => invoke<WorkbookData | null>('excel:open')
  },

  text: {
    open: () => invoke<{ name: string; text: string } | null>('text:open')
  },

  hwp: {
    /** 경로를 주면 그 파일, 안 주면 고르는 창. 한글(COM)로 본문을 꺼낸다 */
    open: (filePath?: string) => invoke<{ name: string; text: string } | null>('hwp:open', filePath),
    /** 끌어다 놓은 파일의 실제 경로 (Electron 32부터 File.path 가 없다) */
    pathOf: (file: File) => webUtils.getPathForFile(file)
  },

  project: {
    create: () => invoke<Project>('project:new'),
    /** 꾸러미 zip 에서 열면 filePath 가 null 이다 (zip 을 덮어쓰지 않기 위해) */
    open: () => invoke<{ project: Project; filePath: string | null } | null>('project:open'),
    save: (project: Project, filePath: string | null, saveAs = false) =>
      invoke<string | null>('project:save', { project, filePath, saveAs }),
    /** 실행 인자로 전달된 프로젝트 수신 (파일 연결/드래그) */
    onOpened: (cb: (p: { project: Project; filePath: string }) => void): (() => void) => {
      const listener = (_e: unknown, p: { project: Project; filePath: string }): void => cb(p)
      ipcRenderer.on('project:opened', listener)
      return (): void => {
        ipcRenderer.removeListener('project:opened', listener)
      }
    }
  },

  exporter: {
    xmi: (project: Project) => invoke<ExportSummary | null>('export:xmi', { project }),
    plantuml: (project: Project, packageUid?: string | null) =>
      invoke<string | null>('export:plantuml', { project, packageUid }),
    json: (project: Project) => invoke<string | null>('export:json', { project }),
    /** 마크다운 볼트(옵시디언). 파일이 아니라 폴더 트리를 만든다 */
    vault: (project: Project) => invoke<VaultSummary | null>('export:vault', { project }),
    preview: (project: Project) =>
      invoke<{ xml: string; stats: Record<string, number> }>('export:preview', { project }),
    plantumlText: (project: Project, packageUid?: string | null) =>
      invoke<string>('export:plantumlText', { project, packageUid }),
    /**
     * 다이어그램 그림(PNG·SVG). 그림은 렌더러에서 굽고 여기는 저장만 한다
     * (메인에는 글꼴·캔버스가 없다). 고른 폴더 안에 `png/`, `svg/` 를 만든다.
     */
    images: (images: { name: string; svg: string; pngBase64: string }[], indexMd?: string | null) =>
      invoke<{ dirPath: string; count: number } | null>('export:images', { images, indexMd }),
    /** 프로젝트 통째로 — 꾸러미 + 프로젝트 원본을 zip 한 파일로 */
    bundle: (
      project: Project,
      images: { name: string; svg: string; pngBase64: string }[],
      indexMd?: string | null
    ) => invoke<BundleSummary | null>('export:bundle', { project, images, indexMd })
  },

  validate: {
    run: (project: Project) => invoke<ValidationIssue[]>('validate:run', project)
  },

  shell: {
    showItem: (p: string) => invoke<boolean>('shell:showItem', p),
    openPath: (p: string) => invoke<boolean>('shell:openPath', p)
  },

  debug: {
    dumpRaw: (text: string, hint: string) => invoke<string | null>('debug:dumpRaw', { text, hint })
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
