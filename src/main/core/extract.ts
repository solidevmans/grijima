import type { AppSettings, ExtractResult, ExtractedActor, ExtractedReq } from '@shared/types'
import { getProvider } from './llm'
import { extractJson } from './json-repair'

/**
 * AI 문서 해석 — 형식을 가리지 않고 요구사항 구조를 뽑아낸다.
 *
 * 왜 파서가 아니라 AI인가:
 *   요구사항 정의서는 기관·사업마다 형식이 다르다. 표를 붙여넣은 것, markdown,
 *   회의록, 번호 목차… 형식마다 파서를 만들면 새 문서가 올 때마다 코드를 고쳐야 한다.
 *   문서를 읽고 "이게 요구사항이고 이건 참조 문구다"를 판단하는 건 원래 LLM이 잘한다.
 *
 * 그래도 코드가 지키는 경계:
 *   - **ID 검증**: 모델이 말한 요구사항 ID가 원문에 실제로 있는지 대조한다.
 *     없으면 지어낸 것으로 보고 버리고, 코드가 규칙대로 다시 채번한다.
 *   - **채번**: 자동 채번은 코드가 한다. 모델에게 시키면 중복되거나 자릿수가 흔들린다.
 *   - **GUID·XMI·좌표**: 애초에 모델이 관여하지 않는다.
 *
 * 즉 "해석은 AI, 기계적 정확성은 코드"다.
 */

export interface ExtractProgress {
  index: number
  total: number
  label: string
}

export interface ExtractArgs {
  text: string
  settings: AppSettings
  signal?: AbortSignal
  onProgress?: (p: ExtractProgress) => void
  /** ID가 없는 문서에서 자동 채번할 때 쓸 접두어 (기본 SFR) */
  prefix?: string
  /**
   * 자동 채번에 넣을 수행 팀. 가져오기 화면에서 입력받는다.
   *   { code: 'ADT1', name: '맞춤형' }  →  SFR-001-ADT1(맞춤형)-01
   * 팀 코드는 사업마다 다르므로 기본값을 코드에 박아두지 않는다.
   * 비어 있으면 팀 구간 없이 `SFR-001-01` 로 채번한다.
   */
  team?: { code: string; name: string }
}

const NL = String.fromCharCode(10)

/**
 * 문서 관리 항목의 **값**을 문서 자체에서 수집한다.
 *
 * "홍길동"은 이름 모양 때문에 액터가 아닌 게 아니라, 문서가 `담당자` 라벨 밑에
 * 적어 둔 값이기 때문에 액터가 아니다. 이름 패턴으로 거르면 담당자가
 * "김관리자"인 순간 뚫린다(관리자 → 역할로 오인). 맥락을 봐야 한다.
 *
 *   담당자          ← 라벨
 *   홍길동          ← 값 (액터 후보에서 제외)
 *   사업 수행팀
 *   개발2팀    ← 값
 *   관련 기관
 *   ○○연구원  ← 값
 *
 * 표가 줄바꿈으로 펼쳐진 형태(라벨 다음 줄이 값)와 "라벨: 값" 두 가지를 본다.
 */
export const META_LABELS = [
  '담당자', '작성자', '책임자', '승인자', '검토자', '작성부서',
  '사업 수행팀', '수행팀', '수행사', '부서', '소속',
  '관련 기관', '관련기관', '발주기관', '기관명', '주관기관',
  '시스템명', '관련시스템', '관련 시스템', '관련DB', '관련DB/API명',
  '출처', '비고', '변경 내역', '변경내역'
]

/** 다른 라벨이거나 섹션 머리글이면 값 수집을 멈춘다 */
function isLabelLike(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (META_LABELS.some((l) => l.replace(/\s/g, '') === t.replace(/\s/g, ''))) return true
  return /^(요구사항|수행방안|상세 내용|고려\/제약사항|관련 비기능|미수용|내용 및 근거|변경일자)/.test(t)
}

/**
 * 문서가 스스로 밝힌 시스템명 · 프로젝트 ID 를 읽는다.
 *
 * 정의서 머리에는 대개 `시스템명: ...` 이 적혀 있다. 그런데 앱은 그걸 읽지 않고,
 * 사용자가 칸을 비워 두면 **"이름 없는 시스템" 이라는 이름을 지어냈다.**
 * 그 문자열은 그냥 표시용이 아니라 EA 모델 이름 · 볼트 폴더명 · 저장 파일명으로
 * 그대로 나간다. 문서에 답이 적혀 있는데 지어낼 이유가 없다.
 *
 * 모델에게 묻지 않고 코드가 읽는다 — 라벨과 값이라는 **문서 구조**로만 판단하므로
 * 3B 모델의 기분에 좌우되지 않는다. (이 파일의 원칙: 해석은 AI, 대조는 코드)
 */
const SYSTEM_NAME_LABELS = ['시스템명', '시스템 명', '사업명', '과제명', '프로젝트명']
const PROJECT_ID_LABELS = ['프로젝트 ID', '프로젝트ID', '프로젝트 코드', '사업코드', '사업 코드']

function readLabeledValue(text: string, labels: string[]): string {
  const flat = (s: string): string => s.replace(/\s/g, '')
  const keys = labels.map(flat)
  const lines = text.split(String.fromCharCode(10))

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim().replace(/^[-*·]\s*/, '')

    // "시스템명: 값" 형태
    const inline = /^([^:：]{2,14})\s*[:：]\s*(.+)$/.exec(t)
    if (inline && keys.includes(flat(inline[1]))) {
      const v = inline[2].trim()
      if (v && v.length <= 60) return v
    }

    // 라벨만 있는 줄 다음에 값이 오는 표 형태
    if (keys.includes(flat(t))) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const v = lines[j].trim()
        if (!v) continue
        // 표 머리글만 펼쳐진 정의서(`시스템명` 다음 줄이 `관련DB`)는 값이 없는 것이다
        if (isLabelLike(v)) break
        if (v.length <= 60) return v
        break
      }
    }
  }
  return ''
}

export function readDocumentMeta(text: string): { systemName: string; projectId: string } {
  return {
    systemName: readLabeledValue(text, SYSTEM_NAME_LABELS),
    projectId: readLabeledValue(text, PROJECT_ID_LABELS)
  }
}

