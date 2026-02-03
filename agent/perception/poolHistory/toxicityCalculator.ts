// agent/perception/poolHistory/toxicityCalculator.ts

import { BucketStats, SizeBucket, SearcherProfile } from "./types"

const BUCKET_WEIGHTS: Record<SizeBucket, number> = {
  LOW: 0.2,
  MEDIUM: 0.3,
  HIGH: 0.5,
}

export function calculateToxicityScore(
  totalSwaps: number,
  attackCount: number,
  bucketStats: Record<SizeBucket, BucketStats>,
  searchers: SearcherProfile[]
): number {
  if (totalSwaps === 0) return 0

  // Base attack rate (0-1)
  const baseScore = attackCount / totalSwaps

  // Searcher diversity penalty
  // More unique searchers = more competitive = higher risk
  const diversityPenalty = Math.log2(1 + searchers.length) / 10

  // Size-weighted risk
  let sizeWeightedRisk = 0
  for (const bucket of ["LOW", "MEDIUM", "HIGH"] as SizeBucket[]) {
    sizeWeightedRisk += BUCKET_WEIGHTS[bucket] * bucketStats[bucket].attackRate
  }
  sizeWeightedRisk /= 3

  // Combine and scale to 0-100
  const raw = (baseScore + diversityPenalty + sizeWeightedRisk) * 100

  // Clamp
  return Math.min(100, Math.max(0, Math.round(raw * 10) / 10))
}