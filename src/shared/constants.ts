import type { AppSettings, ColorKey, Difficulty, Priority, ProjectSettings } from './types'

/**
 * 팀별 색상 배정 팔레트.
 * 팀 코드는 사업마다 다르므로 고정 매핑을 둘 수 없다. 대신 프로젝트 안에서
 * **처음 나온 순서대로** 이 팔레트를 돌려 쓴다 — 같은 정의서를 다시 넣으면
 * 같은 색이 나오고(결정적), 팀이 6개를 넘으면 색이 반복된다.
 */
export const TEAM_PALETTE: ColorKey[] = ['yellow', 'purple', 'blue', 'green', 'orange', 'cyan']
export const COLOR_KEYS: ColorKey[] = ['yellow', 'purple', 'blue', 'green', 'orange', 'cyan', 'none']
export const PRIORITIES: Priority[] = ['High', 'Medium', 'Low']
export const DIFFICULTIES: Difficulty[] = ['상', '중', '하']

/** EA style 태그의 BackColor 값 (BGR 음수 정수) */
export const EA_COLOR_VALUE: Record<ColorKey, string> = {
  yellow: '-256',
  purple: '-8388480',
  orange: '-23296',
  blue: '-16776961',
  green: '-16744448',
  cyan: '-16711681',
  none: '-1'
}

/**
 * 화면 미리보기용 CSS 색상.
 * `none` 은 XMI 에 `-1`(EA 기본색)로 나가므로 EA 가 칠하는 **연한 노란색**이어야 한다.
 * 회색으로 그리면 화면과 EA 가 달라 보인다.
 */
export const CSS_COLOR: Record<ColorKey, string> = {
  yellow: '#ffe680',
  purple: '#d8b4fe',
  orange: '#fdba74',
  blue: '#93c5fd',
  green: '#86efac',
  cyan: '#67e8f9',
  none: '#ffffd7'
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  includeActorsInEachDiagram: true,
  layoutColumns: 3,
  layoutColWidth: 280,
  layoutRowHeight: 120,
  ucWidth: 140,
  ucHeight: 90
}

export const ACTOR_START: { x: number; y: number; gap: number } = { x: 50, y: 100, gap: 200 }
export const UC_START_X = 350
export const UC_START_Y = 80

export const DEFAULT_SETTINGS: AppSettings = {
  activeProvider: 'embedded',
  providers: {
    embedded: {
      id: 'embedded',
      label: '임베디드 (설치 불필요)',
      // 표시용 이름. 실제로 쓰는 것은 modelPath 가 가리키는 파일이다.
      model: 'qwen2.5-3b-instruct',
      modelPath: '',
      // 이 앱의 입력은 요구사항 본문 + 시스템 프롬프트라 2048 로는 잘린다.
      numCtx: 8192,
      temperature: 0.2,
      maxTokens: 8192
    }
  },
  systemPrompt: '',
  generationStrategy: 'auto',
  lastProjectPath: null
}

/** 엑셀 매핑에 사용하는 논리 필드 정의 */
export const OUTLINE_FIELDS = ['depth1', 'depth2', 'reqId', 'reqName'] as const
export const ACTOR_FIELDS = ['kind', 'name', 'description', 'note'] as const
export const DETAIL_FIELDS = [
  'reqId',
  'priority',
  'difficulty',
  'description',
  'mainFlow',
  'altFlow',
  'precondition',
  'postcondition'
] as const

export const FIELD_LABEL: Record<string, string> = {
  depth1: '1depth (대분류)',
  depth2: '2depth (중분류)',
  reqId: '요구사항ID',
  reqName: '요구사항명',
  kind: '구분(Primary/Secondary)',
  name: '액터명',
  description: '설명',
  note: '비고',
  priority: '우선순위',
  difficulty: '난이도',
  mainFlow: '주 흐름',
  altFlow: '대안 흐름',
  precondition: '사전조건',
  postcondition: '사후조건'
}

export const PROJECT_FILE_EXT = 'eaucs'

/**
 * 유스케이스에 액터를 고르는 규칙 — 생성(actorfill)과 되살리기(store)가 같이 쓴다.
 * 등록·관리·설정류 일이면 관리 쪽 액터, 그 밖은 사용 쪽 액터.
 */
export const ADMIN_ROLE = /(관리자|담당자|운영자)$/
export const ADMIN_VERB = /(등록|관리|설정|수정|삭제|승인|발송|배포|편집|통계|모니터링)/
export const isAdminActor = (name: string): boolean => ADMIN_ROLE.test(name.replace(/\s+/g, ''))

/** 이름 끝의 "기능/구현/제공/개발" 꼬리말을 뗀다 — 모델이 지시를 자주 어겨 코드가 한 번 더. 꼬리말뿐이면 '' */
export const trimTail = (name: string): string =>
  name.replace(/(\s*(기능|구현|제공|개발)\s*)+[.]?$/, '').trim()

/**
 * 상세 내용 항목 글 → 유스케이스 이름 — 생성(모델이 빠뜨린 항목)과 되살리기(store)가 같이 쓴다.
 * 세부(` / ` 뒤)·괄호 설명·꼬리말을 뗀다. 꼬리말뿐이면 글 그대로.
 * 머리말이 같은 요구사항의 다른 항목이나 요구사항명(others)과 같으면 묶음 제목이라 둘째 토막(● 줄)을 이름으로 쓴다.
 */
const itemSeg = (seg: string): string =>
  seg.replace(/^[●○■‐-]\s*/, '').replace(/\([^)]*\)?/g, ' ').replace(/\s+/g, ' ').trim()
export const itemHead = (item: string): string => itemSeg(item.split(' / ')[0])
export const itemName = (item: string, others: string[] = []): string => {
  const [head, second] = item.split(' / ')
  const shared = second && others.some((s) => s !== item && s.split(' / ')[0].trim() === head.trim())
  const base = itemSeg(shared ? second : head)
  return trimTail(base) || base
}
