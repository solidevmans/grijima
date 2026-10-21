/**
 * 스모크 테스트: 원시 JSON → 정규화 → XMI 생성 → 파일 저장.
 * npm run smoke 로 실행. 출력 XMI는 PowerShell [xml] 파서로 well-formed 검증한다.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RawAnalysis } from '../src/shared/types'
import { normalizeToProject } from '../src/main/core/normalize'
import { fillActors } from '../src/main/core/actorfill'
import { readActorSection, readReqName, readStandardIds } from '../src/main/core/extract'
import { buildXmi } from '../src/main/core/xmi'
import { validateProject } from '../src/main/core/validate'
import { toPlantUml } from '../src/main/core/plantuml'
import { extractJson } from '../src/main/core/json-repair'
import { itemUseCase, trimHeadTail, trimTail } from '../src/main/core/generate'
import { itemName } from '../src/shared/constants'
import { diagramReqId, packageCode, renumber, splitSubNo, useCaseCode } from '../src/shared/idrules'

const outDir = process.argv[2] ?? '.'

/* 예시 요구사항 형태 + XML 이스케이프를 깨뜨리는 문자를 일부러 섞었다 */
const raw: RawAnalysis = {
  metadata: { system_name: '예시 시스템', project_id: 'EAUCS' },
  actors: [
    { name: '시스템관리자', description: '플랫폼 전체 관리, 권한/메뉴/회원 관리', kind: 'Primary' },
    { name: '정책담당자', description: '주요 정보 조회 & 분석 <공무원>', kind: 'Primary' },
    { name: '일반국민', description: '공개 정보 열람, 알람 수신', kind: 'Primary' },
    { name: '연계기관시스템', description: '외부기관A/외부기관B 외부 시스템 (OpenAPI)', kind: 'Secondary' }
  ],
  requirements: [
    {
      // 요구사항 1건 = UCD 패키지 1개. 유스케이스 2건이 이 안에서 -01-01 / -01-02 로 갈린다.
      req_id: 'SFR-001-PAD(플랫폼기반)-02',
      req_name: '분야별 연계서비스',
      work_type: 'PAD',
      usecases: [
        {
          name: '연계 데이터 수집',
          priority: 'High',
          difficulty: '상',
          description: '외부기관A & 외부기관B 부문 시스템 2건 이상 연계 <필수>',
          main_flow: '1.연계대상시스템 선택\n2.OpenAPI 호출 또는 파일 다운로드\n3.원시데이터 저장',
          precondition: 'API키 발급 완료',
          postcondition: '연계데이터 저장 완료',
          actors: ['연계기관시스템', '시스템관리자']
        },
        {
          name: '데이터 표준화 처리',
          priority: 'High',
          difficulty: '상',
          description: '정합성 검증 → 정제 → 가공',
          main_flow: '1.정합성 검증\n2.정제 처리\n3.표준 형식으로 변환',
          actors: ['시스템관리자']
        }
      ]
    },
    {
      req_id: 'SFR-001-PAD(플랫폼기반)-03',
      req_name: '알람서비스',
      work_type: 'PAD',
      usecases: [
        {
          name: '관심 키워드 알람 수신',
          priority: 'Medium',
          difficulty: '중',
          description: '메인 화면에 팝업 형태로 알람 노출',
          main_flow: '1.관심키워드 등록\n2.키워드 매칭\n3.팝업 노출',
          actors: ['일반국민', '정책담당자']
        }
      ]
    },
    {
      // 구버전(3계층) 스키마도 흡수하는지 함께 본다 — sub_packages 는 평탄화된다
      req_id: 'SFR-005-PAD(플랫폼기반)-01',
      req_name: '권한관리',
      work_type: 'PAD',
      sub_packages: [
        {
          sub_name: '(구버전 중분류 — 무시됨)',
          usecases: [
            {
              name: '사용자 권한 설정',
              priority: 'High',
              difficulty: '중',
              description: '권한그룹별 메뉴 접근 제어',
              main_flow: '1.권한관리 메뉴 접근\n2.사용자 조회\n3.권한 저장',
              actors: ['시스템관리자']
            }
          ]
        }
      ]
    }
  ]
}

/* 1. JSON 복구기 점검 — 코드펜스 + 잘린 응답 */
const fenced = '```json\n' + JSON.stringify({ metadata: { system_name: 'A&B' } }) + '\n```'
const okFence = extractJson<{ metadata: { system_name: string } }>(fenced)
console.log('[1] 코드펜스 파싱:', okFence.metadata.system_name === 'A&B' ? 'OK' : 'FAIL')

