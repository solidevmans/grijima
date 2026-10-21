import { useCallback, useEffect, useState } from 'react'
import { countStats, useStore, type ViewId } from './store'
import ImportView from './views/ImportView'
import DiagramView from './views/DiagramView'
import ExportView from './views/ExportView'
import SettingsView from './views/SettingsView'

/*
 * 레일이 이 앱의 **유일한** 단계 표시다 (가져오기 탭에만 있던 4단계 표시줄은 지웠다 —
 * 번호가 레일과 어긋났고 진행을 따라가지도 않았다). 그래서 번호 옆 설명도 여기 둔다:
 * 레일은 늘 보이므로, 어느 탭에 있든 "지금 몇 단계이고 이 단계가 뭘 하는 곳인지"를
 * 말할 수 있는 자리는 여기뿐이다.
 */
const TABS: Array<{ id: ViewId; icon: string; label: string; hint: string }> = [
  {
    id: 'import',
    icon: '📄',
    label: '만들기',
    hint: '1단계 — 요구사항 정의서에서 액터·유스케이스 초안을 만듭니다'
  },
  /*
   * `모델` 이었다. 이 앱에서 "모델"은 이미 LLM(gguf)을 가리키는 말로 쓰이고 있어서
   * (가져오기 화면 아래 모델 파일 이름, 설정의 `사용 중인 모델`) 레일의 2단계가
   * "LLM 설정"으로 읽혔다. DESIGN.md 의 흐름 그림도 이 단계를 `[편집]` 이라 부른다.
   */
  { id: 'model', icon: '📝', label: '편집', hint: '2단계 — 트리에서 고르고 상세·다이어그램을 고칩니다' },
  { id: 'export', icon: '📤', label: '내보내기', hint: '3단계 — EA에 넣을 XMI 파일로 저장합니다' }
]

