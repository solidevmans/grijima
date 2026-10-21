/**
 * 점수판 — `npm run eval`
 *
 * 왜 필요한가:
 *   프롬프트를 고칠 때마다 "나아진 것 같다"로 판단하면 무엇이 좋아지고 무엇이
 *   나빠졌는지 모른다. 실제 납품된 EAP에서 뽑은 정답(eval/sets/<사업>/gold.json)과
 *   앱의 생성 결과를 숫자로 비교해 두면, 다음 수정 때 전후를 비교할 수 있다.
 *   세트(사업)를 전부 돌리고 세트별 + 전체 평균을 낸다 — 한 사업에만 맞추지 않으려고.
 *
 * 무엇을 재는가 (eval/README.md):
 *   ⓪ 구조             기능 행 · 패키지(SFR-NNN) · 다이어그램(하위 번호)을 정답과 같게 나눴나
 *   ① 유스케이스 재현율  정답 유스케이스 중 뜻이 같은 이름으로 만든 비율
 *   ② 유스케이스 정밀율  만든 것 중 정답에 있는 비율
 *   ③ 액터 재현율/정밀율 (사전 없이 뽑은 이름) · 액터 배정(유스케이스↔액터 연결 쌍)
 *   ④ 요구사항별 유스케이스 개수 차이
 *   ⑤ include / extend 재현율
 *
 * 이름 비교는 글자 완전 일치가 아니라 **핵심 명사 겹침**이다 (sameName 참고).
 *   "만족도조사 목록 조회" ↔ "만족도 조사 목록 보기"  → 같다 (띄어쓰기·어미만 다름)
 *   "만족도조사 대상자 관리" ↔ "만족도조사 사용자 관리" → 다르다 (가르는 명사가 다름)
 *
 * 쓰는 법:
 *   npm run eval                모델로 새로 생성해서 채점 (결과를 캐시에 남긴다)
 *   npm run eval -- --cached    마지막 생성 결과(out/eval-gen-<사업>.json)로 채점 — 모델 없이도 돈다
 *   npm run eval -- --selftest  이름 비교 규칙만 검사 (생성 없이 1초)
 *
 * 결과: 화면 표 + `eval/results/<날짜>.json`
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateProject } from '../src/main/core/generate'
import { validateProject } from '../src/main/core/validate'
import { findBundledModel } from '../src/main/core/llm/embedded'
import { DEFAULT_SETTINGS } from '../src/shared/constants'
import type { AppSettings, Project, UseCase } from '../src/shared/types'

const NL = String.fromCharCode(10)

const SETS_DIR = 'eval/sets'
const RESULT_DIR = 'eval/results'

/** 세트 하나 = eval/sets/<사업>/{input.txt, gold.json, actors.txt} */
interface EvalSet {
  name: string
  doc: string
  gold: string
  cache: string
  /** 액터 사전 (없으면 빈 문자열) — 주고 한 번 더 돌린다 */
  actors: string
  dictCache: string
}

function findSets(): EvalSet[] {
  return readdirSync(SETS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      doc: join(SETS_DIR, d.name, 'input.txt'),
      gold: join(SETS_DIR, d.name, 'gold.json'),
      cache: join('out', `eval-gen-${d.name}.json`),
      actors: existsSync(join(SETS_DIR, d.name, 'actors.txt')) ? join(SETS_DIR, d.name, 'actors.txt') : '',
      dictCache: join('out', `eval-gen-${d.name}-사전.json`)
    }))
    .filter((x) => existsSync(x.doc) && existsSync(x.gold))
}

const readText = (path: string): string => readFileSync(path, 'utf-8').replace(/^﻿/, '')

/** 낱말 하나가 상대 이름의 낱말과 같다고 보는 최소 겹침 */
const COVER = 0.6
/** 핵심 명사가 다 겹쳐도 이름 전체가 이만큼은 닮아야 같다고 본다 */
const FLOOR = 0.45

/* ------------------------------------------------------------------ */
/* 정답 파일 (scripts/ea-export-gold.ps1 가 EAP에서 뽑은 형식)            */
/* ------------------------------------------------------------------ */

interface GoldUseCase {
  name: string
  notes: string
  actors: string[]
  includes: string[]
  extends: string[]
}
interface GoldPackage {
  name: string
  usecases: GoldUseCase[]
  diagrams: { name: string }[]
}
interface Gold {
  source: string
  exportedAt: string
  actors: { name: string }[]
  packages: GoldPackage[]
}

/* ------------------------------------------------------------------ */
/* 이름 비교                                                           */
/* ------------------------------------------------------------------ */