/**
 * 공공 정의서 표준 양식의 칸을 요구사항 ID로 찾아 읽는다.
 *
 *   요구사항 / 상세 내용   → 유스케이스 재료 (LLM에게 이것만 준다)
 *   수행방안 / 상세 내용   → 구현 설명 — 유스케이스 비고로
 *   고려/제약사항          → 비고 끝에
 *
 * 수행방안을 재료로 주면 모델이 "구현 단계"를 유스케이스로 만든다
 * (정답은 상세 내용의 번호 항목 = 사용자 목표). 칸 이름은 양식이 정한
 * 것이라 사업과 무관하다. 칸을 못 찾으면 null — 지금처럼 모델이 옮긴 것을 쓴다.
 */
export interface StandardFields {
  detail: string
  plan: string
  constraints: string
}

export function readStandardFields(text: string, reqId: string): StandardFields | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const flat = (s: string): string => s.replace(/\s/g, '')
  /** start 부터 stop 라벨 전까지의 줄. `-`·`해당사항 없음` 은 빈 값 */
  const take = (start: number, end: number, stop: RegExp): string => {
    const out: string[] = []
    for (let i = start; i < end && !stop.test(flat(lines[i])); i++) {
      if (lines[i]) out.push(lines[i])
    }
    const v = out.join(NL).trim()
    return /^(-|해당사항\s*없음)$/.test(v) ? '' : v
  }
  /** 라벨이 한 줄(`요구사항 상세 내용`)이거나 두 줄(`요구사항` / `상세 내용`)인 자리의 값 시작 줄 */
  const after = (from: number, to: number, head: string): number => {
    for (let i = from; i < to; i++) {
      const f = flat(lines[i])
      if (f === head + '상세내용') return i + 1
      if (f === head && flat(lines[i + 1] ?? '') === '상세내용') return i + 2
    }
    return -1
  }

  for (let at = lines.indexOf(reqId); at !== -1; at = lines.indexOf(reqId, at + 1)) {
    // 이 요구사항의 범위 = 다음 `요구사항 ID` 머리글 전까지
    let end = lines.findIndex((l, i) => i > at && flat(l) === '요구사항ID')
    if (end === -1) end = lines.length
    const d = after(at + 1, end, '요구사항')
    if (d === -1) continue // 개요 표에 나온 ID — 상세 블록이 아니다
    const p = after(d, end, '수행방안')
    const c = lines.findIndex((l, i) => i > d && i < end && /^고려[/·]?제약사항$/.test(flat(l)))
    return {
      detail: take(d, end, /^(관련법제도|출처|관련시스템|수행방안)$/),
      plan: p === -1 ? '' : take(p, end, /^(관련비기능|고려[/·]?제약사항|관련시스템)$/),
      constraints: c === -1 ? '' : take(c + 1, end, /^(관련시스템|관련기관|비고)$/)
    }
  }
  return null
}

/**
 * 표준 양식 `요구사항 ID` 머리글 아래 칸의 행 ID 전부 (문서 순서, 중복 없음).
 * 모델이 돌려주지 않은 행을 코드가 알아채려고 쓴다 — 머리글이 없는 정의서는 빈 배열.
 */
export function readStandardIds(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const ids: string[] = []
  lines.forEach((l, i) => {
    if (l.replace(/\s/g, '') !== '요구사항ID') return
    const id = lines.slice(i + 1, i + 5).find((s) => /^[A-Z]{2,5}-\d{1,4}(-\S+)?$/.test(s))
    if (id && !ids.includes(id)) ids.push(id)
  })
  return ids
}

/**
 * 정의서에서 그 ID 줄의 요구사항명 — `#### SFR-009-PAD-02: 이름`이면 같은 줄 뒤,
 * 표처럼 ID만 있는 줄이면 다음 줄. 뺀 요구사항 경고가 ID만 늘어놓지 않게 쓴다. 못 찾으면 ''.
 * 줄 머리에 ID가 있어야 한다 — `요구사항정의서[SFR-012-…-02] 포함.` 같은 참조 문구는 건너뛴다.
 */
export function readReqName(text: string, id: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim().replace(/^#+\s*/, ''))
  const i = lines.findIndex((l) => l.startsWith(id) && !/[\w(-]/.test(l.charAt(id.length)))
  if (i < 0) return ''
  const rest = lines[i].slice(id.length).replace(/^[\s:：.\-–]+/, '')
  const name = rest || (lines.slice(i + 1).find(Boolean) ?? '')
  return name.length > 120 ? '' : name
}

/**
 * 상세 내용 칸의 **번호 항목** —유스케이스 후보 (LLM 없이, 빠짐없이).
 *   `1. 설문 대상자 관리` / `2. 사용자 관리 기능(…` + 줄바꿈된 `…설정)` → 후보 2개
 * 번호 없는 줄은 앞 항목에 붙인다: `●`·`-` 같은 머리표 줄은 세부(` / `로), 나머지는 줄바꿈된 이어짐.
 * 번호 항목이 하나도 없으면 빈 배열 — 그 요구사항은 예전처럼 모델이 만든다.
 */
export function detailItems(detail: string): string[] {
  const items: string[] = []
  for (const line of detail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const num = /^\d{1,2}[.)]\s*(.+)$/.exec(line)
    if (num) items.push(num[1])
    else if (!items.length) continue
    else if (/^[●○◦•▪■□ㅇ‐–\-∙※]/.test(line)) items[items.length - 1] += ' / ' + line
    else items[items.length - 1] += ' ' + line
  }
  return items
}

/**
 * 수행방안 칸 번호 항목 앞에 붙는 출처 표시.
 * 상세 내용 후보는 빠짐없이 유스케이스가 되지만, 이 표시가 붙은 후보는 모델이 쓸 때만 쓴다 —
 * 수행방안은 구현 계획이라 상세 내용과 같은 일을 다시 적거나 시스템 처리를 적는 일이 흔하다.
 */
export const PLAN_ITEM = '(수행방안) '

/**
 * 유스케이스 후보 = 상세 내용 번호 항목, 수행방안 번호 항목이 **더 많을 때만** 그것도 붙인다.
 * 왜 "더 많을 때만": 수행방안이 상세 내용보다 잘게 쪼개져 있으면 화면·기능 단위가 거기 있다(정답이
 * 수행방안을 따른 요구사항이 그랬다). 아니면 같은 일을 다시 적거나 시스템 처리라 유스케이스만 불었다
 * — 늘 붙이면 생성 28→43건(정답 21)에 정밀율이 떨어졌다.
 * 수행방안의 참조·구현 메모는 먼저 버린다 — `요구사항정의서[SFR-005-…] 일부 포함.`,
 * `eGovFrame4.3 최신 버전 사용.`이 그대로 유스케이스 타원이 됐다(요구사항 이름의 `에 통합|포함` 거르기와 같은 뜻).
 */
const PLAN_MEMO = [/\[[A-Z]{2,}-[^\]]+\].{0,10}(포함|통합|분리)/, /(버전|프레임워크).{0,6}(사용|적용)\.?$/]

