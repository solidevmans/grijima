/**
 * 생성 품질 평가 — `npm run eval -- <정의서> <정답.json>`
 *
 * 왜 필요한가:
 *   프롬프트를 고칠 때마다 화면을 눈으로 보고 "나아진 것 같다"로 판단하면
 *   무엇이 좋아지고 무엇이 나빠졌는지 모른다. 실제로 액터를 고치다가
 *   고립 유스케이스를 늘린 적이 있다.
 *   기존 사업의 유스케이스모형기술서가 곧 정답이므로, 그걸 기준으로 점수를 낸다.
 *
 * 정답 파일(JSON) 형식:
 *   {
 *     "actors": ["소상공인", "공단관리자", ...],        // 나와야 할 액터
 *     "include": ["SFR-001-ADT1(맞춤형)-01", ...],      // 유스케이스로 만들어야 할 요구사항 ID
 *     "exclude": ["TER-001-ADT1(맞춤형)-01", ...]       // 제외해야 할 요구사항 ID (테스트·비기능)
 *   }
 */
import { readFileSync } from 'node:fs'
import { generateProject } from '../src/main/core/generate'
import { validateProject } from '../src/main/core/validate'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import type { AppSettings } from '../src/shared/types'

const NL = String.fromCharCode(10)
const docPath = process.argv[2]
const ansPath = process.argv[3]
const model = process.argv[4] ?? 'qwen2.5:3b'

if (!docPath || !ansPath) {
  console.error('사용법: npm run eval -- <정의서.txt> <정답.json> [모델]')
  process.exit(1)
}

interface Answer {
  actors?: string[]
  include?: string[]
  exclude?: string[]
}

const settings: AppSettings = {
  ...structuredClone(DEFAULT_SETTINGS),
  activeProvider: 'embedded',
  generationStrategy: 'auto'
}
settings.providers.embedded = {
  ...settings.providers.embedded,
  modelPath: process.env.EAUCS_GGUF ?? '',
  numCtx: 8192,
  maxTokens: 1024
}

/** 공백·괄호를 떼고 비교 (문서 표기가 조금씩 다르다) */
const key = (s: string): string => s.replace(/\s+/g, '').toLowerCase()

function pct(a: number, b: number): string {
  return b === 0 ? '  -  ' : `${String(Math.round((100 * a) / b)).padStart(3)}%`
}

async function main(): Promise<void> {
  const text = readFileSync(docPath, 'utf-8')
  const ans = JSON.parse(readFileSync(ansPath, 'utf-8')) as Answer

  console.log(`문서: ${docPath} (${text.length}자) · 모델: ${model}${NL}`)
  const t0 = Date.now()
  const r = await generateProject({
    requirementText: text,
    systemName: '평가',
    projectId: 'EVAL',
    settings,
  })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  const p = r.project
  const ucs = p.packages.flatMap((k) => k.useCases)
  const reqIds = new Set(p.packages.map((k) => key(k.reqId)))

  /* ---------------- 1. 요구사항 커버리지 ---------------- */
  const want = ans.include ?? []
  const hit = want.filter((id) => reqIds.has(key(id)))
  const miss = want.filter((id) => !reqIds.has(key(id)))

  /* ---------------- 2. 제외 정확도 ---------------- */
  const bad = (ans.exclude ?? []).filter((id) => reqIds.has(key(id)))

  /* ---------------- 3. 액터 ---------------- */
  const wantActors = ans.actors ?? []
  const got = p.actors.map((a) => a.name)
  const actorHit = wantActors.filter((n) => got.some((g) => key(g) === key(n)))
  const actorExtra = got.filter((g) => !wantActors.some((n) => key(n) === key(g)))

  /* ---------------- 4. 모델 건전성 ---------------- */
  const orphan = ucs.filter((u) => !u.actorUids.length)
  const noReq = ucs.filter((u) => !u.reqId.trim())
  const issues = validateProject(p)
  const errs = issues.filter((i) => i.level === 'error')

  const line = '─'.repeat(58)
  console.log(line)
  console.log('항목                          결과            점수')
  console.log(line)
  console.log(
    `요구사항 커버리지              ${String(hit.length).padStart(2)}/${String(want.length).padEnd(2)} 건        ${pct(hit.length, want.length)}`
  )
  console.log(
    `제외 대상 정확도               ${String((ans.exclude ?? []).length - bad.length).padStart(2)}/${String((ans.exclude ?? []).length).padEnd(2)} 건        ${pct((ans.exclude ?? []).length - bad.length, (ans.exclude ?? []).length)}`
  )
  console.log(
    `액터 재현율                   ${String(actorHit.length).padStart(2)}/${String(wantActors.length).padEnd(2)} 명        ${pct(actorHit.length, wantActors.length)}`
  )
  console.log(
    `액터 정밀도                   ${String(got.length - actorExtra.length).padStart(2)}/${String(got.length).padEnd(2)} 명        ${pct(got.length - actorExtra.length, got.length)}`
  )
  console.log(
    `액터 연결된 유스케이스           ${String(ucs.length - orphan.length).padStart(2)}/${String(ucs.length).padEnd(2)} 건        ${pct(ucs.length - orphan.length, ucs.length)}`
  )
  console.log(
    `요구사항 ID 있는 유스케이스       ${String(ucs.length - noReq.length).padStart(2)}/${String(ucs.length).padEnd(2)} 건        ${pct(ucs.length - noReq.length, ucs.length)}`
  )
  console.log(line)
  console.log(
    `UCD ${p.packages.length} · 유스케이스 ${ucs.length} · 액터 ${p.actors.length} · 검증오류 ${errs.length} · ${r.calls}회 호출 ${secs}초`
  )
  console.log(line)

  if (miss.length) console.log(NL + '누락된 요구사항:' + NL + miss.map((x) => '  - ' + x).join(NL))
  if (bad.length) console.log(NL + '제외했어야 할 요구사항:' + NL + bad.map((x) => '  - ' + x).join(NL))
  if (actorExtra.length) console.log(NL + '정답에 없는 액터: ' + actorExtra.join(', '))
  const missActors = wantActors.filter((n) => !got.some((g) => key(g) === key(n)))
  if (missActors.length) console.log('못 찾은 액터: ' + missActors.join(', '))
  if (errs.length) console.log(NL + '검증 오류:' + NL + errs.slice(0, 5).map((e) => '  - ' + e.message).join(NL))

  console.log(NL + '액터별 유스케이스 배정:')
  for (const a of p.actors) {
    const n = ucs.filter((u) => u.actorUids.includes(a.uid)).length
    console.log(`  ${a.name.padEnd(14)} ${n}건`)
  }
  if (orphan.length) console.log(`  ${'(연결 없음)'.padEnd(14)} ${orphan.length}건`)
}

void main()
