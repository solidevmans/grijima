// UI 리뷰용 CDP 캡처 도구.
// 사용법: EA_QA=1 npm run dev -- --remote-debugging-port=9222 (창이 화면 밖에 뜬다)
//        node scripts/cdp-shot.mjs shot screens/<이름>.png [1350x729]
//        node scripts/cdp-shot.mjs eval "<표현식>"
//        node scripts/cdp-shot.mjs click "<버튼 텍스트>"
//        node scripts/cdp-shot.mjs quit   (캡처 끝나면 꼭 — 앱을 닫는다)
// EA_QA 없이 그냥 npm run dev로 띄운 창도 캡처는 되지만 화면 앞에 뜨고 포커스를 가져간다.
import { writeFileSync } from 'node:fs'

const [, , cmd, ...rest] = process.argv
const wsUrlRes = await fetch('http://127.0.0.1:9222/json')
const targets = await wsUrlRes.json()
const target = targets.find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)

let id = 0
const pending = new Map()
function send(method, params = {}) {
  const myId = ++id
  return new Promise((resolve) => {
    pending.set(myId, resolve)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
}
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result)
    pending.delete(msg.id)
  }
})
await new Promise((resolve) => ws.addEventListener('open', resolve))
await send('Page.enable')
await send('Runtime.enable')

if (cmd === 'shot') {
  const outPath = rest[0]
  // 두 번째 인자로 `1350x729` 를 주면 그 크기의 창인 것처럼 찍는다.
  // 크기 지정과 촬영은 **한 연결 안에서** 끝내야 한다 — CDP 의 화면 크기 덮어쓰기는
  // 소켓이 닫히면 같이 풀려서, 따로 호출하면 원래 크기로 찍힌다.
  const size = rest[1]?.match(/^(\d+)x(\d+)$/)
  if (size) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: Number(size[1]),
      height: Number(size[2]),
      deviceScaleFactor: 1,
      mobile: false
    })
    await new Promise((r) => setTimeout(r, 300))
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(outPath, Buffer.from(data, 'base64'))
  if (size) await send('Emulation.clearDeviceMetricsOverride')
  console.log('saved', outPath, size ? rest[1] : '')
} else if (cmd === 'eval') {
  // `eval "<표현식>" 1350x729` — 그 크기로 바꾼 뒤 재어서, 창 크기별 치수를 확인한다.
  const expr = rest[0]
  const esize = rest[1]?.match(/^(\d+)x(\d+)$/)
  if (esize) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: Number(esize[1]),
      height: Number(esize[2]),
      deviceScaleFactor: 1,
      mobile: false
    })
    await new Promise((r) => setTimeout(r, 300))
  }
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (esize) await send('Emulation.clearDeviceMetricsOverride')
  console.log(JSON.stringify(res.result?.value ?? res.exceptionDetails ?? res))
} else if (cmd === 'click') {
  const text = rest[0]
  const expr = `(() => {
    const els = Array.from(document.querySelectorAll('button, [role="tab"], a'))
    const el = els.find(e => e.textContent && e.textContent.trim().includes(${JSON.stringify(text)}))
    if (!el) return 'NOT_FOUND:' + els.map(e=>e.textContent.trim()).filter(Boolean).slice(0,40).join('|')
    el.click()
    return 'clicked:' + el.textContent.trim()
  })()`
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  console.log(JSON.stringify(res.result?.value ?? res.exceptionDetails ?? res))
} else if (cmd === 'quit') {
  // 창을 닫으면 window-all-closed → app.quit. 창이 닫히며 소켓도 끊겨 답은 기다리지 않는다.
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: { expression: 'window.close()' } }))
  await new Promise((r) => setTimeout(r, 500))
  console.log('quit')
}
ws.close()
