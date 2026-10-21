import type {
  AppSettings,
  GenerationStrategy,
  Project,
  RawAnalysis,
  RawUseCase
} from '@shared/types'
import { getProvider } from './llm'
import {
  DEFAULT_SYSTEM_PROMPT,
  REFINE_SYSTEM_PROMPT,
  USECASE_ONLY_SYSTEM_PROMPT,
  buildRefinePrompt,
  buildUseCaseOnlyPrompt,
  buildUserPrompt
} from './prompt'
import { extractJson } from './json-repair'
import { buildAnalysis, fallbackUseCase, isStandardFormat, parseOutline, reqKey } from './outline'
import { normalizeToProject, sanitizeRawUseCases } from './normalize'
import { aiResultToBlocks, extractByAI, PLAN_ITEM, readActorSection, readReqName } from './extract'
import { suggestRelations } from './relations'
import { fillActors } from './actorfill'
import { itemHead, itemName, trimTail } from '@shared/constants'

/**
 * 유스케이스 생성 파이프라인.
 *
 * IPC 핸들러에서 분리해 둔 이유: 이 경로가 앱의 심장인데 ipc.ts 안에 있으면
 * 테스트가 로직을 복제해서 검증하게 되고, 그러면 "실제로 앱이 하는 일"을
 * 검증하는 게 아니게 된다. 여기 있으면 스크립트도 앱도 같은 함수를 부른다.
 */

export interface GenerateProgress {
  /** 받은 글자 수 — 셀 때(요구사항 생성)만. 문서 해석 단계는 없음 */
  chars?: number
  index: number
  total: number
  label: string
}

export interface GenerateArgs {
  requirementText: string
  systemName: string
  projectId: string
  author?: string
  /**
   * 수행 팀. 정의서에 요구사항 ID가 없어 앱이 채번할 때 ID에 들어간다.
   *   { code: 'ADT1', name: '맞춤형' }  →  SFR-001-ADT1(맞춤형)-01
   * 비어 있으면 팀 구간 없이 채번한다 (예전에는 무조건 PAD 를 넣었다).
   */
  team?: { code: string; name: string }
  /**
   * 액터 사전 — 사람이 주는 액터 이름 목록(한 줄에 하나). 있으면 문서에서 뽑은 액터를
   * 버리고 **이 이름만** 모델에 주고 배정시킨다. 정답 액터는 정의서 본문에 거의 안 나오는
   * 사업 지식이라 모델이 지어낼 수 없다(점수판 액터 0/7).
   * 비어 있으면 예전처럼 문서에서 뽑는다. 요구사항 단위 전략에만 쓴다.
   * 줄이 `이름: 하는 일`이면 하는 일을 액터 설명으로 모델에 함께 준다 — 이름만으론
   * 고를 근거가 없어 배정이 첫 줄로 쏠렸다(표형식, 사전 2명에 25/27).
   */
  actors?: string[]
  settings: AppSettings
  signal?: AbortSignal
  onProgress?: (p: GenerateProgress) => void
}

export interface GenerateResult {
  project: Project
  rawText: string
  calls: number
  strategy: GenerationStrategy
  warnings: string[]
}

const NL = String.fromCharCode(10)

/**
 * 요구사항 1건짜리 호출의 출력 상한.
 * 유스케이스 2~3건이면 300~800바이트라 1200 토큰이면 충분하고, 모델이 반복
 * 생성에 빠져도 여기서 끊긴다. (설정의 maxTokens 가 더 작으면 그쪽을 쓴다)
 */
const UC_CALL_MAX_TOKENS = 1200

