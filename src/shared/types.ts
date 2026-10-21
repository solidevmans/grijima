/**
 * EA UseCase Studio 도메인 모델
 *
 * 계층 구조 (EA 패키지 트리와 1:1 대응)
 *   Project
 *     └ UcPackage  (UCD = 화면·기능 묶음) → EA 패키지  ex) [UCD-SFR-001-SAD(서비스개발)-03] 통합검색
 *         ├ Diagram[]  (1..N)             → EA 유스케이스 다이어그램
 *         └ UseCase[]                     → EA UseCase 요소 (namespace = 패키지)
 *     └ Actor[]                           → EA "Actors" 패키지
 *
 * 대분류(GRP) 계층은 없다 — 표준 EA 산출물이 `Use Case Model` 바로 아래에 UCD를
 * 평면으로 나열한다.
 *
 * ★ **UCD는 "요구사항 1건"이 아니다.**
 *   실제 유스케이스모형기술서를 보면 UCD는 화면·기능 묶음이고, 그 안에 **여러
 *   요구사항의 유스케이스가 섞여 들어간다.**
 *     [UCD-SFR-005-SAD(서비스개발)-02] 메인화면
 *       ├ UC-SFR-005-SAD(서비스개발)-02-01  대국민 메인화면
 *       ├ UC-SFR-005-SAD(서비스개발)-02-02  공무원 메인화면
 *       └ UC-SFR-001-SAD(서비스개발)-05-01  공지팝업   ← 다른 요구사항
 *   그래서 요구사항 ID는 **유스케이스마다** 들고, 패키지의 reqId 는 코드를 만드는
 *   "대표 요구사항"일 뿐이다. 유스케이스를 다른 UCD로 옮겨도 코드는 그대로다.
 *
 * 생성 직후에는 요구사항 1건이 UCD 1개로 떨어진다(모델이 요구사항 단위로 돌기
 * 때문). 화면 단위로 묶는 건 편집 탭에서 UCD를 만들고 유스케이스를 옮기면 된다.
 *
 * 유스케이스는 **패키지에 속하고 다이어그램에 그려진다**(EA와 같은 구조).
 * 그래서 useCases[] 는 패키지가 들고, 각 UseCase 가 diagramUid 로 자기가 그려질
 * 다이어그램을 가리킨다. 다이어그램이 여러 개인 패키지는 UC 코드의 첫 번째
 * 순번으로 갈린다: UC-{요구사항ID}-{다이어그램순번}-{UC순번}
 *
 * 규칙: 화면에 보이는 모든 값은 이 모델에 저장되고, XMI는 이 모델에서만 생성된다.
 *      (LLM 출력은 이 모델로 "정규화"된 뒤 버려진다 → 이후 수정은 전부 수동 편집)
 */

/**
 * 요구사항 ID에 붙는 수행 팀.
 *   SFR-001-PAD(플랫폼기반)-02  →  { code: 'PAD',  name: '플랫폼기반' }
 *   SFR-021-ADT1(맞춤형)        →  { code: 'ADT1', name: '맞춤형' }
 *
 * 팀 코드는 **사업마다 다르다.** 예전에는 PAD/SAD/RPT/INF 를 상수로 박아두고
 * 그 목록에 없으면 ETC(무색)로 떨궜는데, 다른 사업 문서를 넣으면 전부 ETC가 됐다.
 * 목록을 늘리는 건 답이 아니다 — 문서에서 읽어낸다.
 */
export interface Team {
  /** 팀 코드. 없으면 빈 문자열 */
  code: string
  /** 괄호 안 팀 이름. 없으면 빈 문자열 */
  name: string
}

export type ColorKey = 'yellow' | 'purple' | 'blue' | 'green' | 'orange' | 'cyan' | 'none'
export type Priority = 'High' | 'Medium' | 'Low'
export type Difficulty = '상' | '중' | '하'
export type ActorKind = 'Primary' | 'Secondary'

export interface Point {
  x: number
  y: number
}

export interface Actor {
  /** 내부 고유 ID(uuid). XMI GUID 채번 시드로 사용되므로 절대 재생성하지 말 것 */
  uid: string
  name: string
  description: string
  kind: ActorKind
  /** 외부 시스템 액터 여부 (Secondary 표기용) */
  external: boolean
  /** Actors 다이어그램 및 각 UCD에서의 기본 좌표 */
  position: Point
  /** 사전 없이 정의서에서 추정한 액터 — 사람이 이름을 고치면 꺼진다. 내보내기에는 안 나간다 */
  guessed?: boolean
}