export function candidateItems(std: StandardFields): string[] {
  const detail = detailItems(std.detail)
  const plan = detailItems(std.plan).filter((s) => !PLAN_MEMO.some((re) => re.test(s)))
  return plan.length > detail.length ? [...detail, ...plan.map((s) => PLAN_ITEM + s)] : detail
}

/**
 * 시스템 내부 처리 후보 — 사람이 화면에서 하는 일이 아니라 유스케이스가 아니다.
 * 항목 첫머리(` / ` 세부 앞)가 처리 이름으로 끝날 때만: `…정보를 추출`, `데이터 꾸러미 생성`,
 * `연결고리 제거`, `저장/백업`, `…DB에 저장`, `수집 로직 구현`, `…시스템을 구축함`.
 * 다듬기 지시로 모델에게 고르게 했더니 3B가 못 골랐다 — 그래서 코드가 뗀다.
 */
const SYSTEM_WORK =
  /(추출|연산|연결고리 제거|백업|꾸러미 생성|(DB|데이터베이스|서버)에 (저장|적재)|(시스템|연계|연동|로직|파이프라인)(을|를)? ?(구축|구현)함?)\.?$/

export function isSystemWork(item: string): boolean {
  const head = (item.startsWith(PLAN_ITEM) ? item.slice(PLAN_ITEM.length) : item).split(' / ')[0].trim()
  return SYSTEM_WORK.test(head)
}

export function collectDocumentMetaValues(text: string): Set<string> {
  const out = new Set<string>()
  const add = (v: string): void => {
    const t = v.trim()
    if (t && t.length <= 40) out.add(t.replace(/\s+/g, ' '))
  }

  const lines = text.split(String.fromCharCode(10))
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()

    // "담당자: 홍길동" 형태
    const inline = /^([^:：]{2,12})\s*[:：]\s*(.+)$/.exec(t)
    if (inline && META_LABELS.some((l) => l.replace(/\s/g, '') === inline[1].replace(/\s/g, ''))) {
      add(inline[2])
      continue
    }

    // 라벨 줄 다음의 값 줄들 (표가 펼쳐진 형태)
    if (META_LABELS.some((l) => l.replace(/\s/g, '') === t.replace(/\s/g, ''))) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (isLabelLike(lines[j])) break
        add(lines[j])
      }
    }
  }
  return out
}



/**
 * 액터로 받아들일 이름인가.
 *
 * ★ 판정 기준에 **업무 단어 목록을 두지 않는다.**
 *   예전에는 "관리자|담당자|사용자…"(역할), "화면|대시보드|검색…"(화면),
 *   "국립|한국|과학원|공단…"(기관) 같은 목록으로 걸렀다. 그 목록은 개발자가
 *   본 몇 개 사업의 어휘일 뿐이라, 다른 도메인 문서가 오면 멀쩡한 액터를
 *   버리거나 엉뚱한 값을 통과시킨다. PAD를 무조건 붙이던 것과 같은 문제다.
 *
 * 그래서 남기는 건 **문서 구조에서 나오는 사실**뿐이다:
 *   ① 문서가 관리 항목(담당자·수행팀·관련기관)의 **값**으로 적어 둔 것인가
 *      — 위치로 판단한다. "홍길동"이 사람 이름처럼 생겨서가 아니라
 *        `담당자` 라벨 밑에 있어서 액터가 아니다.
 *   ② 그 표현이 **원문에 실제로 등장하는가**
 *      — 요구사항 ID를 원문과 대조하는 것과 같은 방식이다.
 *        모델이 지어낸 이름("통합검색 사용자")은 대개 원문에 없다.
 *   ③ 길이 (한 줄 문장이 액터로 올라오는 것 방지)
 *
 * "이건 액터가 아니라 화면 이름이다" 같은 **판단은 프롬프트가 한다**(EXTRACT_SYSTEM_PROMPT).
 * 해석은 AI, 기계적 대조는 코드 — 이 파일의 원칙 그대로다.
 */
export function isValidActorName(
  name: string,
  metaValues: Set<string>,
  sourceText = ''
): boolean {
  const n = name.trim()
  if (!n || n.length > 24) return false

  /*
   * ① 문서가 관리 항목의 값으로 적어 둔 것이면 액터가 아니다.
   *
   * 비교는 "같거나, 후보가 값을 통째로 품고 있을 때"만이다.
   * 반대 방향(값이 후보를 포함)은 쓰면 안 된다 —
   *   관련 기관: 소상공인시장진흥공단   →  액터 "소상공인" 이 잘려 나갔다
   *   시스템명:  소상공인24            →  같은 이유
   * 기관명 안에 들어 있다고 그 말이 액터가 아닌 건 아니다.
   */
  const flat = n.replace(/\s+/g, ' ')
  // 괄호 구간과 공백을 떼고 비교한다.
  //   문서 "응용개발1팀(맞춤형)"  ↔  모델 "응용개발1팀"  → 같은 값으로 본다
  //   "소상공인시장진흥공단"      ↔  "소상공인"          → 다른 값 (액터로 통과)
  const squash = (t: string): string => t.replace(/\([^)]*\)/g, '').replace(/\s+/g, '')
  const key = squash(flat)
  for (const m of metaValues) {
    if (m === flat || flat.includes(m)) return false
    if (key && squash(m) === key) return false
  }

  // ② 원문 대조 — 지어낸 이름을 거른다.
  //    공백 차이는 무시한다("시스템 관리자" 문서 ↔ "시스템관리자" 모델 출력)
  if (sourceText) {
    const flatten = (t: string): string => t.replace(/\s+/g, '')
    const hay = flatten(sourceText)
    const needle = flatten(n)
    if (!hay.includes(needle)) return false

    /*
     * ③ **부정문에만 나오는 표현은 액터가 아니다.**
     *
     * 실제 사고: 정의서에 딱 한 번 이렇게 나온 표현이 액터가 됐다.
     *   "… 설문 대상자가 아닌 사용자가 만족도 조사 선택 시 알림을 띄운다"
     * 문장은 "설문 대상자가 아닌 사람"을 말하는데, 원문 대조는 부분 문자열만 보므로
     * 통과했다. 그렇게 생긴 액터는 아무 유스케이스도 쓰지 않았다.
     *
     * 등장 위치를 전부 훑어 **하나라도 부정문이 아닌 자리**가 있으면 인정한다.
     * 처음엔 "예시에 나온 이름은 두 번 이상 나와야 한다"로 막았는데, 그건
     * 이 파일이 하지 않기로 한 **업무 단어 목록**이었고 실제로 멀쩡한 액터
     * (공단관리자)를 잘라 먹었다. 어휘가 아니라 문장 구조로 판단한다.
     */
    /*
     * 부정 표현은 음절 단위로 봐야 한다.
     *   아닌 / 아니라 / 아니고 / 아님  →  닌·니·님 이 각각 다른 음절이다.
     * "아니" 로만 검사하면 **"아닌"이 걸리지 않는다**(닌 ≠ 니 + ㄴ). 실제로 놓쳤다.
     */
    const NEGATED = /^[이가은는을를]?아[닌니님]/
    let positive = 0
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
      if (!NEGATED.test(hay.slice(at + needle.length, at + needle.length + 4))) positive++
    }
    if (positive === 0) return false
  }

  return true
}

