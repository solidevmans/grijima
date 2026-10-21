/**
 * 자동 배치 선 관통 검사 — `npm run test:layout`
 *
 * 액터–유스케이스 선이 다른 유스케이스 타원을 지나면, 두 유스케이스 사이의
 * 관계선처럼 읽힌다. 이 고장은 두 번 나왔다(유스케이스 2개 가로 배치 →
 * 고쳤더니 5개부터 재발). 그래서 눈 대신 숫자로 잰다:
 *   예시 프로젝트의 모든 다이어그램 + 첫 다이어그램에 유스케이스를 1~8개 더해
 *   쓰이는 액터 전부에 연결한 경우에서, 어느 선도 다른 타원 안을 지나지 않고
 *   타원끼리 겹치지 않으면 합격. (손으로 옮긴 좌표는 사용자 몫이라 보지 않는다)
 * 자동 배치는 1366x768 첫 화면(캔버스 951×487)에 타원 폭 전체와 액터가 (두 명까지는
 * 전부, 셋 이상이면 둘 이상) 들어와야 한다 — 10개에서 액터가 화면 아래로, 타원이
 * 오른쪽 밖으로 나갔었고, 첫 액터만 들어오고 둘째는 잘렸다.
 */
import { readFileSync } from 'node:fs'
import type { Diagram, Project, UcPackage } from '../src/shared/types'
import {
  actorsUsedIn,
  nextUseCasePosition,
  resolveActorPositions,
  resolveUseCasePositions,
  treeLayout,
  useCaseNodeSize,
  useCasesOf
} from '../src/shared/layout'
import { ACTOR_H, ACTOR_W } from '../src/shared/diagram-svg'

let pass = 0
let fail = 0

/** 1366x768 창에서 다이어그램 캔버스가 스크롤 없이 보여 주는 크기 */
const FIRST_SCREEN = { w: 951, h: 487 }

/** tree: 트리 배치가 넣은 좌표(position·actorPositions)까지 잰다 */
function inspect(label: string, pkg: UcPackage, dgm: Diagram, project: Project, tree = false): void {
  const ucs = useCasesOf(pkg, dgm).filter((u) => tree || !u.position)
  const ucPos = resolveUseCasePositions(pkg, dgm, project)
  const actorPos = resolveActorPositions(pkg, dgm, project)
  const { w, h } = useCaseNodeSize(pkg, dgm, project)
  const center = (uid: string): { x: number; y: number } => {
    const p = ucPos.get(uid)!
    return { x: p.x + w / 2, y: p.y + h / 2 }
  }
  /** 점이 타원 안이면 1 미만 */
  const inside = (x: number, y: number, c: { x: number; y: number }): number =>
    ((x - c.x) / (w / 2)) ** 2 + ((y - c.y) / (h / 2)) ** 2

  const bad: string[] = []
  for (const uc of ucs) {
    const to = center(uc.uid)
    for (const aUid of uc.actorUids) {
      const ap = actorPos.get(aUid)
      if (!ap || (!tree && dgm.actorPositions?.[aUid])) continue
      const from = { x: ap.x + ACTOR_W / 2, y: ap.y + ACTOR_H / 2 }
      for (const other of ucs) {
        if (other.uid === uc.uid) continue
        const c = center(other.uid)
        for (let t = 0; t <= 1; t += 0.002) {
          if (inside(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, c) < 1) {
            bad.push(`선 →${uc.code} 이 ${other.code} 관통`)
            break
          }
        }
      }
    }
  }
  for (let i = 0; i < ucs.length; i++)
    for (let j = i + 1; j < ucs.length; j++) {
      const a = center(ucs[i].uid)
      const b = center(ucs[j].uid)
      if (Math.abs(a.x - b.x) < w && Math.abs(a.y - b.y) < h)
        bad.push(`${ucs[i].code}·${ucs[j].code} 겹침`)
    }

  const xs = ucs.map((u) => ucPos.get(u.uid)!.x)
  if (!tree) {
    const right = Math.max(...xs) + w
    const bottoms = [...actorPos.values()].map((p) => p.y + ACTOR_H).sort((a, b) => a - b)
    const need = Math.min(bottoms.length, 2)
    if (right > FIRST_SCREEN.w) bad.push(`타원 오른쪽 끝 ${right} > 첫 화면 폭 ${FIRST_SCREEN.w}`)
    if (need > 0 && bottoms[need - 1] > FIRST_SCREEN.h)
      bad.push(`${need}번째 액터 아래 끝 ${bottoms[need - 1]} > 첫 화면 높이 ${FIRST_SCREEN.h}`)
  }

  if (bad.length === 0) {
    pass++
    console.log(`  ✓ ${label} (유스케이스 ${ucs.length}, x=${Math.min(...xs)}~${Math.max(...xs)})`)
  } else {
    fail++
    console.log(`  ✗ ${label}\n      ${bad.join('\n      ')}`)
  }
}

const base = JSON.parse(readFileSync('examples/예시.eaucs', 'utf8')) as Project

console.log('[1] 예시 프로젝트의 다이어그램 전부')
for (const pkg of base.packages) for (const dgm of pkg.diagrams) inspect(`${pkg.name} / ${dgm.uid.slice(0, 8)}`, pkg, dgm, base)

