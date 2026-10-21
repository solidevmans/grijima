import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ProviderConfig } from '@shared/types'
import { LlmError, type GenerateArgs, type LlmProvider } from './types'

/**
 * 임베디드 모델 프로바이더 — `node-llama-cpp` 로 **앱 안에서 직접** 추론한다.
 *
 * 왜 두는가:
 *   Ollama 경로는 사용자가 (1) Ollama 를 설치하고 (2) 모델을 받고
 *   (3) `ollama serve` 를 띄워야 동작한다. 폐쇄망에서는 여기에
 *   `%USERPROFILE%\.ollama\models` 를 manifest 경로까지 맞춰 복사하는 단계가
 *   더 붙는데, 그게 반입 과정에서 가장 자주 깨진다.
 *   여기서는 `.gguf` 파일 하나만 가리키면 끝이다.
 *
 * 왜 서버가 아니라 인프로세스인가:
 *   llama-server 를 자식 프로세스로 띄우면 localhost 포트를 연다. 기관 PC 에서는
 *   그 순간 방화벽 팝업이 뜨고, 막히면 원인을 찾기 어렵다. 포트를 안 연다.
 *
 * ⚠ 네이티브 바이너리라 **코드 서명 정책의 영향을 받는다.**
 *   Windows 의 Smart App Control / WDAC 가 켜져 있으면 서명되지 않은
 *   `llama-addon.node` 로드가 차단된다("An Application Control policy has
 *   blocked this file"). 그 경우 ping 이 그 사실을 그대로 알려주고, 사용자는
 *   그 사실을 그대로 알려 준다 — 앱이 죽지는 않고, 편집·XMI 생성은 계속 된다.
 */

/* ------------------------------------------------------------------ */
/* 모듈 로딩 — ESM 전용 패키지라 동적 import 로 가져온다                  */
/* ------------------------------------------------------------------ */

type LlamaModule = typeof import('node-llama-cpp')

let modulePromise: Promise<LlamaModule> | null = null

/**
 * `node-llama-cpp` 는 ESM 전용이고 메인 프로세스 번들은 CJS 다.
 * 정적 import 는 번들 시점에 깨지므로 런타임 동적 import 로 가져온다.
 * (electron.vite.config 의 externalizeDepsPlugin 이 외부 의존성으로 남겨 둔다)
 */
async function loadModule(): Promise<LlamaModule> {
  if (!modulePromise) {
    modulePromise = import('node-llama-cpp').catch((e) => {
      modulePromise = null
      throw new LlmError(
        '모델 모듈을 불러오지 못했습니다.' +
          NL +
          describeBinaryFailure(e) +
          NL +
          'LLM 없이도 JSON 직접 입력 · 빈 프로젝트로 시작 · 기존 .eaucs 열기 로 ' +
          '편집과 XMI 생성은 그대로 됩니다.',
        'embedded',
        e
      )
    })
  }
  return modulePromise
}

const NL = String.fromCharCode(10)

/**
 * 생성 시드. 고정값이라 **같은 입력이면 같은 결과**가 나온다.
 * 숫자 자체에 의미는 없다 — 바뀌지 않는다는 점이 중요하다.
 */
const SEED = 20260101

/**
 * llama.cpp 가 모델을 올릴 때마다 뱉는, 알려진 무해한 경고들.
 *
 * `control-looking token: 128247 '</s>' was not control-type` 는 GGUF 의 토크나이저
 * 메타데이터가 관례와 다를 때 나오고 **llama.cpp 가 알아서 고쳐 쓴다.** 동작에
 * 영향이 없는데 모델을 올릴 때마다 찍혀서, 진짜 봐야 할 로그를 덮는다.
 * 통째로 로그를 끄면 나중에 진짜 문제가 생겼을 때 아무것도 안 보이므로,
 * **아는 것만 골라 버리고 나머지는 그대로 올린다.**
 */
const KNOWN_HARMLESS = [/control-looking token/i, /was not control-type/i]

const LLAMA_OPTIONS = {
  build: 'never',
  logLevel: 'warn',
  logger: (level: unknown, message: string): void => {
    if (KNOWN_HARMLESS.some((re) => re.test(message))) return
    console.log('[llama]', message)
  }
} as never

/**
 * 바이너리 로드 실패는 원인이 몇 가지로 정해져 있다. 스택을 그대로 보여주면
 * 사용자가 할 수 있는 게 없으므로, 아는 원인은 할 일까지 함께 적는다.
 */
function describeBinaryFailure(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/Application Control policy/i.test(msg)) {
    return (
      '이 PC 의 Windows 응용 프로그램 제어 정책(Smart App Control 등)이 ' +
      '서명되지 않은 네이티브 모듈 로드를 차단했습니다.'
    )
  }
  if (/NoBinaryFound/i.test(msg)) {
    return '이 플랫폼용으로 미리 빌드된 바이너리를 찾지 못했습니다.'
  }
  return msg.split(NL)[0]
}

