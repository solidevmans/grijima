import type { Actor, Diagram, Point, Project, UcPackage } from './types'
import { ACTOR_START, CSS_COLOR, UC_START_Y } from './constants'
import { diagramNameOf } from './idrules'
import {
  actorsUsedIn,
  defaultActorPosition,
  fitText,
  resolveActorPositions,
  resolveUseCasePositions,
  textWidth,
  ucLabelLines,
  useCasesOf,
  useCaseNodeSize,
  UC_LABEL,
  wrapUcName
} from './layout'

/**
 * 다이어그램 한 장의 기하(위치·테두리·선)와 그것을 그린 SVG.
 *
 * 화면(DiagramView)과 내보내는 그림이 **같은 계산**을 쓴다. 따로 두면 한쪽만
 * 고쳤을 때 "화면에서는 맞는데 문서에 붙인 그림은 다른" 상태가 되는데,
 * 피해야 할 것이 바로 그것이다 — 한 문서 안에서 EA 캡처와
 * 이 앱의 그림이 구별되면 안 된다.
 */

export const ACTOR_W = 90
export const ACTOR_H = 100
export const FRAME_PAD = 24
export const FRAME_TAB_H = 22

/**
 * 액터 이름표 줄. 타원 이름과 같은 규칙(12자·넘치면 `…`)으로 접되 두 줄까지 —
 * 132px(11px 글자 12자)이라 칸(90) 양옆으로 21씩 나가지만 FRAME_PAD(24) 안이라
 * 패키지 테두리를 넘지 않는다. 한 줄로 두면 긴 이름이 테두리·캔버스 밖으로 나간다.
 */
export const ACTOR_LABEL_LINE_H = 13
/**
 * 노드(액터·유스케이스)를 끌어 놓을 수 있는 왼쪽 끝. 패키지 테두리가 노드보다
 * FRAME_PAD 왼쪽에 서는데, 캔버스(x=2)에 막히면 테두리가 타원·액터 이름표(칸
 * 양옆 21)를 긋고 이름표 앞 글자가 캔버스 밖으로 잘린다. 여기서는 테두리 2, 이름표 5.
 */
export const NODE_MIN_X = FRAME_PAD + 2
export function actorLabelLines(name: string): string[] {
  return wrapUcName(name, UC_LABEL.nameUnits, 2)
}

/**
 * 유스케이스가 없는 다이어그램의 캔버스 안내 (화면에만, 그림 저장에는 안 넣는다).
 * 빈 상자만 있으면 "잘못 들어갔나?"로 읽힌다 — 빈 상태는 다음에 할 일을 말한다.
 * 둘째 줄은 화면에서 누르는 단추다 (이 다이어그램에 유스케이스를 넣는다).
 */
export const EMPTY_DIAGRAM_HINT = ['유스케이스가 없습니다', '+ 이 다이어그램에 유스케이스 추가']
export const EMPTY_DIAGRAM_HINT_PX = 12

/** 내보낸 그림의 바깥 여백과 기본 가로 크기 */
export const EXPORT_PAD = 32
export const EXPORT_WIDTH = 1600

export interface DiagramLink {
  from: Point
  to: Point
  ucUid: string
  actorUid: string
}

export interface DiagramDep {
  from: Point
  to: Point
  label: string
  fromUid: string
  toUid: string
  type: 'include' | 'extend'
}

export interface DiagramGeometry {
  ucPos: Map<string, Point>
  actorPos: Map<string, Point>
  /** 이 다이어그램에 그려지는 액터 (프로젝트 순서) */
  actors: Actor[]
  /** 타원 크기 — 한 다이어그램 안에서는 모두 같다 */
  ucW: number
  ucH: number
  box: { minX: number; minY: number; maxX: number; maxY: number }
  /** 패키지 테두리(UML 프레임). y 는 본문 상자의 위쪽이고 이름표는 그 위로 나간다 */
  frame: { x: number; y: number; w: number; h: number; tabW: number; label: string }
  links: DiagramLink[]
  deps: DiagramDep[]
}

/**
 * 타원 중심에서 `toward` 쪽으로 나아가 테두리에 닿는 점.
 * 중심에서 중심으로 그으면 선이 통째로 타원 밑에 깔려(타원이 나중에 그려진다)
 * 두 유스케이스가 붙어 있을 때 include 선이 아예 사라진다.
 */
function onEllipse(c: Point, toward: Point, rx: number, ry: number): Point {
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  const k = Math.hypot(dx / rx, dy / ry)
  return k ? { x: c.x + dx / k, y: c.y + dy / k } : c
}

