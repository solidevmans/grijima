import { useEffect, useMemo, useRef, useState } from 'react'
import type { Point } from '@shared/types'
import { CSS_COLOR } from '@shared/constants'
import { defaultActorPosition, treeLayout as treeLayoutOf, ucLabelLines, UC_LABEL } from '@shared/layout'
import {
  ACTOR_H,
  ACTOR_LABEL_LINE_H,
  ACTOR_W,
  actorLabelLines,
  diagramGeometry,
  EMPTY_DIAGRAM_HINT,
  FRAME_TAB_H,
  NODE_MIN_X
} from '@shared/diagram-svg'
import { diagramNameOf } from '@shared/idrules'
import { findPackageOfDiagram, useStore } from '../store'
import TreeView from '../components/TreeView'
import DiagramInspector from '../components/DiagramInspector'
import { saveDiagramImages } from '../image-export'

/**
 * UML 유스케이스 다이어그램.
 *
 * 왼쪽은 편집 탭과 같은 폴더 트리(탐색 전용 모드)다. 2depth 패키지 하나가
 * 다이어그램 하나이므로, 트리에서 패키지나 유스케이스를 클릭하면 해당
 * 다이어그램으로 바로 전환된다. 현재 그려지는 패키지는 트리에서 강조된다.
 *
 * 캔버스는 외부 다이어그램 라이브러리 없이 SVG로 직접 그린다:
 *  - 여기서 옮긴 좌표가 **그대로 XMI DiagramElement geometry** 로 나가야 하는데,
 *    범용 그래프 라이브러리는 자체 좌표계/자동 레이아웃을 강제해 그 대응이 깨진다.
 *  - UML 표기(막대인간 + 타원)는 어차피 커스텀 노드를 그려야 한다.
 * 문서용 렌더링이 필요하면 PlantUML 텍스트를 내보낸다.
 */
