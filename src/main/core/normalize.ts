import { randomUUID } from 'node:crypto'
import type {
  Actor,
  Diagram,
  Difficulty,
  Priority,
  Project,
  RawAnalysis,
  RawUseCase,
  Team,
  UcPackage,
  UseCase
} from '@shared/types'
import { DEFAULT_PROJECT_SETTINGS } from '@shared/constants'
import { colorForTeamIndex, packageCode, pad2, parseTeam, splitSubNo, useCaseCode } from '@shared/idrules'
import { defaultActorPosition } from './layout'
import { formatTimestamp } from './xmi'

const asPriority = (v?: string): Priority => {
  const s = (v ?? '').toLowerCase()
  if (s.startsWith('h') || s.includes('높') || s === '상') return 'High'
  if (s.startsWith('l') || s.includes('낮') || s === '하') return 'Low'
  return 'Medium'
}

const asDifficulty = (v?: string): Difficulty => {
  const s = (v ?? '').trim()
  if (s === '상' || /high/i.test(s)) return '상'
  if (s === '하' || /low/i.test(s)) return '하'
  return '중'
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/* ------------------------------------------------------------------ */
/* 모델 응답 정리 — 반복 생성 방어                                       */
/* ------------------------------------------------------------------ */

/**
 * 요구사항 1건이 가질 수 있는 유스케이스 상한.
 *
 * 실측 기준 요구사항당 2건 안팎이고, 많아야 대여섯이다.
 * 이걸 넘는다는 건 모델이 **같은 객체를 반복 생성하다 토큰이 소진된** 것이다.
 * 실제로 요구사항 1건에서 62건이 나온 적이 있다 — 서로 다른 이름은 3개뿐이었다.
 */
export const MAX_UC_PER_REQ = 12

const squash = (s: string): string => s.replace(/[\s()（）·・_\-,.]/g, '').toLowerCase()

/**
 * 유스케이스 이름이 요구사항명을 통째로 앞에 달고 있으면 그 앞부분을 뗀다.
 *
 *   요구사항: "AI 기반의 지능형 개인맞춤 서비스"
 *   모델 출력: "AI 기반의 지능형 개인맞춤 서비스 데이터 꾸러미 생성"
 *   → "데이터 꾸러미 생성"
 *
 * 소형 모델은 "요구사항명 + 세부동작"으로 이름을 짓는 버릇이 있다. 그대로 두면
 * 다이어그램의 타원마다 같은 앞머리가 반복돼 무엇이 다른지 읽을 수 없다.
 *
 * 떼어 낸 이름이 "등록"처럼 짧아져도 괜찮다 — 요구사항명은 **UCD 패키지 이름이
 * 이미 들고 있다.** 표준 유스케이스모형기술서도 그렇게 되어 있다:
 *   [UCD-SFR-008-ADT1(맞춤형)-01] AI 기반의 지능형 개인맞춤 서비스
 *     └ 등록 / AI 연산방식 개발 / 데이터 꾸러미 생성
 * 남는 게 두 글자도 안 되면(= 이름이 요구사항명 그 자체면) 그대로 둔다.
 *
 * **긴 요구사항명일 때만** 뗀다. "통합검색" 처럼 짧은 앞머리는 붙어 있어도
 * 읽는 데 지장이 없고, 떼면 "통합 검색 수행" 이 "수행" 이 되어 오히려 나빠진다.
 * 문제가 되는 건 "AI 기반의 지능형 개인맞춤 서비스" 같이 긴 것이 타원마다
 * 반복되는 경우다.
 */
const REQ_ECHO_MIN = 10

function trimReqEcho(name: string, reqName: string): string {
  if (!reqName) return name
  const nk = squash(name)
  const rk = squash(reqName)
  if (!rk || rk.length < REQ_ECHO_MIN || !nk.startsWith(rk) || nk.length <= rk.length) return name

  // 원본 문자열에서 요구사항명에 해당하는 구간이 끝나는 지점을 찾는다
  let consumed = 0
  let cut = 0
  for (let i = 0; i < name.length && consumed < rk.length; i++) {
    if (squash(name[i])) consumed++
    cut = i + 1
  }
  const rest = name.slice(cut).replace(/^[\s\-–—:·,]+/, '').trim()
  return rest.length >= 2 ? rest : name
}

export interface SanitizeResult {
  kept: RawUseCase[]
  /** 버린 개수와 이유 (사용자에게 알리기 위한 것) */
  dropped: number
  reason: '' | 'duplicate' | 'overflow'
}

/**
 * 모델이 준 유스케이스 목록을 쓸 수 있는 형태로 정리한다.
 *
 * ① 이름이 없는 것은 버린다
 * ② **이름이 같으면 하나만 남긴다** — 반복 생성의 직접적인 방어선
 * ③ 요구사항명을 그대로 앞에 단 이름은 앞부분을 뗀다
 * ④ 그래도 MAX_UC_PER_REQ 를 넘으면 자른다
 *
 * 액터를 유스케이스당 2개로 제한한 것과 같은 이유다 — 모델이 판단을 포기하고
 * 쏟아 낸 결과를 그대로 받으면, 사용자가 지워야 할 것이 수십 개인 상태로 도착한다.
 */
export function sanitizeRawUseCases(list: RawUseCase[], reqName = ''): SanitizeResult {
  const kept: RawUseCase[] = []
  const seen = new Set<string>()
  let duplicate = 0

  for (const u of list) {
    const name = trimReqEcho(str(u.name), reqName)
    if (!name) continue
    const key = squash(name)
    if (!key || seen.has(key)) {
      duplicate++
      continue
    }
    seen.add(key)
    kept.push({ ...u, name })
  }

  if (kept.length > MAX_UC_PER_REQ) {
    return { kept: kept.slice(0, MAX_UC_PER_REQ), dropped: kept.length - MAX_UC_PER_REQ, reason: 'overflow' }
  }
  if (duplicate) return { kept, dropped: duplicate, reason: 'duplicate' }
  return { kept, dropped: 0, reason: '' }
}

/** LLM이 \n 문자열로 준 흐름을 실제 개행으로 */
const unescapeFlow = (v: unknown): string =>
  str(v)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')

/**
 * LLM 원시 JSON → Project 정규화.
 *
 * 이 단계에서 하는 일:
 *  1. uid 부여 (이후 모든 EA GUID의 시드)
 *  2. **요구사항 행 1건 → 다이어그램 1장**, 하위 번호만 다른 행(SFR-021-…-01·-02)은 패키지 하나로
 *  3. ID 규칙 재적용 — LLM이 준 코드는 신뢰하지 않고 규칙대로 다시 채번
 *  4. 액터 이름 → 액터 uid 해석 (LLM은 이름으로만 참조함)
 *  5. 우선순위/난이도/업무구분 값 정규화
 *
 * 핵심: n8n 버전은 액터-유스케이스 연결을 `index % actors.length` 라운드로빈으로
 * 만들었다. 여기서는 LLM이 지정한 actors 배열을 이름으로 매칭하고, 매칭 실패 시
 * **연결하지 않는다**(검증에서 경고로 잡아 사용자가 직접 붙이게 한다).
 */
export function normalizeToProject(
  raw: RawAnalysis,
  overrides: {
    systemName?: string
    projectId?: string
    author?: string
    /** 요구사항 ID에 팀이 안 붙어 있을 때 쓸 기본 팀 (가져오기 화면에서 입력받는다) */
    team?: Team
  } = {}
): Project {
  const now = formatTimestamp(new Date())

  const actors: Actor[] = (raw.actors ?? [])
    .filter((a) => str(a.name))
    .map((a, i) => ({
      uid: randomUUID(),
      name: str(a.name),
      description: str(a.description) || str(a.name),
      kind: /second/i.test(str(a.kind)) ? 'Secondary' : 'Primary',
      external: a.external === true || /second/i.test(str(a.kind)),
      position: defaultActorPosition(i)
    }))

  const actorByName = new Map<string, string>()
  for (const a of actors) actorByName.set(normalizeName(a.name), a.uid)

  /**
   * 소형 모델은 "액터 목록에 있는 이름만 써라" 를 "전부 써라" 로 이해하는 일이 잦다.
   * 액터 5명을 31개 유스케이스에 다 붙이면 다이어그램이 읽을 수 없게 되고,
   * 사용자가 지워야 할 연결이 100개 가까이 생긴다. 여기서 걸러 낸다.
   */
  const MAX_ACTORS_PER_UC = 2

  /**
   * 액터 연결.
   *
   * 액터가 하나도 안 붙은 유스케이스는 EA에서 선이 없는 타원으로 남는다.
   * 유스케이스는 정의상 "액터가 하는 일"이라 그런 건 있으면 안 된다.
   * (실제 산출물은 21건 전부 액터가 붙어 있었다. 우리는 36%가 비어 있었다.)
   *
   * 그래서 세 단계로 찾는다:
   *   ① 모델이 준 이름과 정확히 일치
   *   ② 부분 일치 — 모델이 "정책 담당자"라 쓰고 목록엔 "정책담당자"인 경우
   *   ③ 그래도 없으면 **유스케이스 본문에 등장하는 액터**를 쓴다
   *      ("대국민 기후위험 예측 요청" → 대국민)
   * 셋 다 실패하면 연결하지 않는다 — 지어내지는 않는다(검증이 경고로 잡는다).
   */
  const resolveActors = (names: string[] | undefined, ucText: string): string[] => {
    const out: string[] = []
    const add = (uid?: string): void => {
      if (uid && !out.includes(uid)) out.push(uid)
    }

    for (const n of names ?? []) {
      const key = normalizeName(String(n))
      if (!key) continue
      const exact = actorByName.get(key)
      if (exact) {
        add(exact)
        continue
      }
      // ② 부분 일치 (공백·괄호 차이, "정책 담당자" ↔ "정책담당자")
      for (const a of actors) {
        const an = normalizeName(a.name)
        if (an && (an.includes(key) || key.includes(an))) {
          add(a.uid)
          break
        }
      }
    }

    // 목록을 통째로 복사해 왔다 = 판단을 포기한 것 → 주 액터 하나만 남긴다
    if (actors.length > 1 && out.length >= actors.length) return out.slice(0, 1)

    // ③ 본문에서 찾기
    if (!out.length) {
      const hay = normalizeName(ucText)
      for (const a of actors) {
        const an = normalizeName(a.name)
        if (an && hay.includes(an)) add(a.uid)
      }
    }

    return out.slice(0, MAX_ACTORS_PER_UC)
  }

  /*
   * 팀별 색상은 **프로젝트 안에서 처음 나온 순서**로 배정한다.
   * PAD=노랑 같은 고정 매핑을 두면 팀 코드가 다른 사업 문서에서 전부 무색이 된다.
   */
  const teamSlot = new Map<string, number>()
  const slotOf = (code: string): number => {
    if (!teamSlot.has(code)) teamSlot.set(code, teamSlot.size)
    return teamSlot.get(code) as number
  }

  const rowPackages: UcPackage[] = (raw.requirements ?? []).map((r, ri) => {
    /*
     * 구버전(3계층) 스키마 호환: sub_packages/tasks 아래에 흩어진 유스케이스를
     * 이 요구사항 하나로 펼쳐 넣는다. 중분류 이름은 버린다 —
     * 표준 구조에 중분류 계층이 없다.
     */
    const legacy = (r.sub_packages ?? r.tasks ?? []).flatMap((sp) => sp.usecases ?? [])
    /*
     * **여기가 마지막 방어선이다.** 요구사항 단위 생성은 호출부에서 이미 한 번
     * 걸러 경고까지 띄우지만, "전체 한 번에" 경로와 JSON 직접 입력은 여기를 통해
     * 들어온다. 어느 경로로 오든 반복 생성이 프로젝트에 박히면 안 된다.
     */
    const rawUcs: RawUseCase[] = sanitizeRawUseCases(
      r.usecases?.length ? r.usecases : legacy,
      str(r.req_name)
    ).kept

    const reqId = str(r.req_id) || deriveReqIdFromCode(str(rawUcs[0]?.usecase_id))
    // 패키지 = 하위 번호 뗀 ID, 다이어그램 번호 = 행의 하위 번호. 같은 패키지 행은 아래에서 합친다
    const { base, sub } = splitSubNo(reqId)
    const code = packageCode(base)

    // 요구사항 ID에 팀이 박혀 있으면 그걸 쓰고, 없으면 사용자가 준 기본 팀을 쓴다
    const parsed = parseTeam(reqId)
    const team: Team = parsed.code
      ? { code: parsed.code, name: parsed.name || overrides.team?.name || '' }
      : { code: overrides.team?.code ?? '', name: overrides.team?.name ?? '' }

    // 행 하나 = 다이어그램 한 장. 하위 번호가 없으면 1번
    const diagram: Diagram = {
      uid: randomUUID(),
      seq: sub || 1,
      name: '',
      actorPositions: {},
      extraActorUids: []
    }

    /*
     * 생성 직후에는 요구사항 1건이 UCD 1개로 떨어진다(모델이 요구사항 단위로
     * 돌기 때문). 유스케이스마다 자기 요구사항 ID를 들고 있으므로, 나중에
     * 편집 탭에서 다른 UCD로 옮겨도 코드는 그대로다.
     */
    const useCases: UseCase[] = rawUcs.map((u, i) => ({
      uid: randomUUID(),
      code: useCaseCode(str(u.req_id) || reqId, i),
      reqId: str(u.req_id) || reqId,
      diagramUid: diagram.uid,
      name: str(u.name) || '미지정 유스케이스',
      priority: asPriority(u.priority),
      difficulty: asDifficulty(u.difficulty),
      description: str(u.description),
      mainFlow: unescapeFlow(u.main_flow),
      altFlow: unescapeFlow(u.alt_flow),
      exceptionFlow: unescapeFlow(u.exception_flow),
      precondition: str(u.precondition),
      postcondition: str(u.postcondition),
      specialRequirement: unescapeFlow(u.special_requirement),
      note: str(u.note),
      actorUids: resolveActors(u.actors, [u.name, u.description, u.main_flow].join(' ')),
      includeUids: [],
      extendUids: [],
      position: null,
      ...(u.invented ? { invented: true } : {}),
      ...(u.sources?.length ? { sources: u.sources } : {})
    }))

    return {
      uid: randomUUID(),
      code,
      reqId: base,
      name: str(r.req_name) || `요구사항 ${ri + 1}`,
      description: str(r.description),
      team,
      color: team.code ? colorForTeamIndex(slotOf(team.code)) : 'none',
      diagrams: [diagram],
      useCases
    }
  })

  const packages = mergeRowPackages(rowPackages)

  return {
    schemaVersion: 2,
    metadata: {
      /*
       * **이름을 지어내지 않는다.**
       *
       * 예전에는 비어 있으면 '이름 없는 시스템' 을 넣었다. 그 문자열은 표시용이
       * 아니라 EA 모델 이름 · 마크다운 볼트 폴더명 · 저장 파일 기본 이름으로
       * 그대로 나간다. 사용자는 자기 사업 폴더가 "이름 없는 시스템" 으로 만들어진
       * 것을 나중에 발견한다. 비어 있으면 비워 두고, 검증이 오류로 짚는다
       * (validate.ts 의 META_SYSTEM_NAME). 고칠 자리는 편집 화면이다.
       */
      systemName: overrides.systemName || str(raw.metadata?.system_name),
      /*
       * 프로젝트 ID 는 EA GUID 의 네임스페이스다(eaid.ts). 모든 프로젝트가 같은
       * 기본값을 쓰면 서로 다른 산출물이 같은 네임스페이스를 공유하게 된다.
       * 없으면 이 프로젝트만의 값을 만든다 — 한 번 정해지면 파일에 저장되므로
       * 재내보내기 때도 같은 GUID 가 나온다.
       */
      projectId: overrides.projectId || str(raw.metadata?.project_id) || newProjectId(),
      author: overrides.author || 'ea-usecase-studio',
      createdAt: now,
      modifiedAt: now
    },
    actors,
    packages,
    settings: { ...DEFAULT_PROJECT_SETTINGS }
  }
}

const normalizeName = (s: string): string => s.replace(/[\s()（）]/g, '').toLowerCase()

/**
 * 같은 패키지 코드(`SFR-021-…-01`, `-02` 행)를 하나로 합친다 — 정답 EAP가
 * `[UCD-SFR-021-ADT1(맞춤형)]` 하나에 다이어그램 `-01`, `-02` 두 장이다.
 * 패키지 이름·개요·팀은 먼저 나온 행 것. 둘째 행부터는 다이어그램 이름에 그 행의
 * 요구사항명을 남긴다(자동 이름은 패키지 이름을 쓰니 행 이름이 사라진다).
 * 하위 번호가 같은 행이 또 오면 같은 다이어그램에 넣는다.
 */
function mergeRowPackages(rows: UcPackage[]): UcPackage[] {
  const byCode = new Map<string, UcPackage>()
  for (const row of rows) {
    const pkg = byCode.get(row.code)
    if (!pkg) {
      byCode.set(row.code, row)
      continue
    }
    const dgm = row.diagrams[0]
    const same = pkg.diagrams.find((d) => d.seq === dgm.seq)
    if (same) {
      pkg.useCases.push(...row.useCases.map((u) => ({ ...u, diagramUid: same.uid })))
      continue
    }
    if (row.name !== pkg.name) dgm.name = `[${pkg.code}-${pad2(dgm.seq)}] ${row.name}`
    pkg.diagrams.push(dgm)
    pkg.diagrams.sort((a, b) => a.seq - b.seq)
    pkg.useCases.push(...row.useCases)
    if (!pkg.description) pkg.description = row.description
  }
  return [...byCode.values()]
}

/** UC-SFR-001-PAD-02-01-01 → SFR-001-PAD-02-01 (뒤 두 순번 제거) */
function deriveReqIdFromCode(code: string): string {
  const m = /^UC-(.+)-\d{2}-\d{2}$/.exec(code.trim())
  if (m) return m[1]
  const m1 = /^UC-(.+)-\d{2}$/.exec(code.trim())
  return m1 ? m1[1] : code.replace(/^UC-/, '')
}

/**
 * 프로젝트 고유 ID — EA GUID 채번의 네임스페이스.
 * 사람이 읽을 일은 거의 없고, **프로젝트마다 달라야 한다**는 점만 중요하다.
 */
function newProjectId(): string {
  return 'P-' + randomUUID().slice(0, 8).toUpperCase()
}

export function emptyProject(systemName = '새 프로젝트', projectId = newProjectId()): Project {
  const now = formatTimestamp(new Date())
  return {
    schemaVersion: 2,
    metadata: {
      systemName,
      projectId,
      author: 'ea-usecase-studio',
      createdAt: now,
      modifiedAt: now
    },
    actors: [],
    packages: [],
    settings: { ...DEFAULT_PROJECT_SETTINGS }
  }
}
