import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * HWP 본문 꺼내기 — 이 PC에 깔린 한컴오피스(한글)를 COM으로 불러 텍스트로 받는다.
 * scripts/hwp-to-text.ps1 과 같은 방식. 외부 통신 없음.
 *
 * 보안 모듈(FilePathCheckerModule)이 등록돼 있지 않으면 한글이 "파일 접근 허용" 창을
 * 띄우고 사람이 누를 때까지 기다린다. 그 창은 자동으로 누르지 않는다 — 사람이 고른다.
 * 경로·출력 파일은 환경변수로 넘긴다 (한글·괄호가 든 경로를 따옴표로 감싸지 않으려고).
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
try { $h = New-Object -ComObject HWPFrame.HwpObject } catch { [Console]::Error.Write('NO_HWP'); exit 2 }
try {
  try { $h.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModule') | Out-Null } catch {}
  if (-not $h.Open($env:EAUCS_HWP_IN, 'HWP', 'forceopen:true')) { [Console]::Error.Write('OPEN_FAIL'); exit 3 }
  $t = $h.GetTextFile('TEXT', '')
  [IO.File]::WriteAllText($env:EAUCS_HWP_OUT, $t, (New-Object System.Text.UTF8Encoding($false)))
} finally { try { $h.Quit() } catch {} }
`

/** signal 로 끊으면 파워셸만 끝난다 — 한글 접근 창이 떠 있었다면 그 창은 사람이 닫는다 */
export function hwpToText(hwpPath: string, signal?: AbortSignal): Promise<string> {
  const out = join(tmpdir(), `eaucs-hwp-${process.pid}-${Date.now()}.txt`)
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { env: { ...process.env, EAUCS_HWP_IN: hwpPath, EAUCS_HWP_OUT: out }, windowsHide: true, signal },
      (err, _stdout, stderr) => {
        if (err) {
          const code = String(stderr)
          if (code.includes('NO_HWP')) return reject(new Error('이 PC에 한컴오피스(한글)가 없습니다.'))
          if (code.includes('OPEN_FAIL'))
            return reject(new Error('한글이 파일을 열지 않았습니다 (접근을 허용하지 않았거나 파일이 손상됨).'))
          return reject(new Error(`한글에서 본문을 꺼내지 못했습니다: ${code.trim() || err.message}`))
        }
        readFile(out, 'utf-8')
          .then(resolve, reject)
          .finally(() => void rm(out, { force: true }))
      }
    )
  })
}
