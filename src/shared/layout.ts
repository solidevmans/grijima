import type { Diagram, Point, Project, UcPackage } from './types'
import { ACTOR_START, UC_START_X, UC_START_Y } from './constants'

/**
 * 다이어그램 좌표 계산 (메인/렌더러 공용).
 * UseCase.position 이 지정되어 있으면(= 캔버스에서 드래그함) 그 값을,
 * 없으면 자동 배치(한 열, autoLayout) 값을 쓴다 → 수동 배치가 항상 우선한다.
 *
 * 좌표는 **다이어그램 단위**다. 한 패키지에 다이어그램이 여러 개일 수 있고,
 * 유스케이스는 자기 diagramUid 가 가리키는 다이어그램에만 그려진다.
 */

/** 이 다이어그램에 그려지는 유스케이스만 */
export function useCasesOf(pkg: UcPackage, dgm: Diagram) {
  return pkg.useCases.filter((uc) => uc.diagramUid === dgm.uid)
}

/** 액터 칸(ACTOR_W×ACTOR_H, diagram-svg) 왼쪽 위에서 몸 중심까지 */
const ACTOR_CENTER = { x: 45, y: 50 }

/**
 * 선분이 타원 안을 지나는가 (가장자리에서 MARGIN 만큼 띄운다).
 * 타원 좌표계로 바꿔 단위원과 선분의 교차를 푼다.
 */
function segmentHitsEllipse(
  a: Point,
  b: Point,
  c: Point,
  rx: number,
  ry: number
): boolean {
  const ax = (a.x - c.x) / rx
  const ay = (a.y - c.y) / ry
  const dx = (b.x - a.x) / rx
  const dy = (b.y - a.y) / ry
  const A = dx * dx + dy * dy
  const B = 2 * (ax * dx + ay * dy)
  const C = ax * ax + ay * ay - 1
  const disc = B * B - 4 * A * C
  if (A === 0 || disc <= 0) return false
  const t1 = (-B - Math.sqrt(disc)) / (2 * A)
  const t2 = (-B + Math.sqrt(disc)) / (2 * A)
  return t1 < 1 && t2 > 0
}

/** 선이 타원을 스치지 않게 두는 여유 (px) */
const MARGIN = 8

/** 1366x768 창에서 다이어그램 캔버스가 스크롤 없이 보여 주는 높이 */
const FIRST_SCREEN_H = 487

/**
 * 자동 배치 — 유스케이스는 한 줄에 하나씩 위에서 아래로, 액터는 그 줄들의 가운데
 * 높이에(단, 첫 화면에 액터 두 명까지 이름표가 들어오는 높이까지만).
 *
 * 예전에는 가장 가파른 선에 맞춰 **열 전체**를 오른쪽으로 밀었다(10개면 x≈840,
 * 1366px 첫 화면에 타원이 안 들어왔다). 실제로 비켜야 하는 건 선이 지나가는
 * 타원뿐이다 — 액터 높이에 가까운 줄일수록 바깥 줄로 가는 선이 그 위를 지나므로
 * 그 줄만 오른쪽으로 민다. 결과는 액터를 둘러싼 활 모양이 된다.
 * 액터를 끌어도 줄이 따라 움직이지 않도록 자동 좌표만 쓴다.
 */
