import { useEffect, useState } from 'react'
import { useStore } from '../store'

/**
 * 설정 화면 — **읽는 화면이다.**
 *
 * 한동안 여기에 프로바이더 버튼 줄 · 엔드포인트 · API 키 · 폐쇄망 경고 ·
 * 컨텍스트 길이 · 최대 출력 토큰 · 생성 전략 · 시스템 프롬프트가 있었다.
 * 그런데 이 앱에는 고를 프로바이더가 하나뿐이고, 모델은 설치본에 들어 있으며,
 * 나머지 값들은 기본값이 곧 권장값이라 **아무도 건드릴 이유가 없었다.**
 * 고칠 일이 없는 값을 늘어놓으면 사용자는 "내가 뭔가 정해야 하나" 하고 멈춘다.
 *
 * 남긴 것은 둘뿐이다 — 지금 무엇이 쓰이는지, 그리고 밖으로 나가는 게 없다는 사실.
 * (컨텍스트 길이 · 생성 전략 등은 기본값으로 동작한다. 바꿀 일이 생기면
 *  그때 화면에 꺼내면 된다 — 값 자체는 AppSettings 에 그대로 있다)
 */
export default function SettingsView(): JSX.Element {
  const { toast } = useStore()
  const [testing, setTesting] = useState(false)
  const [model, setModel] = useState<{
    name: string
    sizeGb: string
    source: 'bundled' | 'custom'
  } | null>(null)

  useEffect(() => {
    void window.api.llm.modelInfo().then((r) => setModel(r.ok ? r.data : null))
  }, [])

  return (
    <div className="pane">
      <h2>설정</h2>
      <p className="sub">
        유스케이스 초안 생성에만 모델을 씁니다. 생성 이후의 편집 · 검증 · XMI 변환은
        전부 로컬 계산이라 모델 없이도 동작합니다.
      </p>

      <div className="card">
        <h3>사용 중인 모델</h3>

        {model ? (
          <div className="model-row">
            <span className="mono grow">{model.name}</span>
            <span className="badge">{model.sizeGb}GB</span>
            <span className="badge">
              {model.source === 'bundled' ? '앱에 포함됨' : '직접 지정'}
            </span>
          </div>
        ) : (
          <div className="model-row warn">
            <span className="grow">앱에 포함된 모델을 찾지 못했습니다</span>
          </div>
        )}

        <p className="hint">
          {model
            ? '설치본에 함께 들어 있어 따로 받거나 지정할 것이 없습니다.'
            : '설치가 불완전하거나 빌드 시 모델이 포함되지 않았습니다. 모델 없이도 저장한 프로젝트(.eaucs)를 열어 편집하고 EA 파일로 내보낼 수 있습니다.'}
        </p>

        <div className="row" style={{ marginTop: 'var(--s3)' }}>
          <button
            disabled={testing || !model}
            onClick={async () => {
              setTesting(true)
              const r = await window.api.llm.ping('embedded')
              setTesting(false)
              if (!r.ok) return toast('error', r.error)
              toast('success', r.data)
            }}
          >
            {testing ? '모델 올리는 중…' : '모델 확인'}
          </button>
          <span className="hint" style={{ margin: 0 }}>
            실제로 메모리에 올려 봅니다. 처음 한 번은 몇 초 걸리고, 이후 생성은 바로
            시작됩니다.
          </span>
        </div>
      </div>

      <div className="card">
        <h3>네트워크</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          이 앱은 <b>어디로도 통신하지 않습니다.</b> 모델이 앱 프로세스 안에서 돌기 때문에
          호출할 서버가 없고, 서버를 띄우지 않으므로 포트도 열지 않습니다.
        </p>
        <table className="grid">
          <tbody>
            <tr>
              <td style={{ width: 210 }}>화면의 외부 통신</td>
              <td className="muted">CSP 로 원천 차단</td>
            </tr>
            <tr>
              <td>외부 폰트 · CDN · 이미지</td>
              <td className="muted">없음 (시스템 폰트만)</td>
            </tr>
            <tr>
              <td>자동 업데이트 · 텔레메트리</td>
              <td className="muted">없음</td>
            </tr>
            <tr>
              <td>모델 호출</td>
              <td className="muted">앱 안에서 직접 추론 — 네트워크 없음</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
