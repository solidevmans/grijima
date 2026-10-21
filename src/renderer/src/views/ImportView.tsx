import { useEffect, useMemo, useRef, useState } from 'react'
import type { BlockMapping, ImportMapping, WorkbookData } from '@shared/types'
import {
  COLUMN_HINTS,
  SHEET_HINTS,
  composeRequirementText,
  guessColumn,
  guessSheet
} from '@shared/compose'
import { ACTOR_FIELDS, DETAIL_FIELDS, FIELD_LABEL, OUTLINE_FIELDS } from '@shared/constants'
import { countStats, useStore } from '../store'

const emptyBlock = (): BlockMapping => ({ sheetName: null, columns: {} })

/*
 * 붙여넣은 정의서는 브라우저에 남긴다.
 *
 * 개발 중 새로고침(HMR)이나 실수로 창을 닫으면 방금 붙여넣은 수천 자가 통째로
 * 날아간다. 다시 찾아서 복사해 오는 게 이 앱에서 제일 짜증나는 순간이었다.
 * 생성 결과가 아니라 **입력**만 남긴다 — 결과는 .eaucs 로 저장하면 된다.
 */
const DRAFT_KEY = 'eaucs.import.draft'

interface Draft {
  text: string
  systemName: string
  teamCode: string
  teamName: string
  actors: string
}

function loadDraft(): Partial<Draft> {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') as Partial<Draft>
  } catch {
    return {}
  }
}

/*
 * 프로젝트 ID(GUID 시드)는 초안에 넣지 않지만, 탭을 떠나면 이 화면이 내려가므로
 * 앱을 켜 둔 동안만 여기 기억한다. 옆 세 칸만 남고 ID만 비면, 재임포트하려던
 * 사람이 모르고 새 시드로 만들어 EA에서 전부 중복 생성된다.
 */
let sessionProjectId = ''

function saveDraft(d: Draft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d))
  } catch {
    // 용량 초과 등은 조용히 넘긴다 — 저장 실패가 작업을 막으면 안 된다
  }
}

/**
 * 가져오기 화면.
 *
 * 이 앱의 본질은 "정의서를 던지면 액터와 유스케이스를 만들어 준다"이다.
 * 그래서 화면의 주인공은 **텍스트 투입구**다. 시스템 정보나 엑셀 매핑 같은
 * 부수 설정은 필요할 때만 펼치도록 접어 둔다.
 */
