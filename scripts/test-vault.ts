/**
 * 마크다운 볼트 내보내기 검증 — `npm run test:vault`
 *
 * 이 산출물의 가치는 "링크를 따라 돌아다닐 수 있다"는 것뿐이므로,
 * 링크가 깨지면 만들 이유가 없다. 그래서 여기서 보는 건 세 가지다:
 *   ① 모든 위키링크가 실제 노트로 해석되는가 (dangling 0)
 *   ② 노트 경로가 유일한가 — 겹치면 덮어써서 내용이 조용히 사라진다
 *   ③ 파일명/frontmatter가 문법을 깨뜨리지 않는가
 */
import type { Project, RawAnalysis } from '../src/shared/types'
import { normalizeToProject } from '../src/main/core/normalize'
import { toVault } from '../src/main/core/markdown'

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label} ${detail}`)
  }
}

const NL = String.fromCharCode(10)

/* 링크·파일명·YAML을 깨뜨릴 만한 문자를 일부러 섞은 입력 */
const raw: RawAnalysis = {
  metadata: { system_name: '예시 시스템', project_id: 'EAUCS' },
  actors: [
    { name: '시스템관리자', description: '권한/메뉴 관리: 전체', kind: 'Primary' },
    { name: '연계기관시스템', description: '외부 시스템 <OpenAPI>', kind: 'Secondary' },
    // 액터 이름 중복 — 검증에서 경고 수준이라 실제로 들어올 수 있다
    { name: '시스템관리자', description: '중복 이름 액터', kind: 'Primary' }
  ],
  requirements: [
    {
      req_id: 'SFR-001-PAD(플랫폼기반)-02',
      req_name: '분야별 연계서비스 [1차]',
      work_type: 'PAD',
      usecases: [
        {
          name: '연계 데이터 수집 & 저장',
          priority: 'High',
          difficulty: '상',
          description: 'A & B 부문 연계 <필수>',
          main_flow: '1.대상 선택\n2.OpenAPI 호출\n3.원시데이터 저장',
          alt_flow: '2a.호출 실패 시 재시도',
          precondition: 'API키 발급 완료',
          postcondition: '연계데이터 저장 완료',
          actors: ['연계기관시스템', '시스템관리자']
        },
        {
          name: '데이터 표준화 처리',
          priority: 'Medium',
          difficulty: '중',
          main_flow: '1.정합성 검증',
          actors: ['시스템관리자']
        }
      ]
    },
    {
      // 요구사항이 다르면 UCD 패키지도 다르다 → 코드가 겹치지 않는다
      req_id: 'SFR-002-PAD(플랫폼기반)-01',
      req_name: '알람서비스 / 통보',
      work_type: 'PAD',
      usecases: [
        {
          name: '알람 발송',
          priority: 'Low',
          difficulty: '하',
          main_flow: '1.대상 조회',
          actors: []
        }
      ]
    }
  ]
}

const project: Project = normalizeToProject(raw, {
  systemName: '예시 시스템',
  projectId: 'EAUCS'
})

const { files, stats } = toVault(project)
const byPath = new Map(files.map((f) => [f.path, f.content]))
const noteNames = new Set(
  files.map((f) => (f.path.split('/').pop() as string).replace(/\.md$/, ''))
)

console.log('[1] 노트 생성')
check('노트가 만들어졌다', files.length > 0, `(${files.length})`)
check('경로가 모두 유일하다', byPath.size === files.length, `${files.length} → ${byPath.size}`)
check('모든 파일이 .md 다', files.every((f) => f.path.endsWith('.md')))
check(
  '유스케이스 수가 일치한다',
  stats.useCases === project.packages.reduce((n, p) => n + p.useCases.length, 0),
  String(stats.useCases)
)
check('액터 수가 일치한다', stats.actors === project.actors.length, String(stats.actors))

console.log(NL + '[2] 파일명 안전성')
const badChars = files.filter((f) =>
  (f.path.split('/').pop() as string).match(/[\\:*?"<>|#^[\]]/)
)
check('Windows/옵시디언 금지 문자가 없다', badChars.length === 0, badChars.map((f) => f.path).join(', '))
const badTail = files.filter((f) => /[.\s]\.md$/.test(f.path))
check('마침표/공백으로 끝나는 이름이 없다', badTail.length === 0, badTail.map((f) => f.path).join(', '))

console.log(NL + '[3] 이름 중복 처리')
// 액터 '시스템관리자' 2명 + 유스케이스 코드 중복 1건이 모두 살아남아야 한다
const actorNotes = files.filter((f) => f.path.startsWith('액터/'))
check('중복 이름 액터도 노트가 따로 생긴다', actorNotes.length === 3, `(${actorNotes.length})`)
const ucNotes = files.filter((f) => f.content.includes('type: 유스케이스'))
check('유스케이스 노트가 전부 생긴다', ucNotes.length === 3, `(${ucNotes.length})`)

console.log(NL + '[4] 위키링크 무결성')
const dangling: string[] = []
let linkCount = 0
for (const [path, content] of byPath) {
  for (const m of content.matchAll(/\[\[([^\]|#^]+)(?:\|[^\]]*)?\]\]/g)) {
    linkCount++
    const target = m[1].trim()
    if (!noteNames.has(target)) dangling.push(`${path} → [[${target}]]`)
  }
}
check('링크가 존재한다', linkCount > 0, `(${linkCount}개)`)
check('끊어진 링크가 없다', dangling.length === 0, NL + '      ' + dangling.join(NL + '      '))

console.log(NL + '[5] frontmatter')
let fmOk = 0
let fmBad: string[] = []
for (const [path, content] of byPath) {
  if (!content.startsWith('---' + NL)) {
    fmBad.push(`${path}: 시작 구분자 없음`)
    continue
  }
  const end = content.indexOf(NL + '---' + NL, 3)
  if (end === -1) {
    fmBad.push(`${path}: 종료 구분자 없음`)
    continue
  }
  const body = content.slice(4, end)
  for (const line of body.split(NL)) {
    if (!line.trim()) continue
    const kv = /^([A-Za-z][\w]*): (.*)$/.exec(line)
    if (!kv) {
      fmBad.push(`${path}: "${line}"`)
      continue
    }
    const v = kv[2]
    // 겹따옴표로 감싼 값은 JSON으로 되읽혀야 한다 (YAML 겹따옴표 스칼라 = JSON 문자열)
    if (v.startsWith('"')) {
      try {
        JSON.parse(v)
      } catch {
        fmBad.push(`${path}: 인용 값 깨짐 ${v}`)
      }
    } else if (/^[:\-?&*!|>%@`]/.test(v)) {
      fmBad.push(`${path}: 인용이 필요한 값 ${v}`)
    }
  }
  fmOk++
}
check('모든 노트에 frontmatter 가 있다', fmOk === files.length, `${fmOk}/${files.length}`)
check('YAML 값이 깨지지 않는다', fmBad.length === 0, NL + '      ' + fmBad.join(NL + '      '))

