/**
 * 3B 모델 내성 검증 — `npm run test:small`
 *
 * 3B급 모델이 실제로 저지르는 일곱 가지 실수를 그대로 만들어 앱의 조립 경로에
 * 통과시킨다. **모델이 어떤 헛소리를 해도 트리와 XMI 는 완성돼야 한다.**
 *
 * 예전에는 Ollama 프로토콜 목 서버를 띄워 HTTP 로 검증했다. 프로바이더가
 * 임베디드 하나로 줄면서 그 서버를 흉내 낼 대상이 없어졌고, 어차피 검증하려던
 * 것은 **응답 문자열을 어떻게 소화하느냐**였다. 순수 함수에 직접 먹인다 —
 * 네트워크가 없으니 빠르고, 실패하면 어디가 깨졌는지 바로 보인다.
 */
import { pickUseCases } from '../src/main/core/generate'
import { buildAnalysis, fallbackUseCase, parseOutline, reqKey } from '../src/main/core/outline'
import { normalizeToProject, sanitizeRawUseCases } from '../src/main/core/normalize'
import { validateProject } from '../src/main/core/validate'
import { buildXmi } from '../src/main/core/xmi'
import type { RawUseCase } from '../src/shared/types'

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
/* 입력 — 앱이 만드는 표준 블록 형식                                     */
/* ------------------------------------------------------------------ */

const REQS = [
  ['통합서비스', '분야별 연계서비스', 'SFR-001-PAD(플랫폼기반)-02', '연계 데이터 수집'],
  ['통합서비스', '알람서비스', 'SFR-001-PAD(플랫폼기반)-03', '관심 키워드 알람'],
  ['데이터관리', '품질관리', 'SFR-002-PAD(플랫폼기반)-01', '데이터 품질 점검'],
  ['데이터관리', '이력관리', 'SFR-002-PAD(플랫폼기반)-02', '변경 이력 조회'],
  ['연계관리', '표준화', 'SFR-003-PAD(플랫폼기반)-01', '수집 데이터 표준화'],
  ['연계관리', '모니터링', 'SFR-003-PAD(플랫폼기반)-02', '연계 상태 확인'],
  ['시스템관리', '권한관리', 'SFR-004-PAD(플랫폼기반)-01', '사용자 권한 설정']
]

const blocks = [
  '[모형기술서]',
  '1depth|2depth|요구사항ID|요구사항명',
  ...REQS.map((r) => r.join('|')),
  '',
  '[액터정의]',
  '구분|액터명|설명|비고',
  'Primary|시스템관리자|시스템을 운영하는 담당자|',
  'Primary|정책담당자|정책을 수립하는 공무원|',
  'Secondary|연계기관시스템|외부 연계 대상 시스템|'
].join(NL)

/* ------------------------------------------------------------------ */
/* 3B 모델의 일곱 가지 실수                                              */
/* ------------------------------------------------------------------ */

const behaviours: string[] = []

function dumbModelResponse(reqName: string, n: number): string {
  const good = {
    usecases: [
      {
        name: reqName,
        priority: 'High',
        difficulty: '상',
        description: reqName + ' 기능',
        main_flow: '1. 메뉴에 진입한다' + NL + '2. 조건을 입력한다' + NL + '3. 결과를 확인한다',
        alt_flow: '',
        precondition: '로그인 상태',
        postcondition: '작업 완료',
        actors: ['시스템관리자']
      }
    ]
  }

  switch (n % 7) {
    case 0:
      behaviours.push('정상')
      return JSON.stringify(good)
    case 1:
      behaviours.push('코드펜스')
      return '```json' + NL + JSON.stringify(good, null, 2) + NL + '```'
    case 2:
      behaviours.push('앞뒤 잡담')
      return (
        '네, 알겠습니다. 아래와 같이 작성했습니다.' + NL + JSON.stringify(good) + NL + '도움이 되었길 바랍니다.'
      )
    case 3: {
      behaviours.push('중간에 잘림')
      const s = JSON.stringify(good)
      return s.slice(0, Math.floor(s.length * 0.72))
    }
    case 4:
      behaviours.push('배열만 반환')
      return JSON.stringify(good.usecases)
    case 5:
      behaviours.push('없는 액터 지어냄')
      return JSON.stringify({
        usecases: [{ ...good.usecases[0], actors: ['외계인관리자', '시스템관리자'] }]
      })
    default:
      behaviours.push('JSON 아님')
      return '죄송합니다. 요구사항이 명확하지 않아 유스케이스를 만들 수 없습니다.'
  }
}

/* ------------------------------------------------------------------ */

console.log(`${NL}[1] 골격 파싱 (LLM 없이 결정론적으로)`)

const outline = parseOutline(blocks)
if (!outline) {
  console.log('  ✗ [모형기술서] 블록을 파싱하지 못했다')
  process.exit(1)
}
check('요구사항 7건을 읽었다', outline.reqs.length === 7, `${outline.reqs.length}건`)
check('액터 3명을 읽었다', outline.actors.length === 3, `${outline.actors.length}명`)
check('요구사항 ID 원문 유지', outline.reqs[0].reqId === 'SFR-001-PAD(플랫폼기반)-02')

