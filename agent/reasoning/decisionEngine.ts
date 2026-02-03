/**
 * DECISION ENGINE v2
 * 
 * Integrates the calculus-based optimizer for mathematically optimal
 * chunk allocation with no arbitrary limits.
 * 
 * Decision flow:
 * 1. If attack not viable (attacker profit < gas) → DIRECT
 * 2. If low risk after historical analysis → DIRECT  
 * 3. Otherwise → Run calculus optimizer to find optimal n
 * 4. If optimal cost >= unprotected cost → PRIVATE relay
 * 5. If any chunks still unsafe → FULL_SHIELD (split + private)
 * 6. Otherwise → SPLIT with optimal plan
 */

import { UserPolicy } from "../core/types"
import { SandwichSimulation } from "../perception/simulator"
import { optimize, OptimizedPlan, ChunkSpec, CostAnalysis } from "./calcOptimizer"

// Re-export ChunkPlan for compatibility
export interface ChunkPlan {
  count: number
  sizes: number[]
  chains: string[]
  blockDelays: number[]
  crossChain: boolean
  reasoning: string
  economics: ChunkEconomics[]
  totalCost: number
  costBreakdown: {
    totalMevExposure: number
    totalUserGas: number
    totalBridgeFees: number
    totalCost: number
    unprotectedCost: number
    savings: number
    savingsPercent: number
  }
}

export interface ChunkEconomics {
  index: number
  sizePercent: number
  valueUsd: number
  chain: string
  mevExposureUsd: number
  userGasCostUsd: number
  bridgeCostUsd: number
  totalCostUsd: number
  safe: boolean
  blockDelay: number
}

export type Strategy =
  | { type: "DIRECT"; reasoning: string }
  | { type: "MEV_ROUTE"; reasoning: string }
  | { type: "SPLIT"; plan: ChunkPlan; reasoning: string }
  | { type: "PRIVATE"; reasoning: string }
  | { type: "FULL_SHIELD"; plan: ChunkPlan; reasoning: string }

/**
 * Convert OptimizedPlan to ChunkPlan for backward compatibility
 */
function convertToChunkPlan(opt: OptimizedPlan): ChunkPlan {
  return {
    count: opt.chunkCount,
    sizes: opt.chunks.map(c => c.sizePercent),
    chains: opt.chunks.map(c => c.chain),
    blockDelays: opt.chunks.map(c => c.blockDelay),
    crossChain: new Set(opt.chunks.map(c => c.chain)).size > 1,
    reasoning: opt.reasoning,
    economics: opt.chunks.map(c => ({
      index: c.index,
      sizePercent: c.sizePercent,
      valueUsd: c.amountUsd,
      chain: c.chain,
      mevExposureUsd: c.mevExposure,
      userGasCostUsd: c.gasCost,
      bridgeCostUsd: c.bridgeCost,
      totalCostUsd: c.totalCost,
      safe: c.isSafe,
      blockDelay: c.blockDelay,
    })),
    totalCost: opt.costs.totalCost,
    costBreakdown: {
      totalMevExposure: opt.costs.mevExposure,
      totalUserGas: opt.costs.gasFees,
      totalBridgeFees: opt.costs.bridgeFees,
      totalCost: opt.costs.totalCost,
      unprotectedCost: opt.costs.unprotectedCost,
      savings: opt.costs.savings,
      savingsPercent: opt.costs.savingsPercent,
    },
  }
}

/**
 * Main decision function.
 * 
 * Uses calculus-based optimization to find the mathematically optimal
 * execution strategy with no arbitrary chunk limits.
 */