/* ------------------------------------------------------------------ */
/* 모델 캐시                                                           */
/* ------------------------------------------------------------------ */

interface Session {
  prompt(text: string, opts: Record<string, unknown>): Promise<string>
  dispose(opts?: { disposeSequence?: boolean }): Promise<void>
}

interface Loaded {
  modelPath: string
  contextSize: number
  /** node-llama-cpp 의 구체 타입은 동적 import 라 여기서는 최소 형태만 쓴다 */
  model: { dispose(): Promise<void> }
  context: { getSequence(): unknown; dispose(): Promise<void> }
  /**
   * 세션을 새로 만든다.
   *
   * 컨텍스트가 내주는 **시퀀스 수가 유한하다**(기본 1개). 세션은 만들 때
   * 시퀀스를 하나 가져가므로, 다 쓰고 `dispose({disposeSequence:true})` 로
   * 반납하지 않으면 두 번째 호출이 "No sequences left" 로 죽는다.
   */
  makeSession: (systemPrompt?: string) => Session
}

let loaded: Loaded | null = null
/** 한 번에 한 요청만 — 컨텍스트 시퀀스를 공유하므로 겹치면 응답이 섞인다 */
let busy: Promise<unknown> = Promise.resolve()

/* ------------------------------------------------------------------ */
/* 동봉된 모델 찾기                                                     */
/* ------------------------------------------------------------------ */

/**
 * 모델은 **앱에 들어 있다.** 사용자가 고르는 것이 아니다 — 그래서 임베디드다.
 *
 * 찾는 곳:
 *   설치본  `<설치경로>/resources/model/*.gguf`  (electron-builder extraResources)
 *   개발    `<저장소>/resources/model/*.gguf`
 *
 * `process.resourcesPath` 는 Electron 이 채워 준다. 스크립트에서 순수 node 로
 * 돌릴 때는 없으므로 저장소 경로로 떨어진다.
 */
function bundledModelDirs(): string[] {
  const dirs: string[] = []
  const rp = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (rp) dirs.push(join(rp, 'model'))
  dirs.push(join(process.cwd(), 'resources', 'model'))
  return dirs
}

/** 동봉된 `.gguf` 하나를 찾는다. 여러 개면 이름순 첫 번째 */
export function findBundledModel(): string | null {
  for (const dir of bundledModelDirs()) {
    if (!existsSync(dir)) continue
    const hit = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.gguf'))
      .sort()[0]
    if (hit) return join(dir, hit)
  }
  return null
}

export interface ModelInfo {
  path: string
  name: string
  sizeGb: string
  /** bundled = 앱에 들어 있는 것, custom = 사용자가 따로 지정한 것 */
  source: 'bundled' | 'custom'
}

/**
 * 지금 쓸 모델. **설정이 비어 있는 것이 정상이다** — 그러면 동봉된 것을 쓴다.
 * 설정에 경로가 있으면 그것을 우선한다(다른 모델로 바꿔 보고 싶을 때의 도피구).
 */
export function resolveModel(config: ProviderConfig): ModelInfo | null {
  const custom = (config.modelPath ?? '').trim()
  const path = custom || findBundledModel()
  if (!path || !existsSync(path)) return null
  return {
    path,
    name: basename(path),
    sizeGb: (statSync(path).size / 1024 ** 3).toFixed(1),
    source: custom ? 'custom' : 'bundled'
  }
}

function resolveModelPath(config: ProviderConfig): string {
  const info = resolveModel(config)
  if (info) return info.path

  const custom = (config.modelPath ?? '').trim()
  if (custom) {
    throw new LlmError(
      `지정하신 모델 파일을 찾을 수 없습니다: ${custom}` +
        NL +
        '설정 탭에서 경로를 지우면 앱에 동봉된 모델을 씁니다.',
      'embedded'
    )
  }
  throw new LlmError(
    '앱에 동봉된 모델 파일을 찾지 못했습니다.' +
      NL +
      '설치가 불완전하거나 빌드 시 모델이 포함되지 않았습니다.' +
      NL +
      '(모델 없이도 JSON 직접 입력 · 빈 프로젝트 · 기존 .eaucs 열기 로 편집과 XMI 생성은 됩니다)',
    'embedded'
  )
}

/**
 * 모델을 올린다. **한 번 올린 것은 계속 들고 있는다** — 요구사항 16건이면
 * 호출이 17번이라 매번 1.9GB 를 다시 읽으면 못 쓴다.
 * 경로나 컨텍스트 길이가 바뀌면 내리고 다시 올린다.
 */
