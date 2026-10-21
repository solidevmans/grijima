import { createHash } from 'node:crypto'

/**
 * EA GUID 채번 — **결정적(deterministic)**.
 *
 * n8n 버전은 Math.random() 으로 매번 새 GUID를 만들었다. 그 결과 XMI를 다시
 * 내보내 EA에 재임포트하면 같은 유스케이스가 "새 요소"로 인식되어 중복 생성된다.
 * 여기서는 엔티티 uid(프로젝트 파일에 영구 저장) + 프로젝트 네임스페이스를
 * SHA-1 해싱해 GUID를 만든다. 따라서:
 *
 *   같은 프로젝트 · 같은 요소 → 항상 같은 GUID → EA가 "갱신"으로 처리
 *
 * ClassifierRole(EAID_)과 Package(EAPK_)는 본문이 동일해야 EA가 짝으로 인식한다.
 */

const FORMAT = (hex: string, prefix: string): string =>
  `${prefix}_${hex.slice(0, 8)}_${hex.slice(8, 12)}_${hex.slice(12, 16)}_${hex.slice(16, 28)}`

function body(namespace: string, seed: string): string {
  return createHash('sha1').update(`${namespace}::${seed}`).digest('hex').toUpperCase()
}

export class GuidFactory {
  private readonly ns: string

  constructor(namespace: string) {
    this.ns = namespace
  }

  /** 요소(UseCase, Actor, Association …) GUID */
  eaid(seed: string): string {
    return FORMAT(body(this.ns, seed), 'EAID')
  }

  /** 패키지 GUID */
  eapk(seed: string): string {
    return FORMAT(body(this.ns, seed), 'EAPK')
  }

  /** 패키지 한 개에 대한 ClassifierRole/Package GUID 쌍 (본문 동일) */
  packagePair(seed: string): { classifierRoleId: string; packageId: string } {
    const hex = body(this.ns, seed)
    return { classifierRoleId: FORMAT(hex, 'EAID'), packageId: FORMAT(hex, 'EAPK') }
  }

  /** 모델 루트용 MX_EAID */
  modelId(seed: string): string {
    return `MX_EAID_${body(this.ns, seed).slice(0, 32)}`
  }

  /** 다이어그램 요소 DUID (8자리) */
  duid(seed: string): string {
    return body(this.ns, seed).slice(0, 8)
  }
}

/** EA가 루트 클래스로 기대하는 고정 GUID */
export const EA_ROOT_CLASS_ID = 'EAID_11111111_5487_4080_A7F4_41526CB0AA00'
