/**
 * zip 쓰기·읽기 검증 — `npm run test:zip`
 *
 * 꾸러미 zip 은 "다른 사람에게 넘기는 파일 하나"다. 그 사람은 윈도우 탐색기나
 * 7-zip 으로 열 뿐이고, 깨진 zip 은 손쓸 방법이 없다. 그래서 여기서 보는 건 셋:
 *   ① 담은 그대로 다시 나오는가 (한글 경로·바이너리·빈 파일 포함)
 *   ② 윈도우가 읽을 수 있는 zip 인가 → `out/test-zip.zip` 을 Expand-Archive 로 푼다
 *      (이 스크립트는 파일만 만들고, 푸는 것은 package.json 의 test:zip 이 한다)
 *   ③ zip 이 아닌 것을 열면 사람이 읽을 수 있는 말로 거절하는가
 *   ④ 내보낸 꾸러미를 "열기"가 다시 열 수 있는가 (담는 쪽·여는 쪽 경로가 어긋나면 끝난다)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Project } from '../src/shared/types'
import { bundleEntries, readProjectFromZip } from '../src/main/core/bundle'
import { readZip, writeZip, type ZipEntry } from '../src/main/core/zip'

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label} ${detail}`)
  }
}

const outDir = process.argv[2] ?? 'out'
mkdirSync(outDir, { recursive: true })

/* 실제 꾸러미와 같은 모양: 한글 폴더·XMI(latin1)·PNG 비슷한 바이너리·마크다운 */
const png = Buffer.alloc(4096)
// PNG 처럼 더는 안 줄어드는 바이트 (고정 씨앗이라 돌릴 때마다 같다) → 무압축 경로를 지난다
let seed = 20261015
for (let i = 0; i < png.length; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  png[i] = (seed >>> 16) & 0xff
}
const entries: ZipEntry[] = [
  { path: '소상공인24/index.md', data: Buffer.from('# 그림 목록\n\n- 00-actors\n', 'utf-8') },
  { path: '소상공인24/xmi/소상공인24.xmi', data: Buffer.from('<XMI>&#49548;</XMI>', 'latin1') },
  { path: '소상공인24/png/00-actors.png', data: png },
  { path: '소상공인24/소상공인24.eaucs', data: Buffer.from(JSON.stringify({ a: '한글' }), 'utf-8') },
  { path: '소상공인24/svg/빈파일.svg', data: Buffer.alloc(0) }
]

console.log('[1] 담은 그대로 다시 나오는가')
const zip = writeZip(entries, new Date(2026, 9, 15, 11, 30, 0))
const back = readZip(zip)
check('항목 수', back.length === entries.length, `${back.length} != ${entries.length}`)
for (const e of entries) {
  const got = back.find((b) => b.path === e.path)
  check(
    `${e.path} (${e.data.length}바이트)`,
    !!got && got.data.equals(e.data),
    got ? `길이 ${got.data.length}` : '경로를 찾지 못함'
  )
}

console.log('[2] 모양')
const rawBytes = entries.reduce((n, e) => n + e.data.length, 0)
check('지역 헤더로 시작한다', zip.readUInt32LE(0) === 0x04034b50)
// 줄지 않는 PNG 를 무압축으로 담으므로 원본보다 커지지는 않는다 (목록만큼만 덧붙는다)
check('원본 합 + 목록 안에 들어온다', zip.length < rawBytes + 1024, `${zip.length} / ${rawBytes}바이트`)

console.log('[3] zip 이 아닌 것')
let msg = ''
try {
  readZip(Buffer.from('이건 zip 이 아니다', 'utf-8'))
} catch (e) {
  msg = e instanceof Error ? e.message : String(e)
}
check('사람이 읽을 수 있는 거절', msg.includes('zip'), msg)

console.log('[4] 내보낸 꾸러미를 다시 열 수 있는가 (examples/예시.eaucs)')
const sample = JSON.parse(readFileSync('examples/예시.eaucs', 'utf-8')) as Project
const bundle = bundleEntries(
  sample,
  [{ name: '00-actors', svg: '<svg/>', pngBase64: png.toString('base64') }],
  '# 그림 목록',
  '예시'
)
const bundleZip = writeZip(bundle)
const reopened = readProjectFromZip(bundleZip)
const paths = bundle.map((e) => e.path)
check('xmi 가 들어 있다', paths.includes('예시/xmi/예시.xmi'), paths.join(' '))
check('프로젝트 원본이 들어 있다', paths.includes('예시/예시.eaucs'))
check('그림은 png·svg 두 장', paths.includes('예시/png/00-actors.png') && paths.includes('예시/svg/00-actors.svg'))
check(
  '다시 연 프로젝트가 같다',
  JSON.stringify(reopened) === JSON.stringify(sample),
  `유스케이스 ${reopened.packages.flatMap((p) => p.useCases).length}개`
)
let openMsg = ''
try {
  readProjectFromZip(writeZip([{ path: 'png/a.png', data: png }]))
} catch (e) {
  openMsg = e instanceof Error ? e.message : String(e)
}
check('프로젝트가 없는 zip 은 무엇이 없는지 말한다', openMsg.includes('.eaucs'), openMsg)

const zipPath = join(outDir, 'test-zip.zip')
writeFileSync(zipPath, zip)
console.log(`\n저장: ${zipPath} (${zip.length}바이트) — 윈도우가 푸는지는 test:zip 이 확인한다`)

console.log(`\n통과 ${pass} / 실패 ${fail}`)
if (fail > 0) process.exit(1)