/* ------------------------------------------------------------------ */

console.log(`${NL}[2] 모델 응답 소화 (7가지 실수를 한 번씩)`)

const byReq = new Map<string, RawUseCase[]>()
const fellBack: string[] = []

outline.reqs.forEach((r, i) => {
  const before = behaviours.length
  const raw = dumbModelResponse(r.reqName, i)
  const behaviour = behaviours[before] ?? '?'

  let ucs: RawUseCase[] | null = null
  try {
    ucs = pickUseCases(raw)
  } catch {
    ucs = null // 파싱 자체가 실패 — 앱은 예외로 죽지 않고 대체로 넘어간다
  }
  if (ucs?.length) ucs = sanitizeRawUseCases(ucs, r.reqName).kept
  if (!ucs?.length) fellBack.push(behaviour)

  byReq.set(reqKey(r), ucs?.length ? ucs : [fallbackUseCase(r)])
})

console.log('    모델 행동:', [...new Set(behaviours)].join(', '))
console.log(`    대체(fallback) ${fellBack.length}건${fellBack.length ? ' — ' + fellBack.join(', ') : ''}`)
const fallbackCount = fellBack.length
check('모든 요구사항에 결과가 있다', byReq.size === 7, `${byReq.size}건`)
check(
  '"JSON 아님"만 대체로 넘어간다',
  fallbackCount === 1,
  `${fallbackCount}건 — 나머지 6가지는 복구돼야 한다`
)

/* ------------------------------------------------------------------ */

console.log(`${NL}[3] 골격 + 결과 조립`)

const analysis = buildAnalysis(outline, byReq, { system_name: '내성 검증', project_id: 'SMALL' })
const project = normalizeToProject(analysis, { systemName: '내성 검증', projectId: 'SMALL' })
const ucs = project.packages.flatMap((p) => p.useCases)

console.log(`    UCD ${project.packages.length} · UC ${ucs.length} · 액터 ${project.actors.length}`)
// 행 7개 = 다이어그램 7장, 하위 번호만 다른 행은 패키지 하나(SFR-001~004 → 4개)
const dgms = project.packages.flatMap((p) => p.diagrams)
check('UCD 4개 · 다이어그램 7장 (모델 실패와 무관하게 고정)', project.packages.length === 4 && dgms.length === 7)
check(
  '다이어그램 번호 = 행의 하위 번호',
  project.packages.every((p) => p.useCases.every((u) => u.reqId.endsWith('-' + String(p.diagrams.find((d) => d.uid === u.diagramUid)!.seq).padStart(2, '0'))))
)
check('유스케이스 7건 이상', ucs.length >= 7, `${ucs.length}건`)
check('액터 3명 전부 보존', project.actors.length === 3)
check(
  '패키지 코드가 요구사항 ID에서 파생 (모델이 못 건드림)',
  project.packages.every((p) => p.code.startsWith('UCD-SFR-'))
)
check(
  '지어낸 액터("외계인관리자")는 연결되지 않는다',
  !project.actors.some((a) => a.name.includes('외계인'))
)
check('요구사항 ID 추적성 유지', ucs.every((u) => u.reqId.startsWith('SFR-')))

/* ------------------------------------------------------------------ */

console.log(`${NL}[4] 검증 → XMI`)

const errs = validateProject(project).filter((i) => i.level === 'error')
check('검증 오류 없음', errs.length === 0, errs.map((e) => e.message).join(' / '))

const { xml, stats } = buildXmi(project)
console.log('    XMI 통계:', JSON.stringify(stats))
check('XMI 생성', xml.length > 1000)
check('비ASCII 잔존 없음', !/[^\x00-\x7F]/.test(xml))

/* ------------------------------------------------------------------ */

console.log(`${NL}[5] 최악의 경우 — 모델이 끝까지 쓰레기만 반환`)

const allGarbage = new Map<string, RawUseCase[]>()
for (const r of outline.reqs) allGarbage.set(reqKey(r), [fallbackUseCase(r)])
const worst = normalizeToProject(
  buildAnalysis(outline, allGarbage, { system_name: 'X', project_id: 'X' }),
  { systemName: 'X', projectId: 'X' }
)
const worstUcs = worst.packages.flatMap((p) => p.useCases)
check('전부 대체돼도 트리가 완성된다', worst.packages.length === 4 && worstUcs.length === 7)
check('대체 유스케이스가 요구사항명을 그대로 쓴다', worstUcs[0].name === REQS[0][3])
check('그 상태로도 XMI 가 나온다', buildXmi(worst).xml.length > 1000)

/* ------------------------------------------------------------------ */

console.log(`${NL}결과: ${pass} 통과 / ${fail} 실패`)
if (fail > 0) process.exit(1)