/** 대분류로 쓰기에 부적절한 문서 관리 항목인가 */
function isJunkGroup(name: string): boolean {
  const n = name.trim()
  if (!n) return true
  if (/(팀|부서|과|실|본부)$/.test(n)) return true
  return /^(담당자|출처|비고|변경\s*내역|관련\s*(법제도|시스템|기관|비기능)|미수용)/.test(n)
}



/**
 * 액터가 사람인지 외부 시스템인지.
 *
 * 예전엔 이름에 든 단어("국민|공무원…" vs "서버|센서…")로 모델 판단을 덮어썼다.
 * 그 목록도 한국 공공사업 어휘라 도메인이 바뀌면 틀린다. 판단은 모델에게 맡기고
 * (프롬프트가 external 의 뜻을 설명한다), 틀리면 편집 탭에서 한 번에 바꾼다.
 * Primary/Secondary 는 표기일 뿐 구조를 바꾸지 않으므로 되돌리기도 싸다.
 */
function resolveActorKind(_name: string, modelSaidExternal: boolean): string {
  return modelSaidExternal ? 'Secondary' : 'Primary'
}

/**
 * 문서의 액터 절을 코드가 읽는다 — 머리글에 `액터`가 든 줄 아래의 번호 목록.
 *
 *   ## 액터 정의
 *   1. 시스템관리자: 플랫폼 전체 관리 …
 *   2. 연계기관시스템: 외부 시스템 …
 *
 * 문서에 적힌 액터는 사람이 준 입력이다. 모델에게 다시 뽑게 하면 빠지거나
 * (정책담당자) 없는 이름이 생기고(전자정부 관리자) 돌릴 때마다 달라졌다.
 * 이름이 `…시스템`으로 끝나면 외부 시스템(Secondary)으로 본다.
 */
export function readActorSection(text: string): ExtractedActor[] {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].replace(/^[\s#\[\]■□▶●○*]+|[\s\]*]+$/g, '')
    if (!head.includes('액터') || head.length > 20 || /[:：|]/.test(head)) continue
    const out: ExtractedActor[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim()
      if (!t) continue
      const m = /^\d+[.)]\s*(.+)$/.exec(t)
      if (!m) break
      const body = m[1].replace(/\*\*/g, '')
      const cut = body.search(/[:：]/)
      const name = (cut === -1 ? body : body.slice(0, cut)).trim()
      if (!name || name.length > 30) continue
      out.push({
        name,
        description: cut === -1 ? '' : body.slice(cut + 1).trim().replace(/\|/g, '/'),
        kind: /시스템$/.test(name) ? 'Secondary' : 'Primary'
      })
    }
    if (out.length) return out
  }
  return []
}

export const EXTRACT_SYSTEM_PROMPT = `너는 요구사항 정의서를 읽고 구조를 뽑아내는 시스템 분석가다.
아래 JSON 하나만 출력한다. 설명, 코드펜스, 주석을 붙이지 마라.

{"requirements":[{"id":"","name":"","group":"","description":"","plan":"","usecase":true}],"actors":[{"name":"","description":"","external":false}]}

각 필드:
- id    : 문서에 요구사항 ID가 적혀 있으면 **원문 그대로** 옮긴다. 예) SFR-001-PAD(플랫폼기반)-02
          없으면 빈 문자열. 절대 지어내지 마라.
- name  : 요구사항명 또는 기능명. 문서의 표현을 살린다.
- group : 이 요구사항이 속한 상위 분류. 문서에 상위 제목이 있으면 그것을,
          없으면 업무 영역을 2~10자로 요약. 예) 데이터연계, 시스템관리
- description : 무엇을 하는 기능인지 한두 문장
- plan  : 수행방안·구현방법·절차가 적혀 있으면 그대로 옮긴다. 없으면 빈 문자열.
- usecase : 이 요구사항을 **유스케이스로 그릴 수 있는가**. true / false
            사용자나 외부 시스템이 **시스템과 주고받는 동작**이면 true.
            시스템을 만드는 과정·품질·환경에 관한 것이면 false.
            판단 기준: "누가, 화면에서, 무엇을 한다"로 쓸 수 있으면 true.
            false 예) 테스트 수행·시나리오 작성, 데이터 이관, 사용자 교육,
                     산출물·문서 작성, 응답속도 목표치, 보안 정책 준수, 장비 도입
            문서에 "구분" 칸이 있고 거기에 비기능·테스트라고 적혀 있으면 usecase=false 다.
            칸이 없으면 내용으로 판단하라. 애매하면 "이 일을 하는 사람이 이 시스템의
            사용자인가?"를 물어라 — 개발자·시험자·운영인력이 하는 일이면 false.

actors : 시스템을 **사용하는 역할(직무)** 이나 연동되는 **외부 시스템**.
         문서에 액터 목록이 따로 없으면 본문에서 누가 이 기능을 쓰는지 찾아 적는다.
         **문서에 실제로 등장하는 표현만 쓴다. 없는 이름을 만들지 마라.**
         external 은 사람이 아닌 외부 시스템/장비/서비스면 true, 사람이면 false.

         액터가 **아닌 것** (자주 틀리는 것들):
         - 화면·기능 이름에 역할 단어를 붙인 것
           "통합검색 사용자", "대시보드 화면 사용자", "보고서 다운로드 사용자" (X)
           → 그 화면을 쓰는 **직무**를 적어라. 화면마다 액터를 만들면 안 된다.
         - 담당자 개인 이름, 팀·부서명, 발주/수행 기관명, 문서 작성자
         - 구축 대상 시스템 자신("본 시스템", "통합플랫폼")

         액터는 **몇 명 안 된다.** 보통 3~7명이다. 화면 수만큼 나오면 잘못 뽑은 것이다.

중요:
1. 문서에 실제로 있는 내용만 뽑는다. 일반적인 기능을 지어내지 마라.
2. "요구사항정의서[SFR-003]에 통합", "제안서(p.45)" 같은 **참조 문구는 요구사항이 아니다**.
   그런 줄은 plan 안에 남기되 별도 요구사항으로 만들지 마라.
3. 목차, 출처, 변경이력, 담당자 같은 관리 항목은 무시한다.
4. 같은 요구사항을 두 번 만들지 마라.

JSON만 출력하라.`

