import type { BundleSummary, Diagram, Project, UcPackage } from '@shared/types'
import {
  ACTORS_IMAGE_NAME,
  actorsSvg,
  diagramImageName,
  diagramSvg,
  imageIndexMarkdown
} from '@shared/diagram-svg'

/**
 * 다이어그램을 그림 파일로 굽는다.
 *
 * PNG는 **렌더러에서** 만든다. 메인 프로세스에는 글꼴도 캔버스도 없어서
 * 한글이 들어간 SVG를 그림으로 바꿀 방법이 없고, 외부 라이브러리를 쓰면
 * 폐쇄망 반입 심사에 걸린다. 브라우저 캔버스는 이미 앱 안에 있다.
 */

/** SVG 문자열 한 장을 PNG base64 로 굽는다 */
function svgToPngBase64(svg: string, width: number, height: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('캔버스를 만들 수 없습니다.'))
      ctx.drawImage(img, 0, 0, width, height)
      resolve(canvas.toDataURL('image/png').split(',')[1] ?? '')
    }
    img.onerror = () => reject(new Error('그림을 그리지 못했습니다.'))
    // data URL 이라야 외부에서 불러오는 것이 없고(폐쇄망), 캔버스도 오염되지 않는다
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
}

export interface DiagramImage {
  /** 확장자 없는 파일 이름 */
  name: string
  svg: string
  pngBase64: string
}

export async function renderDiagramImages(
  project: Project,
  pairs: { pkg: UcPackage; dgm: Diagram }[]
): Promise<DiagramImage[]> {
  const out: DiagramImage[] = []
  for (const { pkg, dgm } of pairs) {
    const { svg, width, height } = diagramSvg(project, pkg, dgm)
    out.push({ name: diagramImageName(pkg, dgm), svg, pngBase64: await svgToPngBase64(svg, width, height) })
  }
  return out
}

/** 액터만 모아 놓은 한 장. 액터가 없으면 그릴 게 없다 */
async function renderActorsImage(project: Project): Promise<DiagramImage | null> {
  const a = actorsSvg(project)
  if (!a) return null
  return {
    name: ACTORS_IMAGE_NAME,
    svg: a.svg,
    pngBase64: await svgToPngBase64(a.svg, a.width, a.height)
  }
}

/**
 * 사람이 고른 폴더 안에 `png/`, `svg/` 를 만들고 같은 이름으로 덮어쓴다
 * (한글 문서의 그림만 바꿔 끼울 수 있어야 한다).
 */
async function save(
  images: DiagramImage[],
  indexMd: string | null
): Promise<{ dirPath: string; count: number } | null> {
  const r = await window.api.exporter.images(images, indexMd)
  if (!r.ok) throw new Error(r.error)
  return r.data
}

/** ② 다이어그램 한 장 (다이어그램 탭의 기본 동작) */
export async function saveDiagramImages(
  project: Project,
  pairs: { pkg: UcPackage; dgm: Diagram }[]
): Promise<{ dirPath: string; count: number } | null> {
  return save(await renderDiagramImages(project, pairs), null)
}

/** ① 액터 다이어그램만 */
export async function saveActorsImage(
  project: Project
): Promise<{ dirPath: string; count: number } | null> {
  const img = await renderActorsImage(project)
  if (!img) throw new Error('액터가 없습니다. 편집 탭에서 액터를 먼저 만드세요.')
  return save([img], null)
}

/**
 * 꾸러미 한 벌 — 액터 한 장 + 다이어그램 전부 + `index.md`.
 * 안내문은 이 단위에서만 쓴다. 한 장만 내보낸 폴더에 전체 목록을 두면
 * 목록의 그림 절반이 없는 상태가 된다.
 */
async function renderBundle(
  project: Project
): Promise<{ images: DiagramImage[]; indexMd: string }> {
  const pairs = project.packages.flatMap((pkg) => pkg.diagrams.map((dgm) => ({ pkg, dgm })))
  const actors = await renderActorsImage(project)
  return {
    images: [...(actors ? [actors] : []), ...(await renderDiagramImages(project, pairs))],
    indexMd: imageIndexMarkdown(project, !!actors)
  }
}

/** ③ 그림 전부 */
export async function saveAllImages(
  project: Project
): Promise<{ dirPath: string; count: number } | null> {
  const { images, indexMd } = await renderBundle(project)
  if (!images.length) throw new Error('내보낼 다이어그램이 없습니다.')
  return save(images, indexMd)
}

/**
 * ④ 프로젝트 통째로 — 꾸러미(xmi·png·svg·index.md) + 프로젝트 원본을 zip 한 파일로.
 * 그림이 없어도 만든다: XMI 와 프로젝트 원본만으로도 넘길 값이 있다.
 */
export async function saveProjectZip(project: Project): Promise<BundleSummary | null> {
  const { images, indexMd } = await renderBundle(project)
  const r = await window.api.exporter.bundle(project, images, indexMd)
  if (!r.ok) throw new Error(r.error)
  return r.data
}
