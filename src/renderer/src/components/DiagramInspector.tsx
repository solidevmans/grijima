import { useState } from 'react'
import type { Diagram, Project, UcPackage, UseCase } from '@shared/types'
import { COLOR_KEYS, CSS_COLOR, DIFFICULTIES, PRIORITIES, itemName } from '@shared/constants'
import { diagramNameOf, packageCode, splitSubNo } from '@shared/idrules'
import { allUseCases, countStats, findUseCase, useStore } from '../store'

/**
 * 인스펙터 — 이 앱의 **유일한 편집 표면**.
 *
 * 목표는 EA 대체가 아니라 "유스케이스 모델을 빠르게 세우고 중요한 곳만 고치고 끝내기"다.
 * 그래서 편집 화면을 따로 두지 않고, 다이어그램을 보면서 왼쪽 트리에서 고른 것을
 * 여기서 바로 고친다. 화면 이동이 없다.
 *
 * 기본으로 보이는 건 "자주 고치는 것"만이고, 나머지는 접어 둔다.
 */
export default function DiagramInspector({
  pkg,
  dgm
}: {
  pkg: UcPackage
  dgm: Diagram
}): JSX.Element {
  const { project, selection } = useStore()
  if (!project) return <div className="inspector" />

  if (selection.actorUid) return <ActorPane pkg={pkg} dgm={dgm} />
  if (selection.useCaseUid) {
    const uc = findUseCase(project, selection.useCaseUid)
    if (uc) return <UseCasePane uc={uc} />
  }
  // 트리의 다이어그램 줄을 골랐으면 그 다이어그램의 폼. 예전에는 부모 요구사항 폼이
  // 떠서, 다이어그램을 지우려고 `삭제` 를 누르면 요구사항이 통째로 사라졌다.
  if (selection.diagramUid) {
    const owner = project.packages.find((p) => p.diagrams.some((d) => d.uid === selection.diagramUid))
    const d = owner?.diagrams.find((x) => x.uid === selection.diagramUid)
    if (owner && d) return <DiagramPane pkg={owner} dgm={d} />
  }
  if (selection.packageUid) {
    const p = project.packages.find((x) => x.uid === selection.packageUid)
    if (p) return <PackagePane pkg={p} />
  }
  return <PackagePane pkg={pkg} />
}

/* ================================================================== */
/* 관계 편집 (include / extend)                                        */
/* ================================================================== */

interface RelCandidate {
  uid: string
  name: string
  code: string
  /** 소속 UCD 이름 — 같은 UCD인지 보여주려면 필요하다 */
  pkgName: string
  /** 편집 중인 유스케이스와 같은 UCD 안에 있는가 */
  samePkg: boolean
}

/**
 * 관계를 걸 수 있는 대상 목록.
 *
 * 대상은 **프로젝트 전체**다. include 로 묶이는 건 대개 공통 기능(로그인,
 * 권한확인)이고 그건 다른 UCD에 있다. 다만 같은 UCD 안의 것이 먼저 보여야
 * 하므로 정렬만 그렇게 한다.
 */
function relationCandidates(project: Project, self: UseCase): RelCandidate[] {
  const out: RelCandidate[] = []
  for (const pkg of project.packages) {
    const samePkg = pkg.useCases.some((u) => u.uid === self.uid)
    for (const u of pkg.useCases) {
      if (u.uid === self.uid) continue
      out.push({ uid: u.uid, name: u.name, code: u.code, pkgName: pkg.name, samePkg })
    }
  }
  return out.sort((a, b) => Number(b.samePkg) - Number(a.samePkg))
}

/** 검색어가 없을 때 한 번에 보여줄 후보 수. 이 이상은 검색으로 찾는다 */
const CANDIDATE_LIMIT = 12