export default function App(): JSX.Element {
  const {
    project,
    filePath,
    dirty,
    view,
    setView,
    setProject,
    setFilePath,
    markSaved,
    setSettings,
    busy,
    setBusy,
    toasts,
    toast,
    dismissToast,
    confirming,
    answerConfirm,
    updateMetadata,
    undo,
    redo,
    history,
    future
  } = useStore()

  useEffect(() => {
    void window.api.settings.get().then((r) => {
      if (r.ok) setSettings(r.data)
    })
  }, [setSettings])

  const save = useCallback(
    async (saveAs = false) => {
      if (!project) return
      const r = await window.api.project.save(project, filePath, saveAs)
      if (!r.ok) return toast('error', `저장 실패: ${r.error}`)
      if (r.data) {
        setFilePath(r.data)
        markSaved(project)
        toast('success', `저장했습니다\n${r.data}`)
      }
    },
    [project, filePath, setFilePath, markSaved, toast]
  )

  const open = useCallback(async () => {
    const r = await window.api.project.open()
    if (!r.ok) return toast('error', `열기 실패: ${r.error}`)
    if (r.data) {
      setProject(r.data.project, r.data.filePath)
      setView('model')
      // zip 꾸러미에서 열면 저장 위치가 없다 — 저장할 때 다시 묻는다는 것을 미리 말해 준다
      toast(
        'success',
        r.data.filePath
          ? '프로젝트를 열었습니다.'
          : 'zip 꾸러미에서 프로젝트를 열었습니다. 저장하면 어디에 둘지 묻습니다.'
      )
    }
  }, [setProject, setView, toast])

  /*
   * 확인 창이 떠 있으면 Esc 로 닫힌다 — 되돌리기가 쉬워야 사람이 도구를 쓴다.
   * 단축키보다 먼저 걸러낸다 (창이 떠 있는 동안 Ctrl+S 가 뒤로 새면 안 된다).
   */
  useEffect(() => {
    if (!confirming) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        answerConfirm(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirming, answerConfirm])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (confirming) return
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 's') {
        e.preventDefault()
        void save(e.shiftKey)
      } else if (k === 'o') {
        e.preventDefault()
        void open()
      } else if (k === 'z' || k === 'y') {
        /*
         * 글칸 안에서는 가로채지 않는다. 거기서의 Ctrl+Z 는 "방금 친 글자"를
         * 되돌리는 것이고, 그건 브라우저가 이미 한다. 가로채면 가져오기 탭에
         * 붙여넣은 원문을 되돌릴 방법이 없어진다.
         */
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        if (k === 'y' || e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, open, confirming, undo, redo])

  useEffect(() => {
    const off = window.api.project.onOpened(({ project: pj, filePath: fp }) => {
      setProject(pj, fp)
      setView('model')
      toast('success', `프로젝트를 열었습니다
${fp}`)
    })
    return off
  }, [setProject, setView, toast])

  useEffect(() => {
    const off = window.api.llm.onProgress((p) => {
      if (!useStore.getState().busy) return
      const step = p.chunkTotal && p.chunkTotal > 1 ? ` (${p.chunkIndex}/${p.chunkTotal})` : ''
      // 글자 수는 실제로 셀 때(요구사항 생성)만 — 문서 해석 단계엔 없다
      if (p.chars === undefined) setBusy(`${p.label ?? '문서 해석 중'}${step}…`)
      else if (step) setBusy(`${p.label ?? ''} 생성 중${step}… ${p.chars.toLocaleString()}자`)
      else setBusy(`모델 응답 수신 중… ${p.chars.toLocaleString()}자`)
    })
    return off
  }, [setBusy])

  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (localStorage.getItem('theme') as 'light' | 'dark') ?? 'light'
  )

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('theme', theme)
  }, [theme])

  const stats = countStats(project)
  // 폴더와 파일 이름의 경계 (윈도 \ 와 / 둘 다)
  const nameAt = filePath ? Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1 : 0

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand">EA UseCase Studio</span>
        <button className="ghost tiny" title="열기 Ctrl+O" onClick={() => void open()}>
          열기
        </button>
        <button className="ghost tiny" disabled={!project} title="저장 Ctrl+S" onClick={() => void save(false)}>
          저장
        </button>
        <button className="ghost tiny" disabled={!project} title="다른 이름으로 저장 Ctrl+Shift+S" onClick={() => void save(true)}>
          다른 이름으로 저장
        </button>
        {/*
          되돌리기는 눈에 보여야 한다. 단축키만 있으면 "실수해도 괜찮다"는 걸
          아무도 모르고, 모르면 삭제 버튼을 안 누른다.
        */}
        <button
          className="ghost tiny"
          disabled={history.length === 0}
          title="되돌리기 Ctrl+Z — 마지막 편집을 되돌립니다"
          onClick={undo}
        >
          되돌리기
        </button>
        <button
          className="ghost tiny"
          disabled={future.length === 0}
          title="다시 실행 Ctrl+Y — 되돌린 편집을 다시 실행합니다"
          onClick={redo}
        >
          다시 실행
        </button>
        {/*
          시스템명은 여기서 바로 고친다.
          이 값은 표시용이 아니라 EA 모델 이름 · 볼트 폴더명 · 저장 파일명으로
          나가는데, 고치려면 설정 어딘가를 찾아 들어가야 했다. 늘 보이는 자리에서
          바로 고칠 수 있어야 한다 — 입력칸처럼 생기지 않게 두되 누르면 고쳐진다.
        */}
        {project && (
          <input
            className="title-name"
            value={project.metadata.systemName}
            placeholder="시스템명을 입력하세요"
            title="시스템명 — EA 모델 이름과 파일명에 쓰입니다"
            onChange={(e) => updateMetadata({ systemName: e.target.value })}
          />
        )}
        {/* 아이콘만 있는 버튼은 이 앱에서 금지 — 🌙/☀ 는 무엇이 바뀌는지 말하지 않았다 */}
        <button
          className="ghost tiny"
          title={theme === 'light' ? '화면을 어둡게 바꿉니다' : '화면을 밝게 바꿉니다'}
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        >
          {theme === 'light' ? '어두운 화면' : '밝은 화면'}
        </button>
        {/* 줄어들 때 앞쪽 폴더만 …로 — 사용자가 보는 건 맨 끝 파일 이름이다 */}
        <span className="path" title={filePath ?? undefined}>
          {dirty && <span className="dot-dirty" />}
          {filePath ? (
            <>
              <span className="path-dir"><bdi>{filePath.slice(0, nameAt)}</bdi></span>
              <span className="path-file">{filePath.slice(nameAt)}</span>
            </>
          ) : project ? '저장되지 않음' : '프로젝트 없음'}
        </span>
      </div>

      <div className="body">
        <nav className="rail">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              className={view === t.id ? 'active' : ''}
              onClick={() => setView(t.id)}
              title={t.hint}
            >
              <span className="rail-step">{i + 1}</span>
              <span className="ico">{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
          <span className="rail-gap" />
          <button
            className={view === 'settings' ? 'active' : ''}
            onClick={() => setView('settings')}
            title="설정"
          >
            <span className="ico">⚙</span>
            <span>설정</span>
          </button>
        </nav>

        <main className="view">
          {view === 'import' && <ImportView />}
          {/* 프로젝트가 없으면 편집·내보내기는 할 게 없다 — 시작하는 두 길을 보인다 */}
          {!project && (view === 'model' || view === 'export') ? (
            <div className="empty">
              <p>아직 프로젝트가 없습니다.</p>
              <div className="empty-actions">
                <button className="primary" onClick={() => setView('import')}>
                  정의서로 유스케이스 만들기
                </button>
                <button onClick={() => void open()}>저장한 프로젝트 열기</button>
              </div>
            </div>
          ) : (
            <>
              {view === 'model' && <DiagramView />}
              {view === 'export' && <ExportView />}
            </>
          )}
          {view === 'settings' && <SettingsView />}
        </main>
      </div>

      <div className="statusbar">
        {/* 프로젝트가 없으면 0 다섯 개는 아무 말도 안 한다 */}
        {project && (
          <>
            <span>요구사항 {stats.packages}</span>
            <span className="sep">│</span>
            <span>다이어그램 {stats.diagrams}</span>
            <span className="sep">│</span>
            <span>유스케이스 {stats.useCases}</span>
            <span className="sep">│</span>
            <span>액터 {stats.actors}</span>
            <span className="sep">│</span>
            <span>연결 {stats.links}</span>
          </>
        )}
        <span className="spacer" />
        {/* 위쪽 막대 경로와 같은 말을 한다 — 파일이 없는데 '저장됨'은 거짓이다 */}
        <span>
          {!project
            ? '프로젝트 없음'
            : dirty
              ? '● 변경됨 (Ctrl+S)'
              : filePath
                ? '저장됨'
                : '저장되지 않음 (Ctrl+S)'}
        </span>
      </div>

      {confirming && (
        /*
          스크림 + 판 하나. busy 와 같은 모양을 쓴다 — 같은 뜻(지금 이것만 하라)은
          같은 모양이어야 한다. 기본 초점은 **취소**에 둔다: 되돌릴 수 없는 행동
          앞에서 Enter 를 습관적으로 누른 사람이 그 행동을 실행하면 안 된다.
        */
        <div className="busy" onClick={() => answerConfirm(false)}>
          <div className="confirm-panel" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title">{confirming.title}</div>
            {confirming.body && <div className="confirm-body">{confirming.body}</div>}
            <div className="confirm-actions">
              <button autoFocus onClick={() => answerConfirm(false)}>
                취소
              </button>
              <button
                className={confirming.danger ? 'danger' : 'primary'}
                onClick={() => answerConfirm(true)}
              >
                {confirming.confirmLabel ?? '계속'}
              </button>
            </div>
          </div>
        </div>
      )}

      {busy && (
        <div className="busy">
          {/*
            스피너 · 문구 · 취소가 스크림 위에 따로 떠 있었다. 셋은 한 가지 일을
            말하므로 하나의 판에 담는다 (**공동 영역**). 판이 있으면 글자색도
            그 판의 배경 기준으로 정할 수 있다 — 스크림 위에서는 배경이 뒤에
            무엇이 있느냐에 따라 달라져 대비를 보장할 수 없다.
          */}
          <div className="busy-panel">
            <div className="spinner" />
            <div className="busy-msg">{busy}</div>
            <button onClick={() => void window.api.llm.cancel()}>취소</button>
          </div>
        </div>
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`} onClick={() => dismissToast(t.id)}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}