/** `[UC-SFR-001-ADT1(맞춤형)-01-01] 추천알고리즘 지원사업 추천` → 뒤쪽 이름만 */
const stripCode = (s: string): string => s.replace(/^\s*\[[^\]]*\]\s*/, '').trim()

/** 비교용 정규화 — 띄어쓰기·괄호·기호를 떼고 붙여 쓴다 */
const norm = (s: string): string =>
  stripCode(s)
    .toLowerCase()
    .replace(/[\s()[\]{}·,.\-_/'"]/g, '')

function bigrams(s: string): string[] {
  if (s.length < 2) return s ? [s] : []
  const out: string[] = []
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
  return out
}

/** 글자 2-gram Dice 계수. 0(안 겹침) ~ 1(같음) */
function dice(a: string, b: string): number {
  const x = bigrams(a)
  const y = bigrams(b)
  if (!x.length || !y.length) return a === b && a !== '' ? 1 : 0
  const left = new Map<string, number>()
  for (const g of x) left.set(g, (left.get(g) ?? 0) + 1)
  let common = 0
  for (const g of y) {
    const n = left.get(g) ?? 0
    if (n > 0) {
      common++
      left.set(g, n - 1)
    }
  }
  return (2 * common) / (x.length + y.length)
}

/** 이름 전체의 닮음. 표에 적는 "겹침" 숫자가 이것이다 */
const similarity = (a: string, b: string): number => dice(norm(a), norm(b))

/**
 * 어느 유스케이스 이름에나 붙는 동작 낱말. **핵심 명사에서 뺀다.**
 * 왜: 이것까지 세면 "만족도조사 대상자 관리"와 "만족도조사 사용자 관리"가
 * 낱말 셋 중 둘이 같아 같은 것으로 붙는다. 뜻을 가르는 건 대상자/사용자다.
 */
const FUNCTION_WORDS = new Set([
  '조회', '보기', '열람', '확인', '관리', '등록', '수정', '삭제', '추가', '입력',
  '처리', '제공', '설정', '발송', '전송', '생성', '기능', '서비스', '고도화', '구현'
])

/** 공백·기호로 끊은 낱말 (각 낱말도 정규화) */
const words = (name: string): string[] =>
  stripCode(name)
    .split(/[\s()[\]{}·,./]+/)
    .map((w) => norm(w))
    .filter((w) => w.length > 0)

/** 뜻을 가르는 낱말만 */
const coreNouns = (name: string): string[] => words(name).filter((w) => !FUNCTION_WORDS.has(w))

/** 낱말 하나가 상대 이름 안에 있는가 — 포함 관계이거나 낱말끼리 많이 겹치면 있다고 본다 */
const covered = (w: string, others: string[]): boolean =>
  others.some(
    (o) =>
      (w.length >= 2 && o.includes(w)) ||
      (o.length >= 2 && w.includes(o)) ||
      dice(w, o) >= COVER
  )

/**
 * 두 이름이 같은 유스케이스를 가리키는가 — **핵심 명사 겹침**으로 본다.
 *
 * 한쪽의 핵심 명사가 **전부** 상대 이름에 들어 있으면 같다고 본다.
 * 한쪽만 보는 이유: 생성된 이름은 패키지 안에 있으니 맥락(만족도조사)을 빼고
 * "설문 관리"처럼 짧게 나오는 일이 흔하다. 양쪽을 다 요구하면 그게 다 틀린 게 된다.
 * 대신 이름 전체의 닮음이 FLOOR 미만이면 붙이지 않는다 — "관리" 한 낱말이
 * 모든 "… 관리"에 붙는 것을 막는다.
 */
function sameName(a: string, b: string): boolean {
  const score = similarity(a, b)
  if (score < FLOOR) return false
  const wa = words(a)
  const wb = words(b)
  return coreNouns(a).every((w) => covered(w, wb)) || coreNouns(b).every((w) => covered(w, wa))
}

/**
 * 생성 이름에서 액터 이름과 똑같은 낱말을 뗀다 (다 떼면 원래 이름).
 * 왜: 사전을 주면 모델이 `통합메시징솔루션 지원사업 추천`처럼 액터를 이름 앞에 붙이는데,
 * 그 낱말이 정답 `Xtracter 솔루션 …`과 "솔루션"으로 겹쳐 거짓 짝이 생긴다.
 * 액터는 ③에서 따로 잰다 — 사전의 액터 이름은 유스케이스 이름 비교에 뜻을 보태지 않는다.
 */
function dropActorWords(name: string, actors: string[]): string {
  const drop = new Set(actors.map(norm).filter(Boolean))
  const kept = stripCode(name)
    .split(/\s+/)
    .filter((w) => !drop.has(norm(w)))
  return kept.length ? kept.join(' ') : name
}

interface Pair {
  gold: number
  gen: number
  score: number
}

/**
 * 1:1로 짝짓는다. 점수가 높은 짝부터 확정하고, 쓰인 쪽은 다시 쓰지 않는다.
 * 왜 1:1인가: 한 생성 유스케이스가 정답 둘을 동시에 메꿨다고 치면 재현율이
 * 실제보다 높게 나온다.
 */
function matchNames(goldNames: string[], genNames: string[]): Pair[] {
  const cand: Pair[] = []
  for (let g = 0; g < goldNames.length; g++) {
    for (let n = 0; n < genNames.length; n++) {
      if (!sameName(goldNames[g], genNames[n])) continue
      cand.push({ gold: g, gen: n, score: similarity(goldNames[g], genNames[n]) })
    }
  }
  cand.sort((a, b) => b.score - a.score)
  const usedGold = new Set<number>()
  const usedGen = new Set<number>()
  const out: Pair[] = []
  for (const c of cand) {
    if (usedGold.has(c.gold) || usedGen.has(c.gen)) continue
    usedGold.add(c.gold)
    usedGen.add(c.gen)
    out.push(c)
  }
  return out
}

/**
 * 요구사항 ID에서 비교용 열쇠를 뽑는다. `SFR-001-ADT1(맞춤형)-01` → `SFR-001`
 *
 * 왜 가운데를 버리는가: 팀 코드(`ADT1(맞춤형)`)와 꼬리 순번은 사업·문서마다
 * 표기가 다르다(정답 EAP의 패키지는 `[UCD-SFR-001-ADT1(맞춤형)]`로 꼬리가 없고
 * 정의서 본문은 `SFR-001-ADT1(맞춤형)-01`로 있다). 앞의 `종류-번호`만 안정적이다.
 */
function reqKeyOf(s: string): string {
  const m = /([A-Za-z]{2,})-(\d{1,4})/.exec(s)
  return m ? `${m[1].toUpperCase()}-${m[2]}` : ''
}

/**
 * 요구사항 **행**의 열쇠. `SFR-021-ADT1(맞춤형)-02` → `SFR-021-02`
 * 정의서 표의 한 행 = 다이어그램 한 장이고, 다이어그램 번호 = 행의 하위 번호다.
 * 하위 번호가 없으면(정답 EAP의 `[UCD-SFR-001-ADT1(맞춤형)] …` 다이어그램) `-01`로 본다.
 */
function rowKeyOf(id: string): string {
  const m = /([A-Za-z]{2,})-(\d{1,4})([^\]]*)/.exec(id)
  if (!m) return ''
  const sub = /-(\d{1,3})\s*$/.exec(m[3])
  return `${m[1].toUpperCase()}-${m[2]}-${(sub ? sub[1] : '1').padStart(2, '0')}`
}

const pct = (a: number, b: number): string =>
  b === 0 ? '  - ' : `${String(Math.round((100 * a) / b)).padStart(3)}%`

/** 한글은 한 글자가 두 칸이라 padEnd 로는 표가 안 맞는다 */
const width = (s: string): number =>
  [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0)
const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - width(s)))

