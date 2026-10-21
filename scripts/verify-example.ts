/**
 * 예시 검증 — 생성한 엑셀을 앱과 똑같은 경로(readWorkbook → 자동매핑 → compose)로
 * 되읽어, 가져오기 탭이 실제로 동작하는지 확인한다.
 */
import { readWorkbook } from '../src/main/core/excel'
import {
  COLUMN_HINTS,
  SHEET_HINTS,
  composeRequirementText,
  guessColumn,
  guessSheet
} from '../src/shared/compose'
import { ACTOR_FIELDS, DETAIL_FIELDS, OUTLINE_FIELDS } from '../src/shared/constants'
import type { BlockMapping, ImportMapping, WorkbookData } from '../src/shared/types'

function autoMap(wb: WorkbookData): ImportMapping {
  const build = (sheetName: string | null, fields: readonly string[]): BlockMapping => {
    const s = wb.sheets.find((x) => x.name === sheetName)
    const columns: Record<string, number | null> = {}
    if (s) for (const f of fields) columns[f] = guessColumn(s.headers, COLUMN_HINTS[f] ?? [f])
    return { sheetName: s ? s.name : null, columns }
  }
  return {
    outline: build(guessSheet(wb.sheets, SHEET_HINTS.outline) ?? wb.sheets[0]?.name ?? null, OUTLINE_FIELDS),
    actors: build(guessSheet(wb.sheets, SHEET_HINTS.actors), ACTOR_FIELDS),
    detail: build(guessSheet(wb.sheets, SHEET_HINTS.detail), DETAIL_FIELDS)
  }
}

async function main(): Promise<void> {
  const wb = await readWorkbook(process.argv[2])
  console.log('시트:', wb.sheets.map((s) => `${s.name}(${s.rows.length}행)`).join(', '))
  for (const s of wb.sheets) console.log(`  [${s.name}] 헤더 자동탐지 →`, s.headers.join(' | '))

  const mapping = autoMap(wb)
  console.log('\n자동 매핑 결과')
  for (const [block, m] of Object.entries(mapping)) {
    const cols = Object.entries(m.columns)
      .map(([k, v]) => `${k}=${v === null ? '×' : v}`)
      .join(' ')
    console.log(`  ${block.padEnd(8)} 시트=${m.sheetName ?? '(없음)'}  ${cols}`)
  }

  const text = composeRequirementText(wb, mapping)
  const lines = text.split('\n')
  console.log(`\n조립된 LLM 입력 ${text.length}자 / ${lines.length}줄`)
  console.log('--- 앞 8줄 ---')
  console.log(lines.slice(0, 8).join('\n'))

  // 빈 셀 상속(forwardFill)이 동작했는지: 모형기술서 본문에 빈 1depth가 없어야 한다
  const outlineBody = lines.slice(2, lines.indexOf('') === -1 ? undefined : lines.indexOf(''))
  const blanks = outlineBody.filter((l) => l.startsWith('|')).length
  console.log(`\n빈 셀 상속: 1depth 누락 ${blanks}건 ${blanks === 0 ? '→ OK' : '→ FAIL'}`)

  const hasActors = text.includes('[액터정의]')
  const hasDetail = text.includes('[요구사항 상세]')
  console.log(`블록 인식: 액터정의=${hasActors ? 'OK' : 'FAIL'} / 요구사항상세=${hasDetail ? 'OK' : 'FAIL'}`)
}

void main()