/**
 * 액터 전용 프롬프트.
 *
 * 왜 따로 부르나: 요구사항 추출과 함께 시키면 작은 모델이 액터를 자꾸 빠뜨린다.
 * 한 번에 두 가지를 시키면 하나가 밀린다. 그리고 액터는 **문서 전체**를 봐야
 * 나오는데, 요구사항 추출은 조각(청크) 단위라 구조가 안 맞는다.
 * 그래서 요구사항을 다 뽑은 뒤, 그 목록을 놓고 "누가 쓰는가"만 한 번 묻는다.
 */
export const ACTOR_SYSTEM_PROMPT = `너는 요구사항 목록을 보고 이 시스템을 쓰는 액터를 뽑는 시스템 분석가다.
아래 JSON 하나만 출력한다. 설명, 코드펜스, 주석을 붙이지 마라.

{"actors":[{"name":"","description":"","external":false}]}

규칙:
1. 액터 = 시스템을 사용하는 **사람의 역할(직무)** 또는 연동되는 **외부 시스템**.
2. **문서에 실제로 나오는 표현만** 쓴다. 없는 이름을 지어내지 마라.
3. **3~7명**이 보통이다. 기능 수만큼 만들면 잘못된 것이다.
4. **name 은 10자 이내의 짧은 명사**로 쓴다. 수식어를 붙이지 마라.
   (X) "통합검색 사용자", "AI 기반 맞춤 서비스 사용자", "자격관리 알림 서비스 수신자"
   기능 이름 + 역할 단어 = 액터가 아니다. 그 기능을 쓰는 **직무 하나**를 적어라.
   같은 사람이 여러 기능을 쓰면 액터는 하나다.
5. **여러 요구사항에 걸쳐 되풀이 등장하는 역할만** 액터다.
   한 문장에 한 번 스친 표현은 액터가 아니다. 특히 "~가 아닌 사용자" 처럼
   **부정문에 나온 표현**을 액터로 만들지 마라.
6. 액터가 아닌 것: 담당자 개인 이름, 팀·부서명(응용개발1팀 등),
   발주·수행 기관명, 구축 대상 시스템 자신.
7. external: 사람이면 false, 외부 시스템·솔루션·채널이면 true.
8. description 은 "무엇을 하는 역할인지" 한 문장.

형식 예시 — **이름은 아래 입력에서만 가져온다. 이 예시의 단어를 쓰지 마라.**
입력: 민원인이 증명서를 신청한다. 심사담당자가 신청을 검토하고 승인한다.
출력: {"actors":[
  {"name":"민원인","description":"증명서를 신청하는 이용자","external":false},
  {"name":"심사담당자","description":"신청을 검토·승인하는 운영자","external":false}
]}
3~5개면 충분하다. 기능마다 액터를 만들지 마라.

JSON만 출력하라.`



interface RawItem {
  id?: string
  name?: string
  group?: string
  description?: string
  plan?: string
  /** 유스케이스로 그릴 수 있는 요구사항인가 (모델 판단) */
  usecase?: boolean
}
interface RawOut {
  requirements?: RawItem[]
  actors?: Array<{ name?: string; description?: string; external?: boolean }>
}

/**
 * 문서를 청크로 나눈다.
 * 빈 줄 기준으로 문단을 묶되, 요구사항 레코드 경계처럼 보이는 줄에서 우선 끊는다.
 */
