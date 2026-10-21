import type { UseCase } from './types'

/**
 * 유스케이스 관계 그래프.
 *
 * include/extend 는 방향이 있는 간선이고, **고리가 있으면 안 된다.**
 * include 는 "항상 함께 실행된다"는 뜻이라 A→B→A 는 무한 재귀이고,
 * EA로 내보내면 연결선이 고리로 그려져 읽을 수 없다.
 *
 * 이 검사가 필요한 곳이 둘이라 여기 둔다:
 *   · main   — AI가 제안한 관계를 거를 때 (core/relations.ts)
 *   · 렌더러 — 다이어그램에서 손으로 이을 때 (store.ts)
 * 규칙이 두 곳에서 갈리면 "AI는 막는데 손으로는 되는" 상태가 된다.
 */

/** uid → 그 유스케이스가 가리키는 uid 들 */
export type RelationEdges = Map<string, Iterable<string>>

/** 유스케이스 목록에서 관계 간선을 뽑는다 */
export function relationEdges(useCases: UseCase[]): RelationEdges {
  const edges: RelationEdges = new Map()
  for (const uc of useCases) edges.set(uc.uid, [...uc.includeUids, ...uc.extendUids])
  return edges
}

/** start 에서 간선을 따라 goal 에 닿을 수 있는가 */
export function reaches(edges: RelationEdges, start: string, goal: string): boolean {
  const stack = [start]
  const seen = new Set<string>()
  while (stack.length) {
    const cur = stack.pop() as string
    if (cur === goal) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const next of edges.get(cur) ?? []) stack.push(next)
  }
  return false
}

/**
 * from → to 간선을 더하면 고리가 생기는가.
 * to 에서 이미 from 으로 갈 수 있다면 이 간선이 고리를 닫는다.
 */
export function wouldCreateCycle(edges: RelationEdges, from: string, to: string): boolean {
  if (from === to) return true
  return reaches(edges, to, from)
}