/**
 * 관계 대상 고르기.
 *
 * 예전에는 프로젝트의 모든 유스케이스를 칩으로 쭉 늘어놓았다. 예시 프로젝트가
 * 25건이고 실제 사업이면 100건이 넘어서, 벽처럼 쌓인 칩 중에서 원하는 것을
 * 찾는 게 불가능했다. 그래서 셋으로 나눈다:
 *   ① 이미 고른 것은 항상 위에 (지우려면 다시 눌러야 하므로)
 *   ② 검색창
 *   ③ 나머지 후보는 같은 UCD 것부터, 처음에는 12개까지만
 */
function RelationPicker({
  label,
  hint,
  candidates,
  selected,
  onToggle
}: {
  label: string
  hint: string
  candidates: RelCandidate[]
  selected: string[]
  onToggle: (uid: string) => void
}): JSX.Element {
  const [q, setQ] = useState('')
  const key = q.trim().toLowerCase()

  const chosen = candidates.filter((c) => selected.includes(c.uid))
  const rest = candidates.filter((c) => !selected.includes(c.uid))
  const matched = key
    ? rest.filter(
        (c) => c.name.toLowerCase().includes(key) || c.code.toLowerCase().includes(key)
      )
    : rest
  const shown = key ? matched.slice(0, 40) : matched.slice(0, CANDIDATE_LIMIT)
  const hidden = matched.length - shown.length

  return (
    <div className="field">
      <label>{label}</label>
      {chosen.length > 0 && (
        <div className="chips" style={{ marginBottom: 'var(--s2)' }}>
          {chosen.map((c) => (
            <span
              key={c.uid}
              className="chip on"
              title={`${c.code}\n${c.pkgName}\n클릭해서 해제`}
              onClick={() => onToggle(c.uid)}
            >
              {c.name} ✕
            </span>
          ))}
        </div>
      )}

      {candidates.length === 0 ? (
        <span className="muted">대상 없음 — 유스케이스가 이것 하나뿐입니다.</span>
      ) : (
        <>
          <input
            placeholder="이름 또는 코드로 검색"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="chips" style={{ marginTop: 'var(--s2)' }}>
            {shown.length === 0 && <span className="muted">검색 결과 없음</span>}
            {shown.map((c) => (
              <span
                key={c.uid}
                className="chip"
                title={`${c.code}\n${c.pkgName}`}
                onClick={() => onToggle(c.uid)}
              >
                {c.samePkg ? '' : '↗ '}
                {c.name}
              </span>
            ))}
          </div>
          {hidden > 0 && (
            <p className="hint">
              {hidden}건 더 있습니다 — 검색으로 좁히세요. ↗ 표시는 다른 UCD입니다.
            </p>
          )}
        </>
      )}
      <p className="hint">
        {hint}
      </p>
    </div>
  )
}

/* ================================================================== */
/* 유스케이스 — 가장 자주 고치는 것                                      */
/* ================================================================== */

