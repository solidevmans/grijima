import ExcelJS from 'exceljs'
import type { SheetData, WorkbookData } from '@shared/types'

/** 셀 값을 문자열로 평탄화 (수식/리치텍스트/하이퍼링크 포함) */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>
    if ('richText' in v && Array.isArray(v.richText))
      return (v.richText as Array<{ text: string }>).map((r) => r.text).join('').trim()
    if ('text' in v && typeof v.text === 'string') return v.text.trim()
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue)
    if ('hyperlink' in v && typeof v.hyperlink === 'string') return v.hyperlink
    if ('formula' in v) return ''
  }
  return String(value).trim()
}

/**
 * 워크북 → 시트별 헤더/행 배열.
 *
 * 헤더 행 탐색: 처음 10행 중 "비어있지 않은 셀이 가장 많은 행"을 헤더로 본다.
 * 요구사항 정의서는 위쪽에 제목/작성자 같은 장식 행이 흔해서 1행 고정은 실패한다.
 */
export async function readWorkbook(filePath: string): Promise<WorkbookData> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)

  const sheets: SheetData[] = []
  wb.eachSheet((ws) => {
    const raw: string[][] = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values: string[] = []
      const count = Math.max(ws.columnCount, row.cellCount)
      for (let c = 1; c <= count; c++) values.push(cellText(row.getCell(c).value))
      raw.push(values)
    })
    if (!raw.length) {
      sheets.push({ name: ws.name, headers: [], rows: [] })
      return
    }

    const scanTo = Math.min(10, raw.length)
    let headerIdx = 0
    let best = -1
    for (let i = 0; i < scanTo; i++) {
      const filled = raw[i].filter((v) => v !== '').length
      if (filled > best) {
        best = filled
        headerIdx = i
      }
    }

    const headers = raw[headerIdx].map((h, i) => h || `열${i + 1}`)
    const rows = raw.slice(headerIdx + 1).filter((r) => r.some((v) => v !== ''))
    sheets.push({ name: ws.name, headers, rows })
  })

  return { filePath, sheets }
}
