import type { ProviderConfig } from '@shared/types'

export interface GenerateArgs {
  system: string
  user: string
  config: ProviderConfig
  /**
   * 이 호출에만 적용할 출력 상한. 없으면 config.maxTokens.
   *
   * 호출마다 만들 것의 크기가 열 배씩 다르다 — 문서 해석은 KB 단위 JSON이고
   * 요구사항 1건의 유스케이스는 300~800바이트다. 그런데 같은 config 를 쓰면
   * 작은 호출도 상한까지 쓸 수 있어서, 모델이 같은 객체를 반복 생성하기
   * 시작하면 그 한도까지 계속 찍어 낸다. 호출별로 조여 준다.
   */
  maxTokens?: number
  signal?: AbortSignal
  /** 스트리밍 토큰 콜백 (진행 표시용) */
  onDelta?: (chunk: string) => void
}

export interface LlmProvider {
  id: string
  /** 원시 텍스트 응답 반환 */
  generate(args: GenerateArgs): Promise<string>
  /** 연결 확인 — 성공 시 모델 정보 */
  ping(config: ProviderConfig): Promise<string>
  /**
   * 호출을 시작하기 전에 설정만으로 알 수 있는 문제를 걸러낸다.
   *
   * 없으면 이런 일이 벌어진다: 모델 파일이 지정되지 않았는데 문서 해석이
   * 시작되어 구간 5개 × 재시도 2회 = **열 번을 헛돌고** 나서야
   * "5개 구간 모두 실패했습니다" 라고 알린다. 사용자는 문서를 의심하게 된다.
   * 설정만 보면 아는 문제는 시작 전에 말해야 한다.
   */
  precheck?(config: ProviderConfig): void
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'LlmError'
  }
}