function UseCasePane({ uc }: { uc: UseCase }): JSX.Element {
  const { project, updateUseCase, removeUseCase, duplicateUseCase, toggleActorLink } = useStore()
  if (!project) return <div className="inspector" />

  const set = (patch: Partial<UseCase>): void => updateUseCase(uc.uid, patch)
  const candidates = relationCandidates(project, uc)
  const toggleRel = (field: 'includeUids' | 'extendUids', target: string): void => {
    const cur = uc[field]
    set({
      [field]: cur.includes(target) ? cur.filter((x) => x !== target) : [...cur, target]
    } as Partial<UseCase>)
  }

  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="insp-kind">유스케이스</span>
        <button className="tiny ghost" title="복제" onClick={() => duplicateUseCase(uc.uid)}>
          복제
        </button>
        <button className="tiny ghost danger" onClick={() => removeUseCase(uc.uid)}>
          삭제
        </button>
      </div>

      <div className="field">
        <label>이름</label>
        <input value={uc.name} onChange={(e) => set({ name: e.target.value })} />
      </div>

      <div className="insp-section">액터 ({uc.actorUids.length})</div>
      <div className="chips" style={{ marginBottom: 'var(--s3)' }}>
        {project.actors.length === 0 && <span className="muted">액터가 없습니다.</span>}
        {project.actors.map((a) => (
          <span
            key={a.uid}
            className={`chip ${uc.actorUids.includes(a.uid) ? 'on' : ''}`}
            onClick={() => toggleActorLink(uc.uid, a.uid)}
            title={a.description}
          >
            {a.external ? '🛰 ' : '🙋 '}
            {a.name}
          </span>
        ))}
      </div>

      <div className="field">
        <label>한 줄 설명</label>
        <textarea rows={2} value={uc.description} onChange={(e) => set({ description: e.target.value })} />
      </div>

      <div className="grid2">
        <div className="field">
          <label>우선순위</label>
          <select value={uc.priority} onChange={(e) => set({ priority: e.target.value as UseCase['priority'] })}>
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>난이도</label>
          <select
            value={uc.difficulty}
            onChange={(e) => set({ difficulty: e.target.value as UseCase['difficulty'] })}
          >
            {DIFFICULTIES.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </div>
      </div>

      <details className="more">
        <summary>시나리오</summary>
        <div className="more-body">
          {/* 항목 구성은 유스케이스모형기술서 양식을 따른다 */}
          <div className="field">
            <label>사전조건</label>
            <textarea rows={2} value={uc.precondition} onChange={(e) => set({ precondition: e.target.value })} />
          </div>
          <div className="field">
            <label>사후조건</label>
            <textarea rows={2} value={uc.postcondition} onChange={(e) => set({ postcondition: e.target.value })} />
          </div>
          <div className="field">
            <label>기본 흐름 (한 줄에 한 단계)</label>
            <textarea rows={6} value={uc.mainFlow} onChange={(e) => set({ mainFlow: e.target.value })} />
          </div>
          <div className="field">
            <label>대체흐름</label>
            <textarea rows={3} value={uc.altFlow} onChange={(e) => set({ altFlow: e.target.value })} />
          </div>
          <div className="field">
            <label>예외흐름 (실패·오류 경로)</label>
            <textarea
              rows={3}
              value={uc.exceptionFlow}
              onChange={(e) => set({ exceptionFlow: e.target.value })}
            />
          </div>
          <div className="field">
            <label>특별요구사항 (흐름에 담기지 않는 제약)</label>
            <textarea
              rows={2}
              value={uc.specialRequirement}
              onChange={(e) => set({ specialRequirement: e.target.value })}
            />
          </div>
        </div>
      </details>

      <details className="more">
        <summary>관계 · 식별</summary>
        <div className="more-body">
          <RelationPicker
            label="<<include>>"
            hint="이 유스케이스가 항상 포함해서 쓰는 것 (공통 로그인·권한확인 등)"
            candidates={candidates}
            selected={uc.includeUids}
            onToggle={(target) => toggleRel('includeUids', target)}
          />
          <RelationPicker
            label="<<extend>>"
            hint="특정 조건에서만 이 유스케이스를 확장하는 것"
            candidates={candidates}
            selected={uc.extendUids}
            onToggle={(target) => toggleRel('extendUids', target)}
          />
          <div className="field">
            <label>요구사항 ID</label>
            <input className="mono" value={uc.reqId} onChange={(e) => set({ reqId: e.target.value })} />
            <p className="hint">
              소속 UCD의 대표 요구사항과 달라도 됩니다 — 화면 단위로 묶은 UCD에는
              여러 요구사항의 유스케이스가 함께 들어갑니다. 코드는 이 값에서 나옵니다.
            </p>
          </div>
          <div className="field">
            <label>유스케이스 코드 (EA alias)</label>
            <input className="mono" value={uc.code} onChange={(e) => set({ code: e.target.value })} />
          </div>
          <div className="row">
            <span className="hint">
              {uc.position ? `수동 배치 (${uc.position.x}, ${uc.position.y})` : '자동 배치'}
            </span>
            <span className="spacer" />
            <button className="tiny" disabled={!uc.position} onClick={() => set({ position: null })}>
              자동으로
            </button>
          </div>
        </div>
      </details>

      <div className="insp-foot">
        <span className="mono">{uc.code}</span>
      </div>
    </div>
  )
}

