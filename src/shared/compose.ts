import type { BlockMapping, ImportMapping, SheetData, WorkbookData } from './types'

const cell = (row: string[], idx: number | null | undefined): string =>
  idx === null || idx === undefined ? '' : (row[idx] ?? '').toString().trim()

function sheetOf(wb: WorkbookData, name: string | null): SheetData | null {
  if (!name) return null
  return wb.sheets.find((s) => s.name === name) ?? null
}

/** 병합셀/빈칸을 위 값으로 상속(forward fill) */
function forwardFill(values: string[]): string[] {
  const out: string[] = []
  let last = ''
  for (const v of values) {
    if (v) last = v
    out.push(last)
  }
  return out
}

function isBlankRow(row: string[], mapping: BlockMapping): boolean {
  return Object.values(mapping.columns).every((idx) => !cell(row, idx))
}

/** [모형기술서] 블록 */
export function composeOutlineBlock(wb: WorkbookData, mapping: BlockMapping): string {
  const sheet = sheetOf(wb, mapping.sheetName)
  if (!sheet) return ''
  const rows = sheet.rows.filter((r) => !isBlankRow(r, mapping))
  const d1 = forwardFill(rows.map((r) => cell(r, mapping.columns.depth1)))
  const d2 = forwardFill(rows.map((r) => cell(r, mapping.columns.depth2)))
  const lines = rows
    .map((r, i) => {
      const reqId = cell(r, mapping.columns.reqId)
      const reqName = cell(r, mapping.columns.reqName)
      if (!reqId && !reqName) return null
      return `${d1[i]}|${d2[i]}|${reqId}|${reqName}`
    })
    .filter((x): x is string => x !== null)
  if (!lines.length) return ''
  return ['[모형기술서]', '1depth|2depth|요구사항ID|요구사항명', ...lines].join('\n')
}

/** [액터정의] 블록 */
export function composeActorBlock(wb: WorkbookData, mapping: BlockMapping): string {
  const sheet = sheetOf(wb, mapping.sheetName)
  if (!sheet) return ''
  const lines = sheet.rows
    .filter((r) => !isBlankRow(r, mapping))
    .map((r) =>
      [
        cell(r, mapping.columns.kind) || 'Primary',
        cell(r, mapping.columns.name),
        cell(r, mapping.columns.description),
        cell(r, mapping.columns.note)
      ].join('|')
    )
    .filter((l) => l.split('|')[1])
  if (!lines.length) return ''
  return ['[액터정의]', '구분|액터명|설명|비고', ...lines].join('\n')
}

/** [요구사항 상세] 블록 */
export function composeDetailBlock(wb: WorkbookData, mapping: BlockMapping): string {
  const sheet = sheetOf(wb, mapping.sheetName)
  if (!sheet) return ''
  const lines = sheet.rows
    .filter((r) => !isBlankRow(r, mapping))
    .map((r) => {
      const reqId = cell(r, mapping.columns.reqId)
      if (!reqId) return null
      const parts = [reqId]
      const push = (key: string, idx: number | null | undefined): void => {
        const v = cell(r, idx)
        if (v) parts.push(`${key}:${v.replace(/\r?\n/g, '\\n')}`)
      }
      push('priority', mapping.columns.priority)
      push('difficulty', mapping.columns.difficulty)
      push('description', mapping.columns.description)
      push('main_flow', mapping.columns.mainFlow)
      push('alt_flow', mapping.columns.altFlow)
      push('precondition', mapping.columns.precondition)
      push('postcondition', mapping.columns.postcondition)
      return parts.join('|')
    })
    .filter((x): x is string => x !== null)
  if (!lines.length) return ''
  return ['[요구사항 상세]', ...lines].join('\n')
}

/** 매핑된 엑셀 → LLM 입력 텍스트 전체 */
export function composeRequirementText(wb: WorkbookData, mapping: ImportMapping): string {
  return [
    composeOutlineBlock(wb, mapping.outline),
    composeActorBlock(wb, mapping.actors),
    composeDetailBlock(wb, mapping.detail)
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 헤더 이름으로 컬럼 인덱스 자동 추론 */
export function guessColumn(headers: string[], keywords: string[]): number | null {
  const norm = (s: string): string => s.replace(/\s|_|-/g, '').toLowerCase()
  const H = headers.map(norm)
  for (const kw of keywords) {
    const k = norm(kw)
    const exact = H.findIndex((h) => h === k)
    if (exact >= 0) return exact
  }
  for (const kw of keywords) {
    const k = norm(kw)
    const partial = H.findIndex((h) => h.includes(k))
    if (partial >= 0) return partial
  }
  return null
}

export const COLUMN_HINTS: Record<string, string[]> = {
  depth1: ['1depth', '대분류', '분류1', '업무대분류', 'level1'],
  depth2: ['2depth', '중분류', '분류2', '업무중분류', 'level2'],
  reqId: ['요구사항ID', '요구사항고유번호', 'reqid', '고유번호', 'ID'],
  reqName: ['요구사항명', '요구사항이름', 'reqname', '기능명'],
  kind: ['구분', '액터구분', 'type', 'kind'],
  name: ['액터명', '액터', 'actor', '이름', 'name'],
  description: ['설명', '내용', '정의', 'description', '요구사항내용'],
  note: ['비고', '기타', 'note', 'remark'],
  priority: ['우선순위', 'priority', '중요도'],
  difficulty: ['난이도', 'difficulty'],
  mainFlow: ['주흐름', '기본흐름', 'mainflow', '처리절차', '수행방안'],
  altFlow: ['대안흐름', '예외흐름', 'altflow'],
  precondition: ['사전조건', 'precondition', '선행조건'],
  postcondition: ['사후조건', 'postcondition', '완료조건']
}

/** 시트명으로 블록 자동 추론 */
export function guessSheet(sheets: SheetData[], keywords: string[]): string | null {
  for (const kw of keywords) {
    const hit = sheets.find((s) => s.name.replace(/\s/g, '').includes(kw))
    if (hit) return hit.name
  }
  return null
}

export const SHEET_HINTS = {
  outline: ['모형기술서', '요구사항목록', '기능목록', '요구사항정의'],
  actors: ['액터', 'Actor', '사용자'],
  detail: ['상세', '요구사항상세', '기능상세', '요구사항정의서']
}
