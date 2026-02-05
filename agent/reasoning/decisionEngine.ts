/**
 * DECISION ENGINE v2
 * Uses calculus-based optimization for mathematically optimal chunk allocation.
 */

import { UserPolicy } from "../core/types"
import { SandwichSimulation } from "../perception/simulator"
import { optimizeChunks, ChunkPlan } from "./calcOptimizer"

export type { ChunkPlan } from "./calcOptimizer"

export type Strategy =
  | { type: "DIRECT"; reasoning: string }
  | { type: "MEV_ROUTE"; reasoning: string }
  | { type: "SPLIT"; plan: ChunkPlan; reasoning: string }
  | { type: "PRIVATE"; reasoning: string }
  | { type: "FULL_SHIELD"; plan: ChunkPlan; reasoning: string }

export async function decide(
  sim: SandwichSimulation,
  policy: UserPolicy,
  tradeSizeUsd: number
): Promise<Strategy> {
  const risk = sim.adjustedRisk

  console.log(`\n🧠 DECISION ENGINE v2`)
  console.log(`═══════════════════════════════════════════════════════════`)
  console.log(`   Risk: ${risk} (base: ${sim.risk})`)
  console.log(`   Attack viable: ${sim.attackViable}`)
  console.log(`   Trade: $${tradeSizeUsd.toFixed(2)}`)
  console.log(`   MEV exposure: $${sim.estimatedLossUsd.toFixed(2)}`)

  // DECISION 1: Attack not profitable
  if (!sim.attackViable) {
    const reasoning = `Attack not viable. Attacker profit ($${sim.attackerProfitUsd.toFixed(2)}) < gas ($${sim.gasData.sandwichGasCostUsd.toFixed(2)}).`
    console.log(`\n   ✅ DIRECT: ${reasoning}`)
    return { type: "DIRECT", reasoning }
  }

  // DECISION 2: Low risk pool
  if (risk === "LOW") {
    const reasoning = `Low risk. Pool sandwich rate: ${(sim.poolThreat.sandwichRate * 100).toFixed(1)}%.`
    console.log(`\n   ✅ DIRECT: ${reasoning}`)
    return { type: "DIRECT", reasoning }
  }

  // DECISION 3: Medium risk, small trade
  if (risk === "MEDIUM" && tradeSizeUsd <= policy.privateThresholdUsd) {
    const reasoning = `Medium risk, small trade ($${tradeSizeUsd.toFixed(0)} < $${policy.privateThresholdUsd}).`
    console.log(`\n   ✅ MEV_ROUTE: ${reasoning}`)
    return { type: "MEV_ROUTE", reasoning }
  }

  // DECISION 4+: Run calculus optimizer
  console.log(`\n   Running calculus optimizer...`)
  const plan = await optimizeChunks(sim, policy, tradeSizeUsd)

  // DECISION 4: Splitting not worth it
  if (plan.totalCost >= sim.estimatedLossUsd) {
    const reasoning = `Split cost ($${plan.totalCost.toFixed(2)}) >= MEV ($${sim.estimatedLossUsd.toFixed(2)}). Use private relay.`
    console.log(`\n   ✅ PRIVATE: ${reasoning}`)
    return { type: "PRIVATE", reasoning }
  }

  // DECISION 5: Critical risk with unsafe chunks
  if (risk === "CRITICAL") {
    const unsafeChunks = plan.economics.filter(e => !e.safe)
    if (unsafeChunks.length > 0) {
      const reasoning = `Critical risk. ${plan.count} chunks, ${unsafeChunks.length} unsafe → add private relay.`
      console.log(`\n   ✅ FULL_SHIELD: ${reasoning}`)
      return { type: "FULL_SHIELD", plan, reasoning }
    }
  }

  // DECISION 6: Split execution
  const chainsUsed = [...new Set(plan.chains)]
  const safeCount = plan.economics.filter(e => e.safe).length
  
  const reasoning = `${risk} risk. ${plan.count} chunks on ${chainsUsed.join("+")}. ` +
    `${safeCount}/${plan.count} safe. Saves $${plan.costBreakdown.savings.toFixed(2)} (${plan.costBreakdown.savingsPercent.toFixed(1)}%).`
  
  console.log(`\n   ✅ SPLIT: ${reasoning}`)
  return { type: "SPLIT", plan, reasoning }
}