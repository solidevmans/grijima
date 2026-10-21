/**
 * LLM 출력에서 JSON을 추출/복구한다.
 * n8n 코드의 복구 로직을 정리하고, 문자열 리터럴 안의 괄호를 세지 않도록 고쳤다.
 * (기존 정규식 방식은 description 안의 "{" 하나 때문에 괄호 수를 잘못 세었다)
 */
export function extractJson<T = unknown>(raw: string): T {
  const text = stripFences(raw)
  const objAt = text.indexOf('{')
  const arrAt = text.indexOf('[')
  if (objAt === -1 && arrAt === -1) {
    throw new Error('응답에서 JSON 시작 위치를 찾지 못했습니다.')
  }

  /*
   * 루트는 객체일 수도 배열일 수도 있다. **먼저 나오는 쪽**을 루트로 보고,
   * 실패하면 다른 쪽을 시도한다.
   *
   * 예전에는 첫 `{` 만 루트로 봤다. 그래서 모델이 `[{...},{...},{...}]` 처럼
   * **배열만** 돌려주면 첫 원소 하나만 잘라내 파싱했고 나머지는 조용히 사라졌다
   * (유스케이스를 3건 만들어 줘도 1건만 남았다). 소형 모델이 자주 하는 실수라,
   * 그냥 두면 "모델이 분해를 안 했다"로 보인다.
   *
   * 순서를 위치로 정하는 이유: 응답 앞에 "[참고]" 같은 대괄호 잡담이 붙는 경우가
   * 있는데, 그때는 `{` 가 더 앞이거나 배열 시도가 실패해 객체로 넘어간다.
   */
  const first: Array<[number, string]> =
    arrAt !== -1 && (objAt === -1 || arrAt < objAt)
      ? [
          [arrAt, ']'],
          [objAt, '}']
        ]
      : [
          [objAt, '}'],
          [arrAt, ']']
        ]

  for (const [start, closer] of first) {
    const parsed = tryRoot<T>(text, start, closer)
    if (parsed !== undefined) return parsed
  }

  throw new Error('JSON 파싱에 실패했습니다. 모델 출력이 잘렸거나 형식이 올바르지 않습니다.')
}

/** 주어진 시작 위치를 루트로 보고 3단계(그대로 → 균형 → 복구)로 파싱한다 */
function tryRoot<T>(text: string, start: number, closer: string): T | undefined {
  if (start === -1) return undefined

  // 1차: 마지막 닫는 괄호까지 그대로 시도
  const end = text.lastIndexOf(closer)
  if (end > start) {
    const direct = tryParse<T>(text.slice(start, end + 1))
    if (direct !== undefined) return direct
  }

  // 2차: 문자열 인식 스캐너로 균형 잡힌 구간 추출
  const balanced = sliceBalanced(text, start)
  if (balanced) {
    const parsed = tryParse<T>(balanced)
    if (parsed !== undefined) return parsed
  }

  // 3차: 잘린 응답 복구 — 열린 괄호를 스캐너 상태에 맞춰 닫는다
  return tryParse<T>(repairTruncated(text.slice(start)))
}

function stripFences(s: string): string {
  return s
    .replace(/```(?:json|JSON)?\s*/g, '')
    .replace(/```/g, '')
    .trim()
}

function tryParse<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T
  } catch {
    return undefined
  }
}

interface ScanState {
  stack: string[]
  inString: boolean
  escaped: boolean
  /** 마지막으로 최상위 객체가 닫힌 위치 (없으면 -1) */
  closedAt: number
}

function scan(text: string, from: number): ScanState {
  const st: ScanState = { stack: [], inString: false, escaped: false, closedAt: -1 }
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (st.inString) {
      if (st.escaped) st.escaped = false
      else if (c === '\\') st.escaped = true
      else if (c === '"') st.inString = false
      continue
    }
    if (c === '"') {
      st.inString = true
      continue
    }
    if (c === '{' || c === '[') st.stack.push(c)
    else if (c === '}' || c === ']') {
      st.stack.pop()
      if (st.stack.length === 0) st.closedAt = i
    }
  }
  return st
}

function sliceBalanced(text: string, start: number): string | null {
  const st = scan(text, start)
  return st.closedAt > start ? text.slice(start, st.closedAt + 1) : null
}

function repairTruncated(fragment: string): string {
  let body = fragment

  // 문자열 중간에서 잘렸으면 따옴표를 닫는다
  const st = scan(body, 0)
  if (st.inString) {
    /*
     * 이스케이프 시퀀스 한가운데서 잘린 경우(`..."1. 진입한다\` 처럼 역슬래시로 끝남).
     * 그대로 따옴표를 붙이면 `\"` 가 되어 그 따옴표까지 이스케이프되고, 문자열이
     * 안 닫혀 복구가 통째로 실패한다. 매달린 역슬래시를 먼저 떼어 낸다.
     */
    if (st.escaped) body = body.slice(0, -1)
    body += '"'
  }

  /*
   * 꼬리 정리 — 값이 없는 조각을 떼어 낸다.
   *
   * 잘린 위치에 따라 남는 모양이 다르다:
   *   `..."alt_flow":"",`        콤마로 끝남
   *   `..."precondition":`       키와 콜론까지만
   *   `..."prec`  → `..."prec"`  **키 이름 한가운데서 잘림** (따옴표를 닫은 뒤)
   * 마지막 경우가 오래 빠져 있었다. 값 없는 키가 남으면 괄호를 아무리 잘 닫아도
   * JSON 이 아니다. 단, 배열 원소는 값이므로 떼면 안 된다 —
   * 지금 열려 있는 괄호가 `{` 일 때만 적용한다.
   */
  body = body.replace(/,\s*$/, '')
  body = body.replace(/,\s*"[^"]*"\s*:\s*$/, '')

  const inObject = (s: string): boolean => {
    const st3 = scan(s, 0)
    return st3.stack[st3.stack.length - 1] === '{'
  }
  if (inObject(body)) {
    const KEY_NO_VALUE = /"(?:[^"\\]|\\.)*"\s*$/
    if (KEY_NO_VALUE.test(body)) {
      // 앞에 콤마가 있으면 콤마째, 객체의 첫 키였으면 키만 떼어 낸다
      body = body.replace(/,\s*"(?:[^"\\]|\\.)*"\s*$/, '')
      body = body.replace(/\{\s*"(?:[^"\\]|\\.)*"\s*$/, '{')
    }
  }

  // 남은 괄호 닫기
  const st2 = scan(body, 0)
  for (let i = st2.stack.length - 1; i >= 0; i--) {
    body += st2.stack[i] === '{' ? '}' : ']'
  }
  return body
}
