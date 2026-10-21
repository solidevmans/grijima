/**
 * 꾸러미 zip 의 내용 — 무엇을 담고, 다시 열 때 어디서 프로젝트를 찾는가.
 *
 * 담는 쪽과 여는 쪽을 한 파일에 둔다. 두 곳에 나뉘어 있으면 한쪽의 경로만
 * 바뀌어도 "내보낸 zip 을 열 수 없는" 상태가 조용히 만들어진다.
 */
import type { Project } from '@shared/types'
import { PROJECT_FILE_EXT } from '@shared/constants'
import { buildXmi } from './xmi'
import type { ZipEntry } from './zip'
import { readZip } from './zip'

export interface BundleImage {
  /** 확장자 없는 파일 이름 (렌더러가 정한다) */
  name: string
  svg: string
  pngBase64: string
}

/**
 * zip 안의 구조:
 * ```
 * <사업>/xmi/<사업>.xmi
 * <사업>/png/<그림>.png · <사업>/svg/<그림>.svg
 * <사업>/index.md
 * <사업>/<사업>.eaucs      ← "열기"가 찾는 프로젝트 원본
 * ```
 * 시스템명 폴더를 한 겹 두는 이유: 받은 사람이 "여기에 풀기"를 눌러도 파일이
 * 바탕화면에 흩어지지 않는다.
 */
export function bundleEntries(
  project: Project,
  images: BundleImage[],
  indexMd: string | null,
  baseName: string
): ZipEntry[] {
  const { xml } = buildXmi(project)
  const entries: ZipEntry[] = [
    // XMI 는 비ASCII 를 &#nnn; 로 바꿔 두므로 latin1 로 적어야 EA 의 선언과 바이트가 맞는다
    { path: `${baseName}/xmi/${baseName}.xmi`, data: Buffer.from(xml, 'latin1') },
    {
      path: `${baseName}/${baseName}.${PROJECT_FILE_EXT}`,
      data: Buffer.from(JSON.stringify(project, null, 2), 'utf-8')
    }
  ]
  if (indexMd) entries.push({ path: `${baseName}/index.md`, data: Buffer.from(indexMd, 'utf-8') })
  for (const img of images) {
    entries.push({ path: `${baseName}/png/${img.name}.png`, data: Buffer.from(img.pngBase64, 'base64') })
    entries.push({ path: `${baseName}/svg/${img.name}.svg`, data: Buffer.from(img.svg, 'utf-8') })
  }
  return entries
}

/** 꾸러미 zip 에서 프로젝트 원본을 꺼낸다. 폴더 깊이는 보지 않고 확장자로 찾는다 */
export function readProjectFromZip(zip: Buffer): Project {
  const inside = readZip(zip).find((f) =>
    f.path.toLowerCase().endsWith(`.${PROJECT_FILE_EXT}`)
  )
  if (!inside) {
    throw new Error(
      `이 zip 에는 프로젝트 원본(.${PROJECT_FILE_EXT})이 없습니다. 이 앱의 "zip 파일로 저장"으로 만든 꾸러미인지 확인하세요.`
    )
  }
  return JSON.parse(inside.data.toString('utf-8')) as Project
}
