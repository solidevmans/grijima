import { create } from 'zustand'
import type {
  Actor,
  AppSettings,
  Diagram,
  Point,
  Project,
  UcPackage,
  UseCase,
  ValidationIssue
} from '@shared/types'
import { ADMIN_VERB, DEFAULT_PROJECT_SETTINGS, isAdminActor } from '@shared/constants'
import { diagramNameOf, diagramReqId, packageCode, renumber, splitSubNo, useCaseCode } from '@shared/idrules'
import { relationEdges, wouldCreateCycle } from '@shared/graph'
import { nextUseCasePosition } from '@shared/layout'

export type ViewId = 'import' | 'model' | 'export' | 'settings'

export interface Selection {
  packageUid: string | null
  diagramUid: string | null
  useCaseUid: string | null
  actorUid: string | null
}

const EMPTY_SELECTION: Selection = {
  packageUid: null,
  diagramUid: null,
  useCaseUid: null,
  actorUid: null
}

/**
 * 되돌리기·다시 실행 뒤 고름을 `to` 프로젝트에 있는 것으로 맞춘다.
 * 사라진 유스케이스·다이어그램을 가리키면 `from`(바꾸기 전)에서 찾은 부모로 올린다 —
 * 그대로 두면 트리엔 고른 줄이 없고 편집 화면은 없는 다이어그램을 찾다 빈 상태가 된다.
 */
function keepSelection(sel: Selection, from: Project, to: Project): Selection {
  const out = { ...sel }
  const has = (pred: (p: UcPackage) => boolean) => to.packages.some(pred)
  if (out.actorUid && !to.actors.some((a) => a.uid === out.actorUid)) out.actorUid = null
  if (out.useCaseUid && !has((p) => p.useCases.some((u) => u.uid === out.useCaseUid))) {
    const pkg = from.packages.find((p) => p.useCases.some((u) => u.uid === out.useCaseUid))
    const uc = pkg?.useCases.find((u) => u.uid === out.useCaseUid)
    out.useCaseUid = null
    out.packageUid = pkg?.uid ?? out.packageUid
    out.diagramUid = uc?.diagramUid ?? out.diagramUid
  }
  if (out.diagramUid && !has((p) => p.diagrams.some((d) => d.uid === out.diagramUid))) {
    const pkg = from.packages.find((p) => p.diagrams.some((d) => d.uid === out.diagramUid))
    out.diagramUid = null
    out.packageUid = pkg?.uid ?? out.packageUid
  }
  if (out.packageUid && !has((p) => p.uid === out.packageUid)) return EMPTY_SELECTION
  return out
}

interface Toast {
  id: number
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
}

/**
 * 되돌릴 수 없는 행동 앞에 띄우는 확인.
 *
 * 왜 store 에 두는가: 확인이 필요한 자리가 가져오기·트리·폼으로 흩어져 있다.
 * 자리마다 따로 만들면 탭마다 다르게 생긴 대화상자가 생기고, "같은 뜻은 같은 모양"
 * 원칙에 어긋난다. 판 하나를 App 에서 그리고 요청만 보낸다.
 */
export interface ConfirmRequest {
  /** 한 문장 질문. "무엇이 어떻게 된다" 가 들어가야 한다 */
  title: string
  /** 잃는 것·바뀌는 것을 구체적인 수치로 */
  body?: string
  /** 진행 버튼 글자. 기본 "계속" — 되돌릴 수 없으면 그 행동을 그대로 적는다 */
  confirmLabel?: string
  /** 되돌릴 수 없으면 true. 진행 버튼이 빨간 테두리가 되고 기본 초점은 취소에 남는다 */
  danger?: boolean
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void
}

interface State {
  project: Project | null
  filePath: string | null
  dirty: boolean
  /**
   * 마지막으로 열거나 저장한 프로젝트 객체. 편집은 늘 새 객체를 만들고 되돌리기는
   * 옛 객체를 그대로 돌려놓으므로, 같은 객체로 돌아오면 저장된 파일과 같다.
   */
  savedProject: Project | null
  view: ViewId
  /** 편집 탭 오른쪽 화면(상세 폼 / 다이어그램). 탭을 오가도 남고, 점검 줄이 상세로 열 수 있다 */
  modelPane: 'edit' | 'diagram'
  /** 가져오기 탭이 열리면 원문에서 찾아 고를 요구사항 ID (점검 카드의 뺀 요구사항 줄). 찾고 나면 비운다 */
  sourceFocus: string | null
  selection: Selection
  expanded: Record<string, boolean>
  issues: ValidationIssue[]
  settings: AppSettings | null
  busy: string | null
  toasts: Toast[]
  confirming: PendingConfirm | null
  /** 되돌리기용 이전 상태들. 맨 뒤가 바로 직전 */
  history: Project[]
  /** 되돌린 것을 다시 실행하기 위한 앞선 상태들 */
  future: Project[]