export default function ImportView(): JSX.Element {
  const { setProject, setView, setBusy, toast, confirm, project, dirty, filePath, settings } =
    useStore()
  /*
   * 모델은 앱에 동봉돼 있지만, 빌드에 안 들어갔거나 설치가 깨졌을 수 있다.
   * "쓸 수 있는 모델이 있는가" 는 메인 프로세스만 아므로 물어본다.
   */
  const [model, setModel] = useState<{ name: string } | null>(null)
  useEffect(() => {
    void window.api.llm.modelInfo().then((r) => setModel(r.ok ? r.data : null))
  }, [settings])
  const hasModel = Boolean(model)
  const modelName = model?.name ?? ''

  const draft = useRef(loadDraft()).current
  const [text, setText] = useState(draft.text ?? '')
  const [wb, setWb] = useState<WorkbookData | null>(null)
  const [mapping, setMapping] = useState<ImportMapping>({
    outline: emptyBlock(),
    actors: emptyBlock(),
    detail: emptyBlock()
  })
  const [dragOver, setDragOver] = useState(false)
  /*
   * 빈 투입구를 "글 쓰는 칸"으로 펼쳤는가.
   *
   * 예전에는 높이 0·투명한 textarea 에 포커스만 줬다. 누른 사람 눈에는 아무 일도
   * 일어나지 않아서 눌리지 않은 줄 알고 다시 눌렀다. 누른 결과는 보여야 한다.
   */
  const [typing, setTyping] = useState(false)
  const [showMeta, setShowMeta] = useState(false)
  /*
   * 이 판의 값은 **생성으로 새로 만들 프로젝트**에 쓴다. 열린 프로젝트의 이름·ID는
   * 위쪽 막대와 편집 탭에서 고친다. 예전에는 열린 프로젝트 값을 한 번 복사해 와서,
   * 같은 `시스템명` 두 칸이 서로 다른 값을 보였고 여기서 고쳐도 프로젝트엔 안 갔다.
   * 프로젝트 ID(GUID 시드)는 초안에도 남기지 않는다 — 이전 사업의 시드가 미리 채워져
   * 다른 사업이 같은 시드로 만들어지면 EA에서 GUID가 겹친다. 비우면 새로 만든다.
   */
  const [systemName, setSystemName] = useState(draft.systemName ?? '')
  const [projectId, setProjectId] = useState(sessionProjectId)
  useEffect(() => {
    sessionProjectId = projectId
  }, [projectId])
  // 수행 팀 — 정의서에 요구사항 ID가 없을 때 앱이 채번하며 ID에 넣는다.
  // 예전에는 코드가 'PAD'를 무조건 박았는데, PAD는 한 사업의 팀 코드일 뿐이다.
  const [teamCode, setTeamCode] = useState(draft.teamCode ?? '')
  const [teamName, setTeamName] = useState(draft.teamName ?? '')
  /*
   * 액터 사전 — 정답 액터(공단관리자·지자체담당자…)는 정의서 본문에 없는 사업 지식이라
   * 모델이 맞출 수 없다. 사람이 한 줄에 하나 적으면 생성이 그 이름 중에서 고른다.
   * `이름: 하는 일`로 적으면 하는 일까지 모델에 넘어가 배정 근거가 된다.
   */
  const [actorText, setActorText] = useState(draft.actors ?? '')
  const actorLines = actorText.split('\n').map((l) => l.trim()).filter(Boolean)
  // `이름: 하는 일` 줄은 이름으로 센다 — 생성 쪽도 같은 이름은 하나로 본다
  const actorDict = [...new Set(actorLines.map((l) => l.split(/[:：]/)[0].trim()).filter(Boolean))]
  const [rawResponse, setRawResponse] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  // 입력이 바뀔 때마다 남긴다 (새로고침해도 그대로 있게)
  useEffect(() => {
    saveDraft({ text, systemName, teamCode, teamName, actors: actorText })
  }, [text, systemName, teamCode, teamName, actorText])

  // 글칸을 펼쳤으면 커서도 거기로 — 펼쳐만 놓고 커서가 없으면 한 번 더 눌러야 한다
  useEffect(() => {
    if (typing) taRef.current?.focus()
  }, [typing])

  // 점검 카드의 뺀 요구사항 줄에서 왔으면 원문의 그 ID 줄을 골라 보여 준다
  // 줄 머리의 ID를 찾는다 — 앞쪽 `요구사항정의서[ID] 포함.` 같은 참조 문구로 가지 않게
  const sourceFocus = useStore((s) => s.sourceFocus)
  useEffect(() => {
    // 렌더 때 값이 아니라 지금 값을 읽고 비운다 — 개발 모드는 effect를 두 번 돌려 알림이 두 번 떴다
    const id = useStore.getState().sourceFocus
    if (!id) return
    useStore.getState().setSourceFocus(null)
    const ta = taRef.current
    let at = -1
    for (let i = text.indexOf(id); i >= 0; i = text.indexOf(id, i + 1)) {
      if (at < 0) at = i
      if (/^[\s#]*$/.test(text.slice(text.lastIndexOf('\n', i - 1) + 1, i))) {
        at = i
        break
      }
    }
    if (!ta || at < 0) {
      toast('warn', `만들기 탭 원문에 ${id}이(가) 없습니다 — 생성에 쓴 정의서를 다시 붙여넣으면 찾을 수 있습니다. 넣으려면 편집 트리 맨 아래 『요구사항(UCD) 추가』로.`)
      return
    }
    // 앞부분만 넣은 칸을 높이 0으로 접으면 scrollHeight가 그 글의 높이다.
    // 칸 높이 그대로 재면 글이 칸보다 짧을 때 칸 높이가 나와 앞쪽 ID가 칸 위로 밀렸다
    const cs = getComputedStyle(ta)
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2
    const h = ta.clientHeight
    const css = ta.style.cssText
    ta.style.cssText = `${css};flex:none;min-height:0;height:0`
    // p에서 시작하는 줄의 윗끝 = 그 앞 줄까지의 높이
    const topOf = (p: number): number => {
      if (p <= 0) return 0
      ta.value = text.slice(0, p - 1)
      return ta.scrollHeight
    }
    let p = text.lastIndexOf('\n', at - 1) + 1
    const lineTop = topOf(p)
    // 칸 반만큼 위 줄의 윗끝에 맞춘다 — 줄 높이를 곱해 맞추면 실제 줄 위치와 어긋나 첫 줄이 잘렸다
    for (let k = Math.floor(h / 2 / lh); k > 0 && p > 0; k--) p = text.lastIndexOf('\n', p - 2) + 1
    let top = topOf(p)
    // 위쪽 줄이 접혀 여러 줄이면 고른 줄이 칸 아래로 빠질 수 있다 — 그땐 가운데로만
    if (lineTop + lh > top + h) top = lineTop - (h - lh) / 2
    ta.style.cssText = css
    ta.value = text
    ta.focus({ preventScroll: true })
    ta.setSelectionRange(at, at + id.length)
    ta.scrollTop = top
  }, [sourceFocus])

  const composed = useMemo(() => (wb ? composeRequirementText(wb, mapping) : ''), [wb, mapping])
  const finalText = wb ? composed : text

  // 문서 해석은 AI가 한다. 넣기 전에 몇 건인지 미리 세려면 파서가 필요하고,
  // 그러면 문서 형식마다 코드를 고쳐야 한다. 여기서는 "무엇을 넣었는지"만 보여준다.

  /* ------------------------------- 입력 ------------------------------- */

  const openExcel = async (): Promise<void> => {
    const r = await window.api.excel.open()
    if (!r.ok) return toast('error', `엑셀 읽기 실패: ${r.error}`)
    if (!r.data) return
    setWb(r.data)
    setMapping(autoMap(r.data))
    setText('')
    if (!systemName) {
      const base = r.data.filePath.split(/[\\/]/).pop() ?? ''
      setSystemName(base.replace(/\.(xlsx|xlsm)$/i, ''))
    }
    toast('success', `${r.data.sheets.length}개 시트를 읽었습니다.`)
  }

  const openText = async (): Promise<void> => {
    const r = await window.api.text.open()
    if (!r.ok) return toast('error', r.error)
    if (r.data) {
      setWb(null)
      setText(r.data.text)
    }
  }

  /*
   * HWP는 한글(COM)이 본문을 꺼내 준다. 몇 초~수십 초 걸리고, 한글이 "파일 접근 허용"
   * 창을 띄우면 사람이 누를 때까지 멈춘다 — 그래서 기다리는 동안 그 말을 띄워 둔다.
   */
  const openHwp = async (filePath?: string): Promise<void> => {
    setBusy('한글로 정의서를 읽는 중… 한글 창이 접근을 물으면 "접근 허용"을 누르세요')
    const r = await window.api.hwp.open(filePath)
    setBusy(null)
    if (!r.ok)
      return toast(
        'error',
        `${r.error} 한컴에서 "다른 이름으로 저장 → 텍스트"로 저장한 뒤 그 파일을 여세요.`
      )
    if (!r.data) return
    setWb(null)
    setText(r.data.text)
    if (!systemName) setSystemName(r.data.name.replace(/\.hwp$/i, ''))
    toast('success', `${r.data.name} 을(를) 읽었습니다.`)
  }

  /*
   * 지우기 = 입력을 비우고 처음 화면(세 가지 투입구)으로 돌아간다. 한 이름 한 동작.
   *
   * 원문은 컴포넌트 상태라 Ctrl+Z 가 닿지 않는다 (되돌리기는 프로젝트 모델만 되돌린다).
   * 한글 문서에서 긁어온 수천 자였으면 다시 긁어와야 하니, 지우기 전에 묻는다.
   * 빈 칸일 때는 잃을 게 없으니 묻지 않는다 — 없는 위험을 묻는 창은 소음이다.
   */
  const clearText = async (): Promise<void> => {
    if (text) {
      const ok = await confirm({
        title: `붙여넣은 요구사항 원문 ${text.length.toLocaleString()}자를 지웁니다.`,
        body: '되돌릴 수 없습니다. 파일에서 열어온 글이 아니면 다시 붙여넣어야 합니다.',
        confirmLabel: '지우기',
        danger: true
      })
      if (!ok) return
    }
    setText('')
    setTyping(false)
  }

  /** 파일을 창에 끌어다 놓으면 확장자로 갈라 처리 */
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (!f) {
      const dropped = e.dataTransfer.getData('text/plain')
      if (dropped) {
        setWb(null)
        setText(dropped)
      }
      return
    }
    if (/\.hwp$/i.test(f.name)) return openHwp(window.api.hwp.pathOf(f))
    if (/\.(xlsx|xlsm)$/i.test(f.name)) {
      toast('info', '엑셀은 아래 "엑셀 파일 열기"로 열어주세요 (시트 매핑이 필요합니다).')
      return
    }
    const content = await f.text()
    setWb(null)
    setText(content)
    if (!systemName) setSystemName(f.name.replace(/\.[^.]+$/, ''))
    toast('success', `${f.name} 을(를) 읽었습니다.`)
  }

  /* ------------------------------- 생성 ------------------------------- */

  const generate = async (): Promise<void> => {
    if (!finalText.trim()) return toast('error', '요구사항 내용이 비어 있습니다.')

    /*
     * 이 버튼의 결과는 열려 있던 프로젝트를 **교체**한다 (추가가 아니다).
     * 이름이 "생성" 이라 추가로 읽히는데, 실제로는 손으로 다듬어 둔 것이 전부
     * 사라지고 저장 경로까지 끊긴다. 되돌리기가 없으니 묻고 나서 진행한다.
     * 묻는 자리는 모델 호출 **전**이다 — 몇 분 기다린 뒤에 묻는 건 묻지 않는 것과 같다.
     */
    if (project) {
      const s = countStats(project)
      const ok = await confirm({
        title: '지금 열려 있는 프로젝트를 새 생성 결과로 교체합니다.',
        body:
          `현재 열린 프로젝트: 요구사항 ${s.packages} · 유스케이스 ${s.useCases} · 액터 ${s.actors}` +
          '\n' +
          (dirty
            ? '저장하지 않은 변경이 있습니다. 교체하면 되돌릴 수 없습니다 — 취소하고 Ctrl+S 로 저장한 뒤 다시 하세요.'
            : filePath
              ? `저장된 파일(${filePath})은 지워지지 않지만, 이 창은 새 프로젝트로 바뀝니다.`
              : '아직 저장한 적이 없어 교체하면 복구할 수 없습니다.'),
        confirmLabel: '교체하고 생성',
        danger: true
      })
      if (!ok) return
    }
    /*
     * 비워 두면 "이름 없는 시스템" 을 지어내고 있었다. 그 문자열은 표시용이 아니라
     * EA 모델 이름 · 볼트 폴더명 · 저장 파일명으로 그대로 나간다.
     * 문서에 `시스템명:` 이 적혀 있으면 생성 단계가 읽어서 채우고, 그래도 없으면
     * 지어내지 않고 물어본다.
     */
    setBusy('요구사항 분석 중…')
    const r = await window.api.llm.generate({
      requirementText: finalText,
      systemName: systemName.trim(),
      projectId: projectId.trim(),
      team: { code: teamCode.trim().toUpperCase(), name: teamName.trim() },
      actors: actorLines
    })
    setBusy(null)
    if (!r.ok) {
      setRawResponse(null)
      return toast('error', `생성 실패\n${r.error}`)
    }
    setRawResponse(r.data.rawText)
    setWarnings([])
    setProject(r.data.project, null)
    setView('model')

    const { packages, actors } = r.data.project
    const count = packages.reduce((n, p) => n + p.useCases.length, 0)
    const { excludedReqs = [], missedReqs = [] } = r.data.project.metadata
    const excluded = [...excludedReqs, ...missedReqs]
    const sysCount = packages.reduce((n, p) => n + p.diagrams.reduce((m, d) => m + (d.systemItems?.length ?? 0), 0), 0)
    const summary =
      `요구사항 ${packages.length} · 유스케이스 ${count} · 액터 ${actors.length}` +
      (excluded.length ? `
정의서 요구사항 ${excluded.length}건은 그리지 않았습니다 — 내보내기 점검에 ID와 이름이 있습니다.` : '') +
      (sysCount ? `
시스템 처리로 본 항목 ${sysCount}건은 다이어그램 폼에서 되살릴 수 있습니다.` : '')
    // 소형 모델은 액터를 자주 못 찾는다 — 그 사실과 다음 할 일을 알림이 말한다
    const guessed = actors.filter((a) => a.guessed)
    if (actors.length === 0)
      toast(
        'warn',
        `액터를 찾지 못했습니다 — 트리 Actors 옆 +로 추가하고 다이어그램 위로 끌어 놓으세요.
${summary}`
      )
    else if (guessed.length > 0)
      toast(
        'warn',
        `액터 ${guessed.length}명(${guessed.map((a) => a.name).join('·')})을 정의서에서 추정했습니다 — 트리 Actors에서 사업 액터 이름으로 고치세요.
${summary}`
      )
    else
      toast(
        r.data.warnings.length ? 'info' : 'success',
        `${summary}
편집 탭에서 다듬으세요.`
      )
    if (r.data.warnings.length) setWarnings(r.data.warnings)
  }



  const hasInput = Boolean(finalText.trim())

  return (
    <div className="pane">
      {/*
        여기에 `① 정의서 투입 → ② 생성 → ③ 편집 → ④ 내보내기` 표시줄이 있었다.
        지웠다. 왼쪽 레일이 이미 `1 가져오기 / 2 모델 / 3 내보내기` 로 번호를 붙여
        현재 단계를 칠하고 있었는데, 번호 체계가 둘이라 ③·④가 레일의 2·3과
        어긋났고, 표시줄은 ①에 고정돼 진행을 따라가지도 않았으며, 이 탭에만 있어
        정작 오래 머무는 편집 화면에서는 사라졌다. 단계를 말하는 자리는 레일 하나다.
      */}

      {/*
        주인공: 텍스트 투입구.
        `filled` = 투입구가 쓰이고 있다 — 점선 테두리("여기 떨어뜨려라")는 비었을 때만.
        빈 상태에서는 상자 아무 데나 눌러도 글칸이 펼쳐진다. 이미 펼쳐져 있으면
        아무것도 하지 않는다 — 안 그러면 `지우기` 클릭이 여기까지 올라와 방금 닫은
        글칸을 그 자리에서 다시 연다.
      */}
      <div
        className={`import-hero ${dragOver ? 'drag' : ''} ${hasInput || wb || typing ? 'filled' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => void onDrop(e)}
        onClick={() => !hasInput && !wb && !typing && setTyping(true)}
      >
        {!hasInput && !wb && !typing ? (
          <>
            <div className="hero-title">요구사항 정의서를 여기에 붙여넣으세요</div>
            <div className="hero-sub">
              한글·Word 표를 그대로 복사해도 되고, 마크다운·회의록·메모도 됩니다.
              <br />
              파일을 끌어다 놓아도 됩니다 (.hwp / .txt / .md)
            </div>
            <div className="hero-actions">
              {/*
                넷 다 "글을 어디서 가져올까" 한 갈래다. 이 화면의 진짜 동작은
                아래 "액터 · 유스케이스 생성" 이므로 넷 다 평범한 버튼으로 둔다 —
                **초점은 화면당 하나**다.
              */}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setTyping(true)
                }}
              >
                직접 붙여넣기
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void openHwp()
                }}
              >
                HWP 파일 열기
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void openText()
                }}
              >
                텍스트 파일 열기
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void openExcel()
                }}
              >
                엑셀 파일 열기
              </button>
            </div>
          </>
        ) : wb ? (
          <div>
            <div className="row" style={{ marginBottom: 'var(--s3)' }}>
              <strong>엑셀 · {wb.sheets.length}개 시트</strong>
              <span className="muted mono" style={{ fontSize: 'var(--fz-xs)' }}>
                {wb.filePath.split(/[\\/]/).pop()}
              </span>
              <span className="spacer" />
              <button
                className="tiny"
                onClick={() => {
                  setWb(null)
                  setTyping(false)
                }}
              >
                지우기
              </button>
            </div>
            <ExcelMapping wb={wb} mapping={mapping} onChange={setMapping} />
          </div>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 'var(--s2)' }}>
              <strong>요구사항 정의서</strong>
              <span className="hint">
                {finalText.length.toLocaleString()}자
              </span>
              <span className="spacer" />
              <button className="tiny" onClick={() => void clearText()}>
                지우기
              </button>
            </div>
            <textarea
              ref={taRef}
              className={`hero-text ${showMeta ? 'short' : ''}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="여기에 붙여넣으세요 (Ctrl+V). 파일을 끌어다 놓아도 됩니다."
            />
          </>
        )}
      </div>


      {/*
        액터 목록은 생성 결과(액터 배정)를 바꾸는 입력이라 누르기 **전에** 보여야 한다.
        예전엔 `새 프로젝트 정보`라는 이름으로 버튼 줄 반대 끝에 있었고 펼치면 버튼 아래로
        열려, 생성을 누르고 나서야 그런 칸이 있는 줄 알았다. 읽는 순서대로 원문 → 이 칸 → 생성.
      */}
      <div className="row" style={{ marginTop: 'var(--s3)' }}>
        <button className="tiny ghost" onClick={() => setShowMeta(!showMeta)}>
          {showMeta ? '▾' : '▸'} 액터 목록과 새 프로젝트 정보
          {actorDict.length > 0 && ` (액터 ${actorDict.length}명)`}
        </button>
      </div>

      {showMeta && (
        <div className="card" style={{ marginTop: 'var(--s3)' }}>
          <div className="field">
            <label>액터 목록</label>
            <textarea
              rows={4}
              value={actorText}
              onChange={(e) => setActorText(e.target.value)}
              placeholder={'한 줄에 한 명 — 이름: 하는 일\n민원인: 신청·조회\n담당자: 접수·승인 관리'}
            />
            <p className="hint">
              {actorDict.length
                ? `유스케이스마다 이 ${actorDict.length}명 중에서 하는 일을 보고 액터를 고릅니다. 정의서에서 따로 뽑지 않습니다.`
                : '비워두면 정의서에서 액터를 추정합니다. 사업 액터를 알면 이름과 하는 일을 적어 두세요.'}
            </p>
          </div>

          <div className="grid2" style={{ marginTop: 'var(--s3)' }}>
            <div className="field">
              <label>새 프로젝트 시스템명</label>
              <input
                value={systemName}
                onChange={(e) => setSystemName(e.target.value)}
                placeholder="문서에서 자동 인식됩니다"
              />
            </div>
            <div className="field">
              <label>새 프로젝트 ID (EA GUID 시드)</label>
              <input
                className="mono"
                value={projectId}
                placeholder="비우면 새로 만듭니다"
                onChange={(e) => setProjectId(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
              />
            </div>
          </div>

          <div className="grid2" style={{ marginTop: 'var(--s3)' }}>
            <div className="field">
              <label>팀 코드</label>
              <input
                className="mono"
                value={teamCode}
                onChange={(e) => setTeamCode(e.target.value.replace(/[^A-Za-z0-9]/g, ''))}
                placeholder="ADT1"
              />
            </div>
            <div className="field">
              <label>팀 이름</label>
              <input
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="맞춤형"
              />
            </div>
          </div>
          <p className="hint">
            정의서에 요구사항 ID가 <b>없을 때만</b> 씁니다. 있으면 원문 ID에서 팀을 읽습니다.
            <br />
            채번 예시:{' '}
            <span className="mono">
              SFR-001
              {teamCode.trim()
                ? `-${teamCode.trim().toUpperCase()}${teamName.trim() ? `(${teamName.trim()})` : ''}`
                : ''}
              -01
            </span>
            {!teamCode.trim() && ' — 비워두면 팀 구간 없이 채번합니다.'}
          </p>
        </div>
      )}

      {/* ------------------- 실행 ------------------- */}
      <div className="cta-row">
        {/*
          모델 파일이 없으면 호출이 전건 실패하고, 그 사실은 5개 구간을 다 돌고 난
          뒤에야 알 수 있었다. 시작하기 전에 막고 어디로 가야 하는지 알려 준다.
        */}
        <button
          className="primary"
          disabled={!hasInput || !hasModel}
          title={
            !hasModel
              ? '설정 탭에서 모델 파일(.gguf)을 먼저 지정하세요'
              : !hasInput
                ? '요구사항 정의서를 먼저 넣으세요'
                : undefined
          }
          onClick={() => void generate()}
        >
          액터 · 유스케이스 생성
        </button>
        {/*
          못 누르는 버튼 옆에는 **왜** 못 누르는지가 글로 있어야 한다. 흐려진
          버튼만 있으면 눌러 보고, 아무 일도 안 일어나고, 이유도 모른 채 멈춘다.
          (비활성 버튼은 마우스 이벤트를 안 받아 툴팁이 안 뜨는 경우가 있다.)
          이유가 없으면 누르면 무슨 일이 일어나는지를 적는다. 모델 파일 이름은 사용자 말이
          아니라 마우스를 올렸을 때만.
        */}
        {!hasModel ? (
          <>
            <span style={{ color: 'var(--warn)', fontSize: 'var(--fz-sm)' }}>
              모델 파일(.gguf)이 지정되지 않았습니다
            </span>
            <button className="tiny" onClick={() => setView('settings')}>
              설정 열기
            </button>
          </>
        ) : !hasInput ? (
          <span className="muted" style={{ fontSize: 'var(--fz-sm)' }}>
            요구사항 정의서를 넣으면 눌립니다
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 'var(--fz-sm)' }} title={`모델: ${modelName}`}>
            AI가 정의서를 읽어 요구사항과 액터를 찾아냅니다
          </span>
        )}
        <span className="spacer" />
        {rawResponse && (
          <button
            className="tiny ghost"
            onClick={() => void window.api.debug.dumpRaw(rawResponse, 'llm-raw')}
          >
            원시 응답 저장
          </button>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="card" style={{ marginTop: 'var(--s3)' }}>
          <h3 style={{ color: 'var(--warn)' }}>확인이 필요한 항목 ({warnings.length})</h3>
          <ul
            className="muted"
            style={{
              margin: 0,
              paddingLeft: 'var(--s4)',
              fontSize: 'var(--fz-sm)',
              lineHeight: 'var(--lh-body)'
            }}
          >
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 엑셀 시트·컬럼 매핑                                                  */
/* ------------------------------------------------------------------ */

function ExcelMapping({
  wb,
  mapping,
  onChange
}: {
  wb: WorkbookData
  mapping: ImportMapping
  onChange: (m: ImportMapping) => void
}): JSX.Element {
  return (
    <>
      <Block
        title="① 모형기술서 (계층 + 요구사항 목록)"
        fields={OUTLINE_FIELDS as unknown as string[]}
        wb={wb}
        block={mapping.outline}
        onChange={(b) => onChange({ ...mapping, outline: b })}
      />
      <Block
        title="② 액터 정의"
        fields={ACTOR_FIELDS as unknown as string[]}
        wb={wb}
        block={mapping.actors}
        onChange={(b) => onChange({ ...mapping, actors: b })}
      />
      <Block
        title="③ 요구사항 상세 (선택)"
        fields={DETAIL_FIELDS as unknown as string[]}
        wb={wb}
        block={mapping.detail}
        onChange={(b) => onChange({ ...mapping, detail: b })}
      />
    </>
  )
}

function Block({
  title,
  fields,
  wb,
  block,
  onChange
}: {
  title: string
  fields: string[]
  wb: WorkbookData
  block: BlockMapping
  onChange: (b: BlockMapping) => void
}): JSX.Element {
  const sheet = wb.sheets.find((s) => s.name === block.sheetName) ?? null
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--s3)', marginTop: 'var(--s3)' }}>
      <div className="row" style={{ marginBottom: 'var(--s2)' }}>
        <strong style={{ fontSize: 'var(--fz-sm)' }}>{title}</strong>
        <select
          style={{ maxWidth: 220 }}
          value={block.sheetName ?? ''}
          onChange={(e) => {
            const name = e.target.value || null
            const s = wb.sheets.find((x) => x.name === name)
            const columns: Record<string, number | null> = {}
            if (s) for (const f of fields) columns[f] = guessColumn(s.headers, COLUMN_HINTS[f] ?? [f])
            onChange({ sheetName: name, columns })
          }}
        >
          <option value="">(사용 안 함)</option>
          {wb.sheets.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} ({s.rows.length}행)
            </option>
          ))}
        </select>
      </div>
      {sheet && (
        <div className="grid3">
          {fields.map((f) => (
            <div key={f}>
              <label>{FIELD_LABEL[f] ?? f}</label>
              <select
                value={block.columns[f] ?? ''}
                onChange={(e) =>
                  onChange({
                    ...block,
                    columns: {
                      ...block.columns,
                      [f]: e.target.value === '' ? null : Number(e.target.value)
                    }
                  })
                }
              >
                <option value="">(없음)</option>
                {sheet.headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function autoMap(wb: WorkbookData): ImportMapping {
  const build = (sheetName: string | null, fields: readonly string[]): BlockMapping => {
    const s = wb.sheets.find((x) => x.name === sheetName)
    const columns: Record<string, number | null> = {}
    if (s) for (const f of fields) columns[f] = guessColumn(s.headers, COLUMN_HINTS[f] ?? [f])
    return { sheetName: s ? s.name : null, columns }
  }
  return {
    outline: build(
      guessSheet(wb.sheets, SHEET_HINTS.outline) ?? wb.sheets[0]?.name ?? null,
      OUTLINE_FIELDS
    ),
    actors: build(guessSheet(wb.sheets, SHEET_HINTS.actors), ACTOR_FIELDS),
    detail: build(guessSheet(wb.sheets, SHEET_HINTS.detail), DETAIL_FIELDS)
  }
}