export default function DiagramView(): JSX.Element {
  const {
    project,
    selection,
    select,
    setUseCasePosition,
    setDiagramActorPosition,
    placeActorOnDiagram,
    removeActorFromDiagram,
    toggleActorLink,
    linkUseCases,
    mutate,
    toast,
    addUseCase
  } = useStore()

  const svgRef = useRef<SVGSVGElement | null>(null)
  /*
   * Delete 키 핸들러가 부를 "선 끊기".
   * 실제 함수는 레이아웃이 정해진 뒤(early return 아래)에야 만들 수 있는데
   * 키 리스너는 훅이라 그 위에 있어야 한다. ref 로 최신 함수를 건네준다.
   */
  const cutRef = useRef<() => void>(() => {})
  const [filter, setFilter] = useState('')
  /** 그림을 굽는 동안 버튼을 잠근다 (큰 다이어그램은 한 박자 걸린다) */
  const [savingImg, setSavingImg] = useState(false)
  const [drag, setDrag] = useState<{ kind: 'uc' | 'actor'; uid: string; offset: Point } | null>(null)
  const [snap, setSnap] = useState(true)
  /*
   * 연결 모드.
   *
   * 캔버스의 드래그는 이미 "노드 옮기기"에 쓰이고 있다. 같은 제스처에 연결까지
   * 얹으면 옮기려다 선을 긋게 된다. 그래서 모드를 명시적으로 나눈다 —
   * 켜져 있는 동안은 드래그가 곧 연결이고, 노드는 움직이지 않는다.
   *
   * 액터↔유스케이스는 연결선(association)이 하나뿐이라 방향만 보면 되고,
   * 유스케이스끼리는 include / extend 둘 중 무엇인지 고를 것이 있어 타입을 함께 둔다.
   */
  const [linkMode, setLinkMode] = useState(false)
  const [linkType, setLinkType] = useState<'include' | 'extend'>('include')
  const [linkFrom, setLinkFrom] = useState<{ kind: 'uc' | 'actor'; uid: string } | null>(null)
  /** 연결선을 그리는 동안의 커서 위치 (고무줄 선 끝점) */
  const [linkTo, setLinkTo] = useState<Point | null>(null)
  /*
   * 캔버스에서 고른 연결선.
   *
   * 선을 지우려면 인스펙터로 가서 칩을 찾아 눌러야 했다. 그림에 보이는 선을
   * 그림에서 지울 수 없는 게 이상하다. 선을 고르면 굵어지고 가운데 ✕ 가 뜬다.
   * Delete 키로도 끊긴다.
   */
  const [selLink, setSelLink] = useState<
    | { kind: 'assoc'; ucUid: string; actorUid: string }
    | { kind: 'dep'; fromUid: string; toUid: string; type: 'include' | 'extend' }
    | null
  >(null)

  /*
   * Esc 로 연결 모드를 끈다.
   * 캔버스 div 에 걸면 그 div 가 포커스를 받은 뒤에만 동작해서, 툴바 버튼으로
   * 켠 직후에는 안 먹는다. 모드가 켜져 있는 동안만 window 에 건다.
   */
  useEffect(() => {
    if (!linkMode && !selLink) return
    const onKey = (e: KeyboardEvent): void => {
      // 입력란에 타이핑 중이면 건드리지 않는다
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return

      if (e.key === 'Escape') {
        setLinkFrom(null)
        setLinkTo(null)
        setLinkMode(false)
        setSelLink(null)
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selLink) {
        e.preventDefault()
        cutRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [linkMode, selLink])
  /*
   * 오른쪽 영역은 한 번에 하나만 보여준다.
   * 트리·캔버스·상세폼을 동시에 띄우면 각각이 좁아지고 툴바가 두 줄이 된다.
   * 트리는 항상 왼쪽에 남기고, 오른쪽만 편집 ↔ 다이어그램으로 바꾼다.
   */
  const { modelPane: mode, setModelPane: setMode } = useStore()
  // 팔레트에서 끌고 있는 액터 uid (캔버스에 놓으면 배치)
  const [dragActor, setDragActor] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<string | null>(null)

  /** 캔버스 하나 = 다이어그램 하나. 패키지 하나에 여러 개일 수 있다 */
  const diagrams = useMemo(
    () =>
      project
        ? project.packages.flatMap((p) => p.diagrams.map((d) => ({ pkg: p, dgm: d })))
        : [],
    [project]
  )

  // 요구사항 줄만 골랐으면 그 요구사항의 첫 다이어그램 — 프로젝트 첫 다이어그램으로 떨어지면 머리줄이 딴 요구사항을 말한다
  const activeUid =
    selection.diagramUid ??
    diagrams.find((x) => x.pkg.uid === selection.packageUid)?.dgm.uid ??
    diagrams[0]?.dgm.uid ??
    null
  const pkg = findPackageOfDiagram(project, activeUid)
  const dgm = pkg?.diagrams.find((d) => d.uid === activeUid) ?? null

  /* 좌표·테두리·선 계산은 내보내는 그림과 같은 것을 쓴다 (@shared/diagram-svg) */
  const layout = useMemo(
    () => (project && pkg && dgm ? diagramGeometry(project, pkg, dgm) : null),
    [project, pkg, dgm]
  )

  if (!project) return <div className="empty">프로젝트를 먼저 여세요.</div>

  const sidebar = (
    <TreeView filter={filter} onFilter={setFilter} mode="edit" activeDiagramUid={activeUid} />
  )

  if (!pkg || !dgm || !layout) {
    return (
      <div className="diagram-layout">
        {sidebar}
        <div className="empty">
          {/*
            여기 있던 `편집 탭에서 추가하기` 버튼은 지금 보고 있는 탭으로 가는
            버튼이라 눌러도 아무 일이 없었다. 추가하는 자리는 바로 왼쪽 트리 맨
            아래다 — 버튼을 없애고 그 자리를 가리킨다.
          */}
          <p>표시할 다이어그램이 없습니다.</p>
          <p className="hint">왼쪽 트리 맨 아래 '요구사항(UCD) 추가' 로 시작하세요.</p>
        </div>
      </div>
    )
  }

  const { ucPos, actorPos, actors, ucW, ucH, box, frame, links, deps } = layout

  const actorXY = (a: { uid: string }, i = 0): Point =>
    actorPos.get(a.uid) ?? defaultActorPosition(i)

  /*
   * SVG 캔버스는 노드가 적어도 최소 크기를 유지해야 한다 (바닥이 쪼그라들면
   * 액터를 끌어다 놓을 자리가 없다). 패키지 테두리(frame)는 그린 것에 딱 맞고,
   * 최소 크기는 바닥에만 적용한다.
   */
  const maxX = Math.max(900, box.maxX)
  const maxY = Math.max(480, box.maxY)

  const toSvg = (e: React.MouseEvent): Point => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const r = svg.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onMouseMove = (e: React.MouseEvent): void => {
    if (linkFrom) {
      setLinkTo(toSvg(e))
      return
    }
    if (!drag) return
    const p = toSvg(e)
    const g = snap ? 10 : 1
    const next = {
      x: Math.max(NODE_MIN_X, Math.round((p.x - drag.offset.x) / g) * g),
      y: Math.max(0, Math.round((p.y - drag.offset.y) / g) * g)
    }
    if (drag.kind === 'uc') setUseCasePosition(drag.uid, next)
    else setDiagramActorPosition(dgm.uid, drag.uid, next)
  }

  /* --------------------------- 연결 제스처 --------------------------- */

  /** 연결 모드에서 노드를 누르면 여기서 시작한다 */
  const startLink = (kind: 'uc' | 'actor', uid: string, e: React.MouseEvent): void => {
    e.preventDefault()
    setLinkFrom({ kind, uid })
    setLinkTo(toSvg(e))
  }

  const cancelLink = (): void => {
    setLinkFrom(null)
    setLinkTo(null)
  }

  /** 고무줄 선의 시작점 = 출발 노드의 중심 */
  const linkAnchor = (f: { kind: 'uc' | 'actor'; uid: string }): Point => {
    if (f.kind === 'actor') {
      const a = actors.find((x) => x.uid === f.uid)
      const p = a ? actorXY(a, actors.indexOf(a)) : { x: 0, y: 0 }
      return { x: p.x + ACTOR_W / 2, y: p.y + ACTOR_H / 2 }
    }
    const p = ucPos.get(f.uid)
    return p ? { x: p.x + ucW / 2, y: p.y + ucH / 2 } : { x: 0, y: 0 }
  }

  /**
   * 연결 확정. 무엇과 무엇을 이었는지로 관계 종류가 정해진다.
   *   액터 ↔ 유스케이스 : association (방향 무관)
   *   유스케이스 → 유스케이스 : 툴바에서 고른 include / extend
   *   액터 ↔ 액터 : UML에 없는 관계다
   * 이미 있는 연결을 다시 이으면 **끊는다** — 인스펙터의 칩과 같은 동작이다.
   */
  const finishLink = (kind: 'uc' | 'actor', uid: string): void => {
    const from = linkFrom
    cancelLink()
    if (!from || (from.kind === kind && from.uid === uid)) return

    const nameOfUc = (u: string): string =>
      pkg.useCases.find((x) => x.uid === u)?.name ?? '유스케이스'
    const nameOfActor = (u: string): string =>
      project.actors.find((x) => x.uid === u)?.name ?? '액터'

    if (from.kind === 'actor' && kind === 'actor') {
      toast('error', '액터끼리는 연결할 수 없습니다.')
      return
    }

    if (from.kind !== kind) {
      const actorUid = from.kind === 'actor' ? from.uid : uid
      const ucUid = from.kind === 'actor' ? uid : from.uid
      const uc = pkg.useCases.find((x) => x.uid === ucUid)
      const had = uc?.actorUids.includes(actorUid) ?? false
      toggleActorLink(ucUid, actorUid)
      toast(
        had ? 'info' : 'success',
        `${nameOfActor(actorUid)} ↔ ${nameOfUc(ucUid)} 연결을 ${had ? '끊었습니다' : '만들었습니다'}.`
      )
      return
    }

    const r = linkUseCases(from.uid, uid, linkType)
    const tag = linkType === 'include' ? '«include»' : '«extend»'
    if (r === 'cycle') {
      toast(
        'error',
        `순환이 생겨 연결하지 않았습니다 — ${nameOfUc(uid)} 쪽에서 이미 ${nameOfUc(from.uid)} 로 이어집니다.`
      )
      return
    }
    if (r === 'invalid') return
    toast(
      r === 'removed' ? 'info' : 'success',
      `${nameOfUc(from.uid)} ${tag} ${nameOfUc(uid)} 연결을 ${r === 'removed' ? '끊었습니다' : '만들었습니다'}.`
    )
  }

  /** 액터별 트리 배치 (계산은 shared/layout). 좌표 변경이 많으므로 한 번의 mutate 로 묶는다. */
  const treeLayout = (): void => {
    const { ucs: ucXY, actors: actorPlan } = treeLayoutOf(pkg, dgm, project)
    mutate((d) => {
      for (const p of d.packages) {
        const dd = p.diagrams.find((x) => x.uid === dgm.uid)
        if (!dd) continue
        dd.actorPositions = Object.fromEntries(actorPlan)
        for (const u of p.useCases) {
          const np = ucXY.get(u.uid)
          if (np) u.position = np
        }
        return
        }
    })
    toast('success', `액터 ${actors.length}명 기준으로 트리 배치했습니다.`)
  }

  /* ------------------------- 선 고르기 / 끊기 ------------------------- */

  const isSelLink = (l: { ucUid: string; actorUid: string }): boolean =>
    selLink?.kind === 'assoc' && selLink.ucUid === l.ucUid && selLink.actorUid === l.actorUid
  const isSelDep = (d: { fromUid: string; toUid: string; type: string }): boolean =>
    selLink?.kind === 'dep' &&
    selLink.fromUid === d.fromUid &&
    selLink.toUid === d.toUid &&
    selLink.type === d.type

  const nameOfUc = (u: string): string => pkg.useCases.find((x) => x.uid === u)?.name ?? '유스케이스'
  const nameOfActor = (u: string): string => project.actors.find((x) => x.uid === u)?.name ?? '액터'

  /** 고른 선을 끊는다. 되돌리기가 없으므로 무엇을 끊었는지 반드시 알린다 */
  const cutSelectedLink = (): void => {
    if (!selLink) return
    if (selLink.kind === 'assoc') {
      toggleActorLink(selLink.ucUid, selLink.actorUid)
      toast('info', `${nameOfActor(selLink.actorUid)} ↔ ${nameOfUc(selLink.ucUid)} 연결을 끊었습니다.`)
    } else {
      linkUseCases(selLink.fromUid, selLink.toUid, selLink.type)
      const tag = selLink.type === 'include' ? '«include»' : '«extend»'
      toast('info', `${nameOfUc(selLink.fromUid)} ${tag} ${nameOfUc(selLink.toUid)} 연결을 끊었습니다.`)
    }
    setSelLink(null)
  }
  cutRef.current = cutSelectedLink

  /** 고른 선의 중점 — 끊기 단추를 여기에 띄운다 */
  const selLinkMid: Point | null = (() => {
    if (!selLink) return null
    const hit =
      selLink.kind === 'assoc'
        ? links.find((l) => isSelLink(l))
        : deps.find((d) => isSelDep(d))
    if (!hit) return null
    return { x: (hit.from.x + hit.to.x) / 2, y: (hit.from.y + hit.to.y) / 2 }
  })()

  /**
   * 팔레트에서 끌어온 액터를 캔버스에 놓는다.
   *  - 유스케이스 위에 놓으면 → 배치 + 연결까지
   *  - 빈 곳에 놓으면 → 자리만 잡아둔다 (연결은 나중에)
   */
  const dropActorAt = (e: React.DragEvent): void => {
    e.preventDefault()
    const uid = dragActor ?? e.dataTransfer.getData('text/actor-uid')
    setDragActor(null)
    setDropHint(null)
    if (!uid) return

    const svg = svgRef.current
    if (!svg) return
    const r = svg.getBoundingClientRect()
    const x = Math.max(NODE_MIN_X, Math.round((e.clientX - r.left - ACTOR_W / 2) / 10) * 10)
    const y = Math.max(0, Math.round((e.clientY - r.top - ACTOR_H / 2) / 10) * 10)

    // 놓은 지점에 유스케이스가 있는지
    const hit = pkg.useCases.find((uc) => {
      const p0 = ucPos.get(uc.uid)
      if (!p0) return false
      const cx = e.clientX - r.left
      const cy = e.clientY - r.top
      return cx >= p0.x && cx <= p0.x + ucW && cy >= p0.y && cy <= p0.y + ucH
    })

    const name = project.actors.find((a) => a.uid === uid)?.name ?? '액터'
    if (hit) {
      if (!hit.actorUids.includes(uid)) toggleActorLink(hit.uid, uid)
      if (!actorPos.has(uid)) {
        placeActorOnDiagram(dgm.uid, uid, { x: 40, y: Math.max(60, y) })
      }
      toast('success', `${name} → ${hit.name} 연결했습니다.`)
    } else {
      placeActorOnDiagram(dgm.uid, uid, { x, y })
      toast('info', `${name} 을(를) 다이어그램에 놓았습니다. 유스케이스 위에 놓으면 연결까지 됩니다.`)
    }
  }


  const curIndex = diagrams.findIndex((x) => x.dgm.uid === activeUid)
  const gotoIndex = (i: number): void => {
    const t = diagrams[i]
    if (t) select({ diagramUid: t.dgm.uid, packageUid: t.pkg.uid, useCaseUid: null })
  }

  const ucList = pkg.useCases.filter((u) => u.diagramUid === dgm.uid)
  const manualCount = ucList.filter((u) => u.position).length

  return (
    <div className="diagram-layout">
      {sidebar}

      <div className="work-pane">
        <div className="mode-bar">
          {/*
            `✏ 편집` / `🔗 다이어그램` 이었다. 레일의 2단계가 `편집` 이 된 뒤로는 같은
            말이 두 가지를 가리킨다 — 단계 전체와, 오른쪽 판이 보여주는 것 중 하나.
            이 버튼이 고르는 건 "트리에서 고른 항목의 내용" 이므로 `상세` 라 부른다.
            연필 그림(✏)은 이 크기에서 작대기로 보여 뜻을 더하지 못했다. 둘 다 뗐다.
          */}
          <button
            className={mode === 'edit' ? 'mode-on' : 'mode-off'}
            title="트리에서 고른 항목(요구사항·유스케이스·액터)의 내용을 고칩니다"
            onClick={() => setMode('edit')}
          >
            상세
          </button>
          <button
            className={mode === 'diagram' ? 'mode-on' : 'mode-off'}
            title="이 다이어그램의 노드를 배치하고 연결선을 고칩니다"
            onClick={() => setMode('diagram')}
          >
            다이어그램
          </button>
          <span className="spacer" />
          <span className="hint" title={diagramNameOf(pkg, dgm)}>
            {diagramNameOf(pkg, dgm)}
          </span>
        </div>

        {mode === 'edit' ? (
          <DiagramInspector pkg={pkg} dgm={dgm} />
        ) : (
      <div className="diagram-wrap">
        {/*
          두 줄을 고정한다. 한 줄에 흘려 두면(flex-wrap) `수동배치 n` 같은 글이
          길어질 때마다 버튼이 다른 줄로 옮겨 가, 방금 누른 버튼이 손 아래에서 사라졌다.
          1줄: 탐색 + 내보내기 / 2줄: 연결 + 배치. 좁으면 드롭다운이 `…`로 줄어든다.
        */}
        <div className="diagram-toolbar">
          <div className="tool-row">
          {/* 탐색 — 어느 다이어그램을 보는가 */}
          <div className="tool-group bare nav">
          {/* 다이어그램 선택 — 트리 클릭 외에 명시적으로 고를 수 있어야 한다 */}
          <button
            className="tiny"
            title="이전 다이어그램"
            disabled={curIndex <= 0}
            onClick={() => gotoIndex(curIndex - 1)}
          >
            ‹
          </button>
          <select
            value={activeUid ?? ''}
            onChange={(e) => {
              const t = diagrams.find((x) => x.dgm.uid === e.target.value)
              select({ diagramUid: e.target.value, packageUid: t?.pkg.uid ?? null, useCaseUid: null })
            }}
          >
            {diagrams.map(({ pkg: pk, dgm: dd }, i) => (
              <option key={dd.uid} value={dd.uid}>
                {i + 1}. {diagramNameOf(pk, dd).slice(0, 48)} (UC{' '}
                {pk.useCases.filter((u) => u.diagramUid === dd.uid).length})
              </option>
            ))}
          </select>
          <button
            className="tiny"
            title="다음 다이어그램"
            disabled={curIndex < 0 || curIndex >= diagrams.length - 1}
            onClick={() => gotoIndex(curIndex + 1)}
          >
            ›
          </button>
          <span className="hint">
            {selLink
              ? '선을 골랐습니다 — ✕ 또는 Delete 로 끊습니다'
              : `${curIndex + 1}/${diagrams.length} · UC ${ucList.length} · 액터 ${actors.length}${
                  manualCount > 0 ? ` · 수동배치 ${manualCount}` : ''
                }`}
          </span>
          </div>

          <span className="spacer" />

          {/* 내보내기 — 이 다이어그램을 밖으로 */}
          <div className="tool-group bare">
          <button
            className="tiny"
            disabled={savingImg}
            title="이 다이어그램을 고른 폴더의 png/ 와 svg/ 에 저장합니다 (한글 문서에 붙이는 그림)"
            onClick={async () => {
              setSavingImg(true)
              try {
                const r = await saveDiagramImages(project, [{ pkg, dgm }])
                if (r) toast('success', `그림을 저장했습니다 — ${r.dirPath}\\png`)
              } catch (e) {
                toast('error', e instanceof Error ? e.message : String(e))
              } finally {
                setSavingImg(false)
              }
            }}
          >
            {savingImg ? '그림 저장 중…' : '그림 저장 (PNG·SVG)'}
          </button>
          <button
            className="tiny"
            onClick={async () => {
              const r = await window.api.exporter.plantumlText(project, pkg.uid)
              if (!r.ok) return toast('error', r.error)
              await navigator.clipboard.writeText(r.data)
              toast('success', 'PlantUML을 클립보드에 복사했습니다.')
            }}
          >
            PlantUML 복사
          </button>
          </div>
          </div>

          <div className="tool-row">
          {/* 연결 — 선을 만들고 끊는다 */}
          <div className="tool-group">
          {/*
            연결 모드 토글. 켜면 드래그가 "옮기기"에서 "잇기"로 바뀐다.
            같은 제스처를 두 뜻으로 쓰지 않으려고 모드로 나눴다.
          */}
          <button
            className={`tiny ${linkMode ? 'on' : ''}`}
            title="노드에서 노드로 끌어 연결선을 만듭니다 (다시 누르면 끊김)"
            onClick={() => {
              const next = !linkMode
              setLinkMode(next)
              cancelLink()
              if (next) toast('info', '연결 모드 — 노드에서 노드로 끌어 놓으세요. Esc 로 끕니다.')
            }}
          >
            {linkMode ? '🔗 연결 중' : '🔗 연결'}
          </button>
          {linkMode && (
            <span className="link-type">
              <button
                className={`tiny ${linkType === 'include' ? 'on' : ''}`}
                title="from 이 실행될 때 항상 함께 실행되는 것"
                onClick={() => setLinkType('include')}
              >
                «include»
              </button>
              <button
                className={`tiny ${linkType === 'extend' ? 'on' : ''}`}
                title="특정 조건에서만 확장하는 것"
                onClick={() => setLinkType('extend')}
              >
                «extend»
              </button>
            </span>
          )}

          </div>

          {/* 배치 — 노드를 어디에 두는가 */}
          <div className="tool-group">
          <label>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              disabled={linkMode}
              checked={snap}
              onChange={(e) => setSnap(e.target.checked)}
            />
            <span>10px 스냅</span>
          </label>
          <button className="tiny" title="액터를 줄기로 두고 가지 형태로 정렬" onClick={treeLayout}>
            트리 배치
          </button>
          <button
            className="tiny"
            title="끌어 놓은 위치를 지우고 자동 배치로 되돌립니다"
            disabled={manualCount === 0 && Object.keys(dgm.actorPositions ?? {}).length === 0}
            onClick={() => {
              // 트리 배치와 같이 한 번의 mutate 로 묶는다 — 유스케이스마다 따로 바꾸면
              // 되돌리기 더미에 노드 수만큼 쌓여서 Ctrl+Z 를 그만큼 눌러야 했다.
              mutate((d) => {
                for (const p of d.packages) {
                  const dd = p.diagrams.find((x) => x.uid === dgm.uid)
                  if (!dd) continue
                  dd.actorPositions = {}
                  for (const u of p.useCases) {
                    if (u.diagramUid === dgm.uid) u.position = null
                  }
                  return
                }
              })
              toast('info', '자동 배치로 되돌렸습니다.')
            }}
          >
            자동 배치
          </button>
          </div>
          </div>

        </div>

        {/* 액터 팔레트 — 끌어다 캔버스에 놓는다 */}
        <div className="actor-palette">
          <span className="palette-label">액터 끌어놓기</span>
          {project.actors.map((a) => {
            const onCanvas = actorPos.has(a.uid)
            return (
              <span
                key={a.uid}
                className={`actor-chip ${onCanvas ? 'on' : ''}`}
                draggable
                title={
                  onCanvas
                    ? `${a.name} — 이미 이 다이어그램에 있음 (× 로 제거)`
                    : `${a.name} — 캔버스로 끌어다 놓으세요. 유스케이스 위에 놓으면 연결됩니다.`
                }
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/actor-uid', a.uid)
                  e.dataTransfer.effectAllowed = 'copy'
                  setDragActor(a.uid)
                }}
                onDragEnd={() => {
                  setDragActor(null)
                  setDropHint(null)
                }}
              >
                {a.kind === 'Secondary' ? '🛰' : '🙋'} {a.name}
                {onCanvas && (
                  <button
                    className="chip-x"
                    title="이 다이어그램에서 제거 (연결도 끊김)"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeActorFromDiagram(dgm.uid, a.uid)
                      toast('info', `${a.name} 을(를) 이 다이어그램에서 뺐습니다.`)
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            )
          })}
        </div>

        <div
          className={`canvas ${dropHint ? 'drop-active' : ''} ${linkMode ? 'linking' : ''}`}

          onDragOver={(e) => {
            if (dragActor || e.dataTransfer.types.includes('text/actor-uid')) {
              e.preventDefault()
              setDropHint('canvas')
            }
          }}
          onDragLeave={() => setDropHint(null)}
          onDrop={dropActorAt}
        >
          <svg
            ref={svgRef}
            width={maxX + 80}
            height={maxY + 80}
            onMouseMove={onMouseMove}
            onMouseUp={() => {
              setDrag(null)
              // 노드가 아닌 빈 곳에서 손을 떼면 연결을 취소한다
              cancelLink()
            }}
            onClick={(e) => {
              // 빈 바닥을 누르면 고른 선을 놓는다 (선·노드 위 클릭은 여기까지 안 온다)
              if (e.target === e.currentTarget) setSelLink(null)
            }}
            onMouseLeave={() => {
              setDrag(null)
              cancelLink()
            }}
          >
            <defs>
              <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                <path className="uml-arrowhead" d="M0,0 L7,3 L0,6" />
              </marker>
              {/*
                EA는 요소 오른쪽 아래에 번지지 않는 회색 그림자를 깐다.
                stdDeviation=0 이면 흐려지지 않아 EA와 같은 단단한 그림자가 된다.
              */}
              <filter id="ea-shadow" x="-10%" y="-10%" width="125%" height="130%">
                <feDropShadow dx="3" dy="3" stdDeviation="0" floodColor="var(--node-shadow)" />
              </filter>
            </defs>

            {/*
              패키지 경계. UML 패키지 모양(왼쪽 위 이름표 + 본문 상자)으로 그린다 —
              EA 다이어그램에서 이 테두리가 "이 요구사항의 UCD"를 뜻한다.
            */}
            <g className="uml-frame-g">
              <rect
                className="uml-frame"
                x={frame.x}
                y={frame.y - FRAME_TAB_H}
                width={frame.tabW}
                height={FRAME_TAB_H}
              />
              <rect
                className="uml-frame"
                x={frame.x}
                y={frame.y}
                width={frame.w}
                height={frame.h}
              />
              <text className="uml-frame-label" x={frame.x + 12} y={frame.y - 6}>
                {frame.label}
              </text>
              {ucPos.size === 0 &&
                EMPTY_DIAGRAM_HINT.map((l, i) =>
                  i === 0 ? (
                    <text
                      key={i}
                      className="uml-empty-hint"
                      x={frame.x + frame.w / 2}
                      y={frame.y + frame.h / 2 + (i - 0.5) * 20 + 4}
                    >
                      {l}
                    </text>
                  ) : (
                    <text
                      key={i}
                      className="uml-empty-hint uml-empty-action"
                      role="button"
                      tabIndex={0}
                      x={frame.x + frame.w / 2}
                      y={frame.y + frame.h / 2 + (i - 0.5) * 20 + 4}
                      onClick={() => addUseCase(pkg.uid, dgm.uid)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          addUseCase(pkg.uid, dgm.uid)
                        }
                      }}
                    >
                      {l}
                    </text>
                  )
                )}
            </g>

            {/*
              연결선. 보이는 선은 1.2px 이라 그대로는 누를 수 없어서, 투명하고
              굵은 선을 밑에 깔아 클릭 판정으로 쓴다 (액터 판정 사각형과 같은 이유).
              연결 모드일 때는 선이 제스처를 가로채지 않도록 판정을 끈다.
            */}
            {links.map((l, i) => {
              const sel = isSelLink(l)
              return (
                <g
                  key={`l${i}`}
                  className={`link-g ${sel ? 'sel' : ''}`}
                  onClick={() =>
                    setSelLink(
                      sel ? null : { kind: 'assoc', ucUid: l.ucUid, actorUid: l.actorUid }
                    )
                  }
                >
                  <line
                    className="uml-hit"
                    style={{ pointerEvents: linkMode ? 'none' : 'stroke' }}
                    x1={l.from.x}
                    y1={l.from.y}
                    x2={l.to.x}
                    y2={l.to.y}
                  />
                  <line
                    className={`uml-link ${selection.useCaseUid === l.ucUid ? 'hl' : ''}`}
                    x1={l.from.x}
                    y1={l.from.y}
                    x2={l.to.x}
                    y2={l.to.y}
                  />
                </g>
              )
            })}

            {deps.map((d, i) => {
              const sel = isSelDep(d)
              return (
                <g
                  key={`d${i}`}
                  className={`link-g ${sel ? 'sel' : ''}`}
                  onClick={() =>
                    setSelLink(
                      sel
                        ? null
                        : { kind: 'dep', fromUid: d.fromUid, toUid: d.toUid, type: d.type }
                    )
                  }
                >
                  <line
                    className="uml-hit"
                    style={{ pointerEvents: linkMode ? 'none' : 'stroke' }}
                    x1={d.from.x}
                    y1={d.from.y}
                    x2={d.to.x}
                    y2={d.to.y}
                  />
                  <line
                    className="uml-dep"
                    x1={d.from.x}
                    y1={d.from.y}
                    x2={d.to.x}
                    y2={d.to.y}
                    markerEnd="url(#arrow)"
                  />
                  <text
                    className="uml-dep-label"
                    x={(d.from.x + d.to.x) / 2}
                    y={(d.from.y + d.to.y) / 2 - 4}
                  >
                    {d.label}
                  </text>
                </g>
              )
            })}

            {/* 고른 선 가운데의 끊기 단추 */}
            {selLinkMid && (
              <g
                className="link-cut"
                onClick={(e) => {
                  e.stopPropagation()
                  cutSelectedLink()
                }}
              >
                <circle cx={selLinkMid.x} cy={selLinkMid.y} r={11} />
                <text x={selLinkMid.x} y={selLinkMid.y + 4}>
                  ✕
                </text>
              </g>
            )}

            {/* 액터 */}
            {actors.map((a, i) => {
              const p = actorXY(a, i)
              const cx = p.x + ACTOR_W / 2
              const isSel = selection.actorUid === a.uid
              const isSrc = linkFrom?.kind === 'actor' && linkFrom.uid === a.uid
              return (
                <g
                  key={a.uid}
                  className={`uml-actor ${isSel ? 'sel' : ''} ${isSrc ? 'link-src' : ''}`}
                  onMouseDown={(e) => {
                    if (linkMode) return startLink('actor', a.uid, e)
                    const m = toSvg(e)
                    setDrag({ kind: 'actor', uid: a.uid, offset: { x: m.x - p.x, y: m.y - p.y } })
                    select({ actorUid: a.uid, useCaseUid: null })
                  }}
                  onMouseUp={() => {
                    if (linkMode) finishLink('actor', a.uid)
                  }}
                >
                  {/*
                    클릭 판정용 투명 사각형.
                    막대인간은 선 몇 개와 원 하나라서, 이게 없으면 1.6px 짜리 선 위를
                    정확히 눌러야 잡힌다. 이름표까지 포함한 노드 전체를 판정 영역으로 둔다.
                    (맨 앞에 둬야 아래 도형들이 이걸 가리지 않는다 — SVG는 나중에 그린 것이 위다)
                  */}
                  <title>{a.name}</title>
                  <rect
                    className="uml-actor-hit"
                    x={p.x}
                    y={p.y}
                    width={ACTOR_W}
                    height={ACTOR_H}
                    rx={8}
                  />
                  <circle cx={cx} cy={p.y + 16} r={10} />
                  <line x1={cx} y1={p.y + 26} x2={cx} y2={p.y + 56} />
                  <line x1={cx - 16} y1={p.y + 36} x2={cx + 16} y2={p.y + 36} />
                  <line x1={cx} y1={p.y + 56} x2={cx - 13} y2={p.y + 78} />
                  <line x1={cx} y1={p.y + 56} x2={cx + 13} y2={p.y + 78} />
                  {actorLabelLines(a.name).map((l, li) => (
                    <text
                      key={li}
                      className="uml-actor-label"
                      x={cx}
                      y={p.y + 94 + li * ACTOR_LABEL_LINE_H}
                    >
                      {l}
                    </text>
                  ))}
                </g>
              )
            })}

            {/* 유스케이스 */}
            {ucList.map((uc) => {
              const p = ucPos.get(uc.uid) as Point
              const cx = p.x + ucW / 2
              const cy = p.y + ucH / 2
              const fill = CSS_COLOR[pkg.color ?? 'none']
              return (
                <g
                  key={uc.uid}
                  className={`uml-uc ${selection.useCaseUid === uc.uid ? 'sel' : ''} ${drag?.uid === uc.uid ? 'dragging' : ''} ${linkFrom?.kind === 'uc' && linkFrom.uid === uc.uid ? 'link-src' : ''}`}
                  onMouseDown={(e) => {
                    if (linkMode) return startLink('uc', uc.uid, e)
                    const m = toSvg(e)
                    setDrag({ kind: 'uc', uid: uc.uid, offset: { x: m.x - p.x, y: m.y - p.y } })
                    select({ useCaseUid: uc.uid, packageUid: pkg.uid, actorUid: null })
                  }}
                  onMouseUp={() => {
                    if (linkMode) finishLink('uc', uc.uid)
                  }}
                  onDoubleClick={() => {
                    if (linkMode) return
                    // 그림에서 바로 고치러 간다
                    select({ useCaseUid: uc.uid })
                    setMode('edit')
                  }}
                >
                  <title>{uc.name}</title>
                  <ellipse
                    cx={cx}
                    cy={cy}
                    rx={ucW / 2}
                    ry={ucH / 2}
                    fill={fill}
                    filter="url(#ea-shadow)"
                  />
                  {/* EA와 같은 배치: 타원 안 첫 줄이 ID, 그 아래가 이름.
                      타원 크기를 이 줄들에서 거꾸로 구했으므로 밖으로 나가지 않는다. */}
                  {(() => {
                    const lines = ucLabelLines(uc.code, uc.name)
                    const top = cy - ((lines.length - 1) * UC_LABEL.lineH) / 2
                    return lines.map((l, i) => (
                      <text
                        key={i}
                        className={i === 0 ? 'uml-code' : 'uml-label'}
                        x={cx}
                        y={top + i * UC_LABEL.lineH + 4}
                      >
                        {l.text}
                      </text>
                    ))
                  })()}
                </g>
              )
            })}

            {/*
              끌고 있는 동안의 고무줄 선. 맨 뒤에 그려야 노드 위로 보인다.
              pointer-events 를 꺼야 이 선이 목적지 노드의 mouseup 을 가로채지 않는다.
            */}
            {linkFrom && linkTo && (
              <line
                className="uml-link-ghost"
                x1={linkAnchor(linkFrom).x}
                y1={linkAnchor(linkFrom).y}
                x2={linkTo.x}
                y2={linkTo.y}
              />
            )}
          </svg>
        </div>
      </div>
        )}
      </div>
    </div>
  )
}