console.log(NL + '[6] 내용 보존')
const uc = [...byPath.values()].find((c) => c.includes('# 연계 데이터 수집 & 저장'))
check('유스케이스 노트를 찾았다', Boolean(uc))
if (uc) {
  check('주 흐름 3단계가 모두 들어 있다', ['대상 선택', 'OpenAPI 호출', '원시데이터 저장'].every((t) => uc.includes(t)))
  check('대안 흐름이 들어 있다', uc.includes('재시도'))
  check('사전/사후조건이 들어 있다', uc.includes('API키 발급 완료') && uc.includes('연계데이터 저장 완료'))
  check('요구사항ID가 원문 그대로 보존된다', uc.includes('SFR-001-PAD(플랫폼기반)-02'))
  check('액터가 링크로 연결된다', uc.includes('[[연계기관시스템]]'))
}
const pkg = [...byPath.values()].find((c) => c.includes('type: 요구사항'))
check('요구사항 노트에 다이어그램(PlantUML)이 들어 있다', Boolean(pkg?.includes('```plantuml') && pkg?.includes('@startuml')))
const orphan = [...byPath.values()].find((c) => c.includes('# 알람 발송'))
check('액터 없는 유스케이스는 그 사실을 밝힌다', Boolean(orphan?.includes('연결 없음')))

console.log(`${NL}결과: ${pass} 통과 / ${fail} 실패`)
if (fail > 0) process.exitCode = 1
