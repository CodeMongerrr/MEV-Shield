/**
 * DECISION ENGINE v3
 * 
 * Works with calcOptimizer v3 to make optimal strategy decisions.
 * The optimizer now does most of the heavy lifting - this engine
 * primarily translates the optimizer's output into execution strategies.
 */

import { UserPolicy } from "../core/types"
import { MEVSimulationResult } from "../perception/mevTemperature"
import { optimize, OptimizedPlan, toChunkPlan, ChunkPlan } from "./calcOptimizer"

export type { ChunkPlan } from "./calcOptimizer"

export type Strategy =
  | { type: "DIRECT"; reasoning: string }
  | { type: "MEV_ROUTE"; reasoning: string }
  | { type: "SPLIT"; plan: ChunkPlan; reasoning: string }
  | { type: "PRIVATE"; reasoning: string }
  | { type: "FULL_SHIELD"; plan: ChunkPlan; reasoning: string }

export async function decide(
  sim: MEVSimulationResult,
  policy: UserPolicy,
  tradeSizeUsd: number
): Promise<Strategy> {
  const risk = sim.risk

  console.log(`\n🧠 DECISION ENGINE v3`)
  console.log(`═══════════════════════════════════════════════════════════`)
  console.log(`   Risk: ${risk} (base: ${sim.risk})`)
  console.log(`   Attack viable: ${sim.attackViable}`)
  console.log(`   Trade: $${tradeSizeUsd.toFixed(2)}`)
  console.log(`   MEV exposure: $${sim.estimatedLossUsd.toFixed(2)}`)

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // FAST EXIT 1: Attack not profitable
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (!sim.attackViable) {
    const reasoning = `Attack not viable. Attacker profit ($${sim.attackerProfitUsd.toFixed(2)}) < gas ($${sim.gasData.sandwichGasCostUsd.toFixed(2)}).`
    console.log(`\n   ✅ DIRECT: ${reasoning}`)
    return { type: "DIRECT", reasoning }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // FAST EXIT 2: Low risk pool
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (risk === "LOW") {
    const reasoning = `Low risk. Pool sandwich rate: ${(sim.mevProfile.metrics.score * 100).toFixed(1)}%.`
    console.log(`\n   ✅ DIRECT: ${reasoning}`)
    return { type: "DIRECT", reasoning }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // FAST EXIT 3: Medium risk, very small trade
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (risk === "MEDIUM" && tradeSizeUsd < 500) {
    const reasoning = `Medium risk but tiny trade ($${tradeSizeUsd.toFixed(0)}). MEV too small to matter.`
    console.log(`\n   ✅ DIRECT: ${reasoning}`)
    return { type: "DIRECT", reasoning }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // RUN FULL OPTIMIZER
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log(`\n   Running calculus optimizer v3...`)
  const optimized = await optimize(sim, policy, tradeSizeUsd)

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TRANSLATE OPTIMIZER DECISION
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  
  switch (optimized.comparison.winner) {
    case "DIRECT_SWAP": {
      // Trade is safe enough to go public
      const reasoning = `Optimizer: ${optimized.comparison.recommendation}`
      console.log(`\n   ✅ DIRECT: ${reasoning}`)
      return { type: "DIRECT", reasoning }
    }

    case "PRIVATE_RELAY": {
      // Private relay is most economical
      const reasoning = `Optimizer: ${optimized.comparison.recommendation}`
      console.log(`\n   ✅ PRIVATE: ${reasoning}`)
      return { type: "PRIVATE", reasoning }
    }

    case "OPTIMIZED_PATH": {
      const plan = toChunkPlan(optimized)
      
      // Check if any chunks are unsafe (critical risk)
      if (risk === "CRITICAL") {
        const unsafeChunks = optimized.chunks.filter(c => !c.isSafe)
        if (unsafeChunks.length > 0) {
          const reasoning = `Critical risk. ${plan.count} chunks, ${unsafeChunks.length} unsafe → add private relay for unsafe chunks.`
          console.log(`\n   ✅ FULL_SHIELD: ${reasoning}`)
          return { type: "FULL_SHIELD", plan, reasoning }
        }
      }

      // Standard split execution
      const chainsUsed = [...new Set(plan.chains)]
      const safeCount = plan.economics.filter(e => e.safe).length
      
      const reasoning = `${risk} risk. ${plan.count} chunks on ${chainsUsed.join("+")}. ` +
        `${safeCount}/${plan.count} safe. Saves $${plan.costBreakdown.savings.toFixed(2)} (${plan.costBreakdown.savingsPercent.toFixed(1)}%).`
      
      console.log(`\n   ✅ SPLIT: ${reasoning}`)
      return { type: "SPLIT", plan, reasoning }
    }

    default: {
      // Fallback
      const reasoning = `Fallback to direct. Winner: ${optimized.comparison.winner}`
      console.log(`\n   ⚠️ DIRECT (fallback): ${reasoning}`)
      return { type: "DIRECT", reasoning }
    }
  }
}