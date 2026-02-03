import { UserPolicy } from "../core/types"
import { SandwichSimulation } from "../perception/simulator"
import { optimizeChunks, ChunkPlan } from "./chunkOptimizer"

export type { ChunkPlan } from "./chunkOptimizer"

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
  // Use adjustedRisk which factors in historical pool threat data
  const risk = sim.adjustedRisk

  console.log(`\n🧠 Deciding: risk=${risk} (base=${sim.risk}), viable=${sim.attackViable}, trade=$${tradeSizeUsd.toFixed(2)}, gasCost=$${sim.gasData.sandwichGasCostUsd.toFixed(2)}`)

  if (!sim.attackViable) {
    return {
      type: "DIRECT",
      reasoning: `Attack not viable. Attacker profit ($${sim.attackerProfitUsd.toFixed(2)}) < gas cost ($${sim.gasData.sandwichGasCostUsd.toFixed(2)}).`,
    }
  }

  if (risk === "LOW") {
    return {
      type: "DIRECT",
      reasoning: `Low risk after historical analysis. Pool has minimal MEV activity.`,
    }
  }

  if (risk === "MEDIUM" && tradeSizeUsd <= policy.privateThresholdUsd) {
    return {
      type: "MEV_ROUTE",
      reasoning: `Medium risk, trade ($${tradeSizeUsd.toFixed(0)}) below threshold ($${policy.privateThresholdUsd}). Safer pool routing.`,
    }
  }

  // Run optimizer for anything that needs splitting
  const plan = await optimizeChunks(sim, policy, tradeSizeUsd)

  // Check if splitting actually helps vs just paying for private relay
  if (plan.totalCost >= sim.estimatedLossUsd) {
    return {
      type: "PRIVATE",
      reasoning: `Split cost ($${plan.totalCost.toFixed(2)}) >= MEV loss ($${sim.estimatedLossUsd.toFixed(2)}). Private relay is cheaper.`,
    }
  }

  if (risk === "CRITICAL") {
    const unsafeChunks = plan.economics.filter((e) => !e.safe)
    if (unsafeChunks.length > 0) {
      return {
        type: "FULL_SHIELD",
        plan,
        reasoning: `Critical risk known attackers, ${(sim.poolThreat.sandwichRate * 100).toFixed(1)}% sandwich rate). ${plan.count} chunks but ${unsafeChunks.length} still unsafe — adding private relay.`,
      }
    }
  }

  return {
    type: "SPLIT",
    plan,
    reasoning: `${risk} risk. Optimizer chose ${plan.count} chunks across ${[...new Set(plan.chains)].join("+")}. Cost: $${plan.totalCost.toFixed(2)} vs $${sim.estimatedLossUsd.toFixed(2)} unprotected. Pool history: ${(sim.poolThreat.sandwichRate * 100).toFixed(1)}% sandwich rate, $${sim.poolThreat.totalMevExtractedUsd.toFixed(0)} extracted from ${sim.poolThreat.analyzedSwaps} swaps.`,
  }
}