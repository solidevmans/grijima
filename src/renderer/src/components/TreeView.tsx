import { useMemo, useState } from 'react'
import { CSS_COLOR } from '@shared/constants'
import { diagramNameOf, splitSubNo } from '@shared/idrules'
import { useStore } from '../store'

/**
 * 폴더 트리 — EA 패키지 트리와 같은 모양이다.
 *   Actors
 *   ├ 액터…
 *   [UCD-SFR-001-ADT1(맞춤형)] 요구사항명     ← 요구사항 1건 = UCD 패키지
 *   ├ [UCD-...-01] 다이어그램명                ← 패키지당 1..N개
 *   │  ├ 유스케이스…
 *
 * 드래그: 유스케이스 → 다른 다이어그램으로 이동(같은 패키지든 다른 패키지든).
 * 대분류 계층은 없다 — 표준 산출물이 UCD를 평면으로 나열한다.
 */
export default function TreeView({
  filter,
  onFilter,
  mode = 'edit',
  activeDiagramUid = null
}: {
  filter: string
  onFilter: (v: string) => void
  /** 'diagram' 이면 편집 버튼을 숨기고 탐색 전용으로 쓴다 */
  mode?: 'edit' | 'diagram'
  /** 현재 캔버스에 그려지고 있는 다이어그램 (강조 표시) */
  activeDiagramUid?: string | null
}): JSX.Element {
  const {
    project,
    selection,
    select,
    expanded,
    toggleExpand,
    expandAll,
    addPackage,
    addDiagram,
    addUseCase,
    addActor,
    reparentUseCase,
    renumberAll,
    toast
  } = useStore()

  const isDiagram = mode === 'diagram'
  const [drag, setDrag] = useState<{ uid: string } | null>(null)
  const [dropUid, setDropUid] = useState<string | null>(null)

  const q = filter.trim().toLowerCase()
  const match = (...vals: string[]): boolean =>
    !q || vals.some((v) => (v ?? '').toLowerCase().includes(q))

  const visible = useMemo(() => {
    if (!project) return { packages: [], actors: [] }
    const packages = project.packages
      .map((p) => {
        const pkgHit = match(p.name, p.code, p.reqId)
        const diagrams = p.diagrams.map((d) => {
          const all = p.useCases.filter((u) => u.diagramUid === d.uid)
          const hits = all.filter((u) => match(u.name, u.code, u.description))
          return { d, useCases: pkgHit && !hits.length ? all : hits }
        })
        return { p, diagrams, pkgHit }
      })
      .filter((x) => !q || x.pkgHit || x.diagrams.some((d) => d.useCases.length))
    const actors = project.actors.filter((a) => match(a.name, a.description))
    return { packages, actors }
  }, [project, q])

  if (!project) return <div />

  const handleDropOnDiagram = (packageUid: string, diagramUid: string): void => {
    if (!drag) return
    reparentUseCase(drag.uid, packageUid, diagramUid)
    // 버튼 이름을 그대로 부른다 — 안내가 가리키는 버튼을 눈으로 찾을 수 있어야 한다
    toast('info', "유스케이스를 옮겼습니다. ID는 위 'ID 다시 매기기' 로 맞추세요. (좌표는 초기화됨)")
    setDrag(null)
    setDropUid(null)
  }

  return (
    <div className="tree-pane">
      <div className="tree-toolbar">
        <input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder="이름·ID 검색"
          title="이름·ID·설명에 이 글자가 들어간 항목만 남깁니다"
        />
        <button className="ghost tiny" title="트리를 모두 펼칩니다" onClick={() => expandAll(true)}>
          펼치기
        </button>
        <button className="ghost tiny" title="트리를 모두 접습니다" onClick={() => expandAll(false)}>
          접기
        </button>
        {/*
          글자 없는 `⟳` 였다. 아이콘만 보면 "새로고침"으로 읽히는데 실제로는
          프로젝트의 모든 패키지·유스케이스 ID를 다시 매긴다 — 눌러 보고 나서야
          뜻을 알게 되는 버튼이었다. 옆의 펼치기·접기와 달리 이건 모델을 바꾸므로
          글자를 달았다. 되돌리기(Ctrl+Z)가 받아 주니 확인 창까지는 두지 않는다.
        */}
        <button
          className="ghost tiny"
          title="프로젝트의 모든 패키지·유스케이스 ID를 규칙대로 다시 매깁니다 (UC-{요구사항ID}-{다이어그램}-{순번}). Ctrl+Z 로 되돌아갑니다."
          onClick={() => {
            renumberAll(true)
            toast('success', '패키지·유스케이스 ID를 다시 매겼습니다. Ctrl+Z 로 되돌릴 수 있습니다.')
          }}
        >
          ID 다시 매기기
        </button>
      </div>

      <div className="tree">
        {/* 맞는 게 없으면 빈 트리 대신 그렇다고 말하고 지우는 길을 준다 —
            `Actors`·`요구사항(UCD) 추가`만 남으면 프로젝트가 빈 줄 안다 */}
        {q && !visible.packages.length && !visible.actors.length ? (
          <div className="empty">
            '{filter.trim()}'에 맞는
            <br />
            요구사항·유스케이스·액터가 없습니다
            <div className="empty-actions">
              <button onClick={() => onFilter('')}>검색 지우기</button>
            </div>
          </div>
        ) : (
          <>
        {/* ---------------- Actors ---------------- */}
        {/* 검색 중 맞는 액터가 없으면 줄째 숨긴다 — `▼ Actors 5` 아래가 비면
            액터가 사라진 줄 안다. 숫자도 요구사항 줄처럼 보이는 수다 */}
        {(!q || visible.actors.length > 0) && (
          <>
        <div className="node" onClick={() => toggleExpand('__actors__')}>
          <span className="twisty">{expanded['__actors__'] === false ? '▶' : '▼'}</span>
          <span className="ico">👤</span>
          <span className="label">Actors</span>
          <span className="count">{visible.actors.length}</span>
          {!isDiagram && (
            <button
              className="ghost tiny"
              title="액터 추가"
              onClick={(e) => {
                e.stopPropagation()
                addActor()
              }}
            >
              +
            </button>
          )}
        </div>
        {expanded['__actors__'] !== false &&
          visible.actors.map((a) => (
            <div
              key={a.uid}
              className={`node lv1 ${selection.actorUid === a.uid ? 'selected' : ''}`}
              onClick={() =>
                select({
                  actorUid: a.uid,
                  packageUid: null,
                  diagramUid: null,
                  useCaseUid: null
                })
              }
            >
              <span className="ico">{a.external ? '🛰' : '🙋'}</span>
              <span className="label">{a.name}</span>
              {/* 점검 카드 '추정한 액터'와 같은 것 — 알림이 지나도 어느 액터인지 보이게. 이름을 고치면 꺼진다(store) */}
              {a.guessed && (
                <span className="tag-guess" title="정의서에서 추정한 액터입니다 — 사업 액터 이름으로 고치세요">
                  추정
                </span>
              )}
            </div>
          ))}

        <div style={{ height: 10 }} />
          </>
        )}

        {/* ---------------- UCD 패키지 (요구사항) ---------------- */}
        {visible.packages.map(({ p, diagrams }) => {
          const open = expanded[p.uid] !== false
          return (
            <div key={p.uid}>
              <div
                className={`node ${selection.packageUid === p.uid && !selection.diagramUid && !selection.useCaseUid ? 'selected' : ''}`}
                onClick={() =>
                  select({
                    packageUid: p.uid,
                    diagramUid: null,
                    useCaseUid: null,
                    actorUid: null
                  })
                }
              >
                <span
                  className="twisty"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleExpand(p.uid)
                  }}
                >
                  {open ? '▼' : '▶'}
                </span>
                <span className="swatch" style={{ background: CSS_COLOR[p.color] }} />
                {/* 코드는 가운데를 줄인다(SFR-001-…-02) — 앞은 요구사항 번호, 끝은 세부 번호라 둘 다 있어야 구별된다 */}
                <span className="code code-mid" title={p.code}>
                  {p.reqId ? (
                    <>
                      <span className="code-head">{p.reqId.slice(0, -3)}</span>
                      <span>{p.reqId.slice(-3)}</span>
                    </>
                  ) : (
                    '(ID 없음)'
                  )}
                </span>
                <span className="label">{p.name}</span>
                {/* 다른 요구사항에서 옮겨 온 유스케이스가 있으면 알린다 — 같은 요구사항의 행(-01·-03)은 묶음이라 셈하지 않는다 */}
                {(() => {
                  const base = splitSubNo(p.reqId).base
                  const bases = new Set(p.useCases.filter((u) => u.reqId).map((u) => splitSubNo(u.reqId).base))
                  if (![...bases].some((b) => b !== base)) return null
                  bases.add(base)
                  return (
                    <span className="tag-mix" title="다른 요구사항에서 옮겨 온 유스케이스가 있습니다">
                      요구사항 {bases.size}
                    </span>
                  )
                })()}
                <span className="count">{p.useCases.length}</span>
                {!isDiagram && (
                  <button
                    className="ghost tiny"
                    title="다이어그램 추가"
                    onClick={(e) => {
                      e.stopPropagation()
                      addDiagram(p.uid)
                    }}
                  >
                    +
                  </button>
                )}
              </div>

              {open &&
                diagrams.map(({ d, useCases }) => {
                  const dOpen = expanded[d.uid] !== false
                  return (
                    <div key={d.uid}>
                      <div
                        className={`node lv1 ${selection.diagramUid === d.uid && !selection.useCaseUid ? 'selected' : ''} ${dropUid === d.uid ? 'drop-target' : ''} ${activeDiagramUid === d.uid ? 'active-diagram' : ''}`}
                        onDragOver={(e) => {
                          if (drag) {
                            e.preventDefault()
                            setDropUid(d.uid)
                          }
                        }}
                        onDragLeave={() => setDropUid(null)}
                        onDrop={(e) => {
                          e.preventDefault()
                          handleDropOnDiagram(p.uid, d.uid)
                        }}
                        onClick={() =>
                          select({
                            packageUid: p.uid,
                            diagramUid: d.uid,
                            useCaseUid: null,
                            actorUid: null
                          })
                        }
                      >
                        <span
                          className="twisty"
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleExpand(d.uid)
                          }}
                        >
                          {dOpen ? '▼' : '▶'}
                        </span>
                        <span className="ico">🗺</span>
                        <span className="code">-{String(d.seq).padStart(2, '0')}</span>
                        {/* [UCD-…-01] 머리는 부모 줄과 -01 이 이미 보여 주므로 이름만 (생성이 둘째 행부터 머리를 붙여 저장한다) */}
                        <span className="label" title={diagramNameOf(p, d)}>
                          {d.name?.trim().replace(/^\[[^\]]*\]\s*/, '') || p.name}
                        </span>
                        <span className="count">{useCases.length}</span>
                        {!isDiagram && (
                          <button
                            className="ghost tiny"
                            title="유스케이스 추가"
                            onClick={(e) => {
                              e.stopPropagation()
                              addUseCase(p.uid, d.uid)
                            }}
                          >
                            +
                          </button>
                        )}
                      </div>

                      {dOpen &&
                        useCases.map((u) => (
                          <div
                            key={u.uid}
                            className={`node lv2 ${selection.useCaseUid === u.uid ? 'selected' : ''}`}
                            draggable={!isDiagram}
                            onDragStart={() => setDrag({ uid: u.uid })}
                            onDragEnd={() => {
                              setDrag(null)
                              setDropUid(null)
                            }}
                            onClick={() =>
                              select({
                                packageUid: p.uid,
                                diagramUid: d.uid,
                                useCaseUid: u.uid,
                                actorUid: null
                              })
                            }
                            title={
                              (u.actorUids.length ? '' : '🔸 액터가 없습니다 — 오른쪽 폼의 액터 이름을 눌러 붙이세요\n') +
                              `${u.code}\n${u.description}`
                            }
                          >
                            <span className="ico">{u.actorUids.length ? '⭕' : '🔸'}</span>
                            <span className="label">{u.name}</span>
                            {/* 점검 카드 UC_INVENTED와 같은 것 — 편집 중에도 어느 줄인지 보이게. 이름을 고치면 꺼진다(store) */}
                            {u.invented && (
                              <span
                                className="tag-llm"
                                title="정의서 상세 내용에 없는 것을 모델이 더했습니다 — 필요 없으면 삭제하고, 두려면 이름을 고치세요"
                              >
                                LLM 추가
                              </span>
                            )}
                            {/* 이 UCD의 대표 요구사항과 다른 것에서 온 유스케이스. 같은 묶음의 다른 행(-01↔-03)은 다이어그램 줄이 이미 말한다 */}
                            {u.reqId && splitSubNo(u.reqId).base !== splitSubNo(p.reqId).base && (
                              <span className="tag-other" title={`다른 요구사항: ${u.reqId}`}>
                                <span className="code-head">{u.reqId.slice(0, -3)}</span>
                                <span>{u.reqId.slice(-3)}</span>
                              </span>
                            )}
                          </div>
                        ))}
                    </div>
                  )
                })}
            </div>
          )
        })}

        {/* 검색 중엔 숨긴다 — 걸러진 트리에서 누르면 안 보이는 자리에 생긴다 */}
        {!isDiagram && !q && (
          <div className="node" style={{ marginTop: 'var(--s2)' }} onClick={() => addPackage()}>
            <span className="twisty" />
            <span className="ico">➕</span>
            <span className="label muted">요구사항(UCD) 추가</span>
          </div>
        )}
          </>
        )}
      </div>
    </div>
  )
}