function autoLayout(
  pkg: UcPackage,
  dgm: Diagram,
  project: Project
): { ucX: number[]; actorY0: number } {
  const rowH = project.settings.layoutRowHeight
  const ucs = useCasesOf(pkg, dgm)
  const n = Math.max(1, ucs.length)
  const used = actorsUsedIn(pkg, dgm)
  const actorOrder = project.actors.filter((a) => used.has(a.uid)).map((a) => a.uid)
  const na = Math.max(1, actorOrder.length)
  const { w, h } = useCaseNodeSize(pkg, dgm, project)

  const mid = UC_START_Y + ((n - 1) * rowH) / 2 + h / 2
  const groupTop = mid - ((na - 1) * ACTOR_START.gap) / 2 - ACTOR_CENTER.y
  // 액터 무리가 내려갈 수 있는 한도: 1366x768 첫 화면에 (두 명까지) 이름표 끝까지
  const shown = Math.min(na, 2)
  const lowest = FIRST_SCREEN_H - (shown - 1) * ACTOR_START.gap - 2 * ACTOR_CENTER.y
  const actorY0 = Math.max(
    UC_START_Y,
    Math.min(UC_START_Y + 2 * rowH, Math.floor(lowest / 10) * 10, Math.round(groupTop / 10) * 10)
  )

  const actorAt = (uid: string): Point => ({
    x: ACTOR_START.x + ACTOR_CENTER.x,
    y: actorY0 + actorOrder.indexOf(uid) * ACTOR_START.gap + ACTOR_CENTER.y
  })
  const ucX = pushClear(
    ucs.map((_, i) => UC_START_Y + i * rowH),
    ucs.map((uc) => uc.actorUids.filter((a) => used.has(a)).map(actorAt)),
    UC_START_X,
    w,
    h
  )
  return { ucX, actorY0 }
}

/**
 * 한 열(위→아래 순서의 ucY)에서 액터 선이 지나는 타원만 10px씩 오른쪽으로 민다.
 * 민 타원은 선에서 멀어질 뿐이라 끝난다. `from[i]`는 i번째 타원에 선을 긋는 액터 몸 중심들.
 */
function pushClear(ucY: number[], from: Point[][], startX: number, w: number, h: number): number[] {
  const ucX = ucY.map(() => startX)
  const center = (i: number): Point => ({ x: ucX[i] + w / 2, y: ucY[i] + h / 2 })
  for (let round = 0, moved = true; moved && round < 500; round++) {
    moved = false
    // 활이 들쭉날쭉하지 않게: 가장 많이 민 줄까지는 오르기만, 그 뒤로는 내리기만
    const peak = ucX.indexOf(Math.max(...ucX))
    for (let i = 1; i <= peak; i++) ucX[i] = Math.max(ucX[i], ucX[i - 1])
    for (let i = ucX.length - 2; i > peak; i--) ucX[i] = Math.max(ucX[i], ucX[i + 1])
    for (let t = 0; t < ucY.length; t++)
      for (const a of from[t])
        for (let o = 0; o < ucY.length; o++) {
          if (o === t) continue
          if (segmentHitsEllipse(a, center(t), center(o), w / 2 + MARGIN, h / 2 + MARGIN)) {
            ucX[o] += 10
            moved = true
          }
        }
  }
  return ucX
}

export function resolveUseCasePositions(
  pkg: UcPackage,
  dgm: Diagram,
  project: Project
): Map<string, Point> {
  const map = new Map<string, Point>()
  const { ucX } = autoLayout(pkg, dgm, project)
  const rowH = project.settings.layoutRowHeight
  useCasesOf(pkg, dgm).forEach((uc, i) => {
    map.set(uc.uid, uc.position ?? { x: ucX[i], y: UC_START_Y + i * rowH })
  })
  return map
}

/**
 * 이 다이어그램에 새로 더할 유스케이스의 자리. 기존 유스케이스가 **전부** 손으로
 * (끌기·`트리 배치`) 놓여 있으면 맨 아래 타원 바로 아래 줄, 같은 x에 둔다 —
 * 자동 자리로 보내면 정리해 둔 열과 다른 곳에 혼자 떨어졌다.
 * 하나라도 자동이면 null(자동 배치 열에 이어 붙는다).
 */
export function nextUseCasePosition(pkg: UcPackage, dgm: Diagram, rowH: number): Point | null {
  const ucs = useCasesOf(pkg, dgm)
  if (ucs.length === 0 || ucs.some((uc) => !uc.position)) return null
  const bottom = ucs.reduce((a, b) => (b.position!.y > a.position!.y ? b : a)).position!
  return { x: bottom.x, y: bottom.y + rowH }
}

export function defaultActorPosition(index: number): Point {
  return { x: ACTOR_START.x, y: ACTOR_START.y + index * ACTOR_START.gap }
}