/* ================================================================== */
/* 액터                                                                */
/* ================================================================== */

function ActorPane({ pkg, dgm }: { pkg: UcPackage; dgm: Diagram }): JSX.Element {
  const {
    project,
    selection,
    updateActor,
    removeActor,
    removeActorFromDiagram,
    setActorOnUseCases,
    select,
    toast
  } = useStore()
  const actor = project?.actors.find((a) => a.uid === selection.actorUid)
  if (!project || !actor) return <div className="inspector" />

  const ofDiagram = pkg.useCases.filter((u) => u.diagramUid === dgm.uid)
  const linked = ofDiagram.filter((u) => u.actorUids.includes(actor.uid))
  const unlinked = ofDiagram.filter((u) => !u.actorUids.includes(actor.uid))
  const totalLinked = allUseCases(project).filter((u) => u.actorUids.includes(actor.uid)).length

  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="insp-kind">액터</span>
        <button
          className="tiny ghost"
          title="이 다이어그램에서만 빼기"
          onClick={() => removeActorFromDiagram(dgm.uid, actor.uid)}
        >
          빼기
        </button>
        <button className="tiny ghost danger" title="프로젝트에서 완전 삭제" onClick={() => removeActor(actor.uid)}>
          삭제
        </button>
      </div>

      <div className="field">
        <label>이름</label>
        <input value={actor.name} onChange={(e) => updateActor(actor.uid, { name: e.target.value })} />
      </div>
      <div className="field">
        <label>설명</label>
        <textarea
          rows={3}
          value={actor.description}
          onChange={(e) => updateActor(actor.uid, { description: e.target.value })}
        />
      </div>
      <label style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'center', marginBottom: 'var(--s4)' }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={actor.external}
          onChange={(e) =>
            updateActor(actor.uid, {
              external: e.target.checked,
              kind: e.target.checked ? 'Secondary' : 'Primary'
            })
          }
        />
        <span>외부 시스템</span>
      </label>

      <div className="insp-section">
        이 다이어그램 {linked.length}건 · 전체 {totalLinked}건
      </div>

      {/*
        일괄 연결.
        모델이 액터를 틀리게 붙이거나(운영자가 할 일을 이용자에게) 아예 못 붙이는 건
        소형 모델에서 늘 생긴다. 하나씩 고치면 다이어그램당 열 번을 클릭해야 한다.
        "이 UCD는 전부 운영자가 하는 일" 인 경우가 많아 통째로 처리할 수 있게 둔다.
      */}
      <div className="row" style={{ marginBottom: 'var(--s3)' }}>
        <button
          className="tiny"
          disabled={unlinked.length === 0}
          title={
            unlinked.length
              ? `${unlinked.map((u) => u.name).slice(0, 5).join(', ')}${unlinked.length > 5 ? ' 외' : ''}`
              : '이미 전부 연결되어 있습니다'
          }
          onClick={() => {
            const n = setActorOnUseCases(
              actor.uid,
              unlinked.map((u) => u.uid),
              true
            )
            if (n) toast('success', `${actor.name} 을(를) 유스케이스 ${n}건에 연결했습니다.`)
          }}
        >
          이 다이어그램 {unlinked.length}건에 연결
        </button>
        <button
          className="tiny"
          disabled={linked.length === 0}
          title="이 다이어그램의 유스케이스에서 이 액터를 모두 뗀다"
          onClick={() => {
            const n = setActorOnUseCases(
              actor.uid,
              linked.map((u) => u.uid),
              false
            )
            if (n) toast('info', `${actor.name} 연결 ${n}건을 해제했습니다.`)
          }}
        >
          연결 해제
        </button>
      </div>

      {linked.map((u) => (
        <button
          key={u.uid}
          className="ghost tiny insp-link"
          onClick={() => select({ useCaseUid: u.uid, actorUid: null })}
        >
          {u.name}
        </button>
      ))}
    </div>
  )
}

