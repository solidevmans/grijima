import type { ColorKey, Diagram, Project, Team, UcPackage } from './types'
import { TEAM_PALETTE } from './constants'

/**
 * ID 규칙.
 *
 * ★ 요구사항 ID는 **원문 그대로** 쓴다.
 *   `SFR-021-ADT1(맞춤형)` 의 괄호도 한글도 깎지 않는다. 표준 EA 산출물이
 *   원문을 유지하고, 정의서와의 추적성이 그 문자열로 걸리기 때문이다.
 *   예전에는 정제해서 붙였는데(`SFR-021-ADT1`), 그러면 EA에서 검색한 ID가
 *   정의서에 없는 문자열이 되어 역추적이 끊긴다.
 *
 * 정제(sanitizeReqId)는 **업무구분 판정에만** 쓴다. 그건 화면에 나가지 않는다.
 */

/**
 * 비교·정렬용 정제 (ID 자체를 바꾸는 용도가 아니다).
 *   SFR-001-PAD(플랫폼기반)-02  →  SFR-001-PAD-02
 */
export function sanitizeReqId(raw: string): string {
  return (raw || '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[가-힣㄰-㆏]/g, '')
    .replace(/\s+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
}

/**
 * 요구사항 ID에서 수행 팀을 뽑는다.
 *
 *   SFR-001-PAD(플랫폼기반)-02  →  { code: 'PAD',  name: '플랫폼기반' }
 *   SFR-021-ADT1(맞춤형)        →  { code: 'ADT1', name: '맞춤형' }
 *   SFR-001-PAD-02             →  { code: 'PAD',  name: '' }
 *   REQ-001                    →  { code: '',     name: '' }
 *
 * 팀 코드 목록을 코드에 두지 않는다 — 사업마다 다르다.
 * "숫자 구간 뒤에 오는 영숫자 토큰"이라는 위치로만 판단한다.
 */
export function parseTeam(reqId: string): Team {
  const id = (reqId || '').trim()

  // 1) 괄호가 있으면 가장 확실하다: -CODE(이름)
  const withName = /-([A-Za-z][A-Za-z0-9]*)\s*\(([^)]*)\)/.exec(id)
  if (withName) return { code: withName[1].toUpperCase(), name: withName[2].trim() }

  // 2) 괄호가 없으면 숫자 구간 다음의 영숫자 토큰
  const afterNum = /-\d+-([A-Za-z][A-Za-z0-9]*)(?:-|$)/.exec(id)
  if (afterNum) return { code: afterNum[1].toUpperCase(), name: '' }

  return { code: '', name: '' }
}

/** 팀 표시용 라벨. `PAD(플랫폼기반)` 또는 `PAD` */
export function teamLabel(team: Team): string {
  if (!team.code) return '(팀 미지정)'
  return team.name ? `${team.code}(${team.name})` : team.code
}

/**
 * 팀 → 색상. 프로젝트 안에서 처음 나온 순서대로 팔레트를 돌려 쓴다.
 * 고정 매핑(PAD=노랑 …)을 두면 다른 사업 문서에서 전부 무색이 된다.
 */
export function colorForTeamIndex(index: number): ColorKey {
  return TEAM_PALETTE[index % TEAM_PALETTE.length]
}

/** 프로젝트 안의 팀 코드 → 등장 순번 (색상 배정 기준) */
export function teamOrder(reqIds: string[]): Map<string, number> {
  const order = new Map<string, number>()
  for (const id of reqIds) {
    const code = parseTeam(id).code
    if (code && !order.has(code)) order.set(code, order.size)
  }
  return order
}

export const pad2 = (n: number): string => String(n).padStart(2, '0')
export const pad3 = (n: number): string => String(n).padStart(3, '0')

/** 요구사항 ID를 코드에 쓸 수 있게 최소 정리 (양끝 공백/대괄호만) */
function reqIdForCode(reqId: string): string {
  return (reqId || '').trim().replace(/^\[|\]$/g, '')
}

/**
 * 요구사항 행 ID를 패키지 ID와 하위 번호로 가른다.
 *   SFR-021-ADT1(맞춤형)-02  →  { base: 'SFR-021-ADT1(맞춤형)', sub: 2 }
 *   SFR-021-02              →  { base: 'SFR-021', sub: 2 }
 *   SFR-021-ADT1(맞춤형)     →  { base: 'SFR-021-ADT1(맞춤형)', sub: 0 }   (하위 번호 없음)
 *   REQ-001                 →  { base: 'REQ-001', sub: 0 }   (끝 숫자가 본 번호)
 * 끝의 `-숫자`를 떼고도 `종류-번호`가 남을 때만 하위 번호로 본다.
 */
export function splitSubNo(reqId: string): { base: string; sub: number } {
  const id = reqIdForCode(reqId)
  const m = /^(.+)-(\d{1,3})\s*$/.exec(id)
  if (m && /[A-Za-z]{2,}-\d+/.test(m[1])) return { base: m[1], sub: Number(m[2]) }
  return { base: id, sub: 0 }
}

/** UCD 패키지 코드: UCD-SFR-021-ADT1(맞춤형) */
export function packageCode(reqId: string): string {
  const id = reqIdForCode(reqId)
  return id ? `UCD-${id}` : 'UCD-UNKNOWN'
}

/**
 * 유스케이스 코드: UC-SFR-001-SAD(서비스개발)-03-01
 *
 * 요구사항 ID 뒤에 **두 자리 하나만** 붙인다. 순번은 **요구사항 ID 안에서**
 * 매긴다 — 패키지도 다이어그램도 기준이 아니다. 유스케이스를 다른 UCD로
 * 옮겨도 코드가 그대로여야 정의서와의 추적성이 유지된다.
 */
export function useCaseCode(reqId: string, ucIndex: number): string {
  const id = reqIdForCode(reqId)
  const base = id ? `UC-${id}` : 'UC-UNKNOWN'
  return `${base}-${pad2(ucIndex + 1)}`
}

/**
 * 다이어그램의 요구사항 행 ID — 그 다이어그램에 새로 넣는 유스케이스가 물려받는 reqId.
 * 생성은 패키지 = 앞부분, 유스케이스 reqId = 행 ID(`SFR-003-PAD-01`)라 패키지 reqId를
 * 그대로 주면 코드가 `UC-SFR-003-PAD-01`(다이어그램 번호 빠짐)이 된다.
 *   패키지 reqId가 이미 행 ID(예전 파일)  → 그대로
 *   다른 유스케이스가 그 번호의 행 ID를 가짐 → 그 ID (원문 글자 그대로)
 *   패키지 유스케이스가 전부 하위 번호 없음 → 패키지 reqId (`REQ-001` 같은 행)
 *   그 밖                                → 앞부분-다이어그램 번호 두 자리
 */
export function diagramReqId(pkg: UcPackage, diagramUid: string, exceptUid?: string): string {
  const { base, sub } = splitSubNo(pkg.reqId)
  if (sub > 0) return pkg.reqId
  const seq = pkg.diagrams.find((d) => d.uid === diagramUid)?.seq ?? 1
  const mine = pkg.useCases.filter((u) => u.uid !== exceptUid && splitSubNo(u.reqId).base === base)
  const row = mine.find((u) => splitSubNo(u.reqId).sub === seq)
  if (row) return row.reqId
  if (mine.length && mine.every((u) => splitSubNo(u.reqId).sub === 0)) return pkg.reqId
  return `${base}-${pad2(seq)}`
}

/** 패키지 표시명: `[UCD-...] 요구사항명` — EA 패키지 name 으로 그대로 나간다 */
export function packageLabel(pkg: UcPackage): string {
  return `[${pkg.code}] ${pkg.name}`.trim()
}

/** 유스케이스 표시명: `[UC-...] 유스케이스명` */
export function useCaseLabel(code: string, name: string): string {
  return `[${code}] ${name}`.trim()
}

/**
 * 다이어그램 표시명.
 * 사용자가 지정했으면 그 값을, 없으면 `[{패키지코드}-{순번2}] {패키지명}`.
 * 표준 산출물이 `[UCD-SFR-021-ADT1(맞춤형)-01] 만족도 설문지 관리` 형태다.
 */
export function diagramNameOf(pkg: UcPackage, dgm: Diagram): string {
  return dgm.name?.trim() || `[${pkg.code}-${pad2(dgm.seq)}] ${pkg.name}`.trim()
}

/**
 * 프로젝트 전체 코드 재채번.
 *
 * 패키지 코드는 요구사항 ID에서 나오므로 순서와 무관하다. 다시 계산해도 같은 값이다.
 * 유스케이스 코드만 **패키지 안에서, 다이어그램별로** 다시 매긴다.
 * (예전에는 카운터 스코프가 정규화 단계와 재채번 단계에서 달라 같은 요구사항이
 *  두 곳에 걸치면 코드가 중복됐다. 이제 요구사항 = 패키지라 그 경우 자체가 없다.)
 */
export function renumber(project: Project, opts: { renumberUseCases?: boolean } = {}): Project {
  /*
   * 유스케이스 순번은 **프로젝트 전역에서 요구사항 ID별로** 매긴다.
   * 같은 요구사항의 유스케이스가 여러 UCD에 흩어져 있어도 -01, -02, -03 이
   * 이어져야 한다(기술서의 유스케이스 목록 표가 그렇게 되어 있다).
   */
  const perReq = new Map<string, number>()
  const nextIndex = (reqId: string): number => {
    const key = reqId.trim()
    const n = perReq.get(key) ?? 0
    perReq.set(key, n + 1)
    return n
  }

  const packages: UcPackage[] = project.packages.map((p) => {
    const code = packageCode(p.reqId)
    // 다이어그램 번호는 정의서 행의 하위 번호라 그대로 둔다. 비었거나 앞 것과 겹치는 번호만 가장 큰 번호 다음으로.
    const used = new Set<number>()
    const keep = p.diagrams.map((d) => {
      const ok = Number.isInteger(d.seq) && d.seq > 0 && !used.has(d.seq)
      if (ok) used.add(d.seq)
      return ok
    })
    let next = Math.max(0, ...used)
    const diagrams = p.diagrams.map((d, i) => ({ ...d, seq: keep[i] ? d.seq : ++next }))

    if (!opts.renumberUseCases) return { ...p, code, diagrams }

    const rowed = p.useCases.some((u) => splitSubNo(u.reqId).sub > 0)
    const useCases = p.useCases.map((uc) => {
      // 예전 + 유스케이스가 패키지 reqId(앞부분)를 물려받아 다이어그램 번호가 빠진 것은 행 ID로 고친다
      // (패키지에 행 ID 유스케이스가 있을 때만 — `REQ-001`처럼 하위 번호 없는 행은 그대로)
      const inherited = (!uc.reqId || uc.reqId.trim() === p.reqId.trim()) && rowed
      const rid = inherited ? diagramReqId(p, uc.diagramUid, uc.uid) : uc.reqId
      return { ...uc, reqId: rid, code: useCaseCode(rid, nextIndex(rid)) }
    })
    return { ...p, code, diagrams, useCases }
  })
  return { ...project, packages }
}
