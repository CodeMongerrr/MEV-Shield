/**
 * EXECUTOR v2
 * Executes strategies from the decision engine.
 */

import { Strategy, ChunkPlan } from "../reasoning/decisionEngine"
import { SwapIntent } from "../core/types"
import { MEVSimulationResult } from "../perception/mevTemperature"
import { buildSplitPlan, SplitResult } from "./splitter"
import { buildPrivateTx, PrivateTxPlan } from "./privateTx"
import { optimizeChunks } from "../reasoning/calcOptimizer"

export interface ExecutionResult {
  strategyType: string
  reasoning: string
  splitResult: SplitResult | null
  privateTxPlan: PrivateTxPlan | null
  optimizationStats?: {
    theoreticalOptimum: number
    actualChunks: number
    savingsPercent: number
  }
}

export async function execute(
  strategy: Strategy,
  intent: SwapIntent,
  sim: MEVSimulationResult,
): Promise<ExecutionResult> {
  console.log(`\n⚙️ EXECUTING: ${strategy.type}`)
  console.log(`📋 ${strategy.reasoning}`)

  const amountIn = BigInt(intent.amountIn)
  const defaultMinOut = (sim.cleanOutputRaw * 9950n) / 10000n

  switch (strategy.type) {
    case "DIRECT":
      console.log("→ Public mempool, no protection")
      return {
        strategyType: "DIRECT",
        reasoning: strategy.reasoning,
        splitResult: null,
        privateTxPlan: null,
      }

    case "MEV_ROUTE":
      console.log("→ MEV-aware routing through safer pools")
      return {
        strategyType: "MEV_ROUTE",
        reasoning: strategy.reasoning,
        splitResult: null,
        privateTxPlan: null,
      }

    case "SPLIT": {
      console.log(`→ Building split: ${strategy.plan.count} chunks`)
      const splitResult = await buildSplitPlan(intent, strategy.plan, sim)
      
      return {
        strategyType: "SPLIT",
        reasoning: strategy.reasoning,
        splitResult,
        privateTxPlan: null,
        optimizationStats: {
          theoreticalOptimum: Math.sqrt(sim.estimatedLossUsd / (sim.gasData.sandwichGasCostUsd / 300000 * 180000)),
          actualChunks: strategy.plan.count,
          savingsPercent: strategy.plan.costBreakdown.savingsPercent,
        },
      }
    }

    case "PRIVATE": {
      console.log("→ Building private relay submission")
      const privateTxPlan = await buildPrivateTx(intent, sim, amountIn, defaultMinOut)

      if (!privateTxPlan.economics.worthIt) {
        console.log("⚠️ Private relay not economical, running optimizer for fallback")
        
        const tradeSizeUsd = sim.cleanOutputRaw > 0n
          ? Number(sim.cleanOutputRaw) / 10 ** sim.outDecimals
          : 0

        const fallbackPlan = await optimizeChunks(sim, {
          privateThresholdUsd: 5000,
          splitEnabled: true,
          riskProfile: "balanced",
        }, tradeSizeUsd)

        const splitResult = await buildSplitPlan(intent, fallbackPlan, sim)
        
        return {
          strategyType: "SPLIT_FALLBACK",
          reasoning: privateTxPlan.economics.reasoning,
          splitResult,
          privateTxPlan,
        }
      }

      return {
        strategyType: "PRIVATE",
        reasoning: strategy.reasoning,
        splitResult: null,
        privateTxPlan,
      }
    }

    case "FULL_SHIELD": {
      console.log(`→ FULL SHIELD: ${strategy.plan.count} chunks + private relay`)
      
      const splitResult = await buildSplitPlan(intent, strategy.plan, sim)
      const unsafeChunks = splitResult.chunks.filter(c => !c.safeTx)
      
      let privateTxPlan: PrivateTxPlan | null = null

      if (unsafeChunks.length > 0) {
        const largest = unsafeChunks.reduce((a, b) => a.amountIn > b.amountIn ? a : b)
        const chunkMinOut = (largest.expectedOut * 9950n) / 10000n
        privateTxPlan = await buildPrivateTx(intent, sim, largest.amountIn, chunkMinOut)
        console.log(`🔒 ${unsafeChunks.length} unsafe chunks — largest via private relay`)
      }

      return {
        strategyType: "FULL_SHIELD",
        reasoning: strategy.reasoning,
        splitResult,
        privateTxPlan,
        optimizationStats: {
          theoreticalOptimum: Math.sqrt(sim.estimatedLossUsd / (sim.gasData.sandwichGasCostUsd / 300000 * 180000)),
          actualChunks: strategy.plan.count,
          savingsPercent: strategy.plan.costBreakdown.savingsPercent,
        },
      }
    }
  }
}