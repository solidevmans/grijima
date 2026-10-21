import { useEffect, useState } from 'react'
import { countStats, useStore } from '../store'
import { saveActorsImage, saveAllImages, saveProjectZip } from '../image-export'

export default function ExportView(): JSX.Element {
  const { project, setBusy, toast, setView } = useStore()
  const [preview, setPreview] = useState<string | null>(null)
  const [lastPath, setLastPath] = useState<string | null>(null)
  const [lastVault, setLastVault] = useState<string | null>(null)
  const [lastImages, setLastImages] = useState<string | null>(null)
  const [lastZip, setLastZip] = useState<string | null>(null)
  const [showAllIssues, setShowAllIssues] = useState(false)
  const { issues, setIssues, select, removeUnusedActors, setModelPane, setSourceFocus } = useStore()

  // 화면에 들어오면 자동 검증 — 내보내기 직전이 확인하기 가장 좋은 시점이다
  useEffect(() => {
    if (!project) return
    void window.api.validate.run(project).then((r) => {
      if (r.ok) setIssues(r.data)
    })
  }, [project, setIssues])

  if (!project) return <div className="empty">프로젝트를 먼저 여세요.</div>
  const stats = countStats(project)
  const unusedActorCount = issues.filter((i) => i.code === 'ACTOR_UNUSED').length
  const errCount = issues.filter((i) => i.level === 'error').length
  const warnCount = issues.filter((i) => i.level === 'warn').length
  // 카드 안 스크롤은 줄을 숨긴다 — 다 펼치고, 너무 길 때만 접는다(페이지가 이미 스크롤된다)
  const ISSUE_FOLD = 20
  const shownIssues = issues.filter((i) => i.level !== 'info')
  const hiddenIssueCount = showAllIssues ? 0 : Math.max(0, shownIssues.length - ISSUE_FOLD)

  const exportXmi = async (): Promise<void> => {
    setBusy('XMI 생성 중…')
    const r = await window.api.exporter.xmi(project)
    setBusy(null)
    if (!r.ok) return toast('error', `내보내기 실패\n${r.error}`)
    if (!r.data) return
    setLastPath(r.data.filePath)
    toast(
      'success',
      `XMI 저장 완료 (${(r.data.bytes / 1024).toFixed(1)} KB)\n` +
        `패키지 ${r.data.packages} · 유스케이스 ${r.data.useCases} · ` +
        `액터 ${r.data.actors} · 관계 ${r.data.associations} · 다이어그램 ${r.data.diagrams}\n` +
        r.data.filePath
    )
  }

  const exportVault = async (): Promise<void> => {
    setBusy('마크다운 볼트 생성 중…')
    const r = await window.api.exporter.vault(project)
    setBusy(null)
    if (!r.ok) return toast('error', `내보내기 실패
${r.error}`)
    if (!r.data) return
    setLastVault(r.data.dirPath)
    toast(
      'success',
      `노트 ${r.data.notes}개 생성 (${(r.data.bytes / 1024).toFixed(1)} KB)
` +
        `유스케이스 ${r.data.useCases} · 액터 ${r.data.actors} · 다이어그램 ${r.data.packages}
` +
        r.data.dirPath
    )
  }

  /**
   * 그림 꾸러미 저장. 그림은 렌더러 캔버스로 굽기 때문에 장수가 많으면 한 박자
   * 걸린다 — 그동안 화면을 잠가 두 번 누르는 것을 막는다.
   */
  const saveImages = async (
    scope: 'all' | 'actors',
    busyLabel: string
  ): Promise<void> => {
    setBusy(busyLabel)
    try {
      const r = scope === 'all' ? await saveAllImages(project) : await saveActorsImage(project)
      if (!r) return
      setLastImages(r.dirPath)
      toast(
        'success',
        `그림 ${r.count}장을 저장했습니다${scope === 'all' ? ' (index.md 포함)' : ''}
${r.dirPath}`
      )
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /** ④ 프로젝트 통째로 — 그림을 굽는 동안 화면을 잠근다 (단위 ③과 같은 이유) */
  const saveZip = async (): Promise<void> => {
    setBusy('zip 꾸러미 만드는 중…')
    try {
      const r = await saveProjectZip(project)
      if (!r) return
      setLastZip(r.filePath)
      toast(
        'success',
        `zip 파일로 저장했습니다 (${(r.bytes / 1024 / 1024).toFixed(1)} MB)
그림 ${r.images}장 · XMI · 프로젝트 원본 — 파일 ${r.files}개
${r.filePath}`
      )
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const showPreview = async (): Promise<void> => {
    const r = await window.api.exporter.preview(project)
    if (!r.ok) return toast('error', r.error)
    setPreview(r.data.xml)
  }

  return (
    <div className="pane">
      <h2>내보내기</h2>
      <p className="sub">EA에 임포트할 XMI, 문서용 PlantUML, 재작업용 JSON을 만듭니다.</p>

      <div className="card">
        <h3>현재 모델</h3>
        <div className="row">
          <span>요구사항(UCD) {stats.packages}</span>
          <span className="sep muted">·</span>
          <span>다이어그램 {stats.diagrams}</span>
          <span className="sep muted">·</span>
          <span>유스케이스 {stats.useCases}</span>
          <span className="sep muted">·</span>
          <span>액터 {stats.actors}</span>
          <span className="sep muted">·</span>
          <span>액터-UC 연결 {stats.links}</span>
        </div>
      </div>

      <div className="card">
        <h3>
          점검 결과{' '}
          <span className="h-note">
            — 내보내기 전에 확인하세요
          </span>
        </h3>
        {issues.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>문제가 없습니다.</p>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 'var(--s2)' }}>
              <span style={{ color: 'var(--err)' }}>● 오류 {errCount}</span>
              <span style={{ color: 'var(--warn)' }}>● 경고 {warnCount}</span>
              <span className="spacer" />
              {/*
                쓰이지 않는 액터는 한 명씩 지우게 하면 검증 목록과 트리를 오가야 한다.
                건수가 있을 때만 버튼을 띄운다.
              */}
              {unusedActorCount > 0 && (
                <button
                  className="tiny"
                  title="아무 유스케이스도 쓰지 않는 액터를 모두 삭제합니다"
                  onClick={() => {
                    const names = removeUnusedActors()
                    if (!names.length) return
                    toast(
                      'success',
                      `쓰이지 않는 액터 ${names.length}명을 지웠습니다: ${names.slice(0, 4).join(', ')}${
                        names.length > 4 ? ' 외' : ''
                      }`
                    )
                  }}
                >
                  쓰이지 않는 액터 {unusedActorCount}명 지우기
                </button>
              )}
            </div>
            <div>
              {shownIssues
                .slice(0, shownIssues.length - hiddenIssueCount)
                .map((i, idx) => {
                  // 시스템명은 트리가 아니라 위쪽 막대 칸에서 고친다 — 누르면 그 칸으로
                  const toTitle = i.code === 'META_SYSTEM_NAME'
                  const linked = i.target || toTitle || i.sourceId
                  return (
                    <div
                      key={idx}
                      className={linked ? 'issue link' : 'issue'}
                      onClick={() => {
                        if (toTitle) document.querySelector<HTMLInputElement>('.title-name')?.focus()
                        // 뺀 요구사항은 트리에 없다 — 가져오기 탭 원문의 그 자리로
                        if (i.sourceId) {
                          setSourceFocus(i.sourceId)
                          setView('import')
                          return
                        }
                        if (!i.target) return
                        select({
                          packageUid: i.target.packageUid ?? null,
                          diagramUid: i.target.diagramUid ?? null,
                          useCaseUid: i.target.useCaseUid ?? null,
                          actorUid: i.target.actorUid ?? null
                        })
                        // 액터는 이름 칸이 있는 상세 폼으로 연다 — 경고가 "이름으로 바꾸세요"라고 하니
                        // 뺀 항목·유스케이스에 없는 상세 내용 항목의 되살리기 목록은 다이어그램 폼에, LLM 추가 유스케이스의 이름·삭제는 유스케이스 폼에 있다
                        if (i.target.actorUid || i.code === 'SYSTEM_ITEMS' || i.code === 'ITEMS_UNCOVERED' || i.code === 'UC_INVENTED') setModelPane('edit')
                        setView('model')
                      }}
                    >
                      <span className={`lvl ${i.level}`}>{i.level === 'error' ? '오류' : '경고'}</span>
                      <span className="grow">{i.message}</span>
                      {linked && <span className="muted">→</span>}
                    </div>
                  )
                })}
              {hiddenIssueCount > 0 && (
                <button
                  className="tiny"
                  style={{ marginTop: 'var(--s2)' }}
                  onClick={() => setShowAllIssues(true)}
                >
                  나머지 {hiddenIssueCount}건 보기
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3>EA XMI 1.1 (UML 1.3)</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          EA 메뉴: <span className="mono">Project → Model Import/Export → Import Package from XMI</span>
          <br />
          대상 패키지를 선택하고 <b>Strip GUIDs 체크 해제</b> 상태로 임포트하세요. GUID는 프로젝트
          ID 기준으로 결정적으로 생성되므로, 같은 프로젝트를 다시 내보내 임포트하면 요소가
          중복되지 않고 갱신됩니다.
        </p>
        <div className="row">
          <button className="primary" onClick={() => void exportXmi()}>
            XMI 파일로 저장
          </button>
          <button onClick={() => void showPreview()}>미리보기</button>
          {lastPath && (
            <button className="tiny" onClick={() => void window.api.shell.showItem(lastPath)}>
              폴더 열기
            </button>
          )}
        </div>
        {preview && (
          <>
            <div className="row" style={{ marginTop: 'var(--s3)' }}>
              <span className="muted">{preview.length.toLocaleString()}자</span>
              <span className="spacer" />
              <button
                className="tiny"
                onClick={async () => {
                  await navigator.clipboard.writeText(preview)
                  toast('success', '클립보드에 복사했습니다.')
                }}
              >
                복사
              </button>
              <button className="tiny" onClick={() => setPreview(null)}>
                닫기
              </button>
            </div>
            <pre className="code">{preview.slice(0, 40000)}</pre>
          </>
        )}
      </div>

      <div className="card">
        <h3>
          다이어그램 그림{' '}
          <span className="h-note">— 한글 문서에 붙이는 PNG · SVG</span>
        </h3>
        <p className="muted" style={{ marginTop: 0 }}>
          고른 폴더에 <span className="mono">png/</span> 와 <span className="mono">svg/</span> 를
          만들어 액터만 모은 한 장과 다이어그램 한 장씩을 넣고,
          <span className="mono"> index.md</span> 에 그림 ↔ 요구사항 ↔ 유스케이스 목록을 적습니다.
          가로 1600px · 흰 배경이고, 다시 내보내면 같은 파일 이름으로 덮어쓰므로 문서에 붙여 둔
          그림만 바꿔 끼우면 됩니다.
          <br />
          한 장만 필요하면 <b>편집</b> 탭의 <b>다이어그램</b> 화면에서 그 다이어그램을 열고{' '}
          <b>그림 저장</b>을 누르세요.
        </p>
        <div className="row">
          <button onClick={() => void saveImages('all', '그림 그리는 중…')}>
            그림 전부 저장
          </button>
          <button onClick={() => void saveImages('actors', '액터 그림 그리는 중…')}>
            액터 그림만 저장
          </button>
          {lastImages && (
            <button className="tiny" onClick={() => void window.api.shell.openPath(lastImages)}>
              폴더 열기
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h3>
          프로젝트 통째로{' '}
          <span className="h-note">— 한 파일로 넘기기 · 납품 보관</span>
        </h3>
        <p className="muted" style={{ marginTop: 0 }}>
          위의 XMI · 그림(<span className="mono">png/</span>, <span className="mono">svg/</span>) ·
          <span className="mono"> index.md</span> 와 프로젝트 원본을 zip 한 파일에 담습니다. 받은
          사람은 풀지 않고 <b>열기</b>로 이 zip 을 바로 열어 이어서 고칠 수 있습니다.
        </p>
        <div className="row">
          <button onClick={() => void saveZip()}>zip 파일로 저장</button>
          {lastZip && (
            <button className="tiny" onClick={() => void window.api.shell.showItem(lastZip)}>
              폴더 열기
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h3>
          마크다운 볼트{' '}
          <span className="h-note">
            — 검토 · 인수인계용
          </span>
        </h3>
        <p className="muted" style={{ marginTop: 0 }}>
          유스케이스 · 액터 · 다이어그램을 노트 한 장씩으로 풀어 씁니다. 서로 위키링크로 엮여 있어
          <b> EA 없이도</b> 요구사항 ID에서 유스케이스로, 액터에서 관련 유스케이스로 따라갈 수
          있습니다. 옵시디언에서 열면 백링크와 그래프 뷰가 그대로 붙고, 없어도 그냥 마크다운
          문서로 읽힙니다.
          <br />
          <b>읽기 전용 사본입니다.</b> 여기서 고친 내용은 원본에 반영되지 않습니다 — 모델 수정은
          앱에서 하고 다시 내보내세요.
        </p>
        <div className="row">
          <button onClick={() => void exportVault()}>볼트 폴더 만들기</button>
          {lastVault && (
            <button className="tiny" onClick={() => void window.api.shell.openPath(lastVault)}>
              폴더 열기
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h3>그 밖의 형식</h3>
        <div className="row">
          <button
            onClick={async () => {
              const r = await window.api.exporter.plantuml(project, null)
              if (!r.ok) return toast('error', r.error)
              if (r.data) toast('success', `PlantUML 저장: ${r.data}`)
            }}
          >
            PlantUML (전체)
          </button>
          <button
            onClick={async () => {
              const r = await window.api.exporter.json(project)
              if (!r.ok) return toast('error', r.error)
              if (r.data) toast('success', `JSON 저장: ${r.data}`)
            }}
          >
            JSON
          </button>
        </div>
      </div>
    </div>
  )
}
