/**
 * 예시 산출물 생성기 — `npm run example`
 *
 * examples/ 에 다음을 만든다.
 *   1. 요구사항정의서_예시.xlsx   가져오기 탭 엑셀 매핑 실습용 (시트 3개)
 *   2. 요구사항_예시.txt          가져오기 탭 텍스트 붙여넣기용 (LLM 입력 형식)
 *   3. LLM응답_예시.json          "JSON 직접 입력" 탭용 (LLM 없이 바로 변환)
 *   4. 예시.eaucs             완성된 프로젝트 파일 — 앱에서 [열기]로 바로 확인
 *   5. 예시.xmi               EA 임포트용 최종 산출물
 *   6. 예시.puml              PlantUML 텍스트
 */
import ExcelJS from 'exceljs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RawAnalysis, RawRequirement, RawSubPackage } from '../src/shared/types'
import { normalizeToProject } from '../src/main/core/normalize'
import { buildXmi } from '../src/main/core/xmi'
import { toPlantUml } from '../src/main/core/plantuml'
import { teamLabel } from '../src/shared/idrules'
import { validateProject } from '../src/main/core/validate'
import { ACTORS, ROWS } from './example-data'

const outDir = process.argv[2] ?? 'examples'

/* ------------------------------------------------------------------ */
/* 1. 엑셀 (시트 3개)                                                   */
/* ------------------------------------------------------------------ */

async function writeExcel(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'EA UseCase Studio'

  // --- 모형기술서: 위에 제목 행을 일부러 넣어 헤더 자동탐지를 검증한다 ---
  const s1 = wb.addWorksheet('모형기술서')
  s1.addRow(['예시 시스템 기능 모형기술서'])
  s1.addRow([])
  s1.addRow(['1depth', '2depth', '요구사항ID', '요구사항명'])
  let prevD1 = ''
  let prevD2 = ''
  for (const r of ROWS) {
    // 실제 산출물처럼 같은 값이 반복되면 빈 셀로 둔다 (forwardFill 검증)
    s1.addRow([r.d1 === prevD1 ? '' : r.d1, r.d2 === prevD2 ? '' : r.d2, r.reqId, r.reqName])
    prevD1 = r.d1
    prevD2 = r.d2
  }
  s1.columns = [{ width: 14 }, { width: 20 }, { width: 30 }, { width: 60 }]

  // --- 액터정의 ---
  const s2 = wb.addWorksheet('액터정의')
  s2.addRow(['구분', '액터명', '설명', '비고'])
  for (const a of ACTORS) s2.addRow([a.kind, a.name, a.description, a.note])
  s2.columns = [{ width: 12 }, { width: 18 }, { width: 60 }, { width: 10 }]

  // --- 요구사항상세 ---
  const s3 = wb.addWorksheet('요구사항상세')
  s3.addRow(['요구사항ID', '우선순위', '난이도', '설명', '주 흐름', '사전조건', '사후조건'])
  for (const r of ROWS) {
    const u = r.ucs[0]
    s3.addRow([r.reqId, u.priority, u.difficulty, u.description, u.mainFlow, u.precondition, u.postcondition])
  }
  s3.columns = [
    { width: 30 },
    { width: 10 },
    { width: 8 },
    { width: 50 },
    { width: 60 },
    { width: 28 },
    { width: 24 }
  ]

  for (const ws of [s1, s2, s3]) {
    const headerRow = ws === s1 ? 3 : 1
    ws.getRow(headerRow).font = { bold: true }
    ws.getRow(headerRow).alignment = { vertical: 'middle' }
  }

  await wb.xlsx.writeFile(path)
}

/* ------------------------------------------------------------------ */
/* 2. LLM 입력 텍스트                                                   */
/* ------------------------------------------------------------------ */

function buildRequirementText(): string {
  const outline = ['[모형기술서]', '1depth|2depth|요구사항ID|요구사항명']
  for (const r of ROWS) outline.push(`${r.d1}|${r.d2}|${r.reqId}|${r.reqName}`)

  const actors = ['[액터정의]', '구분|액터명|설명|비고']
  for (const a of ACTORS) actors.push(`${a.kind}|${a.name}|${a.description}|${a.note}`)

  const detail = ['[요구사항 상세]']
  for (const r of ROWS) {
    const u = r.ucs[0]
    detail.push(
      [
        r.reqId,
        `priority:${u.priority}`,
        `difficulty:${u.difficulty}`,
        `description:${u.description}`,
        `main_flow:${u.mainFlow.replace(/\n/g, '\\n')}`,
        `precondition:${u.precondition}`,
        `postcondition:${u.postcondition}`
      ].join('|')
    )
  }
  return [outline.join('\n'), actors.join('\n'), detail.join('\n')].join('\n\n')
}