  /* ---- 앱 수준 ---- */
  setProject: (p: Project | null, filePath?: string | null) => void
  setFilePath: (p: string | null) => void
  /** 이 프로젝트가 파일에 저장됐다. 빼면 지금 프로젝트 */
  markSaved: (p?: Project) => void
  setView: (v: ViewId) => void
  setModelPane: (m: 'edit' | 'diagram') => void
  setSourceFocus: (id: string | null) => void
  setSettings: (s: AppSettings) => void
  setIssues: (i: ValidationIssue[]) => void
  setBusy: (b: string | null) => void
  toast: (level: Toast['level'], message: string) => void
  dismissToast: (id: number) => void
  /** 사용자가 "계속" 을 누르면 true. 창을 닫거나 Esc 면 false */
  confirm: (req: ConfirmRequest) => Promise<boolean>
  answerConfirm: (ok: boolean) => void
  /** 편집 하나를 되돌린다. 되돌릴 게 없으면 아무 일도 안 한다 */
  undo: () => void
  /** 되돌린 편집을 다시 실행한다 */
  redo: () => void

  /* ---- 선택 / 트리 ---- */
  select: (sel: Partial<Selection>) => void
  toggleExpand: (uid: string) => void
  expandAll: (open: boolean) => void

  /* ---- 편집 ---- */
  /**
   * 프로젝트를 고치는 유일한 통로. 고치기 전 상태를 되돌리기 더미에 쌓는다.
   *
   * `coalesceKey`: 같은 열쇠로 연달아(1초 안에) 들어온 변경은 되돌리기 한 칸으로
   * 묶는다. 글자 한 자, 드래그 한 픽셀마다 칸이 생기면 Ctrl+Z 를 수십 번 눌러야
   * 삭제 하나를 되돌릴 수 있다. 열쇠가 없으면 항상 새 칸이다(삭제·추가·이동).
   */
  mutate: (fn: (draft: Project) => void, coalesceKey?: string) => void
  updateMetadata: (patch: Partial<Project['metadata']>) => void
  updateProjectSettings: (patch: Partial<Project['settings']>) => void

  /** UCD 패키지 = 요구사항 1건 */
  addPackage: () => void
  updatePackage: (uid: string, patch: Partial<UcPackage>) => void
  removePackage: (uid: string) => void
  movePackage: (uid: string, dir: -1 | 1) => void

  /** 다이어그램 — 패키지 하나에 1..N개 */
  addDiagram: (packageUid: string) => void
  updateDiagram: (uid: string, patch: Partial<Diagram>) => void
  removeDiagram: (uid: string) => void
  moveDiagram: (uid: string, dir: -1 | 1) => void

  /** fromItem: 다이어그램의 '시스템 처리로 뺀 항목' 하나를 그 이름으로 되살린다 */
  /** fromItem(뺀 항목 되살리기)이면 붙인 액터 이름을 돌려준다 — 못 붙였으면 null */
  /** source: 유스케이스에 없는 상세 내용 항목을 되살릴 때 그 항목 글 — 점검이 다시 세지 않게 sources로 남긴다 */
  addUseCase: (packageUid: string, diagramUid: string, fromItem?: string, source?: string) => string | null
  updateUseCase: (uid: string, patch: Partial<UseCase>) => void
  removeUseCase: (uid: string) => void
  moveUseCase: (uid: string, dir: -1 | 1) => void
  /** 다른 다이어그램(같은/다른 패키지)으로 옮긴다 */
  reparentUseCase: (uid: string, toPackageUid: string, toDiagramUid: string) => void
  duplicateUseCase: (uid: string) => void
  setUseCasePosition: (uid: string, pos: Point | null) => void
  toggleActorLink: (useCaseUid: string, actorUid: string) => void
  /**
   * 유스케이스끼리 include/extend 를 잇거나 끊는다 (다이어그램에서 직접 연결용).
   * 이미 있으면 끊고, 없으면 잇는다. 순환이 생기는 연결은 거부한다.
   */
  linkUseCases: (
    fromUid: string,
    toUid: string,
    type: 'include' | 'extend'
  ) => 'added' | 'removed' | 'cycle' | 'invalid'
  /**
   * 액터를 여러 유스케이스에 한 번에 붙이거나 뗀다.
   * 바뀐 건수를 돌려준다(이미 그 상태였던 것은 세지 않는다).
   */
  setActorOnUseCases: (actorUid: string, useCaseUids: string[], on: boolean) => number
  /** 아무 유스케이스도 쓰지 않는 액터를 한 번에 지운다. 지운 이름을 돌려준다 */
  removeUnusedActors: () => string[]

  addActor: () => void
  updateActor: (uid: string, patch: Partial<Actor>) => void
  removeActor: (uid: string) => void
  setActorPosition: (uid: string, pos: Point) => void
  /** 특정 다이어그램 안에서의 액터 좌표 */
  setDiagramActorPosition: (diagramUid: string, actorUid: string, pos: Point | null) => void
  /** 다이어그램에 액터를 직접 올린다 (연결 없이 자리만) */
  placeActorOnDiagram: (diagramUid: string, actorUid: string, pos: Point) => void
  /** 다이어그램에서 액터를 뺀다 (그 다이어그램의 연결도 함께 끊는다) */
  removeActorFromDiagram: (diagramUid: string, actorUid: string) => void

  renumberAll: (renumberUseCases: boolean) => void
}

