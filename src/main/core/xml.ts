/**
 * XMI 텍스트 이스케이프.
 *
 * XMI 헤더가 encoding="windows-1252" 이므로 (EA가 기대하는 형식) ASCII 밖의
 * 문자는 전부 숫자 문자 참조(&#nnn;)로 바꿔야 한다.
 *
 * n8n 버전의 encodeKorean()은 한글만 변환하고 `& < > "` 를 이스케이프하지
 * 않았다. 요구사항 설명에 "A&B" 나 "<주의>" 가 하나만 들어가도 XMI 전체가
 * 깨져 EA 임포트가 실패한다. 여기서 함께 처리한다.
 */
export function xmlAttr(text: string | null | undefined): string {
  if (text === null || text === undefined) return ''
  let out = ''
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0) as number
    switch (ch) {
      case '&':
        out += '&amp;'
        continue
      case '<':
        out += '&lt;'
        continue
      case '>':
        out += '&gt;'
        continue
      case '"':
        out += '&quot;'
        continue
      case "'":
        out += '&apos;'
        continue
      case '\n':
        // 속성값 안의 개행은 파서가 공백으로 정규화한다 → 문자 참조로 보존
        out += '&#10;'
        continue
      case '\r':
        continue
      case '\t':
        out += '&#9;'
        continue
      default:
        break
    }
    if (cp > 127) out += `&#${cp};`
    else out += ch
  }
  return out
}

/** 텍스트 노드용 (속성보다 완화) */
export function xmlText(text: string | null | undefined): string {
  return xmlAttr(text)
}

/** 탭 들여쓰기 헬퍼 */
export const T = (n: number): string => '\t'.repeat(n)