export interface UseCase {
  uid: string
  /**
   * 유스케이스 ID. ex) UC-SFR-001-SAD(서비스개발)-03-01
   * `UC-{이 유스케이스의 요구사항ID}-{순번2}` — 두 자리 하나만 붙는다.
   * 순번은 **요구사항 ID 안에서** 매긴다(패키지·다이어그램과 무관).
   */
  code: string
  /**
   * 이 유스케이스의 원본 요구사항 ID. ex) SFR-001-SAD(서비스개발)-05
   * 소속 UCD의 대표 요구사항과 **다를 수 있다** — 기술서에서 실제로 그렇다.
   */
  reqId: string
  /** 이 유스케이스가 그려질 다이어그램 uid (같은 패키지 안) */
  diagramUid: string
  name: string
  priority: Priority
  difficulty: Difficulty
  description: string
  /** 주 흐름. 줄바꿈(\n) 구분 */
  mainFlow: string
  /** 대체흐름 */
  altFlow: string
  /** 예외흐름 — 기술서 양식의 3번째 흐름. 실패·오류 경로 */
  exceptionFlow: string
  precondition: string
  postcondition: string
  /** 특별요구사항 — 흐름에 담기지 않는 제약(로그 저장, 집계 기준 등) */
  specialRequirement: string
  /** 비고 / 수행방안 등 자유 메모 */
  note: string
  /** 이 유스케이스와 연결되는 액터 uid 목록 (Association) */
  actorUids: string[]
  /** <<include>> 대상 유스케이스 uid */
  includeUids: string[]
  /** <<extend>> 대상 유스케이스 uid */
  extendUids: string[]
  /** 다이어그램 내 좌표. 미지정이면 자동 배치 */
  position: Point | null
  /** 모델이 정의서 상세 내용 항목에 없이 더한 유스케이스 — 사람이 이름을 고치면 꺼진다. 내보내기에는 안 나간다 */
  invented?: boolean
  /** 이 유스케이스가 담은 정의서 상세 내용 항목(글 그대로) — 다이어그램 `items` 중 빠진 것을 점검이 센다 */
  sources?: string[]
}

/** 유스케이스 다이어그램. 패키지 하나에 1..N개 */
export interface Diagram {
  uid: string
  /** 패키지 안에서의 순번(1부터). UC 코드의 첫 번째 번호가 된다 */
  seq: number
  /** 다이어그램 이름. 비어 있으면 `[{패키지코드}-{seq2}] {패키지명}` 자동 생성 */
  name: string
  /**
   * 이 다이어그램에서의 액터 좌표 (actorUid → 좌표).
   * 액터는 여러 다이어그램에 동시에 등장하므로 좌표를 전역으로 두면
   * 한 다이어그램에서 옮긴 위치가 다른 다이어그램을 망가뜨린다.
   * 지정이 없으면 "이 다이어그램에서 쓰이는 액터들" 안에서의 순번으로 자동 배치.
   */
  actorPositions?: Record<string, Point>
  /**
   * 유스케이스에 연결되지 않았지만 이 다이어그램에 직접 올려 둔 액터.
   * 팔레트에서 캔버스로 끌어다 놓으면 여기 들어간다.
   */
  extraActorUids?: string[]
  /**
   * 생성이 시스템 내부 처리(추출·백업·로직 구현 등)로 보고 유스케이스에서 뺀 후보 이름.
   * 판단은 사람마다 다르니 지우지 않고 남겨, 다이어그램 폼에서 하나씩 유스케이스로 되살린다.
   * EA로는 나가지 않는다.
   */
  systemItems?: string[]
  /** 생성 때 이 다이어그램 행의 상세 내용 항목(시스템 처리·수행방안 뺀 것). EA로는 나가지 않는다 */
  items?: string[]
}

/** 요구사항 1건 = EA 패키지 1개 (UCD) */
export interface UcPackage {
  uid: string
  /**
   * 패키지 ID. ex) UCD-SFR-021-ADT1(맞춤형)
   * 요구사항 ID를 **원문 그대로** 붙인다 — 괄호·한글을 깎지 않는다.
   * (표준 산출물이 원문을 유지하고, 추적성이 그 문자열로 걸린다)
   */
  code: string
  /**
   * 대표 요구사항 ID — 패키지 코드를 만드는 값.
   * 이 UCD에 담긴 유스케이스가 전부 이 요구사항인 것은 아니다.
   * ex) SFR-001-SAD(서비스개발)-03
   */
  reqId: string
  /**
   * UCD 이름. 화면·기능 단위의 **짧은 명사구**여야 한다.
   * ex) 통합검색 / 메인화면 / 대국민 대시보드 / 영향체인
   * 요구사항 문장을 통째로 넣으면 EA 패키지 이름이 70자를 넘어 읽을 수 없다.
   */
  name: string
  /** UCD 개요 — 기술서의 패키지 단위 설명 문단 */
  description: string
  /** 요구사항 ID에서 파싱한 수행 팀 */
  team: Team
  /** EA 요소 배경색. 기본값은 팀별로 자동 배정되고 사용자가 바꿀 수 있다 */
  color: ColorKey
  diagrams: Diagram[]
  useCases: UseCase[]
}