export async function decide(
  sim: SandwichSimulation,
  policy: UserPolicy,
  tradeSizeUsd: number
): Promise<Strategy> {
  // Use adjustedRisk which factors in historical pool threat data
  const risk = sim.adjustedRisk

  console.log(`\n🧠 DECISION ENGINE v2`)
  console.log(`═══════════════════════════════════════════════════════════`)
  console.log(`   Risk: ${risk} (base: ${sim.risk})`)
  console.log(`   Attack viable: ${sim.attackViable}`)
  console.log(`   Trade size: $${tradeSizeUsd.toFixed(2)}`)
  console.log(`   Unprotected MEV: $${sim.estimatedLossUsd.toFixed(2)}`)
  console.log(`   Attacker profit: $${sim.attackerProfitUsd.toFixed(2)}`)
  console.log(`   Sandwich gas cost: $${sim.gasData.sandwichGasCostUsd.toFixed(2)}`)

  // DECISION 1: Attack not viable
  if (!sim.attackViable) {
    const reasoning = `Attack not viable. Attacker profit ($${sim.attackerProfitUsd.toFixed(2)}) < gas cost ($${sim.gasData.sandwichGasCostUsd.toFixed(2)}). No protection needed.`
    console.log(`\n   ✅ DECISION: DIRECT`)
    console.log(`   ${reasoning}`)
    return { type: "DIRECT", reasoning }
  }

  // DECISION 2: Low risk after historical analysis
  if (risk === "LOW") {
    const reasoning = `Low risk after historical analysis. Pool has minimal MEV activity (${(sim.poolThreat.sandwichRate * 100).toFixed(1)}% sandwich rate).`
    console.log(`\n   ✅ DECISION: DIRECT`)
    console.log(`   ${reasoning}`)
    return { type: "DIRECT", reasoning }
  }

  // DECISION 3: Medium risk, small trade - use safer routing
  if (risk === "MEDIUM" && tradeSizeUsd <= policy.privateThresholdUsd) {
    const reasoning = `Medium risk, trade ($${tradeSizeUsd.toFixed(0)}) below threshold ($${policy.privateThresholdUsd}). Using MEV-aware routing.`
    console.log(`\n   ✅ DECISION: MEV_ROUTE`)
    console.log(`   ${reasoning}`)
    return { type: "MEV_ROUTE", reasoning }
  }

  // DECISION 4+: Run calculus optimizer
  console.log(`\n   Running calculus optimizer...`)
  const optimizedPlan = await optimize(sim, policy, tradeSizeUsd)
  const plan = convertToChunkPlan(optimizedPlan)

  // DECISION 4: Splitting not worth it
  if (plan.totalCost >= sim.estimatedLossUsd) {
    const reasoning = `Optimized split cost ($${plan.totalCost.toFixed(2)}) >= unprotected MEV ($${sim.estimatedLossUsd.toFixed(2)}). Private relay is cheaper.`
    console.log(`\n   ✅ DECISION: PRIVATE`)
    console.log(`   ${reasoning}`)
    return { type: "PRIVATE", reasoning }
  }

  // DECISION 5: Critical risk or unsafe chunks
  if (risk === "CRITICAL") {
    const unsafeChunks = plan.economics.filter(e => !e.safe)
    if (unsafeChunks.length > 0) {
      const reasoning = 
        `Critical risk (${(sim.poolThreat.sandwichRate * 100).toFixed(1)}% sandwich rate). ` +
        `Optimal: ${plan.count} chunks but ${unsafeChunks.length} still unsafe — combining with private relay. ` +
        `Theoretical n*: ${optimizedPlan.mathematicalOptimum.toFixed(1)}.`
      
      console.log(`\n   ✅ DECISION: FULL_SHIELD`)
      console.log(`   ${reasoning}`)
      return { type: "FULL_SHIELD", plan, reasoning }
    }
  }

  // DECISION 6: Split execution
  const chainsUsed = [...new Set(plan.chains)]
  const safeCount = plan.economics.filter(e => e.safe).length
  
  const reasoning = 
    `${risk} risk. Calculus optimizer found n*=${optimizedPlan.mathematicalOptimum.toFixed(1)}, ` +
    `actual optimal: ${plan.count} chunks across ${chainsUsed.join("+")}. ` +
    `${safeCount}/${plan.count} chunks below attack threshold. ` +
    `Cost: $${plan.totalCost.toFixed(2)} vs $${sim.estimatedLossUsd.toFixed(2)} unprotected. ` +
    `Savings: $${plan.costBreakdown.savings.toFixed(2)} (${plan.costBreakdown.savingsPercent.toFixed(1)}%). ` +
    `Pool: ${(sim.poolThreat.sandwichRate * 100).toFixed(1)}% sandwich rate.`

  console.log(`\n   ✅ DECISION: SPLIT`)
  console.log(`   ${reasoning}`)
  
  return { type: "SPLIT", plan, reasoning }
}

/**
 * Quick analysis without full optimization.
 * Useful for UI previews before committing to a trade.
 */
export function quickAnalysis(sim: SandwichSimulation): {
  shouldProtect: boolean
  theoreticalChunks: number
  estimatedSavings: number
  riskLevel: string
} {
  const gasPerSwap = sim.gasData.sandwichGasCostUsd / 300000 * 180000  // Approximate
  const theoreticalN = Math.sqrt(sim.estimatedLossUsd / gasPerSwap)
  
  // Quick estimate: MEV/n + n*gas
  const optimalCost = sim.estimatedLossUsd / theoreticalN + theoreticalN * gasPerSwap
  const estimatedSavings = sim.estimatedLossUsd - optimalCost

  return {
    shouldProtect: sim.attackViable && sim.adjustedRisk !== "LOW",
    theoreticalChunks: Math.round(theoreticalN),
    estimatedSavings: Math.max(0, estimatedSavings),
    riskLevel: sim.adjustedRisk,
  }
}