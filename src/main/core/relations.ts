import type { AppSettings, Project, UseCase } from '@shared/types'
import { getProvider } from './llm'
import { extractJson } from './json-repair'
import { RELATION_SYSTEM_PROMPT, buildRelationPrompt } from './prompt'
import { relationEdges, wouldCreateCycle, type RelationEdges } from '@shared/graph'

/**
 * 유스케이스 사이의 관계(include / extend) 제안.
 *
 * 왜 별도 단계인가:
 *   생성은 요구사항 1건씩 따로 호출한다. 그 호출은 자기 요구사항 본문만 보므로
 *   **다른 유스케이스의 존재를 모른다.** 관계는 정의상 둘 사이의 것이라 거기서는
 *   나올 수가 없다. 그래서 프로젝트가 다 만들어진 뒤 목록 전체를 놓고 한 번 더 묻는다.
 *   (액터를 같은 이유로 마지막에 한 번 더 묻는다 — extract.ts 의 액터 정리와 같은 패턴)
 *
 * 코드가 지키는 경계 — 모델은 **번호만** 말하고 판정은 전부 여기서 한다:
 *   ① 범위     : 목록에 없는 번호는 버린다
 *   ② 자기참조 : from == to 는 버린다
 *   ③ 중복     : 같은 쌍은 한 번만
 *   ④ 순환     : 관계를 따라가 되돌아오면 버린다 (EA에서 무한 루프로 읽힌다)
 *   ⑤ 총량     : 유스케이스 수에 비례한 상한. 소형 모델은 그냥 두면 전부 이어 붙인다
 */

export type RelationType = 'include' | 'extend'

export interface RelationPair {
  from: number
  to: number
  type: RelationType
}

export interface RelationItem {
  index: number
  uid: string
  name: string
  pkgName: string
}

export interface ApplyResult {
  project: Project
  applied: number
  /** 버린 것들 — 사용자에게 왜 안 붙었는지 알린다 */
  rejected: string[]
}

/**
 * 유스케이스가 이만큼 많으면 관계 제안을 건너뛴다.
 *
 * 목록이 길어지면 소형 모델이 번호를 세다 놓치고, 검증을 통과하는 엉뚱한 쌍이
 * 늘어난다. "그럴듯한 오답"이 "없음"보다 나쁘다 — 사용자가 지워야 하기 때문이다.
 */
export const MAX_ITEMS = 80

/** 유스케이스당 나갈 수 있는 관계 수 */
const MAX_OUT_PER_UC = 2

/** 전체 상한. 유스케이스 3건당 1건, 최소 2건 */
const totalCap = (ucCount: number): number => Math.max(2, Math.ceil(ucCount / 3))

/** 모델에게 줄 번호 매긴 목록. 번호는 1부터 */
export function buildRelationItems(project: Project): RelationItem[] {
  const out: RelationItem[] = []
  for (const pkg of project.packages) {
    for (const uc of pkg.useCases) {
      out.push({ index: out.length + 1, uid: uc.uid, name: uc.name, pkgName: pkg.name })
    }
  }
  return out
}

/**
 * 모델 응답에서 관계 배열을 꺼낸다.
 * 소형 모델은 키 이름을 바꾸거나 배열만 주고, 번호를 문자열로 준다.
 */
export function pickRelations(text: string): RelationPair[] {
  const parsed = extractJson<unknown>(text)

  const asList = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null)
  let list: unknown[] | null = asList(parsed)
  if (!list && parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    for (const key of ['relations', 'relationships', 'links', 'items', 'pairs']) {
      const hit = asList(obj[key])
      if (hit) {
        list = hit
        break
      }
    }
  }
  if (!list) return []

  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? '').trim(), 10)
    return Number.isFinite(n) ? n : NaN
  }

  const out: RelationPair[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const from = num(r.from ?? r.source ?? r.a)
    const to = num(r.to ?? r.target ?? r.b)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    const t = String(r.type ?? r.kind ?? 'include').toLowerCase()
    out.push({ from, to, type: t.includes('extend') ? 'extend' : 'include' })
  }
  return out
}

/**
 * 검증 후 프로젝트에 반영한다. **원본은 건드리지 않는다.**
 * 모델 응답이 어떻든 여기를 통과한 것만 모델에 들어간다.
 */