/* ================================================================== */
/* 다이어그램                                                           */
/* ================================================================== */

function DiagramPane({ pkg, dgm }: { pkg: UcPackage; dgm: Diagram }): JSX.Element {
  const { project, updateDiagram, removeDiagram, addUseCase, select, toast } = useStore()
  const seq = `-${String(dgm.seq).padStart(2, '0')}`
  const sysItems = dgm.systemItems ?? []
  // 점검 ITEMS_UNCOVERED와 같은 셈 — 상세 내용 항목 중 프로젝트 어느 유스케이스의 sources에도 없는 것
  const covered = new Set((project?.packages ?? []).flatMap((p) => p.useCases.flatMap((u) => u.sources ?? [])))
  const leftItems = (dgm.items ?? []).filter((s) => !covered.has(s))
  // 이름 규칙에 넘길 같은 요구사항의 글 — 표형식은 행마다 항목 머리말이 요구사항 묶음 제목이다
  const pkgTexts = [...pkg.diagrams.flatMap((d) => d.items ?? []), pkg.name]
  const ucCount = pkg.useCases.filter((u) => u.diagramUid === dgm.uid).length
  const last = pkg.diagrams.length <= 1

  // 되살리기 한 줄 — 시스템 처리 항목은 이름이 곧 글, 상세 내용 항목은 글(source)을 sources로 남긴다
  const restoreRow = (name: string, title: string, source?: string): JSX.Element => (
    <div key={title} className="sys-item">
      <span title={title}>{name}</span>
      <button
        className="tiny"
        title="이 항목을 이 다이어그램의 유스케이스로 넣습니다"
        onClick={() => {
          const actor = addUseCase(pkg.uid, dgm.uid, name, source)
          toast(
            'info',
            `「${name}」을(를) 유스케이스로 되살렸습니다` +
              (actor
                ? ` — 액터 ${actor}에 연결. 되돌리려면 Ctrl+Z.`
                : '. 액터가 없습니다 — 트리의 🔸 줄을 골라 폼에서 붙이세요. 되돌리려면 Ctrl+Z.')
          )
        }}
      >
        되살리기
      </button>
    </div>
  )

  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="insp-kind">다이어그램</span>
        <button
          className="tiny ghost danger"
          disabled={last}
          title={
            last
              ? '요구사항의 마지막 다이어그램은 지울 수 없습니다. 요구사항째 지우려면 트리에서 요구사항 줄을 고르세요'
              : `이 다이어그램만 지웁니다. 유스케이스 ${ucCount}개는 첫 다이어그램으로 옮깁니다`
          }
          onClick={() => {
            const firstSeq = pkg.diagrams.find((x) => x.uid !== dgm.uid)?.seq ?? 1
            removeDiagram(dgm.uid)
            toast(
              'info',
              `다이어그램 ${seq}를 지웠습니다.` +
                (ucCount ? ` 유스케이스 ${ucCount}개는 -${String(firstSeq).padStart(2, '0')}로 옮겼습니다.` : '') +
                ' 되돌리려면 Ctrl+Z.'
            )
          }}
        >
          삭제
        </button>
      </div>

      <div className="field">
        <label>이름</label>
        <input
          value={dgm.name}
          placeholder="비워 두면 자동 이름"
          onChange={(e) => updateDiagram(dgm.uid, { name: e.target.value })}
        />
        {/* 자동 이름을 placeholder에 두면 입력값처럼 읽혀 칸 밖에 적는다 */}
        <p className="hint">
          {dgm.name.trim() ? '비우면 자동 이름: ' : '지금 이름: '}
          {diagramNameOf(pkg, { ...dgm, name: '' })}
          {!dgm.name.trim() && ' (자동)'}
        </p>
      </div>

      <p className="hint">
        유스케이스 {ucCount}개
        {last && ' · 요구사항의 하나뿐인 다이어그램이라 지울 수 없습니다. 요구사항째 지우려면 아래 요구사항으로 가서 지우세요.'}
      </p>

      <button
        className="ghost tiny insp-link"
        onClick={() => select({ packageUid: pkg.uid, diagramUid: null, useCaseUid: null, actorUid: null })}
      >
        요구사항으로 가기: {pkg.reqId || pkg.code} {pkg.name}
      </button>

      {/* 정의서 항목이 빠진 쪽이 점검 경고가 가리키는 것이라 위에 */}
      {leftItems.length > 0 && (
        <>
          <div className="insp-section" style={{ marginTop: 'var(--s4)' }}>
            유스케이스에 없는 상세 내용 항목 ({leftItems.length})
          </div>
          <p className="hint">이 항목을 담은 유스케이스가 없습니다. 필요한 것은 되살리세요.</p>
          {leftItems.map((item) => restoreRow(itemName(item, pkgTexts), item, item))}
        </>
      )}

      {sysItems.length > 0 && (
        <>
          <div className="insp-section" style={{ marginTop: 'var(--s4)' }}>
            시스템 처리로 보고 뺀 항목 ({sysItems.length})
          </div>
          <p className="hint">사람이 화면에서 하는 일이 아니라고 보고 그리지 않았습니다. 필요한 것은 되살리세요.</p>
          {sysItems.map((item) => restoreRow(item, item))}
        </>
      )}
    </div>
  )
}