export async function generateProject(args: GenerateArgs): Promise<GenerateResult> {
  const { settings } = args
  const id = settings.activeProvider
  const provider = getProvider(id)
  const config = settings.providers[id]
  const strategy: GenerationStrategy = settings.generationStrategy ?? 'auto'

  /*
   * 설정만 보면 아는 문제는 **시작 전에** 말한다.
   * 이게 없으면 모델 파일이 지정되지 않았을 때도 문서 해석이 시작되어
   * 구간마다 재시도까지 다 돌고 난 뒤에야 "모두 실패했습니다" 가 뜬다.
   * 사용자는 그 사이 수십 초를 기다리고, 문서를 의심하게 된다.
   */
  provider.precheck?.(config)

  /*
   * 시스템명·프로젝트 ID 는 문서에서 읽어 채울 수 있으므로 여기서는 변수로 둔다.
   * (아래 AI 해석 단계에서 비어 있으면 문서가 밝힌 값으로 채운다)
   */
  let systemName = args.systemName.trim()
  let projectId = args.projectId.trim()

  const warnings: string[] = []
  const rawParts: string[] = []
  let received = 0

  const report = (index: number, total: number, label: string): void =>
    args.onProgress?.({ chars: received, index, total, label })

  const delta = (index: number, total: number, label: string) => (c: string) => {
    received += c.length
    report(index, total, label)
  }

  /* ---------------- AI 문서 해석 (형식 무관, 기본값) ---------------- */
  // 문서를 AI가 읽어 요구사항 구조를 뽑고, 그 결과로 요구사항 단위 생성을 이어간다.
  // 파서를 타지 않으므로 어떤 형식의 정의서든 그대로 받는다.
  let workText = args.requirementText
  let extractNotes: string[] = []
  let excludedReqs: string[] = []
  let missedReqs: string[] = []
  /** 요구사항 행 ID → 시스템 처리로 보고 뺀 후보 (본문 블록을 거치지 않고 다이어그램에 바로 붙인다) */
  const systemItems = new Map<string, string[]>()
  /** 요구사항 행 ID → 상세 내용 항목 — 다이어그램에 남겨 점검이 빠진 항목을 센다 */
  const reqItems = new Map<string, string[]>()
  if (strategy === 'auto') {
    /*
     * 문서 해석은 **AI가 한다**.
     *
     * 예전엔 형식을 알아보면 파서를 먼저 태웠다. 정확하고 재현 가능했지만,
     * 새 문서가 올 때마다 코드를 고쳐야 했다 — 실제로 그랬다:
     *   · 표 형식 파서를 새로 만들고
     *   · SFR-001-ADT1(맞춤형) 의 ADT1 을 못 읽어 정규식을 고치고
     *   · 대분류 판정 규칙을 문서마다 다시 맞추고
     * 사용자가 문서를 던질 때마다 개발자가 붙어야 하는 도구는 도구가 아니다.
     *
     * 그래서 해석은 전부 모델에게 맡긴다. 대신 코드가 두 가지를 지킨다:
     *   ① ID 검증 — 모델이 말한 요구사항 ID가 원문에 실제로 있어야 인정
     *   ② 채번   — 없는 ID는 코드가 규칙대로 붙인다 (모델은 번호를 못 만든다)
     * 표준 블록 형식만 예외다. 그건 앱이 만든 형식이라 해석할 게 없다.
     */
    if (isStandardFormat(args.requirementText)) {
      extractNotes = ['표준 형식 입력 — 해석 없이 그대로 사용']
      workText = args.requirementText
    } else {
      const extracted = await extractByAI({
        text: args.requirementText,
        settings,
        team: args.team,
        signal: args.signal,
        onProgress: (p) => args.onProgress?.({ index: p.index, total: p.total, label: p.label })
      })
      if (!extracted.reqs.length) {
        throw new Error(
          '문서에서 요구사항을 찾지 못했습니다.' + NL + NL + extracted.notes.join(NL)
        )
      }
      extractNotes = extracted.notes
      excludedReqs = extracted.excluded
      missedReqs = extracted.missed
      for (const q of extracted.reqs) if (q.systemItems?.length) systemItems.set(q.reqId, q.systemItems)
      workText = aiResultToBlocks(extracted)
      /*
       * 사용자가 시스템명을 비워 뒀고 문서가 스스로 밝힌 이름이 있으면 그걸 쓴다.
       * 이 값은 표시용이 아니다 — EA 모델 이름 · 볼트 폴더명 · 저장 파일명으로
       * 그대로 나간다. 그래서 지어내지 않고 문서에 적힌 것을 쓴다.
       */
      if (!systemName && extracted.systemName) systemName = extracted.systemName
      if (!projectId && extracted.projectId) projectId = extracted.projectId
    }
  }

  /* ---------------- 요구사항 단위 (경량 모델용) ---------------- */
  if (strategy === 'auto') {
    const outline = parseOutline(workText)
    if (!outline) {
      throw new Error(
        '[모형기술서] 블록을 찾지 못해 요구사항 단위 생성을 할 수 없습니다.' +
          NL +
          '엑셀 매핑을 확인하거나, 설정에서 생성 전략을 "전체 한 번에"로 바꾸세요.'
      )
    }

    const dict = new Map<string, string>()
    for (const line of args.actors ?? []) {
      const [name, ...role] = line.split(/[:：]/)
      if (name.trim() && !dict.has(name.trim())) dict.set(name.trim(), role.join(':').trim())
    }
    if (dict.size) {
      outline.actors = [...dict].map(([name, description]) => ({ kind: '', name, description }))
      extractNotes.push(`액터는 사전 ${dict.size}명 중에서 골랐습니다 — 문서에서 뽑지 않았습니다.`)
    }

    /*
     * 액터 목록을 **요구사항마다 다시 만든다.**
     *
     * 전체 목록을 그대로 주면 모델이 늘 앞의 것(대개 일반 이용자)을 고른다.
     * 실측에서 유스케이스 19건 중 15건이 한 액터로 쏠렸다.
     *
     * 그래서 이 요구사항 본문에 실제로 등장하는 액터를 **맨 앞에 놓는다**.
     * (표시까지 붙여봤더니 역효과였다 — 문서 주제인 액터는 거의 모든 요구사항에
     *  등장해서 전부에 표시가 붙고 변별력이 없어진다. 순서만 바꾼다.)
     */
    const squash = (t: string): string => t.replace(/\s+/g, '')
    const actorLinesFor = (reqText: string): string[] => {
      const hay = squash(reqText)
      const mentioned: string[] = []
      const others: string[] = []
      for (const a of outline.actors) {
        const label = a.description ? `${a.name}: ${a.description}` : a.name
        if (a.name && hay.includes(squash(a.name))) mentioned.push(label)
        else others.push(label)
      }
      return [...mentioned, ...others]
    }
    const byReq = new Map<string, RawUseCase[]>()
    const total = outline.reqs.length

    for (let i = 0; i < total; i++) {
      const r = outline.reqs[i]
      const label = r.reqName || r.reqId
      report(i + 1, total, label)

      // 상세 내용 번호 항목(후보)이 있으면 모델은 다듬기만 한다
      const refine = r.items.length > 0
      const user = refine
        ? buildRefinePrompt({
            reqName: r.reqName,
            items: r.items,
            actorNames: actorLinesFor(`${r.reqName} ${r.items.join(' ')}`)
          })
        : buildUseCaseOnlyPrompt({
            d1: r.d1,
            d2: r.d2,
            reqId: r.reqId,
            reqName: r.reqName,
            detail: r.detail,
            actorNames: actorLinesFor(`${r.reqName} ${r.detail}`)
          })

      let ucs: RawUseCase[] | null = null
      // 경량 모델은 한 번쯤 형식을 어긴다 — 1회 재시도한다
      for (let attempt = 0; attempt < 2 && !ucs; attempt++) {
        try {
          const out = await provider.generate({
            system: refine ? REFINE_SYSTEM_PROMPT : USECASE_ONLY_SYSTEM_PROMPT,
            user:
              attempt === 0
                ? user
                : user + NL + NL + '반드시 {"usecases":[...]} 형태의 JSON만 출력하라.',
            config,
            /*
             * 요구사항 1건의 응답은 300~800바이트다. config.maxTokens(기본 8192)를
             * 그대로 쓰면, 모델이 같은 객체를 반복 생성하기 시작했을 때 그 한도까지
             * 계속 찍어 낸다. 실제로 요구사항 1건에서 62건이 나왔다.
             */
            // 후보가 많으면(9개 등) 1200 토큰에 다 못 담는다 — 후보당 250
            maxTokens: Math.min(config.maxTokens, Math.max(UC_CALL_MAX_TOKENS, 250 * r.items.length)),
            signal: args.signal,
            onDelta: delta(i + 1, total, label)
          })
          rawParts.push('/* ' + label + ' */' + NL + out)
          ucs = pickUseCases(out)
        } catch (e) {
          if (args.signal?.aborted) throw e
          if (attempt === 1) {
            const why = e instanceof Error ? e.message.split(NL)[0] : String(e)
            warnings.push(label + ': ' + why)
          }
        }
      }

      /*
       * 반복 생성 방어.
       *
       * 소형 모델은 JSON 배열 안에서 같은 객체를 계속 찍어 내는 상태에 빠질 수
       * 있다(같은 이름, 같은 흐름). 그대로 두면 요구사항 1건이 유스케이스 62건이
       * 되고, 다이어그램은 똑같은 타원 수십 개가 된다.
       * 정규화 단계에도 같은 방어가 있지만 여기서 한 번 더 하는 이유는 **사용자에게
       * 알리기 위해서**다. 조용히 지우면 모델이 이상하다는 걸 알 수 없다.
       */
      if (ucs && ucs.length) {
        const s = sanitizeRawUseCases(ucs, r.reqName)
        if (s.dropped > 0) {
          warnings.push(
            label +
              ': 모델이 같은 유스케이스를 반복 생성해 ' +
              s.dropped +
              '건을 버렸습니다 (' +
              s.kept.length +
              '건 사용).'
          )
        }
        ucs = s.kept.length ? s.kept : null
      }

      /*
       * 후보는 빠짐없이 — 모델이 어느 from 에도 안 넣은 후보는 코드가 규칙 이름으로 채운다.
       * 모델이 후보 밖에서 지어낸 것(from 없음)은 세어서 알린다.
       */
      if (refine) {
        const used = new Set<number>()
        let invented = 0
        for (const u of ucs ?? []) {
          const from = (u as { from?: unknown }).from
          const nums = (Array.isArray(from) ? from : [from])
            .map(Number)
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= r.items.length)
          if (!nums.length) {
            invented++
            u.invented = true
          } else u.sources = nums.map((n) => r.items[n - 1])
          nums.forEach((n) => used.add(n))
        }
        // 이름이 꼬리말뿐이면(`기능 구현`) 요구사항명으로
        ucs = (ucs ?? []).map((u) => ({ ...u, name: trimHeadTail(trimTail(String(u.name ?? '')), r.reqName) || r.reqName || String(u.name ?? '') }))
        const missed = r.items.filter((s, k) => !used.has(k + 1) && !s.startsWith(PLAN_ITEM))
        if (missed.length) ucs = [...(ucs ?? []), ...missed.map((s) => ({ ...itemUseCase(r.reqId, s, [...r.items, r.reqName]), sources: [s] }))]
        reqItems.set(r.reqId, r.items.filter((s) => !s.startsWith(PLAN_ITEM)))
        if (invented) warnings.push(`${label}: 모델이 상세 내용 항목에 없는 유스케이스 ${invented}건을 더했습니다 — 내보내기 점검에 이름이 있습니다.`)
      }

      const list = ucs && ucs.length ? ucs : [fallbackUseCase(r)]
      byReq.set(reqKey(r), r.note ? list.map((u) => ({ ...u, note: r.note })) : list)
    }

    /**
     * 전부 대체됐다 = 모델이 한 건도 처리하지 못했다.
     * 이 경우 "요구사항명을 그대로 옮긴 트리"가 나오는데, 겉보기에는 성공처럼
     * 보여서 사용자가 LLM이 아예 안 돌았다는 걸 눈치채지 못한다.
     * (모델 파일이 지정되지 않았을 때 실제로 이렇게 됐다) → 조용히 넘어가지 않는다.
     */
    if (total > 0 && warnings.length >= total) {
      // 모든 건이 같은 이유로 실패했다면 그 원인을 그대로 보여준다
      const first = warnings[0] ?? ''
      const cause = first.slice(first.indexOf(': ') + 2)
      throw new Error(
        '모델이 요구사항 ' + total + '건을 모두 처리하지 못했습니다.' + NL + NL +
          '원인: ' + (cause || '알 수 없음') + NL + NL +
          '설정 탭에서 모델 파일이 지정돼 있는지, ' +
          '"연결 테스트"가 성공하는지 확인하세요.'
      )
    }

    const analysis = buildAnalysis(outline, byReq, {
      system_name: systemName,
      project_id: args.projectId
    })
    const filled = fillActors(
      normalizeToProject(analysis, {
        systemName,
        projectId,
        author: args.author,
        team: args.team
      }),
      args.requirementText,
      dict.size > 0 || readActorSection(args.requirementText).length > 0
    )
    const built = filled.project
    if (filled.guessed) extractNotes.push(guessNote(filled.guessed))
    // 알림은 사라진다 — 뺀 요구사항은 프로젝트에 남겨 내보내기 점검이 말하게 한다
    if (excludedReqs.length) built.metadata.excludedReqs = excludedReqs
    if (missedReqs.length) built.metadata.missedReqs = missedReqs
    const reqNames: Record<string, string> = {}
    for (const id of [...excludedReqs, ...missedReqs]) {
      const name = readReqName(args.requirementText, id)
      if (name) reqNames[id] = name
    }
    if (Object.keys(reqNames).length) built.metadata.reqNames = reqNames
    // 뺀 시스템 처리 후보는 그 행의 다이어그램에 — 폼에서 유스케이스로 되살린다
    for (const p of built.packages)
      for (const d of p.diagrams) {
        const reqId = p.useCases.find((u) => u.diagramUid === d.uid)?.reqId
        const items = reqId ? systemItems.get(reqId) : undefined
        // 정의서 글 그대로(세부 ` / ` 앞) — 이름 꼬리 깎기를 하면 `수집 로직 구현`이 `수집 로직`이 된다
        if (items) d.systemItems = items.map((s) => s.replace(PLAN_ITEM, '').split(' / ')[0].trim())
        const own = reqId ? reqItems.get(reqId) : undefined
        if (own?.length) d.items = own
      }

    /*
     * 관계 제안 — 유스케이스가 다 만들어진 뒤에 한 번 더 묻는다.
     *
     * 위 루프는 요구사항 1건씩 따로 호출하므로 모델이 **다른 유스케이스를
     * 보지 못한다.** include/extend 는 둘 사이의 관계라 그 구조에서는 나올 수
     * 없다. 그래서 목록 전체를 놓고 한 번 더 묻는다. 실패해도 던지지 않는다 —
     * 관계는 없어도 모델이 성립하고, 여기서 던지면 다 만들어 놓은 결과가 날아간다.
     */
    report(total, total, '관계 정리')
    const rel = await suggestRelations({
      project: built,
      settings,
      signal: args.signal
    })

    return {
      project: rel.project,
      rawText: rawParts.join(NL + NL),
      calls: total + 1,
      strategy,
      warnings: [...extractNotes, ...warnings, ...rel.notes]
    }
  }

  /* ---------------- 전체 한 번에 (클라우드 대형 모델용) ---------------- */
  const system = settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT
  const jobs = [{ label: '전체', text: args.requirementText }]
  const analyses: RawAnalysis[] = []

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]
    report(i + 1, jobs.length, job.label)
    const out = await provider.generate({
      system,
      user: buildUserPrompt(job.text, {
        systemName,
        projectId: args.projectId
      }),
      config,
      signal: args.signal,
      onDelta: delta(i + 1, jobs.length, job.label)
    })
    rawParts.push('/* ===== ' + job.label + ' ===== */' + NL + out)
    try {
      analyses.push(extractJson<RawAnalysis>(out))
    } catch (e) {
      throw new Error(
        '"' +
          job.label +
          '" 구간의 응답을 해석하지 못했습니다 (' +
          (i + 1) +
          '/' +
          jobs.length +
          ').' +
          NL +
          (e instanceof Error ? e.message : String(e)) +
          NL +
          '설정에서 생성 전략을 "요구사항 단위"로 바꾸면 경량 모델도 안정적으로 끝납니다.'
      )
    }
  }

  const filled = fillActors(
    normalizeToProject(analyses[0] ?? { requirements: [], actors: [] }, {
      systemName,
      projectId,
      author: args.author,
      team: args.team
    }),
    args.requirementText,
    readActorSection(args.requirementText).length > 0
  )
  const built = filled.project
  if (filled.guessed) warnings.unshift(guessNote(filled.guessed))

  // 전체 한 번에 돌려도 include/extend 는 스키마에 없다 — 여기서도 따로 묻는다
  report(jobs.length, jobs.length, '관계 정리')
  const rel = await suggestRelations({
    project: built,
    settings,
    signal: args.signal
  })

  return {
    project: rel.project,
    rawText: rawParts.join(NL + NL),
    calls: jobs.length + 1,
    strategy,
    warnings: [...warnings, ...rel.notes]
  }
}

