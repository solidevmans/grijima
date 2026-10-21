/**
 * 임베디드 모델 실제 검증 — `npm run test:embedded`
 *
 * 목 서버가 아니라 **진짜 모델**을 올려서 앱의 생성 파이프라인을 끝까지 돌린다.
 * Ollama 가 떠 있지 않아도 동작해야 한다 — 그게 이 프로바이더의 존재 이유다.
 *
 * 모델 경로는 인자 또는 EAUCS_GGUF 환경변수로 준다.
 */
import { existsSync } from 'node:fs'
import { generateProject } from '../src/main/core/generate'
import { validateProject } from '../src/main/core/validate'
import { buildXmi } from '../src/main/core/xmi'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import type { AppSettings } from '../src/shared/types'

const NL = String.fromCharCode(10)
/*
 * 인자를 주면 그 모델을, 안 주면 **동봉된 모델**을 쓴다.
 * 사용자가 아무것도 지정하지 않는 것이 정상 경로이므로 그쪽을 기본으로 둔다.
 */
const modelPath = process.argv[2] ?? process.env.EAUCS_GGUF ?? ''
if (modelPath && !existsSync(modelPath)) {
  console.error('모델 파일이 없습니다:', modelPath)
  process.exit(1)
}

const settings: AppSettings = {
  ...structuredClone(DEFAULT_SETTINGS),
  activeProvider: 'embedded',
  generationStrategy: 'auto'
}
settings.providers.embedded = {
  ...settings.providers.embedded,
  modelPath,
  numCtx: 8192,
  maxTokens: 1200
}

const DOC = [
  '요구사항 ID: SFR-001-ADT1(맞춤형)-01',
  '요구사항명: 만족도 설문지 관리',
  // "테스트" 라는 낱말은 넣지 않는다 — 문서 해석 프롬프트가 "테스트·이관은
  // 유스케이스가 아니다" 로 걸러 내서, 배선이 아니라 모델 판정을 시험하게 된다.
  '수행방안: 설문 안내 및 종료 문구를 작성한다. 작성한 설문을 미리본다. 등록된 설문을 관리한다.',
  '',
  '요구사항 ID: SFR-002-ADT1(맞춤형)-01',
  '요구사항명: 지원사업 공고 등록',
  '수행방안: 공단관리자가 공고를 등록하고 자격 요건을 설정한다. 소상공인이 공고를 조회하고 신청한다.'
].join(NL)

async function main(): Promise<void> {
  console.log(`모델: ${modelPath || '(동봉된 것을 자동 탐색)'}${NL}`)
  const t0 = Date.now()
  const r = await generateProject({
    requirementText: DOC,
    systemName: '임베디드 검증',
    projectId: 'EMB',
    settings,
    onProgress: (p) => process.stdout.write(`\r  ${p.index}/${p.total} ${p.label.slice(0, 30)}          `)
  })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`${NL}`)

  const ucs = r.project.packages.flatMap((k) => k.useCases)
  const issues = validateProject(r.project)
  const errs = issues.filter((i) => i.level === 'error')
  const { xml, stats } = buildXmi(r.project)

  let pass = 0
  let fail = 0
  const check = (label: string, ok: boolean, extra = ''): void => {
    if (ok) { pass++; console.log(`  ✓ ${label}${extra ? ' ' + extra : ''}`) }
    else { fail++; console.log(`  ✗ ${label}${extra ? ' ' + extra : ''}`) }
  }

  check('Ollama 없이 생성 완료', true, `${r.calls}회 호출 · ${secs}초`)
  check('요구사항 2건이 UCD 로', r.project.packages.length === 2, `${r.project.packages.length}개`)
  check('유스케이스가 나왔다', ucs.length >= 2, `${ucs.length}건`)
  check('반복 생성 없음 (이름이 전부 다르다)', new Set(ucs.map((u) => u.name)).size === ucs.length)
  check('액터를 찾았다', r.project.actors.length >= 1, `${r.project.actors.length}명`)
  check('검증 오류 없음', errs.length === 0, errs.map((e) => e.message).join(' / '))
  check('XMI 생성', xml.length > 1000, JSON.stringify(stats))
  check('비ASCII 잔존 없음', !/[^\x00-\x7F]/.test(xml))

  console.log(`${NL}생성된 유스케이스:`)
  for (const u of ucs) {
    const actors = u.actorUids.map((a) => r.project.actors.find((x) => x.uid === a)?.name).filter(Boolean)
    console.log(`  ${u.code}  ${u.name}  [${actors.join(', ') || '액터 없음'}]`)
  }
  if (r.warnings.length) console.log(`${NL}경고:${NL}` + r.warnings.map((w) => '  · ' + w).join(NL))

  console.log(`${NL}결과: ${pass} 통과 / ${fail} 실패`)
  if (fail > 0) process.exit(1)
}

void main()