/** 이 다이어그램에서 실제로 사용 중인 액터만 */
export function actorsUsedIn(pkg: UcPackage, dgm: Diagram): Set<string> {
  const s = new Set<string>()
  for (const uc of useCasesOf(pkg, dgm)) for (const a of uc.actorUids) s.add(a)
  // 연결 없이 캔버스에 직접 올려 둔 액터도 그린다
  for (const a of dgm.extraActorUids ?? []) s.add(a)
  return s
}

/**
 * 이 다이어그램에 그릴 액터들의 좌표.
 * 자동 배치는 **전체 액터 목록의 인덱스가 아니라 이 다이어그램에서 쓰이는
 * 액터들 안에서의 순번**을 쓴다. 그렇지 않으면 5명 중 1번과 5번만 쓰는
 * 다이어그램에서 두 액터가 800px 떨어져 그려진다.
 */
export function resolveActorPositions(
  pkg: UcPackage,
  dgm: Diagram,
  project: Project
): Map<string, Point> {
  const used = actorsUsedIn(pkg, dgm)
  const map = new Map<string, Point>()
  const { actorY0 } = autoLayout(pkg, dgm, project)
  let i = 0
  for (const a of project.actors) {
    if (!used.has(a.uid)) continue
    const auto = { x: ACTOR_START.x, y: actorY0 + i * ACTOR_START.gap }
    map.set(a.uid, dgm.actorPositions?.[a.uid] ?? auto)
    i++
  }
  return map
}

/* ===================== 유스케이스 노드 크기 (EA 표기) =====================
 *
 * EA는 유스케이스 이름(`[UC-...] 이름`) 전체를 **타원 안에** 그린다. 이 앱도
 * 같아야 해서 ID와 이름을 타원 안 두 줄로 넣는데,
 * `UC-SFR-001-PAD(플랫폼기반)-02-01` 같은 ID는 11px 고정폭으로도 220px가 넘는다.
 * 설정값(ucWidth 140)에 그대로 그리면 글자가 타원 밖으로 나가 선과 겹친다.
 *
 * 그래서 크기를 **글자에서 거꾸로 구한다.** 설정값은 이제 "최소 크기"다.
 * 한 다이어그램 안에서는 가장 긴 라벨 하나에 맞춰 **모두 같은 크기**로 그린다 —
 * EA 다이어그램이 그렇게 보이고, 크기가 제각각이면 줄이 안 맞아 지저분하다.
 *
 * 이 값은 화면과 XMI geometry가 **같아야** 한다(EA에서 열었을 때 글자가 잘리면
 * 안 된다). 그래서 렌더러와 main이 이 함수를 같이 쓴다.
 */

/** 타원 안 글자 치수 (px). 내보낼 그림에서도 같은 값을 쓰므로 고정이다. */
export const UC_LABEL = {
  idSize: 11,
  nameSize: 12,
  lineH: 15,
  padX: 12,
  padY: 8,
  /** 이름 한 줄의 폭 한도 (전각 글자 수) */
  nameUnits: 12,
  /** 이름 줄 수 한도. 3b 모델이 내는 긴 이름(30자 안팎)이 `…` 없이 들어가는 값 */
  nameLines: 3
}

const WIDE = /[ᄀ-ᇿ　-〿㄰-㆏一-鿿가-힣＀-｠]/

/**
 * 글자 폭 어림값. 한글·전각은 글자크기만큼, 그 밖은 0.6배.
 * (Canvas 측정은 main 프로세스에 없고, 화면과 XMI가 같은 값을 써야 해서 어림한다)
 */
export function textWidth(s: string, fontPx: number): number {
  let n = 0
  for (const ch of s) n += WIDE.test(ch) ? 1 : 0.6
  return n * fontPx
}

/** 어림 폭이 maxW 를 넘으면 끝을 `…`로 줄인다 — 말없이 자르면 잘린 줄 모른다 */
export function fitText(s: string, fontPx: number, maxW: number): string {
  if (textWidth(s, fontPx) <= maxW) return s
  const chars = [...s]
  while (chars.length && textWidth(chars.join('') + '…', fontPx) > maxW) chars.pop()
  return chars.join('').trimEnd() + '…'
}