/** 첫 다이어그램에 유스케이스를 extra개 더하고 전부를 액터 actorCount명에 연결 */
function grown(extra: number, actorCount: number): { project: Project; pkg: UcPackage; dgm: Diagram } {
  const project = structuredClone(base)
  const pkg = project.packages[0]
  const dgm = pkg.diagrams[0]
  const first = useCasesOf(pkg, dgm)[0]
  // 다이어그램의 액터가 모자라면 프로젝트의 다른 액터를 데려온다
  const actorUids = [
    ...new Set([...useCasesOf(pkg, dgm).flatMap((u) => u.actorUids), ...project.actors.map((a) => a.uid)])
  ].slice(0, actorCount)
  for (const u of useCasesOf(pkg, dgm)) u.actorUids = [...actorUids]
  for (let k = 0; k < extra; k++)
    pkg.useCases.push({ ...first, uid: `extra-${k}`, code: `${first.code}+${k + 1}`, actorUids: [...actorUids], position: undefined })
  return { project, pkg, dgm }
}

/** `트리 배치` 버튼과 같이 좌표를 써 넣는다 */
function applyTree(pkg: UcPackage, dgm: Diagram, project: Project): void {
  const plan = treeLayout(pkg, dgm, project)
  dgm.actorPositions = Object.fromEntries(plan.actors)
  for (const u of pkg.useCases) {
    const p = plan.ucs.get(u.uid)
    if (p) u.position = p
  }
}

console.log('[2] 첫 다이어그램에 유스케이스를 더해 쓰이는 액터 전부에 연결')
for (const actorCount of [1, 2, 3])
  for (let extra = 1; extra <= 8; extra++) {
    const { project, pkg, dgm } = grown(extra, actorCount)
    inspect(`+${extra}개 · 액터 ${actorsUsedIn(pkg, dgm).size}명`, pkg, dgm, project)
  }

console.log('[3] 트리 배치 — 예시 다이어그램 전부')
{
  const project = structuredClone(base)
  for (const pkg of project.packages)
    for (const dgm of pkg.diagrams) {
      applyTree(pkg, dgm, project)
      inspect(`${pkg.name} / ${dgm.uid.slice(0, 8)}`, pkg, dgm, project, true)
    }
}

console.log('[4] 트리 배치 — 첫 다이어그램에 유스케이스를 더해 액터 1명·2명에 연결')
for (const actorCount of [1, 2])
  for (let extra = 1; extra <= 8; extra++) {
    const { project, pkg, dgm } = grown(extra, actorCount)
    applyTree(pkg, dgm, project)
    inspect(`+${extra}개 · 액터 ${actorsUsedIn(pkg, dgm).size}명`, pkg, dgm, project, true)
  }

// 유스케이스 6개를 액터 셋이 6·5·1개씩 나눠 쓰면 가지가 빈 액터가
// 200px씩 아래로 쌓여 선이 가팔라지고, 열이 격자 배치보다 190px 오른쪽(첫 화면 밖)으로 밀렸다
console.log('[5] 트리 배치 — 유스케이스 6개를 액터 셋이 6·5·1개씩, 열이 격자 이하·첫 화면 안')
for (let solo = 0; solo < 6; solo++) {
  const { project, pkg, dgm } = grown(4, 3)
  const [a0, a1, a2] = useCasesOf(pkg, dgm)[0].actorUids
  useCasesOf(pkg, dgm).forEach((u, i) => {
    u.actorUids = [a0, ...(i < 5 ? [a1] : []), ...(i === solo ? [a2] : [])]
  })
  const gridX = Math.max(...[...resolveUseCasePositions(pkg, dgm, project).values()].map((p) => p.x))
  applyTree(pkg, dgm, project)
  const { w } = useCaseNodeSize(pkg, dgm, project)
  const treeX = Math.max(...useCasesOf(pkg, dgm).map((u) => u.position!.x))
  const topActor = Math.min(...Object.values(dgm.actorPositions!).map((p) => p.y)) + ACTOR_H
  const label = `정책담당자 ↔ ${solo + 1}번째`
  if (treeX > gridX || treeX + w > FIRST_SCREEN.w || topActor > FIRST_SCREEN.h) {
    fail++
    console.log(`  ✗ ${label} — 트리 x=${treeX}, 격자 x=${gridX}, 오른쪽 끝 ${treeX + w}, 첫 액터 아래 끝 ${topActor}`)
  } else inspect(`${label} (격자 x=${gridX})`, pkg, dgm, project, true)
}

// 트리 배치 뒤 `+ 유스케이스`로 더한 타원이 자동 배치 열에 혼자 떨어졌다
console.log('[6] 트리 배치 뒤 새 유스케이스 — 맨 아래 타원 바로 아래 줄, 같은 x')
{
  const { project, pkg, dgm } = grown(4, 3)
  const rowH = project.settings.layoutRowHeight
  if (nextUseCasePosition(pkg, dgm, rowH) !== null) {
    fail++
    console.log('  ✗ 자동 배치 다이어그램인데 좌표를 정했다')
  } else pass++
  applyTree(pkg, dgm, project)
  const bottom = useCasesOf(pkg, dgm).map((u) => u.position!).reduce((a, b) => (b.y > a.y ? b : a))
  const next = nextUseCasePosition(pkg, dgm, rowH)
  if (!next || next.x !== bottom.x || next.y !== bottom.y + rowH) {
    fail++
    console.log(`  ✗ 새 자리 ${JSON.stringify(next)}, 맨 아래 ${JSON.stringify(bottom)}`)
  } else {
    pass++
    console.log(`  ✓ 맨 아래 (${bottom.x}, ${bottom.y}) → 새 자리 (${next.x}, ${next.y})`)
  }
}

console.log(`\n${fail === 0 ? '통과' : '실패'}: ${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