export function diagramGeometry(project: Project, pkg: UcPackage, dgm: Diagram): DiagramGeometry {
  const ucPos = resolveUseCasePositions(pkg, dgm, project)
  const actorPos = resolveActorPositions(pkg, dgm, project)
  const used = actorsUsedIn(pkg, dgm)
  const actors = project.actors.filter((a) => used.has(a.uid))
  const { w: ucW, h: ucH } = useCaseNodeSize(pkg, dgm, project)

  const actorXY = (a: { uid: string }, i = 0): Point =>
    actorPos.get(a.uid) ?? defaultActorPosition(i)

  const nodeXY = [...actors.map((a) => actorXY(a)), ...ucPos.values()]
  const box = {
    // 빈 다이어그램(노드 0개)에서 Math.min 이 Infinity 가 되지 않게
    minX: nodeXY.length ? Math.min(...nodeXY.map((p) => p.x)) : ACTOR_START.x,
    minY: nodeXY.length ? Math.min(...nodeXY.map((p) => p.y)) : UC_START_Y,
    maxX: Math.max(
      ...actors.map((a) => actorXY(a).x + ACTOR_W),
      ...[...ucPos.values()].map((p) => p.x + ucW),
      ACTOR_START.x + ACTOR_W
    ),
    maxY: Math.max(
      ...actors.map((a) => actorXY(a).y + ACTOR_H),
      ...[...ucPos.values()].map((p) => p.y + ucH),
      UC_START_Y + ACTOR_H
    )
  }

  // 이름표가 위로 FRAME_TAB_H 만큼 더 나가므로 그만큼은 띄워 둔다
  const fx = Math.max(2, box.minX - FRAME_PAD)
  const fy = Math.max(FRAME_TAB_H + 2, box.minY - FRAME_PAD)
  const name = diagramNameOf(pkg, dgm)
  // 노드 0개면 테두리가 액터 한 칸 폭이라 이름표가 ID 중간에서 잘린다 —
  // 이름표 전체와 안내 줄이 들어가는 폭까지 넓힌다
  if (!nodeXY.length) {
    // 올림 — 딱 맞추면 소수 오차로 fitText 가 마지막 글자를 `…`로 줄인다
    const need = Math.ceil(
      Math.max(
        textWidth(name, 11) + 24 + 40,
        ...EMPTY_DIAGRAM_HINT.map((l) => textWidth(l, EMPTY_DIAGRAM_HINT_PX) + 32)
      )
    )
    box.maxX = Math.max(box.maxX, fx + need - FRAME_PAD)
  }

  const fw = box.maxX + FRAME_PAD - fx
  const tabW = Math.min(fw - 40, textWidth(name, 11) + 24)
  const frame = {
    x: fx,
    y: fy,
    w: fw,
    h: box.maxY + FRAME_PAD - fy,
    tabW,
    // 이름표 칸(왼쪽 12 + 오른쪽 12 여백) 안에 들게 줄인다 — 화면·그림 둘 다 이 값을 쓴다
    label: fitText(name, 11, tabW - 24)
  }

  const links: DiagramLink[] = []
  for (const uc of pkg.useCases) {
    const to = ucPos.get(uc.uid)
    if (!to) continue
    for (const auid of uc.actorUids) {
      const a = actors.find((x) => x.uid === auid)
      if (!a) continue
      const ap = actorXY(a)
      links.push({
        from: { x: ap.x + ACTOR_W / 2, y: ap.y + ACTOR_H / 2 },
        to: { x: to.x + ucW / 2, y: to.y + ucH / 2 },
        ucUid: uc.uid,
        actorUid: auid
      })
    }
  }

  const deps: DiagramDep[] = []
  for (const uc of pkg.useCases) {
    const from = ucPos.get(uc.uid)
    if (!from) continue
    const add = (targetUid: string, type: 'include' | 'extend'): void => {
      const to = ucPos.get(targetUid)
      if (!to) return
      const fromC = { x: from.x + ucW / 2, y: from.y + ucH / 2 }
      const toC = { x: to.x + ucW / 2, y: to.y + ucH / 2 }
      deps.push({
        from: onEllipse(fromC, toC, ucW / 2, ucH / 2),
        to: onEllipse(toC, fromC, ucW / 2, ucH / 2),
        label: type === 'include' ? '«include»' : '«extend»',
        fromUid: uc.uid,
        toUid: targetUid,
        type
      })
    }
    uc.includeUids.forEach((t) => add(t, 'include'))
    uc.extendUids.forEach((t) => add(t, 'extend'))
  }

  return { ucPos, actorPos, actors, ucW, ucH, box, frame, links, deps }
}