export interface ProjectMetadata {
  systemName: string
  projectId: string
  author: string
  createdAt: string
  modifiedAt: string
  /**
   * 생성이 "유스케이스로 그릴 수 없다"고 빼 둔 정의서 요구사항(ID 없으면 이름).
   * 알림은 사라지므로 프로젝트에 남겨 내보내기 점검이 계속 말하게 한다.
   */
  excludedReqs?: string[]
  /** 정의서 표에 행 ID가 있는데 해석 결과에 아예 없던 요구사항 — 모델이 판단해 뺀 것과 구분 */
  missedReqs?: string[]
  /** 위 두 목록의 ID → 정의서의 요구사항명 — 점검 카드가 ID만 보여 주면 넣을지 판단할 수 없다 */
  reqNames?: Record<string, string>
}

export interface ProjectSettings {
  /** 액터를 각 UCD에 함께 그릴지 여부 */
  includeActorsInEachDiagram: boolean
  /** 자동 배치 열 개수 */
  layoutColumns: number
  layoutColWidth: number
  layoutRowHeight: number
  /** 유스케이스 노드 크기 */
  ucWidth: number
  ucHeight: number
}

export interface Project {
  /** 2 = 대분류(Group) 제거, 요구사항 1건 = UCD 패키지 구조 */
  schemaVersion: 2
  metadata: ProjectMetadata
  actors: Actor[]
  packages: UcPackage[]
  settings: ProjectSettings
}

/* ------------------------------------------------------------------ */
/* LLM 원시 출력 (정규화 전)                                            */
/* ------------------------------------------------------------------ */

export interface RawUseCase {
  usecase_id?: string
  req_id?: string
  name?: string
  priority?: string
  difficulty?: string
  description?: string
  main_flow?: string
  alt_flow?: string
  exception_flow?: string
  special_requirement?: string
  precondition?: string
  postcondition?: string
  /** 비고 — 모델이 아니라 코드가 채운다(정의서의 수행방안·고려사항) */
  note?: string
  actors?: string[]
  /** 코드가 단다 — 모델이 후보(from) 없이 지어낸 것 */
  invented?: boolean
  /** 코드가 단다 — from 이 가리킨 후보 글 */
  sources?: string[]
}

export interface RawSubPackage {
  sub_seq?: string
  sub_name?: string
  package_id?: string
  diagram_name?: string
  usecases?: RawUseCase[]
}

/**
 * 요구사항 1건 = UCD 패키지 1개.
 * `usecases` 가 정식이고, `sub_packages`/`tasks` 는 구버전(3계층) 스키마 호환용이다.
 * 구버전이 들어오면 하위 유스케이스를 전부 이 요구사항 아래로 펼쳐 넣는다.
 */
export interface RawRequirement {
  req_id?: string
  req_name?: string
  /** UCD 개요 (기술서의 패키지 단위 설명) */
  description?: string
  work_type?: string
  color?: string
  usecases?: RawUseCase[]
  /** 구버전 3계층 스키마 호환 (평탄화해서 흡수) */
  sub_packages?: RawSubPackage[]
  tasks?: RawSubPackage[]
}

export interface RawActor {
  name?: string
  description?: string
  kind?: string
  external?: boolean
}

export interface RawAnalysis {
  metadata?: { system_name?: string; project_id?: string }
  requirements?: RawRequirement[]
  actors?: RawActor[]
}

/* ------------------------------------------------------------------ */
/* 엑셀 가져오기                                                        */
/* ------------------------------------------------------------------ */

export interface SheetData {
  name: string
  headers: string[]
  rows: string[][]
}

export interface WorkbookData {
  filePath: string
  sheets: SheetData[]
}

/** 시트/컬럼 → 논리 블록 매핑 */
export interface ColumnMap {
  [logicalField: string]: number | null
}

export interface BlockMapping {
  sheetName: string | null
  columns: ColumnMap
}

export interface ImportMapping {
  /** 1depth|2depth|요구사항ID|요구사항명 */
  outline: BlockMapping
  /** 구분|액터명|설명|비고 */
  actors: BlockMapping
  /** 요구사항ID|우선순위|난이도|설명|주흐름|사전조건|사후조건 */
  detail: BlockMapping
}