/* ------------------------------------------------------------------ */
/* 생성 (또는 캐시 읽기)                                                */
/* ------------------------------------------------------------------ */

interface Cache {
  ranAt: string
  doc: string
  calls: number
  seconds: number
  project: Project
}

async function produce(set: EvalSet, useCache: boolean, actors?: string[]): Promise<Cache> {
  const CACHE = actors ? set.dictCache : set.cache
  const model = findBundledModel()
  if (useCache || !model) {
    if (!existsSync(CACHE)) {
      console.error(
        (model
          ? '--cached 를 줬지만 '
          : `모델 파일이 없습니다 (resources/model/*.gguf). 캐시로 채점하려 했지만 `) +
          `${CACHE} 가 없습니다.` +
          NL +
          '먼저 모델이 있는 PC에서 `npm run eval` 을 한 번 돌려 캐시를 만드세요.'
      )
      process.exit(1)
    }
    const c = JSON.parse(readFileSync(CACHE, 'utf-8')) as Cache
    console.log(`캐시로 채점: ${CACHE} (생성 시각 ${c.ranAt}, 문서 ${c.doc})`)
    return c
  }

  const settings: AppSettings = structuredClone(DEFAULT_SETTINGS)
  const DOC = set.doc
  const text = readText(DOC)
  console.log(`생성: ${DOC} (${text.length}자) · 모델 ${model.split(/[\\/]/).pop()}`)
  const t0 = Date.now()
  const r = await generateProject({
    requirementText: text,
    systemName: set.name,
    projectId: 'EVAL',
    actors,
    settings
  })
  const c: Cache = {
    ranAt: new Date().toISOString(),
    doc: DOC,
    calls: r.calls,
    seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    project: r.project
  }
  writeFileSync(CACHE, JSON.stringify(c), 'utf-8')
  console.log(`생성 끝: ${c.seconds}초 · LLM ${c.calls}회 → 캐시 ${CACHE}`)
  return c
}

