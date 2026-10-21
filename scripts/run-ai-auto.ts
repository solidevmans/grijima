/** AI 문서 해석 경로 실행 — node out/run-ai-auto.cjs <문서> [모델] */
import { readFileSync, writeFileSync } from 'node:fs'
import { generateProject } from '../src/main/core/generate'
import { buildXmi } from '../src/main/core/xmi'
import { validateProject } from '../src/main/core/validate'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import type { AppSettings } from '../src/shared/types'

const NL = String.fromCharCode(10)
const file = process.argv[2] ?? 'examples/실제정의서_표형식.txt'
const model = process.argv[3] ?? 'qwen2.5:3b'

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

async function main(): Promise<void> {
  const text = readFileSync(file, 'utf-8')
  console.log(`문서: ${file} (${text.length}자) · 모델: ${model} · 전략: AI 해석`)
  console.log('파서 없음 — 문서를 그대로 AI에게 넘긴다' + NL)

  const t0 = Date.now()
  let last = 0
  const r = await generateProject({
    requirementText: text,
    systemName: '',
    projectId: 'EAUCS',
    settings,
    onProgress: (p) => {
      if (p.index !== last) {
        last = p.index
        process.stdout.write(`  [${String(p.index).padStart(2)}/${p.total}] ${p.label.slice(0, 44)}\n`)
      }
    }
  })
  console.log(`${NL}${r.calls}회 생성 호출 · 총 ${((Date.now() - t0) / 1000).toFixed(1)}초`)
  for (const w of r.warnings) console.log('  · ' + w)

  const p = r.project
  console.log(NL + '--- 생성된 트리 ---')
  for (const pkg of p.packages) {
    console.log(`${NL}${pkg.code}  ${pkg.name.slice(0, 44)}`)
    for (const uc of pkg.useCases) {
      const acts = uc.actorUids.map((a) => p.actors.find((x) => x.uid === a)?.name).filter(Boolean).join(', ')
      console.log(`     ${uc.code.padEnd(38)} ${uc.name.slice(0, 24).padEnd(26)} ← ${acts || '(없음)'}`)
    }
  }
  console.log(NL + '--- 액터 ---')
  for (const a of p.actors) console.log(`  ${a.kind.padEnd(10)} ${a.name}`)

  const issues = validateProject(p)
  const err = issues.filter((i) => i.level === 'error')
  console.log(`${NL}검증: 오류 ${err.length} / 경고 ${issues.filter((i) => i.level === 'warn').length}`)
  for (const i of err.slice(0, 5)) console.log('  ' + i.message)

  const { xml, stats } = buildXmi(p)
  console.log('XMI:', JSON.stringify(stats), `${(xml.length / 1024).toFixed(1)} KB`)
  writeFileSync('out/ai-auto.eaucs', JSON.stringify(p, null, 2), 'utf-8')
  writeFileSync('out/ai-auto.xmi', Buffer.from(xml, 'latin1'))
  console.log('저장: out/ai-auto.eaucs / .xmi')
}
void main()