/* ============================ 그림으로 내보내기 ============================ */

/**
 * 내보낸 그림의 색. 화면은 다크/라이트가 있지만 **그림은 늘 흰 종이**다 —
 * 한글(HWP) 문서에 붙는 것이라서. 값은 라이트 토큰과 같다 (tokens.css).
 */
const INK = {
  frame: '#c3beb5',
  frameLabel: '#6f685e',
  nodeText: '#1c1a17',
  nodeCode: '#4a453f',
  nodeStroke: '#55504a',
  shadow: 'rgba(28, 26, 23, 0.28)',
  link: '#938d81',
  fontUi: "'Malgun Gothic', 'Segoe UI', sans-serif",
  fontMono: "'Cascadia Mono', Consolas, monospace"
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const n = (v: number): string => String(Math.round(v * 100) / 100)

/**
 * 그림 한 장의 바깥 틀 — 흰 종이와 공용 defs(화살표·그림자).
 * 다이어그램 한 장과 액터 모음 한 장이 같은 틀을 쓴다. 한 문서 안에 섞여 붙는
 * 그림들이라 종이색·그림자·화살표가 다르면 눈에 띈다.
 */
function svgDoc(
  parts: string[],
  contentW: number,
  contentH: number,
  width: number
): { svg: string; width: number; height: number } {
  const scale = width / contentW
  const w = Math.round(contentW * scale)
  const h = Math.round(contentH * scale)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
    `viewBox="0 0 ${n(contentW)} ${n(contentH)}">` +
    `<defs>` +
    `<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">` +
    `<path d="M0,0 L7,3 L0,6" fill="none" stroke="${INK.link}" stroke-width="1.2"/></marker>` +
    // EA는 요소 오른쪽 아래에 번지지 않는 회색 그림자를 깐다 (stdDeviation 0)
    `<filter id="ea-shadow" x="-10%" y="-10%" width="125%" height="130%">` +
    `<feDropShadow dx="3" dy="3" stdDeviation="0" flood-color="${INK.shadow}"/></filter>` +
    `</defs>` +
    `<rect x="0" y="0" width="${n(contentW)}" height="${n(contentH)}" fill="#ffffff"/>` +
    parts.join('') +
    `</svg>`
  return { svg, width: w, height: h }
}

/** 패키지 테두리(왼쪽 위 이름표 + 본문 상자). 좌표는 그림 안의 최종 위치다 */
function frameParts(
  x: number,
  y: number,
  w: number,
  h: number,
  tabW: number,
  label: string
): string[] {
  const fs = `fill="none" stroke="${INK.frame}" stroke-width="1"`
  return [
    `<rect x="${n(x)}" y="${n(y - FRAME_TAB_H)}" width="${n(tabW)}" height="${FRAME_TAB_H}" ${fs}/>`,
    `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" ${fs}/>`,
    `<text x="${n(x + 12)}" y="${n(y - 6)}" font-family="${INK.fontUi}" font-size="11" fill="${INK.frameLabel}">${esc(label)}</text>`
  ]
}

/** 졸라맨 액터 하나. x·y 는 ACTOR_W×ACTOR_H 칸의 왼쪽 위 */
function actorParts(x: number, y: number, name: string): string[] {
  const cx = x + ACTOR_W / 2
  const st = `stroke="${INK.nodeStroke}" stroke-width="1.6" fill="none"`
  return [
    // 줄인 이름의 전체는 마우스를 올리면 보인다
    `<g><title>${esc(name)}</title>`,
    `<circle cx="${n(cx)}" cy="${n(y + 16)}" r="10" ${st}/>`,
    `<line x1="${n(cx)}" y1="${n(y + 26)}" x2="${n(cx)}" y2="${n(y + 56)}" ${st}/>`,
    `<line x1="${n(cx - 16)}" y1="${n(y + 36)}" x2="${n(cx + 16)}" y2="${n(y + 36)}" ${st}/>`,
    `<line x1="${n(cx)}" y1="${n(y + 56)}" x2="${n(cx - 13)}" y2="${n(y + 78)}" ${st}/>`,
    `<line x1="${n(cx)}" y1="${n(y + 56)}" x2="${n(cx + 13)}" y2="${n(y + 78)}" ${st}/>`,
    ...actorLabelLines(name).map(
      (l, i) =>
        `<text x="${n(cx)}" y="${n(y + 94 + i * ACTOR_LABEL_LINE_H)}" text-anchor="middle" font-family="${INK.fontUi}" font-size="11" fill="${INK.nodeText}">${esc(l)}</text>`
    ),
    '</g>'
  ]
}

/**
 * 다이어그램 한 장을 **그 자체로 완결된** SVG 문자열로 그린다.
 * CSS 변수·외부 글꼴을 쓰지 않는다 — 한글 문서나 브라우저에 그대로 넣어도
 * 같은 그림이 나와야 하고, PNG로 구울 때도 이 문자열만 읽는다.
 */
export function diagramSvg(
  project: Project,
  pkg: UcPackage,
  dgm: Diagram,
  opts: { width?: number } = {}
): { svg: string; width: number; height: number } {
  const g = diagramGeometry(project, pkg, dgm)
  const fill = CSS_COLOR[pkg.color ?? 'none']

  // 그린 것 전체(이름표 포함)를 여백 안쪽으로 옮긴다
  const ox = EXPORT_PAD - g.frame.x
  const oy = EXPORT_PAD - (g.frame.y - FRAME_TAB_H)
  const contentW = g.frame.w + EXPORT_PAD * 2
  const contentH = g.frame.h + FRAME_TAB_H + EXPORT_PAD * 2

  const X = (v: number): string => n(v + ox)
  const Y = (v: number): string => n(v + oy)
  const parts: string[] = [
    ...frameParts(
      g.frame.x + ox,
      g.frame.y + oy,
      g.frame.w,
      g.frame.h,
      g.frame.tabW,
      g.frame.label
    )
  ]

  for (const l of g.links) {
    parts.push(
      `<line x1="${X(l.from.x)}" y1="${Y(l.from.y)}" x2="${X(l.to.x)}" y2="${Y(l.to.y)}" stroke="${INK.link}" stroke-width="1.2"/>`
    )
  }

  for (const d of g.deps) {
    parts.push(
      `<line x1="${X(d.from.x)}" y1="${Y(d.from.y)}" x2="${X(d.to.x)}" y2="${Y(d.to.y)}" stroke="${INK.link}" stroke-width="1.2" stroke-dasharray="5 4" marker-end="url(#arrow)"/>`,
      `<text x="${X((d.from.x + d.to.x) / 2)}" y="${Y((d.from.y + d.to.y) / 2 - 4)}" text-anchor="middle" font-family="${INK.fontUi}" font-size="11" fill="${INK.frameLabel}">${esc(d.label)}</text>`
    )
  }

  g.actors.forEach((a, i) => {
    const p = g.actorPos.get(a.uid) ?? defaultActorPosition(i)
    parts.push(...actorParts(p.x + ox, p.y + oy, a.name))
  })

  for (const uc of pkg.useCases) {
    const p = g.ucPos.get(uc.uid)
    if (!p) continue
    const cx = p.x + g.ucW / 2
    const cy = p.y + g.ucH / 2
    // 줄인 이름의 전체는 마우스를 올리면 보인다 (액터와 같다)
    parts.push(
      `<g><title>${esc(uc.name)}</title>`,
      `<ellipse cx="${X(cx)}" cy="${Y(cy)}" rx="${n(g.ucW / 2)}" ry="${n(g.ucH / 2)}" fill="${fill}" stroke="${INK.nodeStroke}" stroke-width="1" filter="url(#ea-shadow)"/>`
    )
    const lines = ucLabelLines(uc.code, uc.name)
    const top = cy - ((lines.length - 1) * UC_LABEL.lineH) / 2
    lines.forEach((l, i) => {
      const mono = i === 0
      parts.push(
        `<text x="${X(cx)}" y="${Y(top + i * UC_LABEL.lineH + 4)}" text-anchor="middle" font-family="${mono ? INK.fontMono : INK.fontUi}" font-size="${l.size}" fill="${mono ? INK.nodeCode : INK.nodeText}">${esc(l.text)}</text>`
      )
    })
    parts.push('</g>')
  }

  return svgDoc(parts, contentW, contentH, opts.width ?? EXPORT_WIDTH)
}

/** 그림 파일 이름 — `<요구사항 ID>-<다이어그램 번호 2자리>` */
export function diagramImageName(pkg: UcPackage, dgm: Diagram): string {
  return `${pkg.reqId || pkg.code}-${String(dgm.seq).padStart(2, '0')}`
}

/** 액터 모음 그림의 파일 이름. 00 이라서 목록 맨 앞에 선다 */
export const ACTORS_IMAGE_NAME = '00-actors'

/**
 * 액터만 모아 놓은 한 장 (정답 EAP의 `Actors` 패키지와 같은 것).
 * 액터는 다이어그램마다 흩어져 그려지므로 "이 사업의 액터가 누구인가"를
 * 한눈에 보여 주는 그림이 따로 필요하다.
 * 액터가 하나도 없으면 빈 상자를 내보내지 않고 `null` 을 돌려준다.
 */
export function actorsSvg(
  project: Project,
  opts: { width?: number } = {}
): { svg: string; width: number; height: number } | null {
  const actors = project.actors
  if (!actors.length) return null

  const cols = Math.min(6, actors.length)
  const rows = Math.ceil(actors.length / cols)
  // 칸 너비는 가장 긴 액터 이름에 맞춘다 — 이름이 옆 칸을 침범하면 안 된다
  // 이름표는 두 줄로 접히므로 가장 넓은 줄에 맞춘다
  const cellW = Math.max(
    ACTOR_W + 24,
    ...actors.flatMap((a) => actorLabelLines(a.name).map((l) => textWidth(l, 11) + 24))
  )
  const cellH = ACTOR_H + 16

  const frameW = cols * cellW + FRAME_PAD * 2
  const frameH = rows * cellH + FRAME_PAD * 2
  const fx = EXPORT_PAD
  const fy = EXPORT_PAD + FRAME_TAB_H
  const label = 'Actors'
  const parts = frameParts(
    fx,
    fy,
    frameW,
    frameH,
    Math.min(frameW - 40, textWidth(label, 11) + 24),
    label
  )
  actors.forEach((a, i) => {
    const x = fx + FRAME_PAD + (i % cols) * cellW + (cellW - ACTOR_W) / 2
    const y = fy + FRAME_PAD + Math.floor(i / cols) * cellH
    parts.push(...actorParts(x, y, a.name))
  })

  return svgDoc(
    parts,
    frameW + EXPORT_PAD * 2,
    frameH + FRAME_TAB_H + EXPORT_PAD * 2,
    opts.width ?? EXPORT_WIDTH
  )
}

/**
 * 꾸러미 안내문 `index.md` — 그림 ↔ 요구사항 ↔ 유스케이스를 잇는다.
 * 파일 이름(`SFR-008-ADT1(맞춤형)-01.png`)만 보고는 한글 문서의 어느 자리에
 * 붙일 그림인지 알기 어렵기 때문이다.
 */
export function imageIndexMarkdown(project: Project, withActors: boolean): string {
  const actorName = new Map(project.actors.map((a) => [a.uid, a.name]))
  const L: string[] = [
    `# ${project.metadata.systemName || '유스케이스'} — 다이어그램 그림`,
    '',
    '`png/` 와 `svg/` 에 같은 이름으로 들어 있습니다. 한글 문서에는 `png/` 를 붙이고,',
    '크게 넣거나 글자가 깨지면 `svg/` 를 쓰세요. 다시 내보내면 같은 이름으로 덮어씁니다.',
    ''
  ]

  if (withActors) {
    L.push(
      `## 액터 ${project.actors.length}명`,
      '',
      `![액터](png/${ACTORS_IMAGE_NAME}.png)`,
      '',
      project.actors.map((a) => a.name).join(' · '),
      ''
    )
  }

  for (const pkg of project.packages) {
    for (const dgm of pkg.diagrams) {
      const file = diagramImageName(pkg, dgm)
      const ucs = useCasesOf(pkg, dgm)
      L.push(
        `## ${diagramNameOf(pkg, dgm)}`,
        '',
        `- 요구사항 ID: \`${pkg.reqId || '(없음)'}\``,
        `- 그림: \`png/${file}.png\` · \`svg/${file}.svg\``,
        `- 유스케이스 ${ucs.length}개`,
        ''
      )
      if (ucs.length) {
        L.push('| 유스케이스 | 액터 |', '| --- | --- |')
        for (const uc of ucs) {
          const names = uc.actorUids.map((u) => actorName.get(u) ?? '?').join(', ')
          L.push(`| \`[${uc.code}]\` ${uc.name} | ${names || '—'} |`)
        }
        L.push('')
      }
    }
  }

  return L.join('\n')
}