export function chunkDocument(text: string, maxChars = 2400): string[] {
  const lines = text.split(String.fromCharCode(10))

  /*
   * 자르는 위치가 중요하다.
   * 예전엔 글자 수가 차면 잘랐는데, 요구사항 레코드 한가운데가 잘려
   * 앞뒤 조각 어디에서도 온전히 안 읽혀 요구사항이 통째로 누락됐다
   * (실측 문서 11건 → 8건).
   *
   * 그래서 **레코드 경계에서만** 자른다. 문서 구조를 해석하는 게 아니라
   * "여기서 끊어도 안전하다"는 지점만 찾는 것이다.
   */
  const isBoundary = (l: string): boolean =>
    /^\s*(요구사항\s*ID|#{1,4}\s|\[[A-Z][A-Z0-9]{1,7}-\d)/.test(l)

  // 1) 경계마다 조각으로 나눈다
  const blocks: string[][] = []
  let cur: string[] = []
  for (const line of lines) {
    if (isBoundary(line) && cur.length) {
      blocks.push(cur)
      cur = []
    }
    cur.push(line)
  }
  if (cur.length) blocks.push(cur)

  // 2) 조각을 maxChars 안에서 이어 붙인다 (조각 하나가 넘치면 그대로 둔다)
  const chunks: string[] = []
  let buf: string[] = []
  let len = 0
  const NLC = String.fromCharCode(10)
  for (const b of blocks) {
    const size = b.join(NLC).length + 1
    if (buf.length && len + size > maxChars) {
      chunks.push(buf.join(NLC).trim())
      buf = []
      len = 0
    }
    buf.push(...b)
    len += size
  }
  if (buf.length) {
    const t = buf.join(NLC).trim()
    if (t) chunks.push(t)
  }
  return chunks.filter(Boolean)
}

const norm = (s: string): string => s.replace(/[\s()（）·・_-]/g, '').toLowerCase()
const pad2 = (n: number): string => String(n).padStart(2, '0')
const pad3 = (n: number): string => String(n).padStart(3, '0')

/**
 * 자동 채번의 요구사항 유형 접두어.
 *
 * 예전엔 분류명에 "성능|보안|인터페이스"가 들어가면 PER/SER/INR 로 바꿨다.
 * 그 매핑도 특정 문서의 어휘를 보고 만든 것이라, 분류명이 조금만 달라도
 * 엉뚱한 유형이 붙는다. 사용자가 정한 접두어(기본 SFR)를 그대로 쓴다.
 */
function prefixFor(_group: string, base: string): string {
  return base
}

export async function extractByAI(args: ExtractArgs): Promise<ExtractResult> {
  const { settings } = args
  const provider = getProvider(settings.activeProvider)
  const config = settings.providers[settings.activeProvider]
  const basePrefix = (args.prefix ?? 'SFR').toUpperCase()
  /*
   * 팀 구간. 예전엔 `(args.workType ?? 'PAD')` 로 **무조건 PAD**를 박았다.
   * PAD는 한 사업의 팀 코드일 뿐이라, 다른 사업 문서를 넣으면 없는 팀이 붙었다.
   * 이제 사용자가 준 값만 쓰고, 없으면 팀 구간 자체를 생략한다.
   */
  const teamCode = (args.team?.code ?? '').trim().toUpperCase()
  const teamName = (args.team?.name ?? '').trim()
  const teamPart = teamCode ? `-${teamCode}${teamName ? `(${teamName})` : ''}` : ''

  const chunks = chunkDocument(args.text)
  // 문서에서 관리 항목 값을 미리 수집해 액터 후보에서 제외한다
  /*
   * 관리 항목의 **값**(담당자 밑의 이름)뿐 아니라 **라벨 자체**도 액터가 아니다.
   * "사업 수행팀"이 실제로 액터로 올라온 적이 있다. 새 단어 목록을 만들지 않고
   * 이미 있는 라벨 목록을 재사용한다.
   */
  const metaValues = collectDocumentMetaValues(args.text)
  for (const l of META_LABELS) metaValues.add(l)
  const notes: string[] = []
  const items: Array<RawItem & { verifiedId: string }> = []
  const actorMap = new Map<string, ExtractedActor>()
  // 문서에 액터 절이 있으면 그 목록이 전부다 — 모델이 뽑은 액터는 안 받는다
  const docActors = readActorSection(args.text)
  for (const a of docActors) actorMap.set(norm(a.name), a)
  let failed = 0
  let skipped = 0
  /** `usecase:false` 로 걸러진 것들 — 전부 걸러졌을 때 되살리기 위해 들고 있는다 */
  const excluded: Array<RawItem & { verifiedId: string }> = []

  for (let i = 0; i < chunks.length; i++) {
    args.onProgress?.({ index: i + 1, total: chunks.length, label: `문서를 ${chunks.length}조각으로 나눠 읽는 중` })
    const chunk = chunks[i]

    let parsed: RawOut | null = null
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const out = await provider.generate({
          system: EXTRACT_SYSTEM_PROMPT,
          user: chunk,
          config,
          signal: args.signal
        })
        parsed = extractJson<RawOut>(out)
      } catch (e) {
        if (args.signal?.aborted) throw e
        if (attempt === 1) {
          failed++
          notes.push(`구간 ${i + 1}: ${e instanceof Error ? e.message.split(NL)[0] : e}`)
        }
      }
    }
    if (!parsed) continue

    for (const r of parsed.requirements ?? []) {
      const name = (r.name ?? '').trim()
      if (!name || name.length > 120) continue

      /*
       * 유스케이스로 그릴 수 없는 요구사항은 제외한다 — 모델이 판단한다.
       * 테스트·이관·교육·성능목표 같은 건 "누가 화면에서 무엇을 한다"로 쓸 수
       * 없어서, 억지로 유스케이스를 만들면 액터 없는 타원만 늘어난다.
       * (실제 유스케이스모형기술서도 기능 요구사항만 다룬다.)
       * 문서에 기능/비기능 구분이 없을 수도 있으므로 칸을 읽지 않고 내용으로 본다.
       */
      // 참조 문구가 요구사항으로 올라온 경우 걸러낸다
      if (/^(제안서|제안요청서|면담|회의록|출처|변경\s*내역)/.test(name)) continue
      if (/에\s*(통합|포함)$/.test(name) && name.length < 30) continue

      // 중복 제거
      if (items.some((x) => norm(x.name ?? '') === norm(name))) continue

      // ★ ID 검증 — 모델이 말한 ID가 원문에 실제로 있어야 인정한다
      const claimed = (r.id ?? '').trim()
      const verifiedId = claimed && args.text.includes(claimed) ? claimed : ''

      const rawGroup = (r.group ?? '').trim()
      const item = {
        ...r,
        name,
        group: isJunkGroup(rawGroup) ? '미분류' : rawGroup,
        verifiedId
      }

      /*
       * 모델이 "유스케이스로 못 그린다" 고 한 것은 **버리지 않고 따로 담는다.**
       * 바로 버리면 아래 "전건 제외" 방어에서 되살릴 수가 없다.
       */
      if (r.usecase === false) {
        skipped++
        excluded.push(item)
        continue
      }

      items.push(item)
    }

    for (const a of docActors.length ? [] : parsed.actors ?? []) {
      const name = (a.name ?? '').trim()
      if (!isValidActorName(name, metaValues, args.text)) continue
      const key = norm(name)
      const prev = actorMap.get(key)
      if (!prev || (a.description?.length ?? 0) > prev.description.length) {
        actorMap.set(key, {
          name,
          description: (a.description ?? '').trim(),
          kind: resolveActorKind(name, a.external === true)
        })
      }
    }
  }

  /*
   * 모든 구간이 실패했다 = 모델이 한 글자도 돌려주지 못했다.
   *
   * 그냥 두면 요구사항 0건으로 빠져나가고 호출부가
   * "문서에서 요구사항을 찾지 못했습니다" 를 띄운다. 그러면 사용자는
   * 멀쩡한 정의서를 고치러 간다 — 실제로는 모델이 안 올라온 것뿐인데.
   *
   * 게다가 바로 아래 액터 추론은 정규식이라 모델과 무관하게 성공하므로
   * "액터 2명"이 함께 표시돼 부분 성공처럼 보인다. 더 헷갈린다.
   *
   * 유스케이스 생성 단계(generate.ts)에는 이미 같은 방어가 있다.
   * 그 앞 단계인 여기에도 같은 기준을 건다: 전건 실패는 문서 문제가 아니다.
   */
  if (chunks.length > 0 && failed >= chunks.length) {
    const first = notes.find((n) => n.startsWith('구간 ')) ?? ''
    const cause = first.slice(first.indexOf(': ') + 2)
    throw new Error(
      '문서 해석을 위한 모델 호출이 ' + chunks.length + '개 구간 모두 실패했습니다.' + NL + NL +
        '원인: ' + (cause || '알 수 없음') + NL + NL +
        '문서 문제가 아닙니다. 설정 탭에서 모델 파일(.gguf)을 지정하고 ' +
        '"연결 테스트"가 성공하는지 먼저 보세요.'
    )
  }

  /*
   * 요구사항을 다 뽑았으니, 이제 그 목록을 놓고 **액터만 한 번 더 묻는다.**
   * 청크마다 곁다리로 물었을 때보다 훨씬 안정적으로 나온다.
   * 실패해도 앞서 모은 것으로 계속 간다 — 이 호출은 보조다.
   */
  /*
   * **전건 제외 방어.**
   *
   * `usecase` 는 모델이 참/거짓으로 답해야 하는 칸인데, 3B급은 이걸 자주
   * 전부 false 로 찍는다. 실측에서 "공고를 등록하고 조회·신청한다" 같은 명백한
   * 기능까지 false 가 나왔다. 그대로 두면 요구사항이 0건이 되고 앱은
   * "문서에서 요구사항을 찾지 못했습니다" 라고 말한다 — 멀쩡한 정의서인데.
   *
   * 하나도 안 남고 걸러진 것만 있다면 그건 **문서에 기능이 없는 게 아니라
   * 모델이 판단을 못 한 것**이다. 판단이 없었던 것으로 보고 전부 되살린다.
   * (일부만 걸러졌다면 그건 실제 판단이므로 존중한다)
   */
  if (!items.length && excluded.length) {
    items.push(...excluded)
    skipped = 0
    notes.push(
      `모델이 요구사항 ${excluded.length}건을 모두 "유스케이스 아님" 으로 판정했습니다 — ` +
        '판단이 없었던 것으로 보고 전부 사용합니다. 불필요한 항목은 편집 탭에서 지우세요.'
    )
  }

  if (docActors.length) {
    notes.push(`문서의 액터 절에서 액터 ${docActors.length}명을 읽어 그대로 씁니다.`)
  } else if (items.length) {
    // 조각 번호를 달지 않는다 — `(5/5)`면 액터 정리가 다섯째 조각으로 읽힌다
    args.onProgress?.({ index: 1, total: 1, label: '액터 정리' })
    /*
     * 요구사항명만 넘기면 액터가 안 나온다. 액터는 **수행방안 본문**에 있다.
     *   "공단관리자가 공고 설정 시…", "설문 등록자가 대상자를 추가하고…"
     * 그래서 name + description + plan 을 함께 넘긴다.
     */
    /*
     * 전체를 앞에서부터 자르면 **뒤쪽 요구사항이 통째로 빠진다.**
     * 실제로 그래서 운영자 액터(공단관리자 등)가 안 나왔다 — 그 말은
     * 문서 뒷부분 요구사항의 수행방안에만 있었다.
     * 그래서 요구사항마다 조금씩만 잘라 **모든 요구사항이 들어가게** 한다.
     */
    const perItem = Math.max(120, Math.floor(4000 / Math.max(1, items.length)))
    const list = items
      .map((r) => {
        const body = [String(r.description ?? '').trim(), String(r.plan ?? '').trim()]
          .filter(Boolean)
          .join(' ')
          .slice(0, perItem)
        return `- ${r.name}${body ? NL + '  ' + body : ''}`
      })
      .join(NL)
    try {
      /*
       * 문서에서 수집한 관리 항목(담당자·수행팀·관련기관·시스템명)을
       * **"이건 액터가 아니다" 목록으로 프롬프트에 넣는다.**
       * 3b도 7b도 그냥 두면 "응용개발1팀", "소상공인시장진흥공단"을 액터로 낸다.
       * 코드에 단어를 박는 게 아니라 **이 문서에서 읽어낸 값**을 알려주는 것이다.
       */
      const banned = [...metaValues]
        .filter((v) => v.length <= 30 && !/^-+$/.test(v))
        .slice(0, 20)
      const bannedBlock = banned.length
        ? NL + NL + '[액터가 아닌 것 — 이 문서의 관리 항목]' + NL + banned.join(', ')
        : ''

      const out = await provider.generate({
        system: ACTOR_SYSTEM_PROMPT,
        user: '[요구사항 목록]' + NL + list + bannedBlock,
        config,
        signal: args.signal
      })
      const parsed = extractJson<{ actors?: Array<{ name?: string; description?: string; external?: boolean }> }>(out)
      for (const a of parsed.actors ?? []) {
        const name = (a.name ?? '').trim()
        if (!name || !isValidActorName(name, metaValues, args.text)) continue
        const key = norm(name)
        if (actorMap.has(key)) continue
        actorMap.set(key, {
          name,
          description: (a.description ?? '').trim(),
          kind: resolveActorKind(name, a.external === true)
        })
      }
    } catch (e) {
      if (args.signal?.aborted) throw e
      // 왜 실패했는지 없이 "실패"만 적으면 사용자가 할 수 있는 게 없다
      const why = e instanceof Error ? e.message.split(NL)[0] : String(e)
      notes.push(`액터 정리 호출 실패(${why}) — 요구사항에서 찾은 액터만 씁니다.`)
    }
  }

  /*
   * 액터가 없거나 1명뿐이면 **알리기만 한다.**
   *
   * 예전에는 여기서 본문을 정규식으로 훑어 액터를 만들어 넣었다. 그런데 그
   * 규칙표가 한 사업의 액터 카탈로그였다 — 소상공인·설문대상자·국민비서·
   * OCR솔루션… 문서에 없어도 단어가 스치면 없는 액터가 생겼다.
   * PAD를 무조건 붙이던 것과 같은 종류의 오류다.
   *
   * 액터를 못 찾은 건 사실이고, 사실은 사실대로 알려야 사용자가 편집 탭에서
   * 채운다. 앱이 지어내면 사용자는 그게 문서에서 나온 값인 줄 안다.
   */
  if (actorMap.size === 0) {
    notes.push('문서에서 액터를 찾지 못했습니다 — 편집 탭에서 직접 추가하세요.')
  } else if (actorMap.size === 1) {
    notes.push(
      `액터를 1명(${[...actorMap.values()][0].name})만 찾았습니다. ` +
        '유스케이스가 전부 한 액터에 붙어 다이어그램이 단조로워집니다 — 편집 탭에서 확인하세요.'
    )
  }

  /* ---------------- 채번 (코드가 한다) ---------------- */

  const groupOrder: string[] = []
  const byGroup = new Map<string, typeof items>()
  for (const r of items) {
    const g = r.group as string
    if (!byGroup.has(g)) {
      byGroup.set(g, [])
      groupOrder.push(g)
    }
    byGroup.get(g)!.push(r)
  }

  const reqs: ExtractedReq[] = []
  let autoNumbered = 0
  let standard = 0
  let systemDropped = 0
  groupOrder.forEach((group, gi) => {
    const list = byGroup.get(group) as typeof items
    list.forEach((r, ri) => {
      let reqId = r.verifiedId
      if (!reqId) {
        reqId = `${prefixFor(group, basePrefix)}-${pad3(gi + 1)}${teamPart}-${pad2(ri + 1)}`
        autoNumbered++
      }
      const plan = (r.plan ?? '').trim()
      // 원문에서 확인된 ID면 표준 칸을 코드가 직접 읽는다 — 재료는 상세 내용만
      const std = r.verifiedId ? readStandardFields(args.text, r.verifiedId) : null
      if (std?.detail) standard++
      const all = std?.detail ? candidateItems(std) : []
      // 전부 시스템 처리면 떼지 않는다 — 후보가 0이면 다듬기 대신 열린 생성으로 떨어진다
      const sys = all.filter(isSystemWork).length < all.length ? all.filter(isSystemWork) : []
      systemDropped += sys.length
      reqs.push({
        d1: group,
        d2: r.name as string,
        reqId,
        reqName: r.name as string,
        priority: '',
        difficulty: '',
        description: (r.description ?? '').trim(),
        extra: std?.detail || plan,
        items: all.filter((s) => !sys.includes(s)),
        systemItems: sys,
        note: std?.detail
          ? [
              std.plan && `[수행방안]${NL}${std.plan}`,
              std.constraints && `[고려/제약사항]${NL}${std.constraints}`
            ]
              .filter(Boolean)
              .join(NL + NL)
          : ''
      })
    })
  })

  const kept = reqs.length - autoNumbered
  notes.unshift(
    `AI 해석: ${chunks.length}개 구간 → 요구사항 ${reqs.length}건 · 액터 ${actorMap.size}명 · 대분류 ${groupOrder.length}개`
  )
  if (kept) notes.push(`원문에서 확인된 요구사항 ID ${kept}건은 그대로 사용`)
  if (autoNumbered) notes.push(`ID가 없는 ${autoNumbered}건은 규칙대로 자동 채번`)
  if (standard)
    notes.push(`${standard}건은 '요구사항 상세 내용'으로 유스케이스를 만들고, 수행방안·고려사항은 유스케이스 비고에 넣음`)
  if (systemDropped)
    notes.push(`시스템 처리로 보이는 항목 ${systemDropped}개(추출·연산·백업·로직 구현 등)는 유스케이스 후보에서 빼고 그 다이어그램 폼에 남김 — 거기서 유스케이스로 되살릴 수 있음`)
  const excludedIds = skipped ? excluded.map((x) => x.verifiedId || (x.name as string)) : []
  if (skipped)
    notes.push(
      `${skipped}건은 유스케이스로 그릴 수 없어 제외했습니다 (테스트·이관·성능목표 등): ${excludedIds.join(', ')}`
    )
  if (failed) notes.push(`${failed}개 구간은 해석에 실패해 건너뜀`)
  // 정의서 표의 행 중 결과 어디에도 없는 것 — 모델이 안 돌려줬거나 이름 필터·중복 제거에 걸렸다
  const seen = new Set([...reqs.map((r) => r.reqId), ...excludedIds])
  const missed = readStandardIds(args.text).filter((id) => !seen.has(id))
  if (missed.length) notes.push(`정의서 요구사항 ${missed.length}건은 해석 결과에 없습니다: ${missed.join(', ')}`)

  // 문서가 스스로 밝힌 이름이 있으면 그걸 쓴다 — 지어내지 않는다
  const meta = readDocumentMeta(args.text)
  if (meta.systemName) notes.push(`문서에서 시스템명을 읽었습니다: ${meta.systemName}`)

  return {
    systemName: meta.systemName,
    projectId: meta.projectId,
    reqs,
    actors: [...actorMap.values()],
    excluded: excludedIds,
    missed,
    notes
  }
}