/* ------------------------------------------------------------------ */

/**
 * 이름 비교 규칙 검사 — `npm run eval -- --selftest`
 *
 * 왜 두는가: 이 규칙이 점수의 의미 자체다. 임계값을 한 번 건드리면 모든 과거
 * 점수와 비교가 깨지는데, 깨진 걸 알아차릴 방법이 없으면 점수판이 거짓말을 한다.
 * 정답 21개는 서로 다른 유스케이스이므로 **자기 자신과만** 짝지어져야 한다.
 */
function selfTest(sets: EvalSet[]): void {
  let bad = 0
  for (const set of sets) {
    const gold = JSON.parse(readText(set.gold)) as Gold
    const names = gold.packages.flatMap((k) => k.usecases.map((u) => stripCode(u.name)))
    const pairs = matchNames(names, names)
    const wrong = pairs.filter((m) => m.gold !== m.gen)
    const missing = names.length - pairs.filter((m) => m.gold === m.gen).length
    bad += wrong.length + missing
    console.log(`[${set.name}] 정답 ${names.length}개 자기 짝짓기: 틀린 짝 ${wrong.length} · 못 붙은 것 ${missing}`)
    for (const m of wrong) console.log(`  ✗ ${names[m.gold]} ← ${names[m.gen]} (${m.score.toFixed(2)})`)
  }
  const keys: [string, string][] = [
    ['SFR-021-ADT1(맞춤형)-02', 'SFR-021-02'],
    ['[UCD-SFR-021-ADT1(맞춤형)-02]만족도 설문 대상자 관리', 'SFR-021-02'],
    ['[UCD-SFR-001-ADT1(맞춤형)] 지원 가능 지원사업 추천', 'SFR-001-01'],
    ['SFR-007', 'SFR-007-01']
  ]
  for (const [id, want] of keys) {
    const got = rowKeyOf(id)
    if (got !== want) bad++
    console.log(`  ${got === want ? '○' : '✗'} 행 열쇠 ${id} → ${got}`)
  }
  const cases: [string, string, boolean][] = [
    ['만족도조사 목록 조회', '만족도 조사 목록 보기', true],
    ['만족도조사 설문 관리', '설문 관리', true],
    ['성과관리', '성과 관리', true],
    ['만족도조사 대상자 관리', '만족도조사 사용자 관리', false],
    ['만족도조사 목록 조회', '만족도조사 테스트', false],
    ['사용자 맞춤설정 정보 제공', '맞춤정보설정', false],
    ['상시근로자수 표시', '만족도조사 메일 발송', false]
  ]
  for (const [a, b, want] of cases) {
    const got = sameName(a, b)
    if (got !== want) bad++
    console.log(
      `  ${got === want ? '○' : '✗'} ${a} ${got ? '=' : '≠'} ${b} (겹침 ${similarity(a, b).toFixed(2)})`
    )
  }
  const dropped = dropActorWords('통합메시징솔루션 지원사업 추천', ['공단관리자', '통합메시징솔루션'])
  const leak = dropped !== '지원사업 추천' || sameName('Xtracter 솔루션 지원사업 추천서비스', dropped)
  if (leak) bad++
  console.log(`  ${leak ? '✗' : '○'} 액터 낱말 떼기: 통합메시징솔루션 지원사업 추천 → ${dropped}`)
  console.log(bad === 0 ? '이름 비교 규칙: OK' : `이름 비교 규칙: 실패 ${bad}건`)
  process.exit(bad === 0 ? 0 : 1)
}

/** 정답의 유스케이스↔액터 연결 쌍 중 생성 결과에도 있는 비율 (짝지어진 유스케이스·액터 기준) */
function actorAssign(
  goldUcs: GoldUseCase[],
  genUcs: UseCase[],
  ucPairs: Pair[],
  goldActors: string[],
  genActorIndex: Map<string, number>,
  actorPairs: Pair[]
): { hit: number; total: number } {
  const ucGoldToGen = new Map(ucPairs.map((m) => [m.gold, m.gen]))
  const actorGenToGold = new Map(actorPairs.map((m) => [m.gen, m.gold]))
  let hit = 0
  let total = 0
  goldUcs.forEach((u, gi) => {
    const ni = ucGoldToGen.get(gi)
    const got = new Set(
      ni === undefined ? [] : genUcs[ni].actorUids.map((uid) => actorGenToGold.get(genActorIndex.get(uid) ?? -1))
    )
    for (const a of u.actors) {
      total++
      if (got.has(goldActors.indexOf(a))) hit++
    }
  })
  return { hit, total }
}

