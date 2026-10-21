import { randomUUID } from 'crypto'
import type { Actor, Project } from '@shared/types'
import { defaultActorPosition } from './layout'
import { META_LABELS } from './extract'
import { ADMIN_ROLE, ADMIN_VERB, isAdminActor as isAdmin } from '@shared/constants'

/**
 * 액터 0명 금지 — 모든 유스케이스에 액터를 최소 1명 붙인다.
 *
 * 액터 없는 유스케이스는 다이어그램에서 선 없는 타원이다. 이름이 정답과 달라도
 * 액터가 있는 쪽이 고치기 쉽다(이름만 바꾸면 선이 산다).
 *
 * 순서:
 *   ① 프로젝트에 액터가 있으면(사전 또는 문서에서 뽑은 것) 그 안에서 고른다
 *   ② 하나도 없으면 정의서에 실제로 나온 역할 낱말(…사용자·…관리자 등)에서 만든다
 *   ③ 그것도 없으면 `사용자`, `관리자`
 * 고르는 규칙: 등록·관리·설정류 → 관리 쪽 액터, 그 밖(조회·신청·확인류) → 사용 쪽 액터.
 * `guessed` 표시(사람이 사업 액터로 바꿀 자리)는 사람이 적은 이름이 아닌 액터에 단다:
 * ②·③으로 만든 것, 그리고 `named`(액터 사전이나 정의서의 액터 절)가 없을 때 모델이 문서에서 뽑은 것.
 * 정답 액터는 정의서 본문에 안 나오는 사업 지식이라 모델이 뽑은 이름은 거의 그대로 못 쓴다.
 * 설명 글에는 넣지 않는다(설명은 XMI documentation으로 나간다).
 */

const USER_ROLE = /(사용자|이용자|신청자|민원인)$/

const META = new Set(META_LABELS.map((l) => l.replace(/\s/g, '')))

/**
 * 정의서에 나온 역할 낱말 중 가장 자주 나온 것 (조사는 뗀다).
 * 표 머리글 칸(`담당자` 한 줄 — 다음 줄이 사람 이름)은 역할이 아니라 세지 않는다.
 */
function topRole(text: string, role: RegExp): string {
  const count = new Map<string, number>()
  const body = text
    .split('\n')
    .filter((l) => !META.has(l.replace(/\s/g, '')))
    .join('\n')
  for (const tok of body.split(/[^가-힣]+/)) {
    const word = tok.replace(/(에게|께서|이|가|은|는|을|를|의|와|과|도|로)$/, '')
    if (word.length > 8 || !role.test(word)) continue
    count.set(word, (count.get(word) ?? 0) + 1)
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

export function fillActors(
  project: Project,
  docText: string,
  named = false
): { project: Project; guessed: number } {
  const actors = [...project.actors]
  const make = (name: string): Actor => ({
    uid: randomUUID(),
    name,
    description: '',
    kind: 'Primary',
    external: false,
    position: defaultActorPosition(actors.length),
    guessed: true
  })

  const ucs = project.packages.flatMap((p) => p.useCases)
  if (!actors.length && ucs.length) {
    actors.push(make(topRole(docText, USER_ROLE) || '사용자'))
    actors.push(make(topRole(docText, ADMIN_ROLE) || '관리자'))
  }

  const admin = actors.find((a) => isAdmin(a.name))
  const user = actors.find((a) => !isAdmin(a.name)) ?? actors[0]
  const pick = (name: string): string => ((ADMIN_VERB.test(name) && admin) || user).uid

  const used = new Set<string>()
  const packages = project.packages.map((p) => ({
    ...p,
    useCases: p.useCases.map((u) => {
      const actorUids = u.actorUids.length || !user ? u.actorUids : [pick(u.name)]
      actorUids.forEach((x) => used.add(x))
      return actorUids === u.actorUids ? u : { ...u, actorUids }
    })
  }))

  // 새로 만든 기본 액터 중 아무도 안 쓰는 것은 버린다 (전부 조회류면 `관리자`는 군더더기)
  const kept = actors
    .filter((a) => project.actors.includes(a) || used.has(a.uid))
    .map((a) => (named || a.guessed ? a : { ...a, guessed: true }))
  const guessed = kept.filter((a) => a.guessed).length
  return { project: { ...project, actors: kept, packages }, guessed }
}