/** AI 해석 결과 → 표준 블록 (이후 파이프라인은 기존과 동일) */
export function aiResultToBlocks(r: ExtractResult): string {
  const out: string[] = ['[모형기술서]', '1depth|2depth|요구사항ID|요구사항명']
  for (const q of r.reqs) out.push(`${q.d1}|${q.d2}|${q.reqId}|${q.reqName}`)

  if (r.actors.length) {
    out.push('', '[액터정의]', '구분|액터명|설명|비고')
    for (const a of r.actors) out.push(`${a.kind}|${a.name}|${a.description}|`)
  }

  const details = r.reqs
    .map((q) => {
      const parts = [q.reqId]
      if (q.description) parts.push(`description:${q.description}`)
      if (q.extra) parts.push(`main_flow:${q.extra.replace(/\r?\n/g, '\\n')}`)
      // 후보·비고는 맨 끝 — parseOutline 이 떼어 낸다 (항목 안의 `|` 는 줄 구분자와 겹쳐 `/` 로)
      if (q.items?.length) parts.push(`items:${q.items.map((s) => s.replace(/\|/g, '/')).join('\\n')}`)
      // 비고는 맨 끝 — parseOutline 이 떼어 내 모델에게는 주지 않는다
      if (q.note) parts.push(`note:${q.note.replace(/\r?\n/g, '\\n')}`)
      return parts.length > 1 ? parts.join('|') : ''
    })
    .filter(Boolean)
  if (details.length) out.push('', '[요구사항 상세]', ...details)

  return out.join('\n')
}

/**
 * 액터를 못 찾았을 때 본문 어휘로 추론.
 * 특정 사업 문서에 맞춘 규칙이었는데, 다른 사업 문서에서 전부 빗나갔다.
 * 도메인에 매이지 않도록 일반적인 역할 어휘로 다시 짰다.
 */