/** 전각 기준 글자 수 (한글 1, 그 밖 0.5) */
function units(s: string): number {
  let n = 0
  for (const ch of s) n += WIDE.test(ch) ? 1 : 0.5
  return n
}

/**
 * 유스케이스 이름을 타원 안 줄로 자른다. 띄어쓰기에서 끊고, 공백 없는 긴
 * 한글 이름은 글자 수로 끊는다. 한도를 넘으면 마지막 줄에 `…`를 붙인다 —
 * 말없이 자르면 사용자가 이름이 잘린 걸 모른다.
 */
export function wrapUcName(
  name: string,
  perLine = UC_LABEL.nameUnits,
  maxLines = UC_LABEL.nameLines
): string[] {
  const out: string[] = []
  let cur = ''
  const push = (): void => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const w of (name || '').split(/\s+/).filter(Boolean)) {
    if (cur && units(cur) + 0.5 + units(w) > perLine) push()
    if (units(w) > perLine) {
      // 공백 없는 긴 토큰: 글자 수로 끊는다
      for (const ch of w) {
        if (units(cur) + units(ch) > perLine) push()
        cur += ch
      }
    } else cur = cur ? `${cur} ${w}` : w
  }
  push()
  if (out.length <= maxLines) return out
  // 마지막 줄은 단어가 아니라 글자로 한도까지 채운다 — `…` 앞에 한 글자라도 더 보이게
  const kept = out.slice(0, maxLines - 1)
  let last = ''
  for (const ch of out.slice(maxLines - 1).join(' ')) {
    if (units(last + ch) > perLine - 1) break
    last += ch
  }
  kept.push(`${last.trimEnd()}…`)
  return kept
}

/** 타원 안에 들어가는 줄들. 첫 줄이 ID, 나머지가 이름이다 (EA 배치와 같은 순서) */
export function ucLabelLines(code: string, name: string): { text: string; size: number }[] {
  return [
    { text: `[${code}]`, size: UC_LABEL.idSize },
    ...wrapUcName(name).map((text) => ({ text, size: UC_LABEL.nameSize }))
  ]
}

/**
 * 타원 크기. 줄들이 타원 **안쪽**에 들어가는 최소 지름을 구한다.
 * 중심에서 dy 떨어진 높이의 타원 반폭은 `rx·√(1-(dy/ry)²)` 이므로,
 * 줄마다 필요한 rx 를 구해 가장 큰 값을 쓴다.
 */
export function useCaseNodeSize(
  pkg: UcPackage,
  dgm: Diagram,
  project: Project
): { w: number; h: number } {
  const { lineH, padX, padY } = UC_LABEL
  const minW = project.settings.ucWidth
  const minH = project.settings.ucHeight

  let lineCount = 2
  let needRx = minW / 2
  const measured: { w: number; i: number; n: number }[] = []
  for (const uc of useCasesOf(pkg, dgm)) {
    const lines = ucLabelLines(uc.code, uc.name)
    lineCount = Math.max(lineCount, lines.length)
    lines.forEach((l, i) => measured.push({ w: textWidth(l.text, l.size), i, n: lines.length }))
  }
  const ry = Math.max(minH / 2, (lineCount * lineH) / 2 + padY)
  for (const m of measured) {
    const dy = Math.abs((m.i - (m.n - 1) / 2) * lineH) + lineH / 2
    const shrink = Math.sqrt(Math.max(0.1, 1 - (dy / ry) ** 2))
    needRx = Math.max(needRx, (m.w / 2 + padX) / shrink)
  }
  // 10px 눈금(캔버스 스냅)에 맞춘다
  return { w: Math.ceil((needRx * 2) / 10) * 10, h: Math.ceil((ry * 2) / 10) * 10 }
}