const uuid = (): string => crypto.randomUUID()
const now = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19)

/** 새 다이어그램 하나 */
function newDiagram(seq: number): Diagram {
  return { uid: uuid(), seq, name: '', actorPositions: {}, extraActorUids: [] }
}

let toastSeq = 0

/**
 * 되돌리기 더미 최대 칸수. 프로젝트 하나가 40KB쯤이라 50칸이면 2MB —
 * 데스크톱 앱에서 문제가 안 되는 크기이고, 한 작업 분량을 되짚기엔 넉넉하다.
 */
const HISTORY_MAX = 50
/** 묶음으로 칠 시간 — 타자나 드래그가 이어지는 간격 */
const COALESCE_MS = 1000

let lastKey: string | null = null
let lastAt = 0

export const useStore = create<State>((set, get) => ({
  project: null,
  filePath: null,
  dirty: false,
  savedProject: null,
  view: 'import',
  modelPane: 'diagram',
  sourceFocus: null,
  selection: EMPTY_SELECTION,
  expanded: {},
  issues: [],
  settings: null,
  busy: null,
  toasts: [],
  confirming: null,
  history: [],
  future: [],

  setProject: (p, filePath) =>
    set({
      project: p,
      filePath: filePath === undefined ? get().filePath : filePath,
      dirty: false,
      savedProject: p,
      issues: [],
      // 다른 프로젝트의 이전 상태로 되돌아가면 안 된다
      history: [],
      future: [],
      // 첫 요구사항을 고른 채 연다 — 폼이 늘 첫 요구사항 폼으로 떨어지는데 트리에 고른 줄이
      // 없으면, 그 폼이 무엇의 폼인지 안 보이고 `삭제` 가 요구사항 통째를 지운다
      selection: { ...EMPTY_SELECTION, packageUid: p?.packages[0]?.uid ?? null },
      expanded: p ?Object.fromEntries(p.packages.map((x) => [x.uid, true])) : {}
    }),
  setFilePath: (p) => set({ filePath: p }),
  markSaved: (p) =>
    set((s) => {
      const saved = p ?? s.project
      return { savedProject: saved, dirty: s.project !== saved }
    }),
  setView: (v) => set({ view: v }),
  setModelPane: (m) => set({ modelPane: m }),
  setSourceFocus: (id) => set({ sourceFocus: id }),
  setSettings: (s) => set({ settings: s }),
  setIssues: (i) => set({ issues: i }),
  setBusy: (b) => set({ busy: b }),

  toast: (level, message) => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, level, message }] }))
    // 오류·경고는 다음 할 일을 적으니 사용자가 읽고 닫도록 오래 남긴다
    setTimeout(() => get().dismissToast(id), level === 'error' || level === 'warn' ? 15000 : 5000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  confirm: (req) =>
    new Promise<boolean>((resolve) => {
      const prev = get().confirming
      // 확인 창이 이미 떠 있는데 또 묻는 건 호출 쪽 잘못이다. 앞의 것은 취소로 닫는다.
      if (prev) prev.resolve(false)
      set({ confirming: { ...req, resolve } })
    }),
  answerConfirm: (ok) => {
    const c = get().confirming
    if (!c) return
    set({ confirming: null })
    c.resolve(ok)
  },

  select: (sel) => set((s) => ({ selection: { ...s.selection, ...sel } })),
  toggleExpand: (uid) => set((s) => ({ expanded: { ...s.expanded, [uid]: !s.expanded[uid] } })),
  expandAll: (open) =>
    set((s) => {
      if (!s.project) return {}
      const e: Record<string, boolean> = {}
      for (const p of s.project.packages) {
        e[p.uid] = open
        for (const d of p.diagrams) e[d.uid] = open
      }
      return { expanded: e }
    }),

  mutate: (fn, coalesceKey) =>
    set((s) => {
      if (!s.project) return {}
      const draft = structuredClone(s.project)
      fn(draft)
      draft.metadata.modifiedAt = now()

      const t = Date.now()
      const merge =
        coalesceKey !== undefined &&
        coalesceKey === lastKey &&
        t - lastAt < COALESCE_MS &&
        s.history.length > 0
      lastKey = coalesceKey ?? null
      lastAt = t

      return {
        project: draft,
        dirty: true,
        history: merge ? s.history : [...s.history, s.project].slice(-HISTORY_MAX),
        // 새로 고치는 순간 "다시 실행"할 앞날은 사라진다 (갈래가 생기면 안 된다)
        future: []
      }
    }),

  undo: () => {
    const s = get()
    const prev = s.history[s.history.length - 1]
    if (!prev || !s.project) return s.toast('info', '되돌릴 편집이 없습니다')
    lastKey = null
    set({
      project: prev,
      history: s.history.slice(0, -1),
      future: [...s.future, s.project],
      selection: keepSelection(s.selection, s.project, prev),
      dirty: prev !== s.savedProject,
      // 되돌리면 검증 결과는 지금 모델과 맞지 않는다
      issues: []
    })
  },

  redo: () => {
    const s = get()
    const next = s.future[s.future.length - 1]
    if (!next || !s.project) return s.toast('info', '다시 실행할 편집이 없습니다')
    lastKey = null
    set({
      project: next,
      history: [...s.history, s.project].slice(-HISTORY_MAX),
      future: s.future.slice(0, -1),
      selection: keepSelection(s.selection, s.project, next),
      dirty: next !== s.savedProject,
      issues: []
    })
  },

  updateMetadata: (patch) =>
    get().mutate((d) => Object.assign(d.metadata, patch), `meta:${Object.keys(patch).join()}`),
  updateProjectSettings: (patch) =>
    get().mutate(
      (d) => Object.assign(d.settings ?? DEFAULT_PROJECT_SETTINGS, patch),
      `settings:${Object.keys(patch).join()}`
    ),

  /* --------------------- UCD 패키지 (요구사항) ---------------------- */

  addPackage: () => {
    const uid = uuid()
    const dgm = newDiagram(1)
    get().mutate((d) => {
      const reqId = `SFR-${String(d.packages.length + 1).padStart(3, '0')}`
      d.packages.push({
        uid,
        code: packageCode(reqId),
        reqId,
        name: '새 요구사항',
        description: '',
        team: { code: '', name: '' },
        color: 'none',
        diagrams: [dgm],
        useCases: []
      })
    })
    set((s) => ({
      // 고름을 새 요구사항 하나로 통째로 바꾼다 — 액터 고름이 남으면 폼이 액터에 머문다.
      // 다이어그램은 고르지 않는다: 요구사항 줄·폼이 떠야 새 이름을 바로 고친다
      selection: { packageUid: uid, diagramUid: null, useCaseUid: null, actorUid: null },
      expanded: { ...s.expanded, [uid]: true }
    }))
  },

  updatePackage: (uid, patch) => {
    let merged: { packageUid: string; diagramUid: string; label: string; name: string } | null = null
    get().mutate((d) => {
      const p = d.packages.find((x) => x.uid === uid)
      if (!p) return
      Object.assign(p, patch)
      // 요구사항 ID가 바뀌면 패키지 코드가 따라간다 — 생성(normalize.ts)과 같은 규칙:
      // 행 ID(`SFR-002-PAD-04`)의 끝 번호는 다이어그램 번호, 패키지는 그 앞까지
      if (patch.reqId !== undefined) {
        const { base, sub } = splitSubNo(p.reqId)
        p.reqId = base
        p.code = packageCode(base)
        if (sub && p.diagrams.length === 1) p.diagrams[0].seq = sub
        // 같은 앞부분 패키지가 이미 있으면(생성이 -01을 만들어 둔 경우) 빈 새 패키지를 만들지 않고
        // 그 아래 다이어그램으로 합친다 — 코드가 같은 패키지 둘은 EA에서 같은 이름 패키지 둘이 된다
        const home = d.packages.find((x) => x.uid !== uid && x.reqId === base)
        const dgm = p.diagrams[0]
        if (
          home && sub && p.diagrams.length === 1 && p.useCases.length === 0 &&
          !home.diagrams.some((x) => x.seq === sub)
        ) {
          // 먼저 친 요구사항명은 버리지 않고 다이어그램 이름으로 옮긴다 — 패키지째 사라지기 때문.
          // 꼴은 생성(normalize.ts)이 행 이름을 다이어그램에 다는 것과 같다
          const typed = p.name.trim()
          const name = typed && typed !== '새 요구사항' && typed !== home.name && !dgm.name.trim() ? typed : ''
          if (name) dgm.name = diagramNameOf({ ...home, name }, { ...dgm, name: '' })
          home.diagrams.push(dgm)
          home.diagrams.sort((a, b) => a.seq - b.seq)
          d.packages = d.packages.filter((x) => x.uid !== uid)
          merged = { packageUid: home.uid, diagramUid: dgm.uid, label: `${home.code}-${String(sub).padStart(2, '0')}`, name }
        }
      }
    }, `pkg:${uid}:${Object.keys(patch).join()}`)
    if (merged) {
      const m: { packageUid: string; diagramUid: string; label: string; name: string } = merged
      set((s) => ({
        selection: { packageUid: m.packageUid, diagramUid: m.diagramUid, useCaseUid: null, actorUid: null },
        expanded: { ...s.expanded, [m.packageUid]: true }
      }))
      get().toast(
        'info',
        `같은 요구사항이 이미 있어 그 아래 다이어그램 ${m.label}로 넣었습니다.` +
          (m.name ? ` 이름 「${m.name}」은 다이어그램 이름이 됐습니다.` : '')
      )
    }
  },

  /**
   * UCD 삭제.
   *
   * UCD는 화면·기능 묶음이라 **다른 요구사항의 유스케이스를 담고 있을 수 있다.**
   * 통째로 지우면 남의 요구사항까지 사라진다. 그래서 대표 요구사항이 아닌
   * 유스케이스는 그 요구사항의 UCD로 **옮겨 살린다**. 옮길 곳이 없으면
   * 그 요구사항 이름으로 UCD를 새로 만든다.
   * 반환값은 살려서 옮긴 건수 — 호출부가 사용자에게 알린다.
   */
  removePackage: (uid) => {
    let rescued = 0
    get().mutate((d) => {
      const target = d.packages.find((p) => p.uid === uid)
      if (!target) return

      for (const uc of target.useCases) {
        const rid = (uc.reqId || '').trim()
        if (!rid || rid === target.reqId) continue // 이 UCD 소유 → 함께 삭제

        let home = d.packages.find((p) => p.uid !== uid && p.reqId === rid)
        if (!home) {
          const dgm = newDiagram(1)
          home = {
            uid: uuid(),
            code: packageCode(rid),
            reqId: rid,
            name: rid,
            description: '',
            team: { ...target.team },
            color: target.color,
            diagrams: [dgm],
            useCases: []
          }
          d.packages.push(home)
        }
        uc.diagramUid = (home.diagrams[0] ?? newDiagram(1)).uid
        uc.position = null
        home.useCases.push(uc)
        rescued++
      }

      d.packages = d.packages.filter((p) => p.uid !== uid)
    })
    if (rescued) {
      get().toast(
        'info',
        `다른 요구사항의 유스케이스 ${rescued}건은 지우지 않고 해당 요구사항으로 옮겼습니다.`
      )
    }
    set((s) => (s.selection.packageUid === uid ? { selection: EMPTY_SELECTION } : {}))
  },

  movePackage: (uid, dir) =>
    get().mutate((d) => {
      const i = d.packages.findIndex((p) => p.uid === uid)
      const j = i + dir
      if (i < 0 || j < 0 || j >= d.packages.length) return
      ;[d.packages[i], d.packages[j]] = [d.packages[j], d.packages[i]]
    }),

  /* ---------------------------- 다이어그램 --------------------------- */

  addDiagram: (packageUid) => {
    const dgm = newDiagram(1)
    get().mutate((d) => {
      const p = d.packages.find((x) => x.uid === packageUid)
      if (!p) return
      // 번호는 정의서 행의 하위 번호라 비어 있을 수 있다(-02·-03만) — 개수가 아니라 가장 큰 번호 다음
      dgm.seq = Math.max(0, ...p.diagrams.map((x) => x.seq)) + 1
      p.diagrams.push(dgm)
    })
    set((s) => ({
      // 고름을 새 다이어그램 하나로 통째로 바꾼다 — 액터 고름이 남으면 폼이 액터에 머문다
      selection: { packageUid, diagramUid: dgm.uid, useCaseUid: null, actorUid: null },
      expanded: { ...s.expanded, [packageUid]: true }
    }))
  },

  updateDiagram: (uid, patch) =>
    get().mutate((d) => {
      for (const p of d.packages) {
        const dg = p.diagrams.find((x) => x.uid === uid)
        if (dg) {
          Object.assign(dg, patch)
          return
        }
      }
    }, `dgm:${uid}:${Object.keys(patch).join()}`),

  removeDiagram: (uid) => {
    get().mutate((d) => {
      for (const p of d.packages) {
        if (!p.diagrams.some((x) => x.uid === uid)) continue
        // 마지막 다이어그램은 지우지 않는다 — 패키지에 그림이 하나도 없으면
        // 유스케이스가 어디에도 안 그려지는 유령이 된다.
        if (p.diagrams.length <= 1) return
        p.diagrams = p.diagrams.filter((x) => x.uid !== uid)
        // 남은 첫 다이어그램으로 유스케이스를 옮긴다
        const fallback = p.diagrams[0].uid
        for (const uc of p.useCases) {
          if (uc.diagramUid === uid) {
            uc.diagramUid = fallback
            uc.position = null
          }
        }
        return
      }
    })
    set((s) => (s.selection.diagramUid === uid ? { selection: { ...s.selection, diagramUid: null } } : {}))
  },

  moveDiagram: (uid, dir) =>
    get().mutate((d) => {
      for (const p of d.packages) {
        const i = p.diagrams.findIndex((x) => x.uid === uid)
        if (i < 0) continue
        const j = i + dir
        if (j < 0 || j >= p.diagrams.length) return
        // 순서만 바꾼다 — 번호(seq)는 정의서 행의 하위 번호라 그대로 둔다
        ;[p.diagrams[i], p.diagrams[j]] = [p.diagrams[j], p.diagrams[i]]
        return
      }
    }),

  /* --------------------------- 유스케이스 --------------------------- */

  addUseCase: (packageUid, diagramUid, fromItem, source) => {
    const uid = uuid()
    let actorName: string | null = null
    get().mutate((d) => {
      const p = d.packages.find((x) => x.uid === packageUid)
      if (!p) return
      const dgm = p.diagrams.find((x) => x.uid === diagramUid) ?? p.diagrams[0]
      if (!dgm) return
      // 새 유스케이스는 그 다이어그램의 요구사항 행 ID를 물려받는다 (인스펙터에서 바꿀 수 있다)
      const reqId = diagramReqId(p, dgm.uid)
      const n = d.packages.reduce((k, q) => k + q.useCases.filter((u) => u.reqId === reqId).length, 0)
      const position = nextUseCasePosition(p, dgm, d.settings.layoutRowHeight)
      // 되살린 유스케이스도 생성과 같은 규칙으로 액터를 붙인다 — 이 다이어그램에서
      // 등록·관리류면 관리 쪽 액터, 아니면 가장 많이 쓰는 액터. 다이어그램에 액터가 없으면 비운다
      const actorUids: string[] = []
      if (fromItem) {
        dgm.systemItems = (dgm.systemItems ?? []).filter((s) => s !== fromItem)
        const uses = new Map<string, number>()
        for (const u of p.useCases)
          if (u.diagramUid === dgm.uid) for (const a of u.actorUids) uses.set(a, (uses.get(a) ?? 0) + 1)
        const ranked = [...uses].sort((a, b) => b[1] - a[1]).map(([a]) => d.actors.find((x) => x.uid === a)).filter((a) => !!a)
        const admin = ADMIN_VERB.test(fromItem) ? ranked.find((a) => isAdminActor(a.name)) : undefined
        const chosen = admin ?? ranked[0]
        if (chosen) {
          actorUids.push(chosen.uid)
          actorName = chosen.name
        }
      }
      p.useCases.push({
        uid,
        code: useCaseCode(reqId, n),
        reqId,
        diagramUid: dgm.uid,
        name: fromItem ?? '새 유스케이스',
        priority: 'Medium',
        difficulty: '중',
        description: '',
        mainFlow: '',
        altFlow: '',
        exceptionFlow: '',
        precondition: '',
        postcondition: '',
        specialRequirement: '',
        note: '',
        actorUids,
        includeUids: [],
        extendUids: [],
        position,
        ...(source ? { sources: [source] } : {})
      })
    })
    // 뺀 항목 되살리기는 여러 개를 잇달아 누르므로 다이어그램 폼에 머문다
    if (fromItem) return actorName
    // 고름을 새 유스케이스 하나로 통째로 바꾼다 — 액터 고름이 남으면 폼이 액터에 머문다
    set({ selection: { packageUid, diagramUid, useCaseUid: uid, actorUid: null } })
    return null
  },

  updateUseCase: (uid, patch) =>
    get().mutate((d) => {
      for (const p of d.packages) {
        const uc = p.useCases.find((x) => x.uid === uid)
        if (uc) {
          // 이름을 고치면 모델이 지어낸 것이 아니라 사람이 정한 유스케이스다
          if (patch.name !== undefined && patch.name !== uc.name) delete uc.invented
          Object.assign(uc, patch)
          return
        }
      }
    }, `uc:${uid}:${Object.keys(patch).join()}`),

  removeUseCase: (uid) => {
    get().mutate((d) => {
      for (const p of d.packages) {
        p.useCases = p.useCases.filter((u) => u.uid !== uid)
        for (const u of p.useCases) {
          u.includeUids = u.includeUids.filter((x) => x !== uid)
          u.extendUids = u.extendUids.filter((x) => x !== uid)
        }
      }
    })
    set((s) => (s.selection.useCaseUid === uid ? { selection: { ...s.selection, useCaseUid: null } } : {}))
  },

  moveUseCase: (uid, dir) =>
    get().mutate((d) => {
      for (const p of d.packages) {
        const i = p.useCases.findIndex((u) => u.uid === uid)
        if (i < 0) continue
        const j = i + dir
        if (j < 0 || j >= p.useCases.length) return
        ;[p.useCases[i], p.useCases[j]] = [p.useCases[j], p.useCases[i]]
        return
      }
    }),

  reparentUseCase: (uid, toPackageUid, toDiagramUid) =>
    get().mutate((d) => {
      let moved: UseCase | null = null
      for (const p of d.packages) {
        const i = p.useCases.findIndex((u) => u.uid === uid)
        if (i >= 0) {
          moved = p.useCases.splice(i, 1)[0]
          break
        }
      }
      if (!moved) return
      const target = d.packages.find((p) => p.uid === toPackageUid)
      const dgm = target?.diagrams.find((x) => x.uid === toDiagramUid) ?? target?.diagrams[0]
      if (!target || !dgm) return
      moved.diagramUid = dgm.uid
      // 받는 다이어그램 기준 `+ 유스케이스`와 같은 자리 — 손으로 정리했으면 맨 아래 타원 아래 줄
      moved.position = nextUseCasePosition(target, dgm, d.settings.layoutRowHeight)
      target.useCases.push(moved)
    }),

  duplicateUseCase: (uid) => {
    const newUid = uuid()
    get().mutate((d) => {
      for (const p of d.packages) {
        const i = p.useCases.findIndex((u) => u.uid === uid)
        if (i < 0) continue
        const src = p.useCases[i]
        // `+ 유스케이스`와 같은 자리 규칙 — 손으로 정리한 다이어그램이면 맨 아래 타원 아래 줄
        const dgm = p.diagrams.find((g) => g.uid === src.diagramUid)
        const position = dgm ? nextUseCasePosition(p, dgm, d.settings.layoutRowHeight) : null
        p.useCases.splice(i + 1, 0, {
          ...structuredClone(src),
          uid: newUid,
          code: `${src.code}-COPY`,
          name: `${src.name} (복사)`,
          position
        })
        return
      }
    })
    set((s) => ({ selection: { ...s.selection, useCaseUid: newUid } }))
  },

  setUseCasePosition: (uid, pos) => get().updateUseCase(uid, { position: pos }),

  toggleActorLink: (useCaseUid, actorUid) =>
    get().mutate((d) => {
      for (const p of d.packages) {
        const uc = p.useCases.find((u) => u.uid === useCaseUid)
        if (!uc) continue
        uc.actorUids = uc.actorUids.includes(actorUid)
          ? uc.actorUids.filter((a) => a !== actorUid)
          : [...uc.actorUids, actorUid]
        return
      }
    }),

  /**
   * include/extend 연결 토글.
   *
   * 순환을 막는 이유: include 는 "항상 함께 실행된다"는 뜻이라 A→B→A 는
   * 무한 재귀다. EA로 내보내면 연결선이 고리로 그려지고 읽을 수 없게 된다.
   * AI 제안(relations.ts)에도 같은 검사가 있다 — 손으로 잇는 것도 같은 규칙이다.
   */
  linkUseCases: (fromUid, toUid, type) => {
    const p = get().project
    if (!p || fromUid === toUid) return 'invalid'

    const all = p.packages.flatMap((k) => k.useCases)
    const from = all.find((u) => u.uid === fromUid)
    const to = all.find((u) => u.uid === toUid)
    if (!from || !to) return 'invalid'

    const field = type === 'include' ? 'includeUids' : 'extendUids'
    const has = from[field].includes(toUid)

    if (!has && wouldCreateCycle(relationEdges(all), fromUid, toUid)) return 'cycle'

    get().mutate((d) => {
      for (const pk of d.packages) {
        const uc = pk.useCases.find((u) => u.uid === fromUid)
        if (!uc) continue
        uc[field] = has ? uc[field].filter((x) => x !== toUid) : [...uc[field], toUid]
        return
      }
    })
    return has ? 'removed' : 'added'
  },

  /*
   * 액터 일괄 연결/해제.
   *
   * 액터가 틀리게 붙는 건 소형 모델에서 늘 생긴다(README 실측: 액터 미연결 경고 3건).
   * 그런데 고치려면 유스케이스를 하나씩 골라 칩을 눌러야 했다. 다이어그램 하나에
   * 유스케이스가 열 건이면 열 번이다. "운영자가 하는 일"처럼 통째로 같은 액터인
   * 경우가 많으므로 한 번에 처리한다.
   */
  setActorOnUseCases: (actorUid, useCaseUids, on) => {
    const targets = new Set(useCaseUids)
    let changed = 0
    get().mutate((d) => {
      for (const pk of d.packages) {
        for (const uc of pk.useCases) {
          if (!targets.has(uc.uid)) continue
          const has = uc.actorUids.includes(actorUid)
          if (on === has) continue
          uc.actorUids = on
            ? [...uc.actorUids, actorUid]
            : uc.actorUids.filter((a) => a !== actorUid)
          changed++
        }
      }
    })
    return changed
  },

  /*
   * 쓰이지 않는 액터 일괄 삭제.
   *
   * 액터 목록은 문서 전체에서 따로 뽑고 유스케이스는 요구사항별로 따로 만들기
   * 때문에, 아무도 쓰지 않는 액터가 남을 수 있다. 한 명씩 지우게 하면
   * 검증 목록과 트리를 오가야 해서 한 번에 정리한다.
   * 다이어그램에 직접 올려 둔 액터(extraActorUids)는 사용자가 의도적으로
   * 놓은 것이므로 남긴다.
   */
  removeUnusedActors: () => {
    const p = get().project
    if (!p) return []
    const used = new Set<string>()
    for (const pk of p.packages) {
      for (const uc of pk.useCases) for (const a of uc.actorUids) used.add(a)
      for (const d of pk.diagrams) for (const a of d.extraActorUids ?? []) used.add(a)
    }
    const doomed = p.actors.filter((a) => !used.has(a.uid))
    if (!doomed.length) return []
    const uids = new Set(doomed.map((a) => a.uid))
    get().mutate((d) => {
      d.actors = d.actors.filter((a) => !uids.has(a.uid))
      for (const pk of d.packages) {
        for (const dg of pk.diagrams) {
          if (dg.actorPositions) {
            for (const uid of uids) delete dg.actorPositions[uid]
          }
        }
      }
    })
    return doomed.map((a) => a.name || '(이름 없음)')
  },

  /* ------------------------------ 액터 ------------------------------ */

  addActor: () => {
    const uid = uuid()
    get().mutate((d) => {
      d.actors.push({
        uid,
        name: '새 액터',
        description: '',
        kind: 'Primary',
        external: false,
        position: { x: 50, y: 100 + d.actors.length * 200 }
      })
    })
    set({ selection: { ...EMPTY_SELECTION, actorUid: uid } })
  },

  updateActor: (uid, patch) =>
    get().mutate((d) => {
      const a = d.actors.find((x) => x.uid === uid)
      if (!a) return
      // 이름을 고치면 추정이 아니라 사람이 정한 액터다
      if (patch.name !== undefined && patch.name !== a.name) delete a.guessed
      Object.assign(a, patch)
    }, `actor:${uid}:${Object.keys(patch).join()}`),

  removeActor: (uid) => {
    get().mutate((d) => {
      d.actors = d.actors.filter((a) => a.uid !== uid)
      for (const p of d.packages) {
        for (const uc of p.useCases) uc.actorUids = uc.actorUids.filter((x) => x !== uid)
        for (const dg of p.diagrams) {
          dg.extraActorUids = (dg.extraActorUids ?? []).filter((x) => x !== uid)
          if (dg.actorPositions) delete dg.actorPositions[uid]
        }
      }
    })
    set((s) => (s.selection.actorUid === uid ? { selection: { ...s.selection, actorUid: null } } : {}))
  },

  setActorPosition: (uid, pos) => get().updateActor(uid, { position: pos }),

  setDiagramActorPosition: (diagramUid, actorUid, pos) =>
    get().mutate((d) => {
      const dg = findDiagramIn(d, diagramUid)
      if (!dg) return
      const map = { ...(dg.actorPositions ?? {}) }
      if (pos) map[actorUid] = pos
      else delete map[actorUid]
      dg.actorPositions = map
    }, `actorpos:${diagramUid}:${actorUid}`),

  placeActorOnDiagram: (diagramUid, actorUid, pos) =>
    get().mutate((d) => {
      const dg = findDiagramIn(d, diagramUid)
      if (!dg) return
      const extra = new Set(dg.extraActorUids ?? [])
      extra.add(actorUid)
      dg.extraActorUids = [...extra]
      dg.actorPositions = { ...(dg.actorPositions ?? {}), [actorUid]: pos }
    }),

  removeActorFromDiagram: (diagramUid, actorUid) =>
    get().mutate((d) => {
      for (const p of d.packages) {
        const dg = p.diagrams.find((x) => x.uid === diagramUid)
        if (!dg) continue
        dg.extraActorUids = (dg.extraActorUids ?? []).filter((x) => x !== actorUid)
        const map = { ...(dg.actorPositions ?? {}) }
        delete map[actorUid]
        dg.actorPositions = map
        // 이 다이어그램에 그려지는 유스케이스의 연결만 끊는다
        for (const uc of p.useCases) {
          if (uc.diagramUid !== diagramUid) continue
          uc.actorUids = uc.actorUids.filter((x) => x !== actorUid)
        }
        return
      }
    }),

  renumberAll: (renumberUseCases) =>
    // mutate 를 거쳐야 되돌리기 더미에 쌓인다 — 재채번은 프로젝트 전체 ID를 바꾼다
    get().mutate((d) => Object.assign(d, renumber(d, { renumberUseCases })))
}))

