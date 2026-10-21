import type { Diagram, Project, UcPackage } from '@shared/types'
import { diagramNameOf } from '@shared/idrules'
import { useCasesOf } from './layout'

const safe = (s: string): string => s.replace(/"/g, "'").replace(/\r?\n/g, ' ')
const alias = (prefix: string, i: number): string => `${prefix}${i}`

/**
 * PlantUML 유스케이스 다이어그램 텍스트 생성.
 * EA XMI가 "도구용 산출물"이라면 이쪽은 "문서/리뷰용" 산출물이다.
 * (설계서 붙여넣기, PR 리뷰, 위키 게시 등)
 *
 * 인자로 패키지를 주면 그 패키지의 다이어그램만, 없으면 프로젝트 전체를 그린다.
 * 한 패키지에 다이어그램이 여러 개면 각각 rectangle 로 나눈다.
 */
export function toPlantUml(project: Project, pkg?: UcPackage): string {
  const targets: Array<{ pkg: UcPackage; dgm: Diagram }> = (
    pkg ? [pkg] : project.packages
  ).flatMap((p) => p.diagrams.map((dgm) => ({ pkg: p, dgm })))

  const usedActorUids = new Set<string>()
  for (const { pkg: p, dgm } of targets)
    for (const uc of useCasesOf(p, dgm)) for (const a of uc.actorUids) usedActorUids.add(a)

  const actorAlias = new Map<string, string>()
  project.actors
    .filter((a) => usedActorUids.has(a.uid))
    .forEach((a, i) => actorAlias.set(a.uid, alias('A', i + 1)))

  const ucAlias = new Map<string, string>()
  let ucIdx = 0
  for (const { pkg: p, dgm } of targets)
    for (const uc of useCasesOf(p, dgm)) ucAlias.set(uc.uid, alias('UC', ++ucIdx))

  const lines: string[] = []
  lines.push('@startuml')
  lines.push(
    `title ${safe(pkg ? `[${pkg.code}] ${pkg.name}` : project.metadata.systemName)}`
  )
  lines.push('left to right direction')
  lines.push('skinparam packageStyle rectangle')
  lines.push('skinparam shadowing false')
  lines.push('')

  for (const a of project.actors.filter((x) => usedActorUids.has(x.uid))) {
    lines.push(`actor "${safe(a.name)}" as ${actorAlias.get(a.uid)}`)
  }
  lines.push('')

  for (const { pkg: p, dgm } of targets) {
    lines.push(`rectangle "${safe(diagramNameOf(p, dgm))}" {`)
    for (const uc of useCasesOf(p, dgm)) {
      lines.push(
        `  usecase "${safe(`${uc.name}\\n<size:10>[${uc.code}]</size>`)}" as ${ucAlias.get(uc.uid)}`
      )
    }
    lines.push('}')
    lines.push('')
  }

  for (const { pkg: p, dgm } of targets) {
    for (const uc of useCasesOf(p, dgm)) {
      for (const au of uc.actorUids) {
        const a = actorAlias.get(au)
        if (a) lines.push(`${a} --> ${ucAlias.get(uc.uid)}`)
      }
      for (const inc of uc.includeUids) {
        const t = ucAlias.get(inc)
        if (t) lines.push(`${ucAlias.get(uc.uid)} ..> ${t} : <<include>>`)
      }
      for (const ext of uc.extendUids) {
        const t = ucAlias.get(ext)
        if (t) lines.push(`${t} ..> ${ucAlias.get(uc.uid)} : <<extend>>`)
      }
    }
  }

  lines.push('@enduml')
  return lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n')
}
