import type { ProviderId } from '@shared/types'
import { embeddedProvider } from './embedded'
import type { LlmProvider } from './types'

/**
 * 프로바이더 레지스트리 — **임베디드 하나뿐이다.**
 *
 * 한동안 Ollama · OpenAI 호환 · Anthropic · Google 넷을 함께 뒀다. 고를 수 있다는
 * 건 좋은 일 같았지만 실제로는 설정 탭에 엔드포인트 · API 키 · 모델명 · 폐쇄망
 * 경고가 프로바이더마다 따로 붙고, 문서도 "어느 프로바이더를 쓰느냐에 따라" 로
 * 갈라졌다. 정작 납품 대상에서 쓰는 건 하나다.
 *
 * 임베디드는 `.gguf` 파일 하나만 있으면 되고 설치도 서버도 필요 없다. 그래서
 * 나머지를 지웠다 — 고를 것이 없으면 틀릴 것도 없다.
 * (다시 필요해지면 파일 하나 + 여기 한 줄이다. 그 구조는 그대로 남겨 뒀다.)
 */
const REGISTRY: Record<ProviderId, LlmProvider> = {
  embedded: embeddedProvider
}

export function getProvider(id: ProviderId): LlmProvider {
  const p = REGISTRY[id]
  if (!p) throw new Error(`알 수 없는 프로바이더: ${id}`)
  return p
}

export { LlmError } from './types'
export type { LlmProvider, GenerateArgs } from './types'