async function main(): Promise<void> {
  const useCache = process.argv.includes('--cached')
  const sets = findSets()
  if (!sets.length) {
    console.error(`${SETS_DIR}/<사업>/{input.txt, gold.json} 세트가 없습니다. eval/README.md 참고.`)
    process.exit(1)
  }
  if (process.argv.includes('--selftest')) selfTest(sets)
  const results: Record<string, ReturnType<typeof scoreOf> & { withDict: ReturnType<typeof scoreOf>['scores'] | null }> =
    {}
  for (const set of sets) {
    console.log(NL + `══ 세트: ${set.name} ══`)
    const gold = JSON.parse(readText(set.gold)) as Gold
    const r = scoreOf(set, gold, await produce(set, useCache), useCache, false)
    if (set.actors) {
      // 사전을 주면 액터 이름은 정답과 같으니 배정을 본다. 프롬프트가 달라지므로 유스케이스 점수도 남긴다.
      console.log(NL + `── ${set.name}: 액터 사전 줌 (${set.actors}) ──`)
      const dict = readText(set.actors).split(NL).map((x) => x.trim()).filter(Boolean)
      const d = scoreOf(set, gold, await produce(set, useCache, dict), useCache, true)
      r.scores.actorAssignWithDict = d.scores.actorAssignNoDict
      r.scores.actorAssignByReqWithDict = d.scores.actorAssignByReq
      results[set.name] = { ...r, withDict: d.scores }
    } else results[set.name] = { ...r, withDict: null }
  }

  /* ---------------- 전체 평균 ---------------- */
  const names = Object.keys(results)
  const average: Record<string, number> = {}
  for (const k of Object.keys(results[names[0]].scores)) {
    const vals = names
      .map((n) => (results[n].scores as Record<string, unknown>)[k])
      .filter((v): v is number => typeof v === 'number')
    if (vals.length) average[k] = Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3))
  }
  console.log(NL + `전체 평균 (세트 ${names.length}개)`)
  for (const [k, v] of Object.entries(average)) console.log(`  ${pad(k, 22)}${pct(v, 1)}`)

  if (!existsSync(RESULT_DIR)) mkdirSync(RESULT_DIR, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const out = join(RESULT_DIR, `${stamp}.json`)
  const file = { ranAt: new Date().toISOString(), sets: results, average }
  writeFileSync(out, JSON.stringify(file, null, 2) + NL, 'utf-8')
  console.log(NL + `결과: ${out}`)
}