/*
 * 개발 빌드에서만 store 를 전역에 둔다. 화면 캡처 도구(scripts/cdp-shot.mjs)가
 * "열기" 네이티브 대화상자를 누를 수 없어서, 그게 없으면 프로젝트가 열린 화면을
 * 한 장도 찍을 수 없다(= 모든 화면 검사가 빈 화면에서 끝난다).
 * 배포 빌드에는 들어가지 않는다.
 */
if (import.meta.env.DEV) {
  ;(window as unknown as { __eaStore: typeof useStore }).__eaStore = useStore
}

function findDiagramIn(p: Project, uid: string): Diagram | null {
  for (const pk of p.packages) {
    const dg = pk.diagrams.find((x) => x.uid === uid)
    if (dg) return dg
  }
  return null
}

/* ----------------------------- 셀렉터 ----------------------------- */

export const findPackage = (p: Project | null, uid: string | null): UcPackage | null =>
  !p || !uid ? null : (p.packages.find((x) => x.uid === uid) ?? null)

export const findDiagram = (p: Project | null, uid: string | null): Diagram | null =>
  !p || !uid ? null : findDiagramIn(p, uid)

export const findPackageOfDiagram = (p: Project | null, uid: string | null): UcPackage | null =>
  !p || !uid ? null : (p.packages.find((x) => x.diagrams.some((d) => d.uid === uid)) ?? null)

export const findUseCase = (p: Project | null, uid: string | null): UseCase | null => {
  if (!p || !uid) return null
  for (const pk of p.packages) {
    const found = pk.useCases.find((u) => u.uid === uid)
    if (found) return found
  }
  return null
}

export const findPackageOfUseCase = (p: Project | null, uid: string | null): UcPackage | null =>
  !p || !uid ? null : (p.packages.find((pk) => pk.useCases.some((u) => u.uid === uid)) ?? null)

export const allUseCases = (p: Project | null): UseCase[] =>
  p ? p.packages.flatMap((pk) => pk.useCases) : []

export const countStats = (
  p: Project | null
): { packages: number; diagrams: number; useCases: number; actors: number; links: number } => {
  if (!p) return { packages: 0, diagrams: 0, useCases: 0, actors: 0, links: 0 }
  const ucs = allUseCases(p)
  return {
    packages: p.packages.length,
    diagrams: p.packages.reduce((n, pk) => n + pk.diagrams.length, 0),
    useCases: ucs.length,
    actors: p.actors.length,
    links: ucs.reduce((n, u) => n + u.actorUids.length, 0)
  }
}