async function ensureLoaded(config: ProviderConfig): Promise<Loaded> {
  const modelPath = resolveModelPath(config)
  const contextSize = config.numCtx ?? 8192

  if (loaded && loaded.modelPath === modelPath && loaded.contextSize === contextSize) {
    return loaded
  }
  await unload()

  const { getLlama, LlamaChatSession } = await loadModule()
  try {
    const llama = await getLlama(LLAMA_OPTIONS)
    const model = await llama.loadModel({
      modelPath,
      // GPU 에 올릴 수 있는 만큼 올리고, 안 되면 CPU 로 떨어진다
      gpuLayers: 'auto'
    })
    const context = await model.createContext({ contextSize })
    // 시스템 프롬프트는 전용 옵션으로 넘긴다 — 모델의 채팅 템플릿이 적용된다.
    // 사용자 프롬프트 앞에 붙여 버리면 instruct 모델이 역할을 구분하지 못한다.
    const makeSession = (systemPrompt?: string): Session =>
      new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt
      }) as unknown as Session

    loaded = {
      modelPath,
      contextSize,
      model: model as unknown as Loaded['model'],
      context: context as unknown as Loaded['context'],
      makeSession
    }
    return loaded
  } catch (e) {
    await unload()
    throw new LlmError(
      '모델을 올리지 못했습니다: ' + basename(modelPath) + NL + describeBinaryFailure(e),
      'embedded',
      e
    )
  }
}

async function unload(): Promise<void> {
  const cur = loaded
  loaded = null
  if (!cur) return
  try {
    await cur.context.dispose()
    await cur.model.dispose()
  } catch {
    /* 내리는 중 오류는 무시 — 어차피 버리는 자원이다 */
  }
}

/* ------------------------------------------------------------------ */

export const embeddedProvider: LlmProvider = {
  id: 'embedded',

  /** 모델 파일이 있는지만 본다 — 여기서 걸리면 호출을 아예 시작하지 않는다 */
  precheck(config: ProviderConfig): void {
    resolveModelPath(config)
  },

  async generate({ system, user, config, maxTokens, signal, onDelta }: GenerateArgs): Promise<string> {
    const run = busy.then(async () => {
      const l = await ensureLoaded(config)
      /*
       * 호출마다 세션을 새로 만든다.
       * 이 앱의 호출은 서로 독립이다(요구사항 A 의 답이 요구사항 B 에 섞이면
       * 안 된다). 대화를 이어갈 이유가 없고, 이어가면 컨텍스트만 찬다.
       */
      const session = l.makeSession(system)
      try {
        return await session.prompt(user, {
          maxTokens: maxTokens ?? config.maxTokens,
          temperature: config.temperature,
          /*
           * 시드를 고정한다.
           *
           * 없으면 **같은 문서를 두 번 넣어도 결과가 달라진다.** 실제로 같은
           * 요구사항을 한 번은 유스케이스로 만들고 다음엔 "그릴 수 없음" 으로
           * 판정한 적이 있다. 사용자는 앱이 고장났다고 생각하고, 프롬프트를
           * 고쳤을 때 나아진 건지 운이 좋았던 건지도 구분할 수 없다.
           * 초안 생성 도구에 필요한 건 다양성이 아니라 재현성이다.
           */
          seed: SEED,
          signal,
          onTextChunk: onDelta
        })
      } finally {
        // 시퀀스를 반납하지 않으면 다음 호출이 "No sequences left" 로 죽는다
        await session.dispose({ disposeSequence: true })
      }
    })
    busy = run.catch(() => undefined)

    try {
      const out = await run
      if (!out.trim()) throw new LlmError('모델이 빈 응답을 반환했습니다.', 'embedded')
      return out
    } catch (e) {
      if (e instanceof LlmError) throw e
      if (signal?.aborted) throw e
      throw new LlmError(describeBinaryFailure(e), 'embedded', e)
    }
  },

  async ping(config: ProviderConfig): Promise<string> {
    const info = resolveModel(config)
    if (!info) resolveModelPath(config) // 던진다

    const { getLlama } = await loadModule()
    const llama = await getLlama(LLAMA_OPTIONS)
    const gpu = llama.gpu === false ? 'CPU' : String(llama.gpu).toUpperCase()

    // 실제로 올려 본다 — 파일이 있어도 형식이 아니면 여기서 걸린다
    await ensureLoaded(config)
    const m = info as ModelInfo
    return `모델 OK — ${m.name} (${m.sizeGb}GB), ${gpu}, 컨텍스트 ${config.numCtx ?? 8192}`
  }
}

/** 설정이 바뀌어 모델을 내려야 할 때 (설정 저장 시 호출) */
export async function unloadEmbeddedModel(): Promise<void> {
  await unload()
}