function scoreOf(set: EvalSet, gold: Gold, run: Cache, useCache: boolean, dict: boolean) {
  const p = run.project

  const goldUcs = gold.packages.flatMap((k) => k.usecases)
  const genUcs: UseCase[] = p.packages.flatMap((k) =>
    k.useCases.map((u) => ({ ...u, reqId: u.reqId.trim() || k.reqId }))
  )

  /* ① 재현율 · ② 정밀율 ------------------------------------------- */
  const ucPairs = matchNames(
    goldUcs.map((u) => u.name),
    // 사전 준 실행에서만 뗀다. 문서에서 뽑은 액터(`소상공인`)는 업무 낱말이기도 해 정답 이름에도 나온다
    genUcs.map((u) => (dict ? dropActorWords(u.name, p.actors.map((a) => a.name)) : u.name))
  )
  const matchedGold = new Set(ucPairs.map((m) => m.gold))
  const matchedGen = new Set(ucPairs.map((m) => m.gen))

  /* ③ 액터 ------------------------------------------------------- */
  const goldActors = gold.actors.map((a) => a.name)
  const genActors = p.actors.map((a) => a.name)
  const actorPairs = matchNames(goldActors, genActors)

  /* ④ 요구사항별 개수 -------------------------------------------- */
  const goldByReq = new Map<string, number>()
  for (const k of gold.packages) {
    const key = reqKeyOf(k.name)
    goldByReq.set(key, (goldByReq.get(key) ?? 0) + k.usecases.length)
  }
  const genByReq = new Map<string, number>()
  for (const u of genUcs) {
    const key = reqKeyOf(u.reqId) || '(ID 없음)'
    genByReq.set(key, (genByReq.get(key) ?? 0) + 1)
  }
  const reqKeys = [...new Set([...goldByReq.keys(), ...genByReq.keys()])].sort()
  // 정답 EAP에는 있지만 입력 정의서에는 없는 요구사항이 있다(소상공인24의 SFR-039).
  // 그걸 생성 못 한 것은 모델 잘못이 아니므로 표에 표시하고 상한을 따로 적는다.
  const docText = existsSync(run.doc) ? readFileSync(run.doc, 'utf-8') : ''
  const perReq = reqKeys.map((key) => {
    const g = goldByReq.get(key) ?? 0
    const n = genByReq.get(key) ?? 0
    return { req: key, gold: g, gen: n, diff: n - g, inDoc: docText ? docText.includes(key) : true }
  })
  const absent = perReq.filter((r) => r.gold > 0 && !r.inDoc)
  const ceiling = goldUcs.length - absent.reduce((n, r) => n + r.gold, 0)

  /* ⓪ 구조 — 기능 행 · 패키지 · 다이어그램 -------------------------- */
  // 정답: 다이어그램 한 장 = 기능 행 하나. 생성: 패키지·유스케이스의 요구사항 ID에서 행을 읽고,
  // 다이어그램은 `패키지의 SFR-NNN + 다이어그램 순번`으로 본다 — 순번이 행의 하위 번호와
  // 다르면(`SFR-022-…-02` 행이 `-01` 다이어그램이 되면) 틀린 것으로 센다.
  const goldRows = new Set(gold.packages.flatMap((k) => k.diagrams.map((d) => rowKeyOf(d.name))))
  const goldPkgs = new Set(gold.packages.map((k) => reqKeyOf(k.name)))
  const genRows = new Set(
    p.packages.flatMap((k) => [k.reqId, ...k.useCases.map((u) => u.reqId)].map(rowKeyOf)).filter(Boolean)
  )
  const genPkgs = p.packages.map((k) => reqKeyOf(k.reqId))
  // 다이어그램의 행 = 그 안 유스케이스의 요구사항 ID (없으면 패키지의 것). 번호가 행과 다르면 빈 열쇠.
  const genDiagrams = p.packages.flatMap((k) =>
    k.diagrams.map((d) => {
      const key = `${reqKeyOf(k.reqId)}-${String(d.seq).padStart(2, '0')}`
      const row = rowKeyOf(k.useCases.find((u) => u.diagramUid === d.uid)?.reqId || k.reqId)
      return key === row ? key : ''
    })
  )
  const hits = (gen: string[], want: Set<string>): number => new Set(gen.filter((x) => want.has(x))).size
  const structure = {
    rows: { hit: hits([...genRows], goldRows), gold: goldRows.size, gen: genRows.size },
    packages: { hit: hits(genPkgs, goldPkgs), gold: goldPkgs.size, gen: genPkgs.length },
    diagrams: { hit: hits(genDiagrams, goldRows), gold: goldRows.size, gen: genDiagrams.length }
  }
  // 액터 없는 유스케이스 — 다이어그램에서 선 없는 타원. 목표 0
  const noActor = genUcs.filter((u) => !u.actorUids.length).length
  const missedRows = [...goldRows].filter((x) => !genRows.has(x)).sort()
  const extraRows = [...genRows].filter((x) => !goldRows.has(x)).sort()

  /* ③ 액터 배정 --------------------------------------------------- */
  const genActorIndex = new Map(p.actors.map((a, i) => [a.uid, i]))
  const assign = actorAssign(goldUcs, genUcs, ucPairs, goldActors, genActorIndex, actorPairs)
  // 요구사항 단위 배정 — 정답이 그 요구사항에 쓴 액터 중 생성도 그 요구사항에 쓴 것.
  // 유스케이스 이름 짝짓기(재현율)에 묶이지 않아, 이름을 못 맞혀도 "누가 하는 일인지"를 잰다.
  const actorsByReq = (pairs: [string, string[]][]): Map<string, Set<string>> => {
    const m = new Map<string, Set<string>>()
    for (const [k, names] of pairs) {
      const set = m.get(k) ?? new Set<string>()
      for (const n of names) set.add(n)
      m.set(k, set)
    }
    return m
  }
  const genName = new Map(p.actors.map((a) => [a.uid, a.name]))
  const goldReqActors = actorsByReq(
    gold.packages.flatMap((k) => k.usecases.map((u): [string, string[]] => [reqKeyOf(k.name), u.actors]))
  )
  const genReqActors = actorsByReq(
    genUcs.map((u): [string, string[]] => [reqKeyOf(u.reqId), u.actorUids.map((x) => genName.get(x) ?? '')])
  )
  const byReq = { hit: 0, total: 0 }
  for (const [k, want] of goldReqActors) {
    const got = new Set([...(genReqActors.get(k) ?? [])].map(norm))
    for (const a of want) {
      byReq.total++
      if (got.has(norm(a))) byReq.hit++
    }
  }

  /* ⑤ include / extend ------------------------------------------- */
  // 정답은 유스케이스 이름으로 가리키고, 생성 결과는 uid 로 가리킨다.
  // 정답 쪽 간선의 양 끝이 둘 다 짝지어졌고, 그 생성 유스케이스들 사이에
  // 같은 종류의 간선이 있으면 맞춘 것으로 센다.
  const goldIndexByName = new Map<string, number>()
  goldUcs.forEach((u, i) => goldIndexByName.set(norm(u.name), i))
  const genByUid = new Map<string, UseCase>(genUcs.map((u) => [u.uid, u]))
  const genIndex = new Map<string, number>()
  genUcs.forEach((u, i) => genIndex.set(u.uid, i))
  const goldToGen = new Map<number, number>(ucPairs.map((m) => [m.gold, m.gen]))

  function edgeHits(kind: 'includes' | 'extends'): { hit: number; total: number } {
    let hit = 0
    let total = 0
    goldUcs.forEach((u, gi) => {
      for (const targetName of u[kind]) {
        total++
        const gj = goldIndexByName.get(norm(targetName))
        if (gj === undefined) continue
        const ni = goldToGen.get(gi)
        const nj = goldToGen.get(gj)
        if (ni === undefined || nj === undefined) continue
        const src = genUcs[ni]
        const uids = kind === 'includes' ? src.includeUids : src.extendUids
        if (uids.some((uid) => genIndex.get(uid) === nj)) hit++
      }
    })
    return { hit, total }
  }
  const inc = edgeHits('includes')
  const ext = edgeHits('extends')
  const genInc = genUcs.reduce((n, u) => n + u.includeUids.filter((x) => genByUid.has(x)).length, 0)
  const genExt = genUcs.reduce((n, u) => n + u.extendUids.filter((x) => genByUid.has(x)).length, 0)

  /* ---------------- 화면 출력 ---------------- */
  const errs = validateProject(p).filter((i) => i.level === 'error')
  const line = '─'.repeat(60)
  console.log(NL + line)
  console.log(`${pad('항목', 26)}${pad('결과', 16)}점수`)
  console.log(line)
  const row = (label: string, a: number, b: number, unit: string): void =>
    console.log(`${pad(label, 26)}${pad(`${a}/${b} ${unit}`, 16)}${pct(a, b)}`)
  const srow = (label: string, x: { hit: number; gold: number; gen: number }, unit: string): void =>
    console.log(`${pad(label, 26)}${pad(`${x.hit}/${x.gold} ${unit} (생성 ${x.gen})`, 16)} ${pct(x.hit, x.gold)}`)
  srow('⓪ 구조: 기능 행', structure.rows, '행')
  srow('⓪ 구조: 패키지 SFR-NNN', structure.packages, '개')
  srow('⓪ 구조: 다이어그램 번호', structure.diagrams, '장')
  console.log(`${pad('⓪ 액터 없는 유스케이스', 26)}${pad(`${noActor}건`, 16)}목표 0`)
  row('① 유스케이스 재현율', matchedGold.size, goldUcs.length, '건')
  row('② 유스케이스 정밀율', matchedGen.size, genUcs.length, '건')
  row('③ 액터 재현율', actorPairs.length, goldActors.length, '명')
  row('③ 액터 정밀율', actorPairs.length, genActors.length, '명')
  row(`③ 액터 배정 (사전 ${dict ? '줌' : '없음'})`, assign.hit, assign.total, '쌍')
  row('③ 배정 (요구사항별)', byReq.hit, byReq.total, '쌍')
  row('⑤ include 재현율', inc.hit, inc.total, '개')
  row('⑤ extend 재현율', ext.hit, ext.total, '개')
  console.log(line)
  console.log(
    `UCD ${p.packages.length}/${gold.packages.length} · 유스케이스 ${genUcs.length}/${goldUcs.length} · ` +
      `액터 ${genActors.length}/${goldActors.length} · include ${genInc}/${inc.total} · ` +
      `extend ${genExt}/${ext.total} · 검증오류 ${errs.length}`
  )
  console.log(line)
  if (missedRows.length) console.log('⓪ 못 읽은 기능 행: ' + missedRows.join(', '))
  if (extraRows.length) console.log('⓪ 정답에 없는 행 (비기능·참조 ID 등): ' + extraRows.join(', '))
  if (!set.actors) console.log('③ 액터 배정 (사전 줌): 건너뜀 — 세트에 actors.txt 가 없다')

  console.log(NL + '④ 요구사항별 유스케이스 개수')
  console.log(`${pad('요구사항', 12)}${pad('정답', 6)}${pad('생성', 6)}차이`)
  for (const r of perReq) {
    const mark = r.diff === 0 ? '0' : r.diff > 0 ? `+${r.diff}` : String(r.diff)
    const note = r.gold > 0 && !r.inDoc ? '   ← 입력 정의서에 없는 요구사항' : ''
    console.log(`${pad(r.req, 12)}${pad(String(r.gold), 6)}${pad(String(r.gen), 6)}${pad(mark, 4)}${note}`)
  }
  if (absent.length) {
    console.log(
      NL +
        `주의: 정답의 ${absent.map((r) => r.req).join(', ')} 는 입력 정의서에 없다(유스케이스 ` +
        `${goldUcs.length - ceiling}개). ① 재현율의 상한은 ${ceiling}/${goldUcs.length} = ` +
        `${Math.round((100 * ceiling) / goldUcs.length)}% 다.`
    )
  }

  const missedUcs = goldUcs.filter((_, i) => !matchedGold.has(i)).map((u) => stripCode(u.name))
  const extraUcs = genUcs.filter((_, i) => !matchedGen.has(i)).map((u) => u.name)
  const missedActors = goldActors.filter((_, i) => !actorPairs.some((m) => m.gold === i))
  const extraActors = genActors.filter((_, i) => !actorPairs.some((m) => m.gen === i))

  if (ucPairs.length) {
    console.log(NL + '짝지어진 유스케이스 (정답 ← 생성, 겹침)')
    for (const m of ucPairs.sort((a, b) => a.gold - b.gold)) {
      console.log(
        `  ${pad(stripCode(goldUcs[m.gold].name), 34)}← ${pad(genUcs[m.gen].name, 34)}${m.score.toFixed(2)}`
      )
    }
  }
  if (missedUcs.length) console.log(NL + '못 만든 유스케이스:' + NL + missedUcs.map((x) => '  - ' + x).join(NL))
  if (extraUcs.length) console.log(NL + '정답에 없는 유스케이스:' + NL + extraUcs.map((x) => '  - ' + x).join(NL))
  if (missedActors.length) console.log(NL + '못 찾은 액터: ' + missedActors.join(', '))
  if (extraActors.length) console.log('정답에 없는 액터: ' + extraActors.join(', '))

  /* ---------------- 결과 파일 ---------------- */
  const ratio = (a: number, b: number): number => Number((a / Math.max(1, b)).toFixed(3))
  return {
    doc: run.doc,
    gold: set.gold,
    goldSource: gold.source,
    generatedAt: run.ranAt,
    cached: useCache || !findBundledModel(),
    seconds: run.seconds,
    calls: run.calls,
    scores: {
      structureRows: ratio(structure.rows.hit, structure.rows.gold),
      structurePackages: ratio(structure.packages.hit, structure.packages.gold),
      structureDiagrams: ratio(structure.diagrams.hit, structure.diagrams.gold),
      useCasesWithoutActor: noActor,
      ucRecall: Number((matchedGold.size / Math.max(1, goldUcs.length)).toFixed(3)),
      ucPrecision: Number((matchedGen.size / Math.max(1, genUcs.length)).toFixed(3)),
      actorRecall: Number((actorPairs.length / Math.max(1, goldActors.length)).toFixed(3)),
      actorPrecision: Number((actorPairs.length / Math.max(1, genActors.length)).toFixed(3)),
      /** 이 실행의 배정. 사전 준 실행의 값은 main 이 actorAssignWithDict 로 옮긴다 */
      actorAssignNoDict: ratio(assign.hit, assign.total),
      actorAssignWithDict: null as number | null,
      /** 요구사항 단위 배정 — 정답이 요구사항마다 쓴 액터를 생성도 그 요구사항에 썼나 */
      actorAssignByReq: ratio(byReq.hit, byReq.total),
      actorAssignByReqWithDict: null as number | null,
      includeRecall: `${inc.hit}/${inc.total}`,
      extendRecall: `${ext.hit}/${ext.total}`
    },
    counts: {
      goldPackages: gold.packages.length,
      genPackages: p.packages.length,
      goldUseCases: goldUcs.length,
      genUseCases: genUcs.length,
      goldActors: goldActors.length,
      genActors: genActors.length,
      genInclude: genInc,
      genExtend: genExt,
      validationErrors: errs.length
    },
    structure,
    missedRows,
    extraRows,
    goldReqsNotInDoc: absent.map((r) => r.req),
    ucRecallCeiling: `${ceiling}/${goldUcs.length}`,
    perReq,
    matches: ucPairs.map((m) => ({
      gold: stripCode(goldUcs[m.gold].name),
      gen: genUcs[m.gen].name,
      score: Number(m.score.toFixed(2))
    })),
    missedUseCases: missedUcs,
    extraUseCases: extraUcs,
    missedActors,
    extraActors
  }
}

void main()
