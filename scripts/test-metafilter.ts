import { readFileSync } from 'node:fs'
import { collectDocumentMetaValues, isValidActorName, readDocumentMeta } from '../src/main/core/extract'

const NL = String.fromCharCode(10)
const text = readFileSync('examples/실제정의서_표형식.txt', 'utf-8')
const meta = collectDocumentMetaValues(text)

console.log('문서에서 수집한 관리 항목 값:')
for (const v of [...meta].sort()) console.log('  ·', v)

console.log(NL + '--- 액터 후보 판정 ---')
const cases = [
  '임창묵', '플랫폼기반팀', '국립환경과학원', '통합플랫폼',
  '시스템관리자', '정책담당자', '일반국민', '전문가', '연계기관시스템'
]
const flat = (s: string): string => s.replace(/\s+/g, ' ')
for (const c of cases) {
  const blocked = [...meta].some((m) => m === flat(c) || m.includes(flat(c)) || flat(c).includes(m))
  console.log(`  ${c.padEnd(16)} ${blocked ? '✗ 제외 (문서 관리 항목)' : '○ 액터 후보'}`)
}

console.log(NL + '--- 가상 검증: 담당자가 "김관리자"였다면? ---')
const fake = text.replace('임창묵', '김관리자')
const m2 = collectDocumentMetaValues(fake)
const blocked = [...m2].some((m) => m === '김관리자')
console.log(`  김관리자 → ${blocked ? '✗ 제외됨 (이름에 "관리자"가 있어도 담당자 값이므로)' : '○ 통과 — 실패'}`)

/* ------------------------------------------------------------------ */
/* 액터 판정 — 업무 단어 목록이 아니라 문서 구조로 판단한다              */
/* ------------------------------------------------------------------ */
console.log(NL + '--- 액터 이름 판정 (원문 대조) ---')
let pass = 0
let fail = 0

/* 액터가 실제로 등장하는 짧은 원문 */
const src = [
  '본 시스템은 공무원과 관리자가 사용하며, 대국민에게도 공개된다.',
  '연계기관시스템과 OpenAPI로 연동한다.',
  '통합검색 화면에서 전체 콘텐츠를 조회한다.'
].join(NL)

const none = new Set<string>()
const expect = (name: string, want: boolean, why: string): void => {
  const got = isValidActorName(name, none, src)
  const mark = got === want ? '✓' : '✗'
  if (got === want) pass++
  else fail++
  console.log(`  ${mark} ${name.padEnd(22)} ${want ? '○ 액터' : '✗ 제외'}  ${why}`)
}

// 원문에 나오는 직무·외부시스템 → 통과 (단어 목록 없이)
expect('공무원', true, '원문에 있음')
expect('관리자', true, '원문에 있음')
expect('대국민', true, '원문에 있음')
expect('연계기관시스템', true, '원문에 있음 (외부 시스템)')

// 모델이 지어낸 이름 → 원문에 없으므로 제외
expect('통합검색 사용자', false, '원문에 없는 조합 — 지어낸 이름')
expect('부문별 대시보드 화면 사용자', false, '원문에 없음')
expect('소상공인', false, '다른 사업 어휘 — 이 문서엔 없음')

// 문서 관리 항목의 값이면 원문에 있어도 제외 (위치로 판단)
const metaOnly = new Set(['홍길동'])
const gotMeta = isValidActorName('홍길동', metaOnly, '담당자' + NL + '홍길동')
if (!gotMeta) { pass++; console.log('  ✓ 홍길동                 ✗ 제외  담당자 라벨의 값') }
else { fail++; console.log('  ✗ 홍길동                 관리 항목인데 통과함') }

/* ------------------------------------------------------------------ */
/* 부정문에만 나오는 표현 — 실제로 겪은 사고 재현                         */
/* ------------------------------------------------------------------ */

console.log(`${NL}--- 부정문 판정 (어휘 목록 없이 문장 구조로) ---`)

