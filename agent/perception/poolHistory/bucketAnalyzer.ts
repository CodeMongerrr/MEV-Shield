// agent/perception/poolHistory/bucketAnalyzer.ts

import { DecodedSwap, SandwichAttack, BucketStats, SizeBucket, classifySizeBucket } from "./types"

export function analyzeBuckets(
  swaps: DecodedSwap[],
  attacks: SandwichAttack[]
): Record<SizeBucket, BucketStats> {
  
  const stats: Record<SizeBucket, BucketStats> = {
    LOW: { bucket: "LOW", totalSwaps: 0, sandwichedSwaps: 0, attackRate: 0, avgExtractionPercent: 0 },
    MEDIUM: { bucket: "MEDIUM", totalSwaps: 0, sandwichedSwaps: 0, attackRate: 0, avgExtractionPercent: 0 },
    HIGH: { bucket: "HIGH", totalSwaps: 0, sandwichedSwaps: 0, attackRate: 0, avgExtractionPercent: 0 },
  }

  // Track extraction percentages for averaging
  const extractions: Record<SizeBucket, number[]> = { LOW: [], MEDIUM: [], HIGH: [] }

  // Count swaps per bucket
  for (const swap of swaps) {
    const bucket = classifySizeBucket(swap.amountInUsd)
    stats[bucket].totalSwaps++
  }

  // Count sandwiched swaps and extraction
  const victimTxHashes = new Set(attacks.map(a => a.victimTx.txHash))
  
  for (const attack of attacks) {
    const bucket = classifySizeBucket(attack.victimTx.amountInUsd)
    stats[bucket].sandwichedSwaps++
    extractions[bucket].push(attack.victimLossPercent)
  }

  // Calculate rates
  for (const bucket of ["LOW", "MEDIUM", "HIGH"] as SizeBucket[]) {
    const s = stats[bucket]
    s.attackRate = s.totalSwaps > 0 ? s.sandwichedSwaps / s.totalSwaps : 0
    s.avgExtractionPercent = extractions[bucket].length > 0
      ? extractions[bucket].reduce((a, b) => a + b, 0) / extractions[bucket].length
      : 0
  }

  return stats
}