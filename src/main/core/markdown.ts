import type { Actor, Diagram, Project, UcPackage, UseCase } from '@shared/types'
import { diagramNameOf, packageLabel, teamLabel } from '@shared/idrules'
import { useCasesOf } from './layout'
import { toPlantUml } from './plantuml'

/**
 * 마크다운 볼트 생성 — 검토·인수인계용 **읽기 전용** 산출물.
 *
 * XMI가 "EA용", PlantUML이 "그림용"이라면 이쪽은 **"탐색용"**이다.
 * 요구사항ID ↔ 유스케이스 ↔ 액터는 이미 그래프인데, 지금은 그 관계가
 * .eaucs 안에 uid로만 묶여 있어 EA를 열지 않으면 사람이 볼 수 없다.
 * 위키링크로 풀어 두면 옵시디언에서 백링크·그래프 뷰로 바로 훑을 수 있고,
 * 옵시디언이 없어도 그냥 마크다운 문서로 읽힌다(폐쇄망에서 이게 중요하다).
 *
 * 폴더 구조는 EA 패키지 트리를 그대로 따른다: 요구사항 1건 = 폴더 1개.
 *
 * ★ 되읽지 않는다 — 이 방향은 단방향이다.
 *   EA GUID는 `SHA-1(projectId::uid)`로 채번되고(eaid.ts), 그 uid는 .eaucs에
 *   영구 저장된 값이다. 볼트를 원본 삼아 편집하고 되읽으면 노트를 지웠다 쓰거나
 *   복제하는 순간 uid가 흔들리고, 그러면 EA에서 "갱신"이 "중복 생성"으로 바뀐다.
 *   frontmatter의 uid는 대조용으로만 적어 둔다.
 */

export interface VaultFile {
  /** 볼트 루트 기준 상대 경로 (구분자는 '/') */
  path: string
  content: string
}

export interface VaultResult {
  files: VaultFile[]
  stats: { notes: number; useCases: number; actors: number; packages: number; diagrams: number }
}

const NL = '\n'

/**
 * 파일명으로 쓸 수 없는 문자 제거.
 *   `\ / : * ? " < > |` → Windows 금지 문자
 *   `# ^ [ ] |`         → 옵시디언 위키링크 문법을 깨뜨리는 문자
 */
const FORBIDDEN = /[\\/:*?"<>|#^[\]]/g

function fileName(raw: string): string {
  const s = (raw || '')
    .replace(FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90)
    // Windows는 마침표/공백으로 끝나는 이름을 허용하지 않는다
    .replace(/[.\s]+$/, '')
  return s || '무제'
}

/**
 * 노트 이름 유일성 보장.
 * 위키링크는 파일명으로 대상을 찾으므로 이름이 겹치면 링크가 엉뚱한 노트를
 * 가리킨다. 액터 이름 중복은 검증에서 경고 수준이고, 요구사항 ID가 겹치면
 * 패키지 코드도 겹친다. 덮어쓰지 말고 번호를 붙인다.
 */
class NameAllocator {
  private used = new Map<string, number>()

  take(base: string): string {
    const name = fileName(base)
    const key = name.toLowerCase()
    const n = this.used.get(key) ?? 0
    this.used.set(key, n + 1)
    if (n === 0) return name
    const suffixed = `${name} (${n + 1})`
    this.used.set(suffixed.toLowerCase(), 1)
    return suffixed
  }
}

/** YAML 스칼라. 안전한 값은 그대로, 아니면 JSON 문자열(= YAML 겹따옴표 스칼라) */
function yaml(raw: string): string {
  const s = (raw ?? '').trim()
  if (!s) return '""'
  return /^[\w가-힣][\w가-힣 .()\-/]*$/.test(s) ? s : JSON.stringify(s)
}

/** [[대상|표시]] — 표시가 대상과 같으면 별칭을 생략한다 */
function link(target: string, label?: string): string {
  return !label || label === target ? `[[${target}]]` : `[[${target}|${label}]]`
}

/**
 * 여러 줄 텍스트를 마크다운 목록으로.
 * 흐름은 보통 "1. …" 처럼 이미 번호가 붙어 오므로 그때는 번호 목록으로 그대로 두고
 * 앞에 `-` 를 덧붙이지 않는다 (`- 1. …` 로 마커가 두 번 찍힌다).
 */
function asList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) =>
      /^\d+[.)]\s*/.test(l)
        ? l.replace(/^(\d+)[.)]\s*/, '$1. ')
        : `- ${l.replace(/^[-*·]\s*/, '')}`
    )
}

function section(title: string, body: string[]): string[] {
  return body.length ? ['', `## ${title}`, ...body] : []
}

export function toVault(project: Project): VaultResult {
  const names = new NameAllocator()

  /* ---------------- 1단계: 노트 이름 확정 ----------------
     위키링크가 서로를 참조하므로 본문을 쓰기 전에 이름부터 전부 정한다. */

  const indexName = names.take(project.metadata.systemName || '유스케이스 모델')

  const actorName = new Map<string, string>()
  for (const a of project.actors) actorName.set(a.uid, names.take(a.name || '이름 없는 액터'))

  const pkgName = new Map<string, string>()
  const ucName = new Map<string, string>()
  for (const p of project.packages) {
    pkgName.set(p.uid, names.take(packageLabel(p)))
    // 유스케이스 노트는 이름이 아니라 **코드**로 연다.
    // 이름은 중복되기 쉽다("데이터 수집"이 여러 번 나온다) — 링크가 깨진다.
    for (const uc of p.useCases) ucName.set(uc.uid, names.take(uc.code || uc.name))
  }

  /* ---------------- 2단계: 본문 ---------------- */

  const files: VaultFile[] = []

  files.push({ path: `${indexName}.md`, content: indexNote(project, indexName, pkgName, actorName) })

  for (const a of project.actors) {
    files.push({
      path: `액터/${actorName.get(a.uid)}.md`,
      content: actorNote(a, project, ucName, pkgName)
    })
  }

  for (const p of project.packages) {
    const dir = pkgName.get(p.uid) as string
    files.push({
      path: `${dir}/${dir}.md`,
      content: packageNote(p, project, indexName, ucName, actorName)
    })
    for (const uc of p.useCases) {
      files.push({
        path: `${dir}/${ucName.get(uc.uid)}.md`,
        content: useCaseNote(uc, p, pkgName, ucName, actorName)
      })
    }
  }

  const useCases = project.packages.reduce((n, p) => n + p.useCases.length, 0)
  const diagrams = project.packages.reduce((n, p) => n + p.diagrams.length, 0)

  return {
    files,
    stats: {
      notes: files.length,
      useCases,
      actors: project.actors.length,
      packages: project.packages.length,
      diagrams
    }
  }
}

/* ------------------------------------------------------------------ */
/* 노트별 본문                                                          */
/* ------------------------------------------------------------------ */

function indexNote(
  project: Project,
  indexName: string,
  pkgName: Map<string, string>,
  actorName: Map<string, string>
): string {
  const useCases = project.packages.reduce((n, p) => n + p.useCases.length, 0)
  const diagrams = project.packages.reduce((n, p) => n + p.diagrams.length, 0)

  const lines = [
    '---',
    'type: 인덱스',
    `systemName: ${yaml(project.metadata.systemName)}`,
    `projectId: ${yaml(project.metadata.projectId)}`,
    `exportedAt: ${yaml(project.metadata.modifiedAt)}`,
    '---',
    `# ${indexName}`,
    '',
    `요구사항(UCD) ${project.packages.length} · 다이어그램 ${diagrams} · 유스케이스 ${useCases} · 액터 ${project.actors.length}`,
    '',
    '> [!info] 읽기 전용 산출물',
    '> EA UseCase Studio가 내보낸 검토용 사본입니다.',
    '> 원본은 `.eaucs` 프로젝트 파일이며, 이 볼트를 고쳐도 원본에 반영되지 않습니다.',
    '> 모델을 수정하려면 앱에서 편집한 뒤 다시 내보내세요.',
    '',
    '## 요구사항 (UCD 패키지)'
  ]

  if (!project.packages.length) lines.push('- (없음)')
  for (const p of project.packages) {
    lines.push(
      `- ${link(pkgName.get(p.uid) as string)} — 유스케이스 ${p.useCases.length} · 다이어그램 ${p.diagrams.length}`
    )
  }

  if (project.actors.length) {
    lines.push('', '## 액터')
    for (const a of project.actors) {
      const kind = a.external ? '외부 시스템' : a.kind === 'Secondary' ? 'Secondary' : 'Primary'
      lines.push(`- ${link(actorName.get(a.uid) as string)} — ${kind}`)
    }
  }

  return lines.join(NL) + NL
}

function packageNote(
  p: UcPackage,
  project: Project,
  indexName: string,
  ucName: Map<string, string>,
  actorName: Map<string, string>
): string {
  const actorUids = new Set<string>()
  for (const uc of p.useCases) for (const a of uc.actorUids) actorUids.add(a)

  const lines = [
    '---',
    'type: 요구사항',
    `code: ${yaml(p.code)}`,
    `reqId: ${yaml(p.reqId)}`,
    `team: ${yaml(teamLabel(p.team))}`,
    `uid: ${yaml(p.uid)}`,
    '---',
    `# ${packageLabel(p)}`,
    '',
    `요구사항 \`${p.reqId || '미지정'}\` · 팀 ${teamLabel(p.team)}`,
    '',
    `상위: ${link(indexName)}`,
    ...(p.description.trim() ? ['', '## 개요', p.description.trim()] : [])
  ]

  if (actorUids.size) {
    lines.push(
      '',
      `액터: ${[...actorUids].map((u) => link(actorName.get(u) as string)).join(' · ')}`
    )
  }

  // 다이어그램별로 유스케이스를 나눠 적는다. UC 코드의 첫 순번이 곧 다이어그램이다.
  for (const dgm of p.diagrams) {
    const ucs = useCasesOf(p, dgm)
    lines.push('', `## ${diagramNameOf(p, dgm)}`)
    if (!ucs.length) lines.push('- (유스케이스 없음)')
    for (const uc of ucs) {
      lines.push(
        `- ${link(ucName.get(uc.uid) as string)} ${uc.name} — ${uc.priority} · ${uc.difficulty}`
      )
    }
    lines.push('', '```plantuml', toPlantUml(project, { ...p, diagrams: [dgm] }), '```')
  }

  const orphan = p.useCases.filter((uc) => !p.diagrams.some((d) => d.uid === uc.diagramUid))
  if (orphan.length) {
    lines.push('', '## 소속 다이어그램 없음')
    lines.push('> 어느 다이어그램에도 그려지지 않습니다. 앱의 검증 탭에서 확인하세요.')
    for (const uc of orphan) lines.push(`- ${link(ucName.get(uc.uid) as string)} ${uc.name}`)
  }

  return lines.join(NL) + NL
}