const negCase = (name: string, text: string, want: boolean, why: string): void => {
  const got = isValidActorName(name, new Set(), text)
  const mark = want ? '○ 액터 ' : '✗ 제외 '
  if (got === want) { pass++; console.log(`  ✓ ${name.padEnd(12)} ${mark} ${why}`) }
  else { fail++; console.log(`  ✗ ${name.padEnd(12)} 기대 ${want} / 실제 ${got} — ${why}`) }
}

{
  /*
   * 사고 ①: 정의서에 딱 한 번, 그것도 부정문으로 스친 표현이 액터가 됐고
   * 그 액터를 쓰는 유스케이스는 하나도 없었다.
   */
  const onceNegated =
    '만족도 조사 등록 시 설문 안내, 경품 안내, 종료 문구를 등록하고 ' +
    '설문 대상자가 아닌 사용자가 만족도 조사 선택 시 알림을 띄우는 방식으로 구현'
  negCase('설문대상자', onceNegated, false, '부정문에만 나옴 ("~가 아닌")')

  // 부정문 말고 다른 자리에도 나오면 진짜 액터다
  negCase(
    '설문대상자',
    onceNegated + ' 설문대상자에게 결과를 발송한다.',
    true,
    '부정문 밖에도 등장'
  )

  /*
   * 사고 ②: 위 방어를 "예시에 나온 이름은 두 번 이상 나와야 한다"로 만들었더니
   * 한 번만 언급된 멀쩡한 액터(공단관리자)가 잘려 나갔다.
   * 등장 횟수가 아니라 문장 구조로 판단해야 한다.
   */
  negCase('공단관리자', '공단관리자가 공고를 등록한다.', true, '1회 등장이어도 정상 문장')
  negCase('국세청시스템', '국세청시스템과 연계하여 소득 정보를 조회한다.', true, '1회 등장 외부 시스템')
  negCase('민원인', '민원인이 증명서를 신청한다.', true, '프롬프트 예시와 같은 이름이어도 정상 문장')
}

/* ------------------------------------------------------------------ */
/* 문서가 밝힌 이름을 읽는가 — 지어내지 않는다                            */
/* ------------------------------------------------------------------ */

console.log(`${NL}--- 시스템명 · 프로젝트 ID 읽기 ---`)

{
  const meta = (t: string) => readDocumentMeta(t)
  const chk = (label: string, got: string, want: string): void => {
    if (got === want) { pass++; console.log(`  ✓ ${label.padEnd(14)} ${JSON.stringify(got)}`) }
    else { fail++; console.log(`  ✗ ${label.padEnd(14)} 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`) }
  }

  chk('인라인 라벨', meta('# 정의서' + NL + '- 시스템명: 국가환경통합플랫폼').systemName, '국가환경통합플랫폼')
  chk('표 형태', meta('시스템명' + NL + '소상공인24 고도화' + NL + NL + '담당자' + NL + '홍길동').systemName, '소상공인24 고도화')
  chk('사업명도 인정', meta('사업명 : 통합민원포털 구축').systemName, '통합민원포털 구축')
  chk('프로젝트 ID', meta('- 시스템명: X' + NL + '- 프로젝트 ID: NIER').projectId, 'NIER')

  /*
   * 없으면 **비워 둔다.** 예전에는 "이름 없는 시스템" 을 지어냈는데, 그 문자열이
   * EA 모델 이름 · 볼트 폴더명 · 저장 파일명으로 그대로 나갔다.
   */
  chk('없으면 빈 값', meta('요구사항 ID: SFR-001' + NL + '요구사항명: 아무거나').systemName, '')
  chk('문장은 이름이 아님', meta('시스템명: ' + '가'.repeat(80)).systemName, '')
}

console.log(`${NL}액터 판정: ${pass} 통과 / ${fail} 실패`)
if (fail > 0) process.exitCode = 1