const truncated = '{"metadata":{"system_name":"X"},"requirements":[{"req_name":"통합","sub_packages":[{"sub_name":"가"'
try {
  const rec = extractJson<RawAnalysis>(truncated)
  console.log('[2] 잘린 JSON 복구:', rec.requirements?.[0]?.req_name === '통합' ? 'OK' : 'FAIL')
} catch (e) {
  console.log('[2] 잘린 JSON 복구: FAIL —', (e as Error).message)
}

/* 3. 정규화 */
const project = normalizeToProject(raw, { systemName: raw.metadata!.system_name, projectId: 'EAUCS' })
const ucs = project.packages.flatMap((p) => p.useCases)
console.log('[3] 정규화: 그룹', project.packages.length, '· 패키지', project.packages.length, '· UC', ucs.length, '· 액터', project.actors.length)
console.log('    코드 샘플:', ucs.map((u) => u.code).join(', '))
console.log('    액터 연결:', ucs.map((u) => u.actorUids.length).join('/'), '(0이 있으면 매칭 실패)')

/* 4. 검증 */
const issues = validateProject(project)
console.log('[4] 검증:', issues.filter((i) => i.level === 'error').length, '오류 /', issues.filter((i) => i.level === 'warn').length, '경고')
for (const i of issues) console.log('    -', i.level, i.code, i.message)

/* 5. XMI 생성 (결정성 확인 포함) */
const a = buildXmi(project, { timestamp: '2026-08-14 10:00:00' })
const b = buildXmi(project, { timestamp: '2026-08-14 10:00:00' })
console.log('[5] XMI 결정성(같은 입력 → 같은 GUID):', a.xml === b.xml ? 'OK' : 'FAIL')
console.log('    통계:', JSON.stringify(a.stats))

const xmiPath = join(outDir, 'smoke.xmi')
writeFileSync(xmiPath, Buffer.from(a.xml, 'latin1'))
console.log('    저장:', xmiPath, `(${a.xml.length}자)`)