/* ------------------------------------------------------------------ */
/* 3. LLM 응답 형태의 원시 JSON                                         */
/* ------------------------------------------------------------------ */

function buildRawAnalysis(): RawAnalysis {
  /*
   * 요구사항 1건 = UCD 패키지 1개.
   * 정의서의 1depth/2depth 는 텍스트 예시(요구사항_예시.txt)에는 그대로 남지만
   * 모델 구조에는 쓰지 않는다 — 표준 EA 산출물에 그 계층이 없다.
   * 2depth 는 요구사항명이 비어 있을 때 이름 대용으로만 빌려 쓴다.
   */
  const requirements: RawRequirement[] = ROWS.map((r) => ({
    req_id: r.reqId,
    req_name: r.reqName || r.d2,
    work_type: 'PAD',
    usecases: r.ucs.map((u) => ({
      name: u.name,
      priority: u.priority,
      difficulty: u.difficulty,
      description: u.description,
      main_flow: u.mainFlow,
      alt_flow: u.altFlow ?? '',
      precondition: u.precondition,
      postcondition: u.postcondition,
      actors: u.actors
    }))
  }))

  return {
    metadata: { system_name: '예시 시스템', project_id: 'EAUCS' },
    requirements,
    actors: ACTORS.map((a) => ({ name: a.name, description: a.description, kind: a.kind }))
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const xlsxPath = join(outDir, '요구사항정의서_예시.xlsx')
  await writeExcel(xlsxPath)
  console.log('✓ 엑셀        ', xlsxPath)

  const reqText = buildRequirementText()
  writeFileSync(join(outDir, '요구사항_예시.txt'), reqText, 'utf-8')
  console.log('✓ 텍스트      ', join(outDir, '요구사항_예시.txt'), `(${reqText.length}자)`)

  const raw = buildRawAnalysis()
  writeFileSync(join(outDir, 'LLM응답_예시.json'), JSON.stringify(raw, null, 2), 'utf-8')
  console.log('✓ 원시 JSON   ', join(outDir, 'LLM응답_예시.json'))

  const project = normalizeToProject(raw, {
    systemName: '예시 시스템',
    projectId: 'EAUCS',
    author: 'EA UseCase Studio 예시'
  })

  // 예시니까 include 관계도 하나 걸어둔다: "수집 데이터 표준화" → "정합성 검증 수행"
  const all = project.packages.flatMap((p) => p.useCases)
  const from = all.find((u) => u.name === '수집 데이터 표준화')
  const to = all.find((u) => u.name === '정합성 검증 수행')
  if (from && to) from.includeUids = [to.uid]

  const eaucsPath = join(outDir, '예시.eaucs')
  writeFileSync(eaucsPath, JSON.stringify(project, null, 2), 'utf-8')
  console.log('✓ 프로젝트    ', eaucsPath)

  const issues = validateProject(project)
  const err = issues.filter((i) => i.level === 'error').length
  const warn = issues.filter((i) => i.level === 'warn').length
  console.log(`  검증: 오류 ${err} / 경고 ${warn} / 정보 ${issues.length - err - warn}`)
  for (const i of issues.filter((x) => x.level !== 'info')) console.log('   -', i.level, i.message)

  const { xml, stats } = buildXmi(project, { timestamp: '2026-08-18 09:00:00' })
  const xmiPath = join(outDir, '예시.xmi')
  writeFileSync(xmiPath, Buffer.from(xml, 'latin1'))
  console.log('✓ XMI         ', xmiPath, `(${(xml.length / 1024).toFixed(1)} KB)`)
  console.log('  통계:', JSON.stringify(stats))

  const pumlPath = join(outDir, '예시.puml')
  writeFileSync(pumlPath, toPlantUml(project), 'utf-8')
  console.log('✓ PlantUML    ', pumlPath)

  console.log('\n트리 구조 미리보기')
  for (const p of project.packages) {
    console.log(`  ${p.code}  ${p.name}  [${teamLabel(p.team)}/${p.color}]`)
    for (const d of p.diagrams) {
      console.log(`    -${String(d.seq).padStart(2, '0')}  ${d.name || '(자동 이름)'}`)
      for (const u of p.useCases.filter((x) => x.diagramUid === d.uid)) {
        console.log(`      ${u.code}  ${u.name}`)
      }
    }
  }
}

void main()
