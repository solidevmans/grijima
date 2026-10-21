import type { Project, ValidationIssue } from '@shared/types'
import { splitSubNo } from '@shared/idrules'

/**
 * EA 임포트 전 사전 점검.
 * "XMI를 만들고 EA에서 깨진 걸 발견" → "만들기 전에 앱에서 잡는다" 로 옮기는 게 목적.
 */
export function validateProject(project: Project): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const push = (i: ValidationIssue): void => {
    issues.push(i)
  }

  if (!project.metadata.systemName.trim())
    push({ level: 'error', code: 'META_SYSTEM_NAME', message: '시스템명이 비어 있습니다 — 위쪽 막대의 시스템명 칸에 입력하세요.' })
  if (!/^[A-Za-z0-9_-]+$/.test(project.metadata.projectId || ''))
    push({
      level: 'warn',
      code: 'META_PROJECT_ID',
      message: '프로젝트 ID는 영문/숫자/-/_ 로만 구성하는 것을 권장합니다. (GUID 채번 시드로 사용됨)'
    })

  /*
   * 생성이 "유스케이스로 그릴 수 없다" 고 뺀 정의서 요구사항.
   * 알림 한 번으로 끝내면 놓친 사람은 정의서 전체가 변환된 줄 알고 내보낸다.
   * 사람이 같은 ID로 요구사항을 다시 만들면 그 ID는 목록에서 빠진다.
   */
  const reqIds = new Set(project.packages.flatMap((p) => [p.reqId, ...p.useCases.map((u) => u.reqId)]))
  // 행 ID는 패키지(앞부분) + 다이어그램 번호(끝 번호)로 다시 만들어진다 — 그 다이어그램이 있으면 넣은 것
  const drawn = (id: string): boolean => {
    if (reqIds.has(id)) return true
    const { base, sub } = splitSubNo(id)
    return !!sub && project.packages.some((p) => p.reqId === base && p.diagrams.some((d) => d.seq === sub))
  }
  // 한 건에 한 줄, ID 옆에 정의서의 요구사항명 — 이름이 있어야 넣을지 판단한다. 누르면 원문의 그 자리로
  const names = project.metadata.reqNames ?? {}
  const label = (id: string): string => (names[id] ? `${id} ${names[id]}` : id)
  for (const id of (project.metadata.excludedReqs ?? []).filter((id) => !drawn(id)))
    push({
      level: 'warn',
      code: 'REQ_EXCLUDED',
      message: `${label(id)} — 유스케이스로 그리지 않았습니다. 누르면 만들기 탭 원문의 그 줄을 보여 줍니다. 넣으려면 편집 트리 맨 아래 『요구사항(UCD) 추가』로.`,
      sourceId: id
    })
  // 모델이 아예 돌려주지 않은 행 — 판단해서 뺀 것이 아니라 해석에서 빠진 것
  for (const id of (project.metadata.missedReqs ?? []).filter((id) => !drawn(id)))
    push({
      level: 'warn',
      code: 'REQ_MISSED',
      message: `${label(id)} — 해석에서 빠졌습니다. 누르면 만들기 탭 원문의 그 줄을 보여 줍니다. 넣으려면 편집 트리 맨 아래 『요구사항(UCD) 추가』로.`,
      sourceId: id
    })

  // 시스템 처리로 보고 뺀 후보 — 다이어그램 폼에만 있어 그 폼을 안 여는 사람은 빠진 줄 모른다
  // 다이어그램마다 한 줄 — 줄을 누르면 그 다이어그램 폼으로 간다
  for (const p of project.packages)
    for (const d of p.diagrams)
      if (d.systemItems?.length)
        push({
          level: 'warn',
          code: 'SYSTEM_ITEMS',
          message: `[${p.code}-${String(d.seq).padStart(2, '0')}] 시스템 처리로 보고 그리지 않은 정의서 항목 ${d.systemItems.length}건. 다이어그램 폼에서 필요한 것을 유스케이스로 되살리세요.`,
          target: { packageUid: p.uid, diagramUid: d.uid }
        })

  // 상세 내용 항목 중 어느 유스케이스에도 없는 것 — 생성은 다 채우니, 사람이 지운 뒤에 생긴다
  const covered = new Set(project.packages.flatMap((p) => p.useCases.flatMap((u) => u.sources ?? [])))
  for (const p of project.packages)
    for (const d of p.diagrams) {
      const left = (d.items ?? []).filter((s) => !covered.has(s))
      if (!left.length) continue
      // 머리말이 묶음 제목뿐인 정의서가 있어(항목 둘이 같은 머리말) 둘째 토막까지, 길면 줄인다
      const short = (s: string): string => {
        const t = s.split(' / ').slice(0, 2).map((x) => x.replace(/^[●○■‐-]\s*/, '').trim()).join(' · ')
        return t.length > 40 ? t.slice(0, 39) + '…' : t
      }
      const names = left.slice(0, 2).map((s) => `『${short(s)}』`).join(', ')
      push({
        level: 'warn',
        code: 'ITEMS_UNCOVERED',
        message: `[${p.code}-${String(d.seq).padStart(2, '0')}] 상세 내용 ${d.items!.length}항목 중 ${left.length}항목이 어느 유스케이스에도 없습니다 — ${names}${left.length > 2 ? ` 외 ${left.length - 2}` : ''}. 다이어그램 폼에서 필요한 것을 유스케이스로 되살리세요.`,
        target: { packageUid: p.uid, diagramUid: d.uid }
      })
    }

  if (!project.actors.length)
    push({ level: 'error', code: 'NO_ACTOR', message: '액터가 한 명도 없습니다.' })
  if (!project.packages.length)
    push({ level: 'error', code: 'NO_PACKAGE', message: 'UCD 패키지(요구사항)가 없습니다.' })

  /* 액터 */
  const actorNames = new Map<string, number>()
  for (const a of project.actors) {
    const key = a.name.trim()
    actorNames.set(key, (actorNames.get(key) ?? 0) + 1)
    if (!key)
      push({
        level: 'error',
        code: 'ACTOR_NAME_EMPTY',
        message: '이름이 비어 있는 액터가 있습니다.',
        target: { actorUid: a.uid }
      })
  }
  for (const [name, n] of actorNames) {
    if (n > 1 && name)
      push({ level: 'warn', code: 'ACTOR_DUP', message: `액터 이름 중복: ${name} (${n}건)` })
  }
  // 생성 완료 알림은 15초면 사라진다 — 내보내기 전에 다시 짚어 준다
  const guessed = project.actors.filter((a) => a.guessed)
  if (guessed.length)
    push({
      level: 'warn',
      code: 'ACTOR_GUESSED',
      message: `추정한 액터 ${guessed.length}명(${guessed.map((a) => a.name).join('·')}) — 사업 액터 이름으로 바꾸세요.`,
      target: { actorUid: guessed[0].uid }
    })

  /*
   * 아무 유스케이스도 쓰지 않는 액터.
   *
   * 액터 목록은 **문서 전체**를 훑어 따로 만들고, 유스케이스는 요구사항 1건씩
   * 따로 만든다. 두 결과를 맞춰 보는 단계가 없어서, 문서에 한 번 스친 표현이
   * 액터로 올라왔는데 아무도 쓰지 않는 상태가 생긴다.
   *
   * 그대로 두면 EA "Actors" 패키지에는 들어가는데 어느 다이어그램에도 안 그려진다
   * (다이어그램은 그 다이어그램에서 쓰이는 액터만 그린다). 모델을 받아 보는 쪽에서는
   * 정체를 알 수 없는 액터가 하나 앉아 있는 셈이라, 검증에서 짚어 준다.
   */
  const usedActorUids = new Set<string>()
  for (const p of project.packages) {
    for (const uc of p.useCases) for (const a of uc.actorUids) usedActorUids.add(a)
    for (const d of p.diagrams) for (const a of d.extraActorUids ?? []) usedActorUids.add(a)
  }
  for (const a of project.actors) {
    if (usedActorUids.has(a.uid)) continue
    push({
      level: 'warn',
      code: 'ACTOR_UNUSED',
      message: `${a.name || '(이름 없음)'}: 이 액터를 쓰는 유스케이스가 없습니다 — 연결하거나 삭제하세요.`,
      target: { actorUid: a.uid }
    })
  }

  /* 코드 중복 */
  const pkgCodes = new Set<string>()
  const ucCodes = new Map<string, number>()
  const allUcUids = new Set<string>()
  const actorUids = new Set(project.actors.map((a) => a.uid))

  for (const p of project.packages) {
    if (pkgCodes.has(p.code))
      push({
        level: 'error',
        code: 'PKG_CODE_DUP',
        message: `패키지 코드 중복: ${p.code}`,
        target: { packageUid: p.uid }
      })
    pkgCodes.add(p.code)

    const rid = p.reqId.trim()
    if (!rid)
      push({
        level: 'warn',
        code: 'PKG_NO_REQ',
        message: `[${p.code}] ${p.name}: 요구사항 ID가 없어 추적성이 끊깁니다.`,
        target: { packageUid: p.uid }
      })


    if (!p.diagrams.length)
      push({
        level: 'error',
        code: 'PKG_NO_DIAGRAM',
        message: `[${p.code}] ${p.name}: 다이어그램이 없습니다.`,
        target: { packageUid: p.uid }
      })

    // 다이어그램 번호 = 정의서 행의 하위 번호. 겹치면 EA에 같은 이름 그림이 두 장 들어간다.
    const seqs = new Set<number>()
    for (const dg of p.diagrams) {
      if (seqs.has(dg.seq))
        push({
          level: 'error',
          code: 'DGM_SEQ_DUP',
          message: `[${p.code}] 다이어그램 번호가 겹칩니다(-${String(dg.seq).padStart(2, '0')}) — 트리 위 'ID 다시 매기기'를 누르면 겹친 쪽이 다음 번호가 됩니다.`,
          target: { packageUid: p.uid, diagramUid: dg.uid }
        })
      seqs.add(dg.seq)
    }

    if (!p.useCases.length)
      push({
        level: 'warn',
        code: 'PKG_EMPTY',
        message: `[${p.code}] ${p.name}: 유스케이스가 없습니다. 빈 다이어그램이 생성됩니다.`,
        target: { packageUid: p.uid }
      })

    const diagramUids = new Set(p.diagrams.map((d) => d.uid))

    for (const uc of p.useCases) {
      allUcUids.add(uc.uid)
      ucCodes.set(uc.code, (ucCodes.get(uc.code) ?? 0) + 1)

      const t = { packageUid: p.uid, diagramUid: uc.diagramUid, useCaseUid: uc.uid }

      /*
       * 유스케이스는 반드시 같은 패키지의 다이어그램 하나에 속해야 한다.
       * 끊어지면 XMI에는 요소로 들어가지만 어느 다이어그램에도 안 그려져
       * EA에서 "패키지에는 있는데 그림에는 없는" 유령이 된다.
       */
      if (!diagramUids.has(uc.diagramUid))
        push({
          level: 'error',
          code: 'UC_NO_DIAGRAM',
          message: `${uc.code}: 소속 다이어그램이 없습니다. EA에서 어느 그림에도 그려지지 않습니다.`,
          target: t
        })

      if (!uc.name.trim())
        push({ level: 'error', code: 'UC_NAME_EMPTY', message: `${uc.code}: 이름이 비어 있습니다.`, target: t })
      if (!uc.actorUids.length)
        push({
          level: 'warn',
          code: 'UC_NO_ACTOR',
          message: `${uc.code} ${uc.name}: 연결된 액터가 없습니다. EA에서 고립된 유스케이스가 됩니다.`,
          target: t
        })
      for (const au of uc.actorUids) {
        if (!actorUids.has(au))
          push({
            level: 'error',
            code: 'UC_ACTOR_MISSING',
            message: `${uc.code}: 삭제된 액터를 참조하고 있습니다.`,
            target: t
          })
      }
      if (!uc.reqId.trim())
        push({
          level: 'warn',
          code: 'UC_NO_REQ',
          message: `${uc.code} ${uc.name}: 요구사항 ID가 없어 추적성이 끊깁니다.`,
          target: t
        })
      // 생성 알림은 사라진다 — 정의서에 근거가 없는 유스케이스를 내보내기 전에 다시 짚는다
      if (uc.invented)
        push({
          level: 'warn',
          code: 'UC_INVENTED',
          message: `${uc.code} ${uc.name}: 정의서 상세 내용에 없는 것을 모델이 더했습니다(LLM 추가) — 필요 없으면 삭제하고, 두려면 이름을 고치세요.`,
          target: t
        })
      if (!uc.mainFlow.trim())
        push({ level: 'info', code: 'UC_NO_FLOW', message: `${uc.code}: 기본 흐름이 비어 있습니다.`, target: t })
    }
  }

  for (const [code, n] of ucCodes) {
    if (n > 1)
      push({ level: 'error', code: 'UC_CODE_DUP', message: `유스케이스 코드 중복: ${code} (${n}건)` })
  }

  /* include / extend 참조 무결성 */
  for (const p of project.packages) {
    for (const uc of p.useCases) {
      const t = { packageUid: p.uid, diagramUid: uc.diagramUid, useCaseUid: uc.uid }
      for (const ref of [...uc.includeUids, ...uc.extendUids]) {
        if (!allUcUids.has(ref))
          push({
            level: 'error',
            code: 'REL_DANGLING',
            message: `${uc.code}: 존재하지 않는 유스케이스를 include/extend 하고 있습니다.`,
            target: t
          })
        if (ref === uc.uid)
          push({
            level: 'error',
            code: 'REL_SELF',
            message: `${uc.code}: 자기 자신을 include/extend 할 수 없습니다.`,
            target: t
          })
      }
    }
  }

  return issues
}

export function summarize(issues: ValidationIssue[]): { error: number; warn: number; info: number } {
  return {
    error: issues.filter((i) => i.level === 'error').length,
    warn: issues.filter((i) => i.level === 'warn').length,
    info: issues.filter((i) => i.level === 'info').length
  }
}