/* 6. 이스케이프 확인 */
const hasRawAmp = /value="[^"]*&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(a.xml)
const hasRawLt = /value="[^"]*<[^"]*"/.test(a.xml)
const nonAscii = [...a.xml].some((c) => c.codePointAt(0)! > 127)
console.log('[6] 이스케이프: 미처리 & =', hasRawAmp, '/ 미처리 < =', hasRawLt, '/ 비ASCII 잔존 =', nonAscii)

/* 6-1. 빈 요구사항(UCD) + 액터 0명이어도 파일 바이트가 전부 ASCII 인지 — 0x00 이 섞이면 XML 파서가 파일째 거부한다 */
const p0 = project.packages[0]
const bare = {
  ...project,
  actors: [],
  packages: [
    ...project.packages.map((p) => ({ ...p, useCases: p.useCases.map((u) => ({ ...u, actorUids: [] })) })),
    { ...p0, uid: 'smoke-empty', code: 'UCD-SFR-099', reqId: 'SFR-099', name: '빈 요구사항', useCases: [], diagrams: [{ uid: 'smoke-empty-d1', seq: 1, name: '' }] }
  ]
}
const bareBytes = Buffer.from(buildXmi(bare, { timestamp: '2026-08-14 10:00:00' }).xml, 'latin1')
const badBytes = bareBytes.filter((x) => x === 0 || x > 0x7f).length
console.log('[6-1] 빈 UCD·액터 0명 XMI 바이트:', badBytes === 0 ? 'OK' : `FAIL — 0x00·0x80~0xFF ${badBytes}개`)
if (badBytes) process.exitCode = 1

/* 6-2. 액터 0명 금지 — 문서의 역할 낱말로 액터를 만들고 유스케이스마다 하나 이상 붙인다 */
const filled = fillActors(bare, '공단관리자가 공고를 등록하고 민원인은 공고를 조회한다.').project
const lonely = filled.packages.flatMap((p) => p.useCases).filter((u) => !u.actorUids.length).length
const names = filled.actors.map((a) => a.name).join(',')
const fillOk = lonely === 0 && /민원인|공단관리자/.test(names) && filled.actors.every((a) => a.guessed && !a.description)
console.log('[6-2] 액터 0명 금지:', fillOk ? 'OK' : 'FAIL', `— 액터 ${names} / 액터 없는 유스케이스 ${lonely}`)
if (!fillOk) process.exitCode = 1
/* 6-3. 사람이 적은 액터(사전·정의서 `액터 정의` 절)는 추정 표시를 달지 않고, 그게 없을 때 모델이 뽑은 액터는 단다 */
const docActor = { ...filled.actors[0], uid: 'smoke-doc-actor', name: '대국민', guessed: undefined }
const kept = fillActors({ ...bare, actors: [docActor] }, '', true).project
const pulled = fillActors({ ...bare, actors: [docActor] }, '')
const keptOk = kept.actors.length === 1 && !kept.actors[0].guessed && pulled.guessed === 1 && pulled.project.actors[0].guessed === true
console.log('[6-3] 사람이 적은 액터만 추정 표시 없음:', keptOk ? 'OK' : 'FAIL')
if (!keptOk) process.exitCode = 1
/* 6-4. 정의서의 `## 액터 정의` 번호 목록을 코드가 그대로 읽는다 — 모델에게 다시 뽑게 하지 않는다 */
const secActors = readActorSection(readFileSync(join(__dirname, '../examples/요구사항정의서_원문.md'), 'utf8'))
const secNames = secActors.map((a) => a.name).join(',')
const secOk =
  secNames === '시스템관리자,정책담당자(공무원),전문가(연구자/산업계),대국민,연계기관시스템' &&
  secActors[4].kind === 'Secondary' && secActors[0].description.startsWith('플랫폼 전체 관리') &&
  readActorSection(['# 제목', '본문에 액터가 나오는 줄', '일반 문장'].join('\n')).length === 0
console.log('[6-4] 문서 액터 절 읽기:', secOk ? 'OK' : 'FAIL', `— ${secNames}`)
if (!secOk) process.exitCode = 1
/* 6-5. 생성이 뺀 요구사항은 한 건에 한 줄(ID + 정의서 이름, 누르면 원문)로 남고, 같은 ID가 다시 생기면 빠진다 */
const exProj = structuredClone(project)
exProj.metadata.excludedReqs = ['ZZZ-999-01', exProj.packages[0].reqId]
exProj.metadata.reqNames = { 'ZZZ-999-01': '알람 기능 구현' }
const exIssue = validateProject(exProj).filter((i) => i.code === 'REQ_EXCLUDED')
const table = readFileSync(join(__dirname, '../examples/실제정의서_표형식.txt'), 'utf8')
const mdDoc = readFileSync(join(__dirname, '../examples/요구사항정의서_원문.md'), 'utf8')
const exOk = exIssue.length === 1 && exIssue[0].message.startsWith('ZZZ-999-01 알람 기능 구현 — ') &&
  exIssue[0].sourceId === 'ZZZ-999-01' && !validateProject(project).some((i) => i.code === 'REQ_EXCLUDED') &&
  readReqName(table, 'SFR-012-PAD(플랫폼기반)-02') === '메뉴,리소스,사용자 권한 등 서비스 접근제어 기능' &&
  readReqName(mdDoc, 'SFR-009-PAD-02') === '과학-해법-정책 연계 체계 구현' && readReqName(mdDoc, 'ZZZ-999') === ''
console.log('[6-5] 뺀 요구사항 점검 경고:', exOk ? 'OK' : 'FAIL')
if (!exOk) process.exitCode = 1
/* 6-6. 정의서 표의 행 ID를 코드가 센다 — 해석에서 빠진 행은 따로 점검 경고 */
const stdIds = readStandardIds(readFileSync(join(__dirname, '..', 'examples', '실제정의서_표형식.txt'), 'utf-8'))
const msProj = structuredClone(project)
msProj.metadata.missedReqs = ['ZZZ-998-01']
const msIssue = validateProject(msProj).filter((i) => i.code === 'REQ_MISSED')
const msOk = stdIds.length === 11 && stdIds.includes('SFR-002-PAD(플랫폼기반)-04') &&
  readStandardIds('요구사항 목록\nSFR-001 이름').length === 0 &&
  msIssue.length === 1 && msIssue[0].message.includes('ZZZ-998-01')
console.log('[6-6] 해석에서 빠진 행 세기:', msOk ? 'OK' : 'FAIL', `— 표 행 ${stdIds.length}개`)
if (!msOk) process.exitCode = 1
/* 6-7. 빠진 행을 손으로 다시 넣으면 패키지 = 앞부분, 다이어그램 번호 = 끝 번호 — 그것도 넣은 것으로 센다 */
const rdProj = structuredClone(msProj)
const rowId = 'SFR-002-PAD(플랫폼기반)-04'
rdProj.metadata.missedReqs = [rowId]
const rd = splitSubNo(rowId)
rdProj.packages[0] = { ...rdProj.packages[0], reqId: rd.base, code: packageCode(rd.base), diagrams: [{ ...rdProj.packages[0].diagrams[0], seq: rd.sub }] }
const rdOk = rdProj.packages[0].code === 'UCD-SFR-002-PAD(플랫폼기반)' && rd.sub === 4 &&
  !validateProject(rdProj).some((i) => i.code === 'REQ_MISSED')
console.log('[6-7] 다시 넣은 행은 다이어그램 번호로 셈:', rdOk ? 'OK' : 'FAIL')
if (!rdOk) process.exitCode = 1

/* 6-8. 생성된 다이어그램(패키지 = 앞부분, 유스케이스 = 행 ID)에 더한 유스케이스는 그 행 ID를 물려받고, 재채번도 같은 꼴 */
const adProj = structuredClone(project)
const adPkg = adProj.packages[0]
const adBase = 'SFR-003-PAD(플랫폼기반)'
const d1 = { ...adPkg.diagrams[0], uid: 'd1', seq: 1 }
const d3 = { ...adPkg.diagrams[0], uid: 'd3', seq: 3 }
const ucOf = (uid: string, reqId: string, dg: string, i: number) =>
  ({ ...adPkg.useCases[0], uid, reqId, diagramUid: dg, code: useCaseCode(reqId, i) })
adPkg.reqId = adBase
adPkg.diagrams = [d1, d3]
adPkg.useCases = [ucOf('a', `${adBase}-01`, 'd1', 0), ucOf('b', `${adBase}-01`, 'd1', 1), ucOf('c', `${adBase}-01`, 'd1', 2), ucOf('e', `${adBase}-03`, 'd3', 0),
  ucOf('old', adBase, 'd3', 0)] // 예전 + 유스케이스 (패키지 reqId를 물려받음)
adProj.packages = [adPkg]
const adRn = renumber(adProj, { renumberUseCases: true }).packages[0].useCases
const adOk = diagramReqId(adPkg, 'd1') === `${adBase}-01` && diagramReqId(adPkg, 'd3') === `${adBase}-03` &&
  adRn.find((u) => u.uid === 'old')?.code === `UC-${adBase}-03-02` && adRn.find((u) => u.uid === 'c')?.code === `UC-${adBase}-01-03`
console.log('[6-8] 더한 유스케이스는 다이어그램 행 ID:', adOk ? 'OK' : 'FAIL', `— 재채번 ${adRn.map((u) => u.code.slice(-5)).join(' ')}`)
if (!adOk) process.exitCode = 1

/* 6-9. 추정한 액터는 점검 경고에 이름과 함께, 표시가 꺼지면 경고도 없음 */
const gsProj = structuredClone(project)
gsProj.actors[0].guessed = true
const gsIssue = validateProject(gsProj).filter((i) => i.code === 'ACTOR_GUESSED')
const gsOk = gsIssue.length === 1 && gsIssue[0].message.includes(gsProj.actors[0].name) &&
  !validateProject(project).some((i) => i.code === 'ACTOR_GUESSED')
console.log('[6-9] 추정 액터 점검 경고:', gsOk ? 'OK' : 'FAIL', `— ${gsIssue[0]?.message ?? '없음'}`)
if (!gsOk) process.exitCode = 1

/* 6-10. 시스템 처리로 뺀 항목은 점검 경고에 수와 함께, 누르면 그 다이어그램 */
const siProj = structuredClone(project)
const siDgm = siProj.packages[0].diagrams[0]
siDgm.systemItems = ['데이터 추출', '백업']
const siIssue = validateProject(siProj).filter((i) => i.code === 'SYSTEM_ITEMS')
const siOk = siIssue.length === 1 && siIssue[0].message.includes('2건') && siIssue[0].target?.diagramUid === siDgm.uid &&
  !validateProject(project).some((i) => i.code === 'SYSTEM_ITEMS')
console.log('[6-10] 시스템 처리 항목 점검 경고:', siOk ? 'OK' : 'FAIL', `— ${siIssue[0]?.message ?? '없음'}`)
if (!siOk) process.exitCode = 1

/* 6-11. 이름이 꼬리말뿐이면 trimTail은 '' (생성이 요구사항명으로 채움), 후보 이름은 글 그대로 */
const ttOk = trimTail('기능 구현') === '' && trimTail('사용자 관리 기능') === '사용자 관리' &&
  itemUseCase('R-1', '기능 구현').name === '기능 구현'
console.log('[6-11] 꼬리말뿐인 이름:', ttOk ? 'OK' : 'FAIL')
if (!ttOk) process.exitCode = 1

/* 6-12. 요구사항명에서 온 앞머리의 꼬리말만 뗀다 */
const htOk = trimHeadTail('데이터 수집 기능 모니터링', '내·외부 데이터 수집 기능 설계') === '데이터 수집 모니터링' &&
  trimHeadTail('검색 기능 및 현황판', '통합플랫폼 운영 관리') === '검색 기능 및 현황판' &&
  trimHeadTail('사용자 관리 기능', '사용자 관리 기능') === '사용자 관리 기능'
console.log('[6-12] 요구사항명 앞머리 꼬리말:', htOk ? 'OK' : 'FAIL')
if (!htOk) process.exitCode = 1

/* 6-13. 모델이 지어낸 유스케이스(invented)는 프로젝트까지 표시가 가고, 점검 경고에 이름과 함께, 누르면 그 유스케이스 */
const ivRaw = structuredClone(raw)
const ivRawUc = ivRaw.requirements![0].usecases![0]
ivRawUc.invented = true
const ivProj = normalizeToProject(ivRaw, { systemName: 'S', projectId: 'EAUCS' })
const ivUcs = ivProj.packages.flatMap((p) => p.useCases)
const ivUc = ivUcs.find((u) => u.name === ivRawUc.name)
const ivIssue = validateProject(ivProj).filter((i) => i.code === 'UC_INVENTED')
const ivOk = !!ivUc?.invented && ivUcs.filter((u) => 'invented' in u).length === 1 &&
  ivIssue.length === 1 && ivIssue[0].target?.useCaseUid === ivUc.uid && ivIssue[0].message.includes(ivUc.name) &&
  !validateProject(project).some((i) => i.code === 'UC_INVENTED') && !buildXmi(ivProj).xml.includes('invented')
console.log('[6-13] LLM 추가 유스케이스 점검 경고:', ivOk ? 'OK' : 'FAIL', `— ${ivIssue[0]?.message ?? '없음'}`)
if (!ivOk) process.exitCode = 1

/* 6-14. 상세 내용 항목(sources)은 프로젝트까지 가고, 그 유스케이스를 지우면 점검이 빠진 항목을 센다 */
const srRaw = structuredClone(raw)
const srRawUc = srRaw.requirements![0].usecases![0]
srRawUc.sources = ['회원 목록 조회 / ● 검색']
const srProj = normalizeToProject(srRaw, { systemName: 'S', projectId: 'EAUCS' })
const srPkg = srProj.packages.find((p) => p.useCases.some((u) => u.sources))!
const srUc = srPkg.useCases.find((u) => u.sources)!
const srDgm = srPkg.diagrams.find((d) => d.uid === srUc.diagramUid)!
srDgm.items = ['회원 목록 조회 / ● 검색']
const srBefore = validateProject(srProj).filter((i) => i.code === 'ITEMS_UNCOVERED').length
srPkg.useCases = srPkg.useCases.filter((u) => u !== srUc)
const srIssue = validateProject(srProj).filter((i) => i.code === 'ITEMS_UNCOVERED')
const srOk = srBefore === 0 && srIssue.length === 1 && srIssue[0].target?.diagramUid === srDgm.uid &&
  srIssue[0].message.includes('1항목 중 1항목') && srIssue[0].message.includes('『회원 목록 조회 · 검색』') &&
  !buildXmi(srProj).xml.includes('회원 목록 조회 / ') &&
  // 다이어그램 폼 되살리기 = 생성과 같은 이름 + 그 항목을 sources로 → 경고가 사라진다
  itemName(srDgm.items[0]) === itemUseCase('R-1', srDgm.items[0]).name &&
  // 머리말이 묶음 제목이면(같은 행 두 항목이 같은 머리말) 둘째 토막이 이름 — 같은 이름 둘이 생기지 않게
  itemName('묶음 제목 / ● (수집)외부 데이터 연계 기능', ['묶음 제목 / ● (수집)외부 데이터 연계 기능', '묶음 제목 / ● 분석 지원']) === '외부 데이터 연계' &&
  (srPkg.useCases.push({ ...srUc, name: itemName(srDgm.items[0]), sources: [srDgm.items[0]] }),
  validateProject(srProj).every((i) => i.code !== 'ITEMS_UNCOVERED'))
console.log('[6-14] 유스케이스에 없는 상세 내용 항목:', srOk ? 'OK' : 'FAIL', `— ${srIssue[0]?.message ?? '없음'}`)
if (!srOk) process.exitCode = 1

/* 7. PlantUML */
const puml = toPlantUml(project)
writeFileSync(join(outDir, 'smoke.puml'), puml, 'utf-8')
console.log('[7] PlantUML:', puml.split('\n').length, '줄 저장')