function useCaseNote(
  uc: UseCase,
  p: UcPackage,
  pkgName: Map<string, string>,
  ucName: Map<string, string>,
  actorName: Map<string, string>
): string {
  const rel = (uids: string[]): string[] =>
    uids.map((u) => ucName.get(u)).filter(Boolean).map((n) => `- ${link(n as string)}`)

  const dgm = p.diagrams.find((d) => d.uid === uc.diagramUid)

  const lines = [
    '---',
    'type: 유스케이스',
    `code: ${yaml(uc.code)}`,
    `reqId: ${yaml(uc.reqId || p.reqId)}`,
    `priority: ${yaml(uc.priority)}`,
    `difficulty: ${yaml(uc.difficulty)}`,
    `package: ${yaml(p.code)}`,
    `diagram: ${yaml(dgm ? diagramNameOf(p, dgm) : '(없음)')}`,
    // 대조용. 되읽지 않는다 — 이 값이 EA GUID의 시드다(markdown.ts 상단 참고).
    `uid: ${yaml(uc.uid)}`,
    '---',
    `# ${uc.name}`,
    '',
    `\`${uc.code}\` · 요구사항 \`${uc.reqId || p.reqId || '미지정'}\` · 우선순위 ${uc.priority} · 난이도 ${uc.difficulty}`,
    '',
    `상위: ${link(pkgName.get(p.uid) as string)}`
  ]

  const actors = uc.actorUids.map((u) => actorName.get(u)).filter(Boolean)
  lines.push(
    '',
    actors.length
      ? `액터: ${actors.map((n) => link(n as string)).join(' · ')}`
      : '액터: (연결 없음) — EA에서 고립된 유스케이스가 됩니다.'
  )

  // 절 구성은 유스케이스모형기술서 양식을 따른다
  if (uc.description.trim()) lines.push(...section('유스케이스 개요', [uc.description.trim()]))
  lines.push(...section('관련 요구사항', [`\`${uc.reqId || p.reqId || '미지정'}\``]))
  if (uc.precondition.trim()) lines.push(...section('사전조건', asList(uc.precondition)))
  if (uc.postcondition.trim()) lines.push(...section('사후조건', asList(uc.postcondition)))
  lines.push(...section('기본 흐름', asList(uc.mainFlow)))
  lines.push(...section('대체흐름', asList(uc.altFlow)))
  lines.push(...section('예외흐름', asList(uc.exceptionFlow)))
  if (uc.specialRequirement.trim())
    lines.push(...section('특별요구사항', asList(uc.specialRequirement)))
  lines.push(...section('include', rel(uc.includeUids)))
  lines.push(...section('extend', rel(uc.extendUids)))
  if (uc.note.trim()) lines.push(...section('비고', [uc.note.trim()]))

  return lines.join(NL) + NL
}

function actorNote(
  a: Actor,
  project: Project,
  ucName: Map<string, string>,
  pkgName: Map<string, string>
): string {
  const lines = [
    '---',
    'type: 액터',
    `kind: ${yaml(a.kind)}`,
    `external: ${a.external}`,
    `uid: ${yaml(a.uid)}`,
    '---',
    `# ${a.name}`,
    '',
    a.external ? '외부 시스템 액터' : `${a.kind} 액터`
  ]

  if (a.description.trim() && a.description.trim() !== a.name.trim()) {
    lines.push('', a.description.trim())
  }

  /*
   * 백링크로도 보이지만 명시적으로 적는다.
   * 옵시디언 없이 열었을 때도 "이 액터가 무엇에 관여하는가"가 보여야 한다.
   */
  const rows: string[] = []
  for (const p of project.packages) {
    for (const uc of p.useCases) {
      if (!uc.actorUids.includes(a.uid)) continue
      rows.push(
        `- ${link(ucName.get(uc.uid) as string)} ${uc.name} — ${link(pkgName.get(p.uid) as string)}`
      )
    }
  }

  lines.push('', '## 이 액터가 등장하는 유스케이스')
  lines.push(rows.length ? rows.join(NL) : '- (없음)')

  return lines.join(NL) + NL
}

/** 다이어그램 하나만 담은 임시 패키지로 PlantUML을 뽑기 위한 헬퍼 타입 보정 */
export type { Diagram }
