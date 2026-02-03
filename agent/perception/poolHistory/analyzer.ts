// agent/perception/poolHistory/analyzer.ts

import { PoolHistoryAnalysis } from "./types"
import { fetchPoolTransactions } from "./etherscanFetcher"
import { detectSandwiches } from "./sandwichDetector"
import { analyzeBuckets } from "./bucketAnalyzer"
import { profileSearchers } from "./searcherProfiler"
import { calculateToxicityScore } from "./toxicityCalculator"

export async function analyzePoolHistory(
  poolAddress: string,
  txCount: number = 30
): Promise<PoolHistoryAnalysis> {
   poolAddress = poolAddress.startsWith("0x")
    ? poolAddress.slice(2)
    : poolAddress
  // 1. Fetch transactions
  const swaps = await fetchPoolTransactions(poolAddress, txCount)
  
  // 2. Detect sandwiches
  const attacks = detectSandwiches(swaps)
  
  // 3. Bucket analysis
  const bucketStats = analyzeBuckets(swaps, attacks)
  
  // 4. Searcher profiling
  const searchers = profileSearchers(attacks)
  
  // 5. Calculate toxicity
  const toxicityScore = calculateToxicityScore(
    swaps.length,
    attacks.length,
    bucketStats,
    searchers
  )
  
  return {
    poolAddress,
    totalTransactions: swaps.length,
    sandwichAttacks: attacks,
    overallAttackRate: swaps.length > 0 ? attacks.length / swaps.length : 0,
    bucketStats,
    uniqueSearchers: searchers.length,
    topSearchers: searchers.slice(0, 5),
    toxicityScore,
  }
}