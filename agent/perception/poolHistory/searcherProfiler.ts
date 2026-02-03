// agent/perception/poolHistory/searcherProfiler.ts

import { SandwichAttack, SearcherProfile } from "./types"

export function profileSearchers(attacks: SandwichAttack[]): SearcherProfile[] {
  const map = new Map<string, SearcherProfile>()

  for (const attack of attacks) {
    const addr = attack.attackerAddress.toLowerCase()
    const existing = map.get(addr)

    if (existing) {
      existing.attackCount++
      existing.totalExtractedUsd += attack.extractedValueUsd
    } else {
      map.set(addr, {
        address: addr,
        attackCount: 1,
        totalExtractedUsd: attack.extractedValueUsd,
      })
    }
  }

  // Sort by attack count descending
  return Array.from(map.values()).sort((a, b) => b.attackCount - a.attackCount)
}