/**
 * 액터별 트리 배치 (`트리 배치` 버튼) — 액터를 왼쪽 줄기로 두고, 각 유스케이스를
 * 처음 연결된 액터의 가지에 한 열로 늘어놓는다. 액터는 자기 가지 가운데 높이에.
 *
 * 가지가 빈 액터(유스케이스를 앞 액터에 다 뺏긴 경우)를 맨 아래에 두면 그 액터의
 * 선이 열 전체를 가로질러 타원을 관통한다. 그래서 연결된 유스케이스들의 가운데
 * 높이에 두고(다른 액터와 겹치면 가장 가까운 빈 높이로), 자동 배치처럼 선이
 * 지나는 타원만 오른쪽으로 민다.
 */
export function treeLayout(
  pkg: UcPackage,
  dgm: Diagram,
  project: Project
): { ucs: Map<string, Point>; actors: Map<string, Point> } {
  const rowH = project.settings.layoutRowHeight
  const ACTOR_X = 40
  const GAP = 40
  const { w, h } = useCaseNodeSize(pkg, dgm, project)
  const ucs = useCasesOf(pkg, dgm)
  const used = actorsUsedIn(pkg, dgm)
  const actors = project.actors.filter((a) => used.has(a.uid))

  const branch = new Map<string, string>()
  for (const uc of ucs) {
    const owner = actors.find((a) => uc.actorUids.includes(a.uid))
    if (owner) branch.set(uc.uid, owner.uid)
  }

  // 유스케이스 y (x는 기울기를 본 뒤 정한다)
  const ucY = new Map<string, number>()
  const actorY = new Map<string, number>()
  let y = UC_START_Y
  for (const a of actors) {
    const mine = ucs.filter((u) => branch.get(u.uid) === a.uid)
    if (mine.length === 0) continue
    mine.forEach((u, i) => ucY.set(u.uid, y + i * rowH))
    actorY.set(a.uid, Math.round((y + (mine.length * rowH) / 2 - ACTOR_CENTER.y) / 10) * 10)
    y += mine.length * rowH + GAP
  }
  // 액터가 없는 유스케이스는 맨 아래에 따로 모은다
  ucs.filter((u) => !branch.has(u.uid)).forEach((u, i) => ucY.set(u.uid, y + i * rowH))

  // 가지가 빈 액터: 연결된 유스케이스 가운데 높이, 다른 액터와 겹치면 위아래로 가장
  // 가까운 빈 높이에. 아래로만 쌓으면 셋째 액터부터 선이 가팔라져 열이 첫 화면 밖으로
  // 밀렸다
  for (const a of actors) {
    if (actorY.has(a.uid)) continue
    const linked = ucs.filter((u) => u.actorUids.includes(a.uid)).map((u) => ucY.get(u.uid)! + h / 2)
    const want = linked.length
      ? Math.round((linked.reduce((s, v) => s + v, 0) / linked.length - ACTOR_CENTER.y) / 10) * 10
      : y
    const free = (ay: number): boolean =>
      ay >= UC_START_Y && [...actorY.values()].every((other) => Math.abs(other - ay) >= ACTOR_START.gap)
    let ay = want
    for (let d = 10; !free(ay); d += 10) ay = free(want - d) ? want - d : want + d
    actorY.set(a.uid, ay)
  }

  // 선이 지나는 타원만 오른쪽으로 민다 (자동 배치와 같은 규칙)
  const order = [...ucs].sort((p, q) => ucY.get(p.uid)! - ucY.get(q.uid)!)
  const ucX = pushClear(
    order.map((u) => ucY.get(u.uid)!),
    order.map((u) =>
      u.actorUids
        .filter((a) => actorY.has(a))
        .map((a) => ({ x: ACTOR_X + ACTOR_CENTER.x, y: actorY.get(a)! + ACTOR_CENTER.y }))
    ),
    UC_START_X,
    w,
    h
  )

  return {
    ucs: new Map(order.map((u, i) => [u.uid, { x: ucX[i], y: ucY.get(u.uid)! }])),
    actors: new Map([...actorY].map(([uid, ay]) => [uid, { x: ACTOR_X, y: ay }]))
  }
}
