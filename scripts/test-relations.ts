/**
 * 관계 제안(include/extend) 내성 검증 — `npm run test:rel`
 *
 * 모델은 **번호만** 말하고 판정은 전부 코드가 한다. 그래서 검증할 것은
 * "모델이 어떤 헛소리를 해도 프로젝트가 망가지지 않는가" 하나다.
 * 소형 모델이 실제로 하는 실수를 재현해 던진다.
 *
 * LLM 호출은 하지 않는다 — 순수 함수만 검증한다.
 */
import {
  applyRelations,
  buildRelationItems,
  pickRelations,
  type RelationPair
} from '../src/main/core/relations'
import { relationEdges, wouldCreateCycle } from '../src/shared/graph'
import { validateProject } from '../src/main/core/validate'
import { buildXmi } from '../src/main/core/xmi'
import {
  MAX_UC_PER_REQ,
  normalizeToProject,
  sanitizeRawUseCases
} from '../src/main/core/normalize'
import type { Project, RawAnalysis, RawUseCase } from '../src/shared/types'

const NL = String.fromCharCode(10)
let pass = 0
let fail = 0

function check(label: string, ok: boolean, extra = ''): void {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}${extra ? ' ' + extra : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${extra ? ' ' + extra : ''}`)
  }
}

/* ------------------------------------------------------------------ */
/* 테스트용 프로젝트 — 유스케이스 6건                                    */
/* ------------------------------------------------------------------ */

const analysis: RawAnalysis = {
  metadata: { system_name: '관계 테스트', project_id: 'REL' },
  requirements: [
    {
      req_id: 'SFR-001-PAD(플랫폼기반)-01',
      req_name: '통합검색',
      usecases: [
        { name: '통합 검색 수행', main_flow: '1. 검색어를 입력한다', actors: ['이용자'] },
        { name: '검색 이력 저장', main_flow: '1. 검색어를 저장한다', actors: ['이용자'] }
      ]
    },
    {
      req_id: 'SFR-002-PAD(플랫폼기반)-01',
      req_name: '공통기능',
      usecases: [
        { name: '사용자 로그인', main_flow: '1. 자격을 확인한다', actors: ['이용자'] },
        { name: '권한 확인', main_flow: '1. 권한을 조회한다', actors: ['관리자'] }
      ]
    },
    {
      req_id: 'SFR-003-PAD(플랫폼기반)-01',
      req_name: '알람',
      usecases: [
        { name: '알람 수신', main_flow: '1. 알람을 받는다', actors: ['이용자'] },
        { name: '알람 설정', main_flow: '1. 조건을 지정한다', actors: ['이용자'] }
      ]
    }
  ],
  actors: [
    { name: '이용자', description: '서비스를 쓰는 사람', kind: 'Primary' },
    { name: '관리자', description: '운영자', kind: 'Primary' }
  ]
}

const base: Project = normalizeToProject(analysis, {
  systemName: '관계 테스트',
  projectId: 'REL'
})
const items = buildRelationItems(base)

console.log(`${NL}[1] 목록 만들기`)
check('유스케이스 6건이 번호로 나열됨', items.length === 6, `${items.length}건`)
check('번호는 1부터 연속', items.every((it, i) => it.index === i + 1))
check('UCD 이름이 함께 나감', items.every((it) => it.pkgName.length > 0))

/* ------------------------------------------------------------------ */
/* 2. 응답 파싱 — 소형 모델의 형식 파괴                                  */
/* ------------------------------------------------------------------ */

console.log(`${NL}[2] 응답 파싱 (모델이 형식을 어겨도 읽어낸다)`)

const parseCases: Array<[string, string, number]> = [
  ['정상', '{"relations":[{"from":1,"to":3,"type":"include"}]}', 1],
  ['코드펜스', '```json' + NL + '{"relations":[{"from":1,"to":3,"type":"include"}]}' + NL + '```', 1],
  ['배열만 반환', '[{"from":1,"to":3,"type":"include"}]', 1],
  ['키 이름 다름', '{"relationships":[{"source":1,"target":3,"kind":"include"}]}', 1],
  ['번호가 문자열', '{"relations":[{"from":"1","to":"3","type":"include"}]}', 1],
  ['관계 없음', '{"relations":[]}', 0],
  ['잡담이 섞임', '알겠습니다. {"relations":[{"from":2,"to":4,"type":"extend"}]}', 1]
]
for (const [label, text, want] of parseCases) {
  let got = -1
  try {
    got = pickRelations(text).length
  } catch {
    got = -1
  }
  check(label, got === want, `${got}건`)
}

/* ------------------------------------------------------------------ */
/* 3. 검증 — 모델이 규칙을 어겼을 때                                     */
/* ------------------------------------------------------------------ */

console.log(`${NL}[3] 규칙 위반은 코드가 버린다`)

const inc = (from: number, to: number): RelationPair => ({ from, to, type: 'include' })

{
  const r = applyRelations(base, items, [inc(1, 99), inc(0, 2), inc(-1, 3)])
  check('목록에 없는 번호는 버린다', r.applied === 0, `적용 ${r.applied}건`)
  check('버린 이유를 남긴다', r.rejected.length === 3)
}
{
  const r = applyRelations(base, items, [inc(2, 2)])
  check('자기 자신 참조를 버린다', r.applied === 0)
}
{
  const r = applyRelations(base, items, [inc(1, 3), inc(1, 3), inc(1, 3)])
  check('같은 쌍 중복은 한 번만', r.applied === 1, `적용 ${r.applied}건`)
}
{
  // 모델이 "전부 이어 붙이기"를 시전한 경우 — 액터에서 겪은 바로 그 실패
  const everything: RelationPair[] = []
  for (let a = 1; a <= 6; a++) {
    for (let b = 1; b <= 6; b++) if (a !== b) everything.push(inc(a, b))
  }
  const r = applyRelations(base, items, everything)
  check(
    '전부 이어 붙이면 상한에서 잘린다',
    r.applied <= 2,
    `${everything.length}건 요청 → ${r.applied}건 적용`
  )
  const ucs = r.project.packages.flatMap((p) => p.useCases)
  check('한 유스케이스가 2건을 넘지 않는다', ucs.every((u) => u.includeUids.length <= 2))
}
{
  // 1 → 3, 3 → 1 : 되돌아오는 순환
  const r = applyRelations(base, items, [inc(1, 3), inc(3, 1)])
  check('직접 순환을 막는다', r.applied === 1, `적용 ${r.applied}건`)
}
{
  // 1 → 3 → 5 → 1 : 세 단계를 돌아오는 순환
  const r = applyRelations(base, items, [inc(1, 3), inc(3, 5), inc(5, 1)])
  check('먼 순환도 막는다', r.applied === 2, `적용 ${r.applied}건`)
}
{
  /*
   * 이미 프로젝트에 관계가 있는 상태에서 고리를 닫으려 하는 경우.
   * 순환 그래프를 빈 상태에서 시작하면 이걸 놓친다 — 실제로 그랬다.
   */
  const seeded = applyRelations(base, items, [inc(1, 3)]).project
  const r = applyRelations(seeded, buildRelationItems(seeded), [inc(3, 1)])
  check('기존 관계와 합쳐지는 순환도 막는다', r.applied === 0, `적용 ${r.applied}건`)
}
{
  // 공용 그래프 함수 자체 — 렌더러(손으로 잇기)도 같은 규칙을 쓴다
  const ucs = base.packages.flatMap((k) => k.useCases)
  const linked = applyRelations(base, items, [inc(1, 3)]).project.packages.flatMap((k) => k.useCases)
  check('빈 그래프에서는 순환이 아니다', !wouldCreateCycle(relationEdges(ucs), ucs[0].uid, ucs[2].uid))
  check(
    '반대 방향은 순환이다',
    wouldCreateCycle(relationEdges(linked), linked[2].uid, linked[0].uid)
  )
  check('자기 자신은 항상 순환', wouldCreateCycle(relationEdges(ucs), ucs[0].uid, ucs[0].uid))
}

/* ------------------------------------------------------------------ */
/* 3b. 반복 생성 방어 — 실제로 겪은 사고 재현                            */
/* ------------------------------------------------------------------ */

console.log(`${NL}[3b] 모델이 같은 유스케이스를 반복 생성하는 경우`)

{
  /*
   * 실제 증상: 요구사항 1건("AI 기반의 지능형 개인맞춤 서비스")에서
   * 유스케이스 62건이 나왔고 서로 다른 이름은 3개뿐이었다.
   * 코드가 -01-01 부터 -01-62 까지 찍혔고 다이어그램은 같은 타원 수십 개가 됐다.
   */
  const reqName = 'AI 기반의 지능형 개인맞춤 서비스'
  const looped: RawUseCase[] = [
    { name: `${reqName} 등록`, main_flow: '1. 등록한다' },
    { name: `${reqName} AI 연산방식 개발`, main_flow: '1. 개발한다' }
  ]
  for (let i = 0; i < 60; i++) {
    looped.push({ name: `${reqName} 데이터 전송 데이터 꾸러미 생성`, main_flow: '1. 생성한다' })
  }

  const s = sanitizeRawUseCases(looped, reqName)
  check('62건 → 서로 다른 3건만 남는다', s.kept.length === 3, `${s.kept.length}건`)
  check('버린 개수를 알려준다', s.dropped === 59, `${s.dropped}건`)
  check(
    '요구사항명 앞머리를 뗀다',
    s.kept.every((u) => !(u.name ?? '').startsWith(reqName)),
    s.kept.map((u) => u.name).join(' / ')
  )

  // 정규화까지 통과시켜도 막히는가 (전체 한 번에 · JSON 직접 입력 경로)
  const p = normalizeToProject(
    {
      metadata: { system_name: 'X', project_id: 'X' },
      requirements: [{ req_id: 'SFR-008-ADT1(맞춤형)-01', req_name: reqName, usecases: looped }],
      actors: [{ name: '소상공인', kind: 'Primary' }]
    },
    { systemName: 'X', projectId: 'X' }
  )
  const made = p.packages.flatMap((k) => k.useCases)
  check('정규화 경로도 막는다', made.length === 3, `${made.length}건`)
  check('코드가 -01-62 까지 가지 않는다', !made.some((u) => u.code.endsWith('-62')))
}
{
  // 상한: 이름이 전부 다르더라도 한 요구사항에 12건까지
  const many: RawUseCase[] = []
  for (let i = 0; i < 40; i++) many.push({ name: `서로 다른 유스케이스 ${i}` })
  const s = sanitizeRawUseCases(many, '요구사항')
  check('이름이 달라도 상한에서 자른다', s.kept.length === MAX_UC_PER_REQ, `${s.kept.length}건`)
}
{
  // 멀쩡한 응답은 건드리지 않는다
  const ok: RawUseCase[] = [
    { name: '연계 데이터 수집' },
    { name: '수집 데이터 표준화' },
    { name: '표준화 결과 확인' }
  ]
  const s = sanitizeRawUseCases(ok, '분야별 연계서비스')
  check('정상 응답은 그대로 통과', s.kept.length === 3 && s.dropped === 0)
  check('짧은 이름은 안 건드린다', s.kept[0].name === '연계 데이터 수집')
}

/* ------------------------------------------------------------------ */
/* 4. 정상 반영                                                        */
/* ------------------------------------------------------------------ */

console.log(`${NL}[4] 정상 관계 반영`)

const good = applyRelations(base, items, [
  { from: 1, to: 3, type: 'include' },
  { from: 5, to: 4, type: 'extend' }
])
check('2건이 적용됨', good.applied === 2, `적용 ${good.applied}건`)

const findByName = (p: Project, name: string) =>
  p.packages.flatMap((k) => k.useCases).find((u) => u.name === name)

{
  const search = findByName(good.project, '통합 검색 수행')
  const login = findByName(good.project, '사용자 로그인')
  check('include 가 대상 uid 로 걸렸다', Boolean(search && login && search.includeUids.includes(login.uid)))
}
{
  const recv = findByName(good.project, '알람 수신')
  const perm = findByName(good.project, '권한 확인')
  check('extend 가 대상 uid 로 걸렸다', Boolean(recv && perm && recv.extendUids.includes(perm.uid)))
}
{
  const beforeUc = base.packages.flatMap((k) => k.useCases)
  check('원본 프로젝트는 그대로다', beforeUc.every((u) => u.includeUids.length === 0 && u.extendUids.length === 0))
}

/* ------------------------------------------------------------------ */
/* 5. 검증 · XMI 까지 살아남는가                                        */
/* ------------------------------------------------------------------ */

console.log(`${NL}[5] 검증 → XMI`)

const issues = validateProject(good.project)
const errs = issues.filter((i) => i.level === 'error')
check('검증 오류 없음', errs.length === 0, errs.map((e) => e.message).join(' / '))

const { xml, stats } = buildXmi(good.project)
console.log(`    XMI 통계: ${JSON.stringify(stats)}`)
check('XMI 생성', xml.length > 1000)
check('include 스테레오타입이 XMI 에 있다', xml.includes('include'))
check('extend 스테레오타입이 XMI 에 있다', xml.includes('extend'))
check('비ASCII 잔존 없음', !/[^\x00-\x7F]/.test(xml))

/* ------------------------------------------------------------------ */

console.log(`${NL}결과: ${pass} 통과 / ${fail} 실패`)
if (fail > 0) process.exit(1)