/* ------------------------------------------------------------------ */
/* LLM 설정                                                            */
/* ------------------------------------------------------------------ */

/**
 * LLM 프로바이더 — **임베디드 하나뿐이다.**
 * 앱 안에서 직접 추론하므로 밖으로 나가는 통신이 없다.
 */
export type ProviderId = 'embedded'

export type GenerationStrategy = 'auto' | 'full'

export interface ProviderConfig {
  id: ProviderId
  label: string
  model: string
  /**
   * 모델 파일(.gguf) 경로.
   * Ollama 가 받아 둔 blob 도 그대로 gguf 라 그 경로를 가리켜도 된다.
   */
  modelPath?: string
  /** 컨텍스트 길이 (토큰). 입력이 이보다 길면 앞부분이 조용히 잘린다 */
  numCtx?: number
  temperature: number
  maxTokens: number
}

export interface AppSettings {
  activeProvider: ProviderId
  providers: Record<ProviderId, ProviderConfig>
  /** 커스텀 시스템 프롬프트. 비어 있으면 기본 프롬프트 사용 */
  systemPrompt: string
  /**
   * 생성 전략 — 모델이 한 번에 감당할 출력 크기에 맞춰 고른다.
   *   auto : 문서를 AI가 해석한 뒤 **요구사항 1건씩** 호출한다. 계층·ID·패키지
   *          트리는 앱이 만들고 모델은 유스케이스만 뽑으므로 3B급도 완주한다.
   *   full : 전체를 한 번에. 14B급 이상 모델이 있을 때만 쓸 것.
   */
  generationStrategy: GenerationStrategy
  lastProjectPath: string | null
}

/* ------------------------------------------------------------------ */
/* 검증                                                                */
/* ------------------------------------------------------------------ */

export type IssueLevel = 'error' | 'warn' | 'info'

export interface ValidationIssue {
  level: IssueLevel
  code: string
  message: string
  /** 클릭 시 이동할 대상 */
  target?: { packageUid?: string; diagramUid?: string; useCaseUid?: string; actorUid?: string }
  /** 클릭 시 가져오기 탭 원문에서 찾을 요구사항 ID — 트리에 없는 것(뺀 요구사항) */
  sourceId?: string
}

/* ------------------------------------------------------------------ */
/* IPC 공통 결과                                                        */
/* ------------------------------------------------------------------ */

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface ExportSummary {
  filePath: string
  packages: number
  useCases: number
  actors: number
  associations: number
  diagrams: number
  bytes: number
}

/** 마크다운 볼트 내보내기 결과 */
export interface VaultSummary {
  dirPath: string
  notes: number
  packages: number
  diagrams: number
  useCases: number
  actors: number
  bytes: number
}

/** 프로젝트 통째로(zip) 내보내기 결과 */
export interface BundleSummary {
  filePath: string
  /** zip 안에 담긴 파일 수 (xmi · 그림 · index.md · 프로젝트 원본) */
  files: number
  /** 그림 장수 (png·svg 한 쌍을 1장으로 센다) */
  images: number
  bytes: number
}

/* ------------------------------------------------------------------ */
/* AI 문서 해석 결과                                                    */
/* ------------------------------------------------------------------ */

export interface ExtractedReq {
  /** 상위 분류 (대분류) */
  d1: string
  /** 중분류 = 다이어그램 이름 */
  d2: string
  reqId: string
  reqName: string
  priority: string
  difficulty: string
  description: string
  /** 수행방안 등 유스케이스 생성의 재료 */
  extra: string
  /** 상세 내용의 번호 항목 = 유스케이스 후보. 표준 칸을 못 찾았으면 비어 있다 */
  items?: string[]
  /** 시스템 처리로 보고 후보에서 뺀 항목 — 생성이 그 행의 다이어그램에 남긴다 */
  systemItems?: string[]
  /** 표준 양식의 수행방안·고려/제약사항 — 재료가 아니라 유스케이스 비고로 간다 */
  note: string
}

export interface ExtractedActor {
  name: string
  description: string
  kind: string
}

export interface ExtractResult {
  systemName: string
  projectId: string
  reqs: ExtractedReq[]
  actors: ExtractedActor[]
  /** 모델이 `usecase:false` 로 뺀 요구사항 — ID(없으면 이름) */
  excluded: string[]
  /** 정의서 표에 행 ID가 있는데 해석 결과(reqs·excluded)에 없는 것 */
  missed: string[]
  /** 해석 과정 로그 — 사용자에게 무엇을 어떻게 읽었는지 알린다 */
  notes: string[]
}