/* ================================================================== */
/* UCD 패키지(요구사항) / 프로젝트                                       */
/* ================================================================== */

function PackagePane({ pkg }: { pkg: UcPackage }): JSX.Element {
  const {
    project,
    updatePackage,
    removePackage,
    addUseCase,
    addDiagram,
    updateMetadata,
    select,
    confirm
  } = useStore()
  if (!project) return <div className="inspector" />
  const stats = countStats(project)

  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="insp-kind">요구사항 (UCD)</span>
        <button
          className="tiny ghost danger"
          onClick={async () => {
            const ok = await confirm({
              title: `요구사항 ${pkg.reqId || pkg.code} 「${pkg.name}」을(를) 지웁니다.`,
              body: `유스케이스 ${pkg.useCases.length}개와 다이어그램 ${pkg.diagrams.length}개가 함께 지워집니다. 되돌리기(Ctrl+Z)로 되살릴 수 있습니다.`,
              confirmLabel: '삭제'
            })
            if (ok) removePackage(pkg.uid)
          }}
        >
          삭제
        </button>
      </div>

      <div className="field">
        <label>요구사항명</label>
        <input value={pkg.name} onChange={(e) => updatePackage(pkg.uid, { name: e.target.value })} />
      </div>

      <div className="field">
        <label>개요</label>
        <textarea
          rows={3}
          value={pkg.description}
          onChange={(e) => updatePackage(pkg.uid, { description: e.target.value })}
        />
        <p className="hint">기술서의 UCD 단위 설명</p>
      </div>

      <div className="field">
        <label>요구사항 ID</label>
        <ReqIdInput key={pkg.uid} pkg={pkg} />
      </div>

      <div className="field">
        <label>EA 배경색</label>
        <div className="chips">
          {COLOR_KEYS.map((c) => (
            <span
              key={c}
              className={`swatch-pick ${pkg.color === c ? 'on' : ''}`}
              style={{ background: CSS_COLOR[c] }}
              title={c}
              onClick={() => updatePackage(pkg.uid, { color: c })}
            />
          ))}
        </div>
      </div>

      <div className="insp-section">다이어그램 ({pkg.diagrams.length})</div>
      {pkg.diagrams.map((d) => (
        <button
          key={d.uid}
          className="ghost tiny insp-link"
          onClick={() => select({ diagramUid: d.uid, useCaseUid: null, actorUid: null })}
        >
          {/* 드롭다운·트리 툴팁·EA와 같은 표시명. 직접 지은 이름이 없으면 (자동) */}
          {diagramNameOf(pkg, d)}{' '}
          <span className="muted">
            {!d.name?.trim() && '(자동) '}
            ({pkg.useCases.filter((u) => u.diagramUid === d.uid).length})
          </span>
        </button>
      ))}

      <div className="row" style={{ marginBottom: 'var(--s4)', marginTop: 'var(--s3)' }}>
        <button className="tiny" onClick={() => addDiagram(pkg.uid)}>
          + 다이어그램
        </button>
        <button
          className="tiny"
          onClick={() => addUseCase(pkg.uid, pkg.diagrams[0]?.uid ?? '')}
        >
          + 유스케이스
        </button>
        {/*
          여기 `+ 액터` 가 나란히 있었다. 옆의 둘은 **이 요구사항(UCD) 안에** 넣는데
          액터만 프로젝트 전체 Actors 에 넣는다 — 같은 줄 같은 모양이면 같은 범위로
          읽힌다. 액터를 더하는 자리는 왼쪽 트리의 `Actors` 줄 `+` 하나로 둔다.
        */}
      </div>

      <div className="insp-section">유스케이스 ({pkg.useCases.length})</div>
      {pkg.useCases.length === 0 && (
        <p className="hint">비어 있습니다.</p>
      )}
      {pkg.useCases.map((u) => (
        <button
          key={u.uid}
          className="ghost tiny insp-link"
          onClick={() => select({ useCaseUid: u.uid, actorUid: null })}
        >
          {u.name}
        </button>
      ))}

      <details className="more" style={{ marginTop: 'var(--s4)' }}>
        {/* `프로젝트` 한 단어였다 — 열기 전에는 안에 무엇이 있는지 알 수 없었다 */}
        <summary>프로젝트 전체 — 시스템명 · EA GUID 시드</summary>
        <div className="more-body">
          <div className="field">
            <label>시스템명</label>
            <input
              value={project.metadata.systemName}
              onChange={(e) => updateMetadata({ systemName: e.target.value })}
            />
          </div>
          <div className="field">
            <label>프로젝트 ID (EA GUID 시드 — 바꾸지 마세요)</label>
            <input
              className="mono"
              value={project.metadata.projectId}
              onChange={(e) =>
                updateMetadata({ projectId: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })
              }
            />
          </div>
          <p className="hint">
            요구사항 {stats.packages} · 다이어그램 {stats.diagrams} · 유스케이스 {stats.useCases} · 액터{' '}
            {stats.actors}
          </p>
        </div>
      </details>
    </div>
  )
}

/**
 * 요구사항 ID 칸 — 다 쓰고 나갈 때(또는 Enter) 한 번에 넣는다.
 * 넣을 때 행 ID의 끝 번호를 떼어 다이어그램 번호로 옮기므로, 글자마다 넣으면
 * `-0`까지 친 순간 칸에서 번호가 사라진다.
 */
function ReqIdInput({ pkg }: { pkg: UcPackage }): JSX.Element {
  const updatePackage = useStore((s) => s.updatePackage)
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft !== null && draft !== pkg.reqId) updatePackage(pkg.uid, { reqId: draft })
    setDraft(null)
  }
  const { base, sub } = splitSubNo(draft ?? pkg.reqId)
  return (
    <>
      <input
        className="mono"
        value={draft ?? pkg.reqId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <p className="hint">
        {draft === null ? pkg.code : packageCode(base)}
        {draft !== null && sub > 0 && pkg.diagrams.length === 1 && ` · 다이어그램 -${String(sub).padStart(2, '0')}`}
        <br />
        행 ID의 끝 번호는 다이어그램 번호가 됩니다
      </p>
    </>
  )
}
