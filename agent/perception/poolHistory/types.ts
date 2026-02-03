// agent/perception/poolHistory/types.ts

export type SizeBucket = "LOW" | "MEDIUM" | "HIGH"

export const SIZE_THRESHOLDS = {
  LOW_MAX: 1_000,
  MEDIUM_MAX: 10_000,
} as const

export interface DecodedSwap {
  txHash: string
  blockNumber: number
  timestamp: number
  trader: string
  tokenIn: string
  tokenOut: string
  amountInUsd: number
  gasPrice: bigint
  positionInBlock: number
}

export interface SandwichAttack {
  frontrunTx: DecodedSwap
  victimTx: DecodedSwap
  backrunTx: DecodedSwap
  attackerAddress: string
  extractedValueUsd: number
  victimLossPercent: number
}

export interface BucketStats {
  bucket: SizeBucket
  totalSwaps: number
  sandwichedSwaps: number
  attackRate: number
  avgExtractionPercent: number
}

export interface SearcherProfile {
  address: string
  attackCount: number
  totalExtractedUsd: number
}

export interface PoolHistoryAnalysis {
  poolAddress: string
  totalTransactions: number
  sandwichAttacks: SandwichAttack[]
  overallAttackRate: number
  bucketStats: Record<SizeBucket, BucketStats>
  uniqueSearchers: number
  topSearchers: SearcherProfile[]
  toxicityScore: number
}

export function classifySizeBucket(amountUsd: number): SizeBucket {
  if (amountUsd < SIZE_THRESHOLDS.LOW_MAX) return "LOW"
  if (amountUsd < SIZE_THRESHOLDS.MEDIUM_MAX) return "MEDIUM"
  return "HIGH"
}