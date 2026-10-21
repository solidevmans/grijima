/**
 * E2E — 예시 요구사항정의서(.xlsx) 하나로 EA XMI까지 만든다.
 *
 * 앱의 "가져오기 탭" 이 하는 일을 **같은 함수들로** 그대로 재현한다.
 *   엑셀 읽기 → 시트/컬럼 자동매핑 → LLM 입력 조립 → generateProject() → 검증 → XMI
 * generateProject 는 IPC 핸들러가 부르는 바로 그 함수다.
 *
 *   node out/run-e2e-excel.cjs [xlsx경로] [모델명] [출력디렉터리]
 *   EAUCS_ACTORS=<파일> 이면 그 파일(한 줄에 한 명, `이름: 하는 일`)을 액터 사전으로 준다 (텍스트 입력만)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readWorkbook } from '../src/main/core/excel'
import { generateProject } from '../src/main/core/generate'
import { buildXmi } from '../src/main/core/xmi'
import { toPlantUml } from '../src/main/core/plantuml'
import { validateProject } from '../src/main/core/validate'
import { teamLabel } from '../src/shared/idrules'
import {
  COLUMN_HINTS,
  SHEET_HINTS,
  composeRequirementText,
  guessColumn,
  guessSheet
} from '../src/shared/compose'
import { ACTOR_FIELDS, DEFAULT_SETTINGS, DETAIL_FIELDS, OUTLINE_FIELDS } from '../src/shared/constants'
import type { AppSettings, BlockMapping, ImportMapping, WorkbookData } from '../src/shared/types'

const NL = String.fromCharCode(10)

const xlsxPath = process.argv[2] ?? 'examples/요구사항정의서_예시.xlsx'
const model = process.argv[3] ?? 'qwen2.5:3b'
const outDir = process.argv[4] ?? 'out'

/** 가져오기 탭의 autoMap 과 동일 */
function autoMap(wb: WorkbookData): ImportMapping {
  const build = (sheetName: string | null, fields: readonly string[]): BlockMapping => {
    const s = wb.sheets.find((x) => x.name === sheetName)
    const columns: Record<string, number | null> = {}
    if (s) for (const f of fields) columns[f] = guessColumn(s.headers, COLUMN_HINTS[f] ?? [f])
    return { sheetName: s ? s.name : null, columns }
  }
  return {
    outline: build(
      guessSheet(wb.sheets, SHEET_HINTS.outline) ?? wb.sheets[0]?.name ?? null,
      OUTLINE_FIELDS
    ),
    actors: build(guessSheet(wb.sheets, SHEET_HINTS.actors), ACTOR_FIELDS),
    detail: build(guessSheet(wb.sheets, SHEET_HINTS.detail), DETAIL_FIELDS)
  }
}

async function main(): Promise<void> {
  const bar = '='.repeat(64)

  // .md / .txt 면 서술형 텍스트 경로로
  if (/\.(md|txt)$/i.test(xlsxPath)) return runText()

  console.log(bar)
  console.log('1단계  엑셀 읽기')
  console.log(bar)
  const wb = await readWorkbook(xlsxPath)
  console.log(`파일: ${xlsxPath}`)
  for (const s of wb.sheets) {
    console.log(`  시트 [${s.name}]  ${s.rows.length}행 · 헤더: ${s.headers.join(' | ')}`)
  }

  console.log('\n' + bar)
  console.log('2단계  시트·컬럼 자동 매핑')
  console.log(bar)
  const mapping = autoMap(wb)
  for (const [block, m] of Object.entries(mapping)) {
    const cols = Object.entries(m.columns)
      .map(([k, v]) => `${k}=${v === null ? '×' : v}`)
      .join(' ')
    console.log(`  ${block.padEnd(8)} 시트=${m.sheetName ?? '(없음)'}  ${cols}`)
  }

  const text = composeRequirementText(wb, mapping)
  console.log(`\n조립된 LLM 입력: ${text.length}자`)

  console.log('\n' + bar)
  console.log('3단계  유스케이스 생성 (앱과 동일한 generateProject)')
  console.log(bar)

  const settings: AppSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    activeProvider: 'embedded',
    generationStrategy: 'auto'
  }
  settings.providers.embedded = {
    ...settings.providers.embedded,
  modelPath: process.env.EAUCS_GGUF ?? '',
    numCtx: 8192,
    maxTokens: 1024
  }
  console.log(`프로바이더: ${settings.activeProvider} / ${model} · 전략: ${settings.generationStrategy}\n`)

  const t0 = Date.now()
  let lastIdx = 0
  const result = await generateProject({
    requirementText: text,
    systemName: '예시 시스템',
    projectId: 'EAUCS',
    author: 'E2E 테스트',
    settings,
    onProgress: (p) => {
      if (p.index !== lastIdx) {
        lastIdx = p.index
        process.stdout.write(`  [${String(p.index).padStart(2)}/${p.total}] ${p.label.slice(0, 40)}\n`)
      }
    }
  })
  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n${result.calls}회 호출 · ${sec}초 · 전략 ${result.strategy}`)
  if (result.warnings.length) {
    console.log(`대체 처리 ${result.warnings.length}건:`)
    for (const w of result.warnings) console.log('  - ' + w)
  }

  console.log('\n' + bar)
  console.log('4단계  생성된 트리')
  console.log(bar)
  const p = result.project
  for (const pkg of p.packages) {
    {
      console.log(`
${pkg.code}  ${pkg.name}   [${teamLabel(pkg.team)}]`)
      for (const uc of pkg.useCases) {
        const actors = uc.actorUids
          .map((a) => p.actors.find((x) => x.uid === a)?.name)
          .filter(Boolean)
          .join(', ')
        console.log(`     ${uc.code}  ${uc.name}  [${uc.priority}/${uc.difficulty}]  ← ${actors || '(액터 없음)'}`)
        const first = uc.mainFlow.split(String.fromCharCode(10))[0]
        if (first) console.log(`        흐름: ${first} …`)
      }
    }
  }
  console.log('\n액터:')
  for (const a of p.actors) console.log(`  ${a.kind === 'Secondary' ? '🛰' : '🙋'} ${a.name} — ${a.description.slice(0, 40)}`)

  console.log('\n' + bar)
  console.log('5단계  검증')
  console.log(bar)
  const issues = validateProject(p)
  const err = issues.filter((i) => i.level === 'error')
  const warn = issues.filter((i) => i.level === 'warn')
  const info = issues.filter((i) => i.level === 'info')
  console.log(`오류 ${err.length} / 경고 ${warn.length} / 정보 ${info.length}`)
  for (const i of [...err, ...warn].slice(0, 8)) console.log(`  ${i.level}  ${i.message}`)

  console.log('\n' + bar)
  console.log('6단계  XMI 내보내기')
  console.log(bar)
  const { xml, stats } = buildXmi(p)
  console.log(JSON.stringify(stats))
  const nonAscii = [...xml].some((c) => (c.codePointAt(0) as number) > 127)
  console.log(`크기 ${(xml.length / 1024).toFixed(1)} KB · 비ASCII 잔존 ${nonAscii}`)

  const base = join(outDir, 'e2e-excel')
  writeFileSync(base + '.eaucs', JSON.stringify(p, null, 2), 'utf-8')
  writeFileSync(base + '.xmi', Buffer.from(xml, 'latin1'))
  writeFileSync(base + '.puml', toPlantUml(p), 'utf-8')
  writeFileSync(base + '-raw.txt', result.rawText, 'utf-8')
  console.log(`\n저장: ${base}.eaucs / .xmi / .puml / -raw.txt`)

  if (err.length) process.exitCode = 1
}

async function runText(): Promise<void> {
  const bar = '='.repeat(64)
  const { readFileSync } = await import('node:fs')
  console.log(bar)
  console.log('1단계  문서 투입 (해석은 AI가 한다)')
  console.log(bar)
  const raw = readFileSync(xlsxPath, 'utf-8')
  console.log(`파일: ${xlsxPath} (${raw.length}자)`)
  await generateAndReport(raw, '', 'EAUCS', 'e2e-text')
}


async function generateAndReport(
  text: string,
  systemName: string,
  projectId: string,
  outName: string
): Promise<void> {
  const bar = '='.repeat(64)
  const settings: AppSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    activeProvider: 'embedded',
    generationStrategy: 'auto'
  }
  settings.providers.embedded = {
    ...settings.providers.embedded,
    numCtx: 8192,
    maxTokens: 1024
  }

  console.log(NL + bar)
  console.log('2단계  유스케이스 생성 (앱과 동일한 generateProject)')
  console.log(bar)
  console.log(`${settings.activeProvider} / ${model} · ${settings.generationStrategy}
`)

  const t0 = Date.now()
  let last = 0
  const result = await generateProject({
    requirementText: text,
    systemName,
    projectId,
    author: 'E2E',
    actors: process.env.EAUCS_ACTORS ? readFileSync(process.env.EAUCS_ACTORS, 'utf-8').split(NL) : undefined,
    settings,
    onProgress: (p) => {
      if (p.index !== last) {
        last = p.index
        process.stdout.write(`  [${String(p.index).padStart(2)}/${p.total}] ${p.label.slice(0, 42)}
`)
      }
    }
  })
  console.log(`
${result.calls}회 호출 · ${((Date.now() - t0) / 1000).toFixed(1)}초`)
  if (result.warnings.length) for (const w of result.warnings) console.log('  ⚠ ' + w)

  const p = result.project
  console.log(NL + bar)
  console.log('3단계  생성된 트리')
  console.log(bar)
  for (const pkg of p.packages) {
    {
      console.log(`
${pkg.code}  ${pkg.name}`)
      for (const uc of pkg.useCases) {
        const acts = uc.actorUids
          .map((a) => p.actors.find((x) => x.uid === a)?.name)
          .filter(Boolean)
          .join(', ')
        console.log(`     ${uc.code}  ${uc.name}  [${uc.priority}/${uc.difficulty}]  ← ${acts || '(없음)'}`)
      }
    }
  }

  console.log(NL + bar)
  console.log('4단계  검증 → XMI')
  console.log(bar)
  const issues = validateProject(p)
  const err = issues.filter((i) => i.level === 'error')
  console.log(`오류 ${err.length} / 경고 ${issues.filter((i) => i.level === 'warn').length}`)
  for (const i of err.slice(0, 5)) console.log('  ' + i.message)

  const { xml, stats } = buildXmi(p)
  console.log(JSON.stringify(stats))
  console.log(`XMI ${(xml.length / 1024).toFixed(1)} KB · 비ASCII 잔존 ${[...xml].some((c) => (c.codePointAt(0) as number) > 127)}`)

  const base = join(outDir, outName)
  writeFileSync(base + '.eaucs', JSON.stringify(p, null, 2), 'utf-8')
  writeFileSync(base + '.xmi', Buffer.from(xml, 'latin1'))
  console.log(`
저장: ${base}.eaucs / .xmi`)
  if (err.length) process.exitCode = 1
}

void main()