export function applyRelations(
  project: Project,
  items: RelationItem[],
  pairs: RelationPair[]
): ApplyResult {
  const byIndex = new Map<number, RelationItem>()
  for (const it of items) byIndex.set(it.index, it)

  const cap = totalCap(items.length)
  const rejected: string[] = []
  const outCount = new Map<string, number>()
  const seen = new Set<string>()

  /*
   * 순환 검사용 간선.
   * **이미 프로젝트에 있는 관계에서 출발한다** — 빈 그래프에서 시작하면
   * 기존 관계와 합쳐져 생기는 고리를 놓친다.
   */
  const edges: RelationEdges = new Map(
    relationEdges(project.packages.flatMap((p) => p.useCases))
  )
  const link = (a: string, b: string): void => {
    edges.set(a, [...(edges.get(a) ?? []), b])
  }

  const accepted: Array<{ from: RelationItem; to: RelationItem; type: RelationType }> = []

  for (const p of pairs) {
    const from = byIndex.get(p.from)
    const to = byIndex.get(p.to)
    const label = `${p.from}→${p.to}`

    if (!from || !to) {
      rejected.push(`${label}: 목록에 없는 번호`)
      continue
    }
    if (from.uid === to.uid) {
      rejected.push(`${label}: 자기 자신`)
      continue
    }
    const key = `${from.uid}|${to.uid}`
    if (seen.has(key)) continue
    if (accepted.length >= cap) {
      rejected.push(`${from.name} → ${to.name}: 상한 ${cap}건 초과`)
      continue
    }
    if ((outCount.get(from.uid) ?? 0) >= MAX_OUT_PER_UC) {
      rejected.push(`${from.name} → ${to.name}: 한 유스케이스당 ${MAX_OUT_PER_UC}건까지`)
      continue
    }
    if (wouldCreateCycle(edges, from.uid, to.uid)) {
      rejected.push(`${from.name} → ${to.name}: 순환`)
      continue
    }

    seen.add(key)
    link(from.uid, to.uid)
    outCount.set(from.uid, (outCount.get(from.uid) ?? 0) + 1)
    accepted.push({ from, to, type: p.type })
  }

  if (!accepted.length) return { project, applied: 0, rejected }

  const incBy = new Map<string, string[]>()
  const extBy = new Map<string, string[]>()
  for (const a of accepted) {
    const m = a.type === 'include' ? incBy : extBy
    const cur = m.get(a.from.uid) ?? []
    cur.push(a.to.uid)
    m.set(a.from.uid, cur)
  }

  const patch = (uc: UseCase): UseCase => {
    const inc = incBy.get(uc.uid)
    const ext = extBy.get(uc.uid)
    if (!inc && !ext) return uc
    return {
      ...uc,
      includeUids: inc ? [...new Set([...uc.includeUids, ...inc])] : uc.includeUids,
      extendUids: ext ? [...new Set([...uc.extendUids, ...ext])] : uc.extendUids
    }
  }

  return {
    project: {
      ...project,
      packages: project.packages.map((pkg) => ({ ...pkg, useCases: pkg.useCases.map(patch) }))
    },
    applied: accepted.length,
    rejected
  }
}

export interface SuggestArgs {
  project: Project
  settings: AppSettings
  signal?: AbortSignal
}

export interface SuggestResult {
  project: Project
  /** 사용자에게 보여줄 한 줄 요약들 */
  notes: string[]
}

/**
 * 모델에게 관계를 묻고 반영한다.
 *
 * **실패해도 예외를 던지지 않는다.** 관계는 있으면 좋은 것이지 없으면 안 되는 것이
 * 아니다. 여기서 던지면 유스케이스를 다 만들어 놓고 마지막 한 번의 실패로 전체가
 * 날아간다. 사실만 알리고 프로젝트는 그대로 돌려준다.
 */
export async function suggestRelations(args: SuggestArgs): Promise<SuggestResult> {
  const items = buildRelationItems(args.project)
  if (items.length < 2) return { project: args.project, notes: [] }
  if (items.length > MAX_ITEMS) {
    return {
      project: args.project,
      notes: [
        `유스케이스가 ${items.length}건이라 관계 제안을 건너뛰었습니다 ` +
          `(${MAX_ITEMS}건 초과) — 편집 탭에서 직접 연결하세요.`
      ]
    }
  }

  const id = args.settings.activeProvider
  const config = args.settings.providers[id]

  let pairs: RelationPair[] = []
  try {
    const out = await getProvider(id).generate({
      system: RELATION_SYSTEM_PROMPT,
      user: buildRelationPrompt(items),
      config,
      signal: args.signal
    })
    pairs = pickRelations(out)
  } catch (e) {
    if (args.signal?.aborted) throw e
    const why = e instanceof Error ? e.message.split(String.fromCharCode(10))[0] : String(e)
    return {
      project: args.project,
      notes: [`관계 제안 호출 실패 — 관계 없이 진행합니다. (${why})`]
    }
  }

  const r = applyRelations(args.project, items, pairs)
  const notes: string[] = []
  if (r.applied) {
    notes.push(`관계 ${r.applied}건을 제안했습니다 — 다이어그램에서 확인하고 지우거나 더하세요.`)
  } else {
    notes.push('유스케이스 사이의 관계는 찾지 못했습니다 (없는 것이 정상인 경우가 많습니다).')
  }
  if (r.rejected.length) {
    notes.push(`관계 ${r.rejected.length}건은 규칙에 맞지 않아 버렸습니다: ${r.rejected[0]}`)
  }
  return { project: r.project, notes }
}