const guessNote = (n: number): string =>
  `액터 ${n}명을 정의서에서 추정했습니다 — 사업 액터로 바꾸려면 편집 탭에서 액터 이름을 고치세요.`

/**
 * 모델이 빠뜨린 후보를 규칙대로 유스케이스로 만든다.
 *   `사용자 관리 기능(무제한 추가…) / ● …` → `사용자 관리`
 * 세부(` / ` 뒤)·괄호 설명·"기능/구현/제공/개발" 꼬리말을 뗀다 — 규칙은 `itemName`(되살리기와 같이 씀).
 */
export { trimTail }

/**
 * 이름 앞머리가 요구사항명에서 온 말이면 그 끝의 꼬리말을 뗀다 — 모델이 요구사항명을 꼬리말째 붙인다.
 *   `데이터 수집 기능 모니터링`(요구사항명 `내·외부 데이터 수집 기능 설계`) → `데이터 수집 모니터링`
 */
export const trimHeadTail = (name: string, reqName: string): string => {
  const w = name.split(/\s+/)
  for (let i = w.length - 2; i >= 1; i--) {
    if (/^(기능|구현|제공|개발)$/.test(w[i]) && reqName.includes(w.slice(0, i + 1).join(' '))) {
      return [...w.slice(0, i), ...w.slice(i + 1)].join(' ')
    }
  }
  return name
}

export function itemUseCase(reqId: string, item: string, others: string[] = []): RawUseCase {
  const head = itemHead(item)
  return {
    req_id: reqId,
    name: itemName(item, others),
    priority: 'Medium',
    difficulty: '중',
    description: head,
    main_flow: '',
    actors: []
  }
}

/**
 * 모델 응답에서 유스케이스 배열을 꺼낸다.
 * 경량 모델은 {"usecases":[...]} 대신 배열만 주거나 키 이름을 바꾸는 일이 잦다.
 */
export function pickUseCases(text: string): RawUseCase[] | null {
  const parsed = extractJson<unknown>(text)

  const asList = (v: unknown): RawUseCase[] | null =>
    Array.isArray(v) ? (v as RawUseCase[]).filter((u) => u && typeof u.name === 'string') : null

  const direct = asList(parsed)
  if (direct?.length) return direct

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    for (const key of ['usecases', 'useCases', 'use_cases', 'cases', 'items']) {
      const hit = asList(obj[key])
      if (hit?.length) return hit
    }
    // 유스케이스 객체 하나만 덜렁 준 경우
    if (typeof obj.name === 'string') return [obj as RawUseCase]
  }
  return null
}
