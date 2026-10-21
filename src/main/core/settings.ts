import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings, GenerationStrategy, ProviderId } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/constants'

/**
 * 설정 저장소.
 *
 * 예전에는 API 키를 `safeStorage`(Windows DPAPI)로 암호화해 `secrets.bin` 에
 * 따로 보관했다. 프로바이더가 임베디드 하나로 줄면서 **키를 쓰는 곳이 없어졌다** —
 * 모델 파일을 직접 읽어 앱 안에서 추론하므로 인증할 상대가 없다.
 * 그래서 키 저장소를 통째로 걷어냈다. 저장할 게 없으면 샐 것도 없다.
 */

let settingsPath = ''
let cache: AppSettings | null = null

function ensurePaths(): void {
  if (settingsPath) return
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  settingsPath = join(dir, 'settings.json')
}

/**
 * 저장된 설정을 기본값 위에 얹는다.
 *
 * 디스크의 값을 그대로 믿지 않는다. 구버전이 남긴 settings.json 에는 지금은
 * 없는 값이 들어 있다 — 프로바이더를 임베디드 하나로 줄이기 전의
 * `activeProvider: "ollama"`, 전략 이름이 바뀌기 전의 generationStrategy 가 그렇다.
 * 그대로 통과시키면 getProvider 가 매번 예외를 던지거나, 전략이 조용히
 * 엉뚱한 경로로 빠진다. 모르는 값은 기본값으로 되돌린다.
 */
function mergeDefaults(partial: Partial<AppSettings>): AppSettings {
  const providers = { ...DEFAULT_SETTINGS.providers }
  for (const key of Object.keys(providers) as ProviderId[]) {
    providers[key] = { ...providers[key], ...(partial.providers?.[key] ?? {}) }
  }

  const known = Object.keys(providers) as ProviderId[]
  const activeProvider = known.includes(partial.activeProvider as ProviderId)
    ? (partial.activeProvider as ProviderId)
    : DEFAULT_SETTINGS.activeProvider

  const strategies: GenerationStrategy[] = ['auto', 'full']
  const generationStrategy = strategies.includes(partial.generationStrategy as GenerationStrategy)
    ? (partial.generationStrategy as GenerationStrategy)
    : DEFAULT_SETTINGS.generationStrategy

  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    providers,
    activeProvider,
    generationStrategy
  }
}

export function loadSettings(): AppSettings {
  ensurePaths()
  if (cache) return cache
  try {
    if (existsSync(settingsPath)) {
      cache = mergeDefaults(JSON.parse(readFileSync(settingsPath, 'utf-8')) as Partial<AppSettings>)
    } else {
      cache = mergeDefaults({})
    }
  } catch {
    cache = mergeDefaults({})
  }
  return cache
}

export function saveSettings(next: AppSettings): AppSettings {
  ensurePaths()
  cache = mergeDefaults(next)
  writeFileSync(settingsPath, JSON.stringify(cache, null, 2), 'utf-8')
  return cache
}
