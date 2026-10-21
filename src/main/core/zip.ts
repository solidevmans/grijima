/**
 * zip 쓰기·읽기 (의존성 없음).
 *
 * 왜 직접 쓰는가: 폐쇄망 반입 심사 때문에 새 패키지를 들이지 않는다.
 * node 의 zlib 만으로 충분하다 — zip 은 "deflate 한 덩어리 + 목록"이 전부다.
 * 지원 범위는 이 앱이 만드는 꾸러미에 필요한 만큼: 한 덩이 파일, deflate 또는
 * 무압축, UTF-8 이름, 4GB 미만(zip64 없음). 암호·분할·주석은 다루지 않는다.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** zip 안의 경로. 구분자는 항상 `/` (윈도우에서 만들어도 `/`) */
  path: string
  data: Buffer
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
/** 이름을 UTF-8 로 적었다는 표시. 한글 파일명이 깨지지 않게 하는 비트다 */
const FLAG_UTF8 = 0x0800

/** zip 의 시간은 1980년 기준 DOS 형식이다 */
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

export function writeZip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosDateTime(now)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf-8')
    const deflated = deflateRawSync(e.data)
    // 이미 압축된 PNG 는 deflate 하면 오히려 커진다 — 그럴 때는 그냥 담는다
    const compressed = deflated.length < e.data.length
    const body = compressed ? deflated : e.data
    const method = compressed ? 8 : 0
    const crc = crc32(e.data)

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(SIG_LOCAL, 0)
    lh.writeUInt16LE(20, 4) // 풀려면 필요한 버전 2.0
    lh.writeUInt16LE(FLAG_UTF8, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(time, 10)
    lh.writeUInt16LE(date, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, body)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(SIG_CENTRAL, 0)
    ch.writeUInt16LE(20, 4) // 만든 버전
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(FLAG_UTF8, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(time, 12)
    ch.writeUInt16LE(date, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)

    offset += lh.length + name.length + body.length
  }

  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, central, eocd])
}

/** 끝에서 거꾸로 목록 꼬리표를 찾는다 */
function findEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  throw new Error('zip 파일이 아닙니다 (목록을 찾지 못했습니다).')
}

export function readZip(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('zip 목록이 깨졌습니다.')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const at = buf.readUInt32LE(p + 42)
    const path = buf.toString('utf-8', p + 46, p + 46 + nameLen)

    // 데이터 시작점은 로컬 헤더 뒤다. 로컬 쪽 extra 길이는 목록과 다를 수 있어 다시 읽는다
    if (buf.readUInt32LE(at) !== SIG_LOCAL) throw new Error(`zip 항목이 깨졌습니다: ${path}`)
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
    const body = buf.subarray(start, start + compSize)
    if (method !== 0 && method !== 8) {
      throw new Error(`다룰 수 없는 압축 방식입니다 (${method}): ${path}`)
    }
    out.push({ path, data: method === 8 ? inflateRawSync(body) : Buffer.from(body) })

    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}
