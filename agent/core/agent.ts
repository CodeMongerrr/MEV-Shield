/**
 * MEV SHIELD AGENT v2
 * Main entry point that orchestrates simulation, decision, and execution.
 */

import { SwapIntent } from "./types"
import { analyzePool, MEVSimulationResult } from "../perception/mevTemperature"
import { fetchUserPolicy } from "../perception/ens"
import { decide } from "../reasoning/decisionEngine"
import { execute } from "../actions/executor"

export class MEVShieldAgent {
  async handleSwap(intent: SwapIntent) {
    console.log("\n" + "═".repeat(70))
    console.log("🛡️ MEV SHIELD AGENT v2")
    console.log("═".repeat(70))
    console.log(`   ${intent.tokenIn.slice(0, 10)}... → ${intent.tokenOut.slice(0, 10)}...`)
    console.log(`   Amount: ${intent.amountIn.toString()}`)

    // 1. Fetch user policy
    const policy = await fetchUserPolicy(intent.user)
    console.log(`   Policy: ${policy.riskProfile}, threshold=$${policy.privateThresholdUsd}`)

    // 2. Simulate MEV exposure
    const sim = await analyzePool(
      intent.tokenIn,
      intent.tokenOut,
      intent.amountIn.toString(),
      process.env.GRAPH_API_KEY || ""
    )

    const tradeSizeUsd = sim.cleanOutputRaw > 0n
      ? Number(sim.cleanOutputRaw) / 10 ** sim.outDecimals
      : 0

    // 3. Decide optimal strategy
    const strategy = await decide(sim, policy, tradeSizeUsd)

    // 4. Execute strategy
    const execution = await execute(strategy, intent, sim)

    // 5. Serialize response
    const serializeChunks = execution.splitResult?.chunks.map((c) => ({
      index: c.index,
      sizePercent: c.sizePercent,
      amountIn: c.amountIn.toString(),
      expectedOut: c.expectedOut.toString(),
      minAmountOut: c.minAmountOut.toString(),
      priceImpactPercent: c.priceImpactPercent,
      mevExposureUsd: c.mevExposureUsd,
      safeTx: c.safeTx,
      route: c.route,
      blockDelay: c.blockDelay,
      tx: c.tx ? {
        to: c.tx.to,
        data: c.tx.data.slice(0, 66) + "...",
        value: c.tx.value.toString(),
      } : null,
      crossChainTx: c.crossChainTx ? {
        to: c.crossChainTx.to,
        tool: c.crossChainTx.tool,
        chainId: c.crossChainTx.chainId,
        feesUsd: c.crossChainTx.feesUsd,
        gasUsd: c.crossChainTx.gasUsd,
        executionDuration: c.crossChainTx.executionDuration,
        estimatedOutput: c.crossChainTx.estimatedOutput.toString(),
        minOutput: c.crossChainTx.minOutput.toString(),
      } : null,
    }))

    const serializePrivateTx = execution.privateTxPlan
      ? {
          relay: execution.privateTxPlan.relay,
          economics: execution.privateTxPlan.economics,
          tx: {
            to: execution.privateTxPlan.tx.to,
            gasLimit: execution.privateTxPlan.tx.gasLimit.toString(),
            maxFeePerGas: execution.privateTxPlan.tx.maxFeePerGas.toString(),
            maxPriorityFeePerGas: execution.privateTxPlan.tx.maxPriorityFeePerGas.toString(),
          },
          unsignedTxHash: execution.privateTxPlan.unsignedTxHash,
        }
      : null

    // Final summary
    console.log("\n" + "═".repeat(70))
    console.log("📊 FINAL RESULT")
    console.log("═".repeat(70))
    console.log(`   Strategy: ${execution.strategyType}`)
    console.log(`   Trade size: $${tradeSizeUsd.toFixed(2)}`)
    console.log(`   Unprotected MEV: $${sim.estimatedLossUsd.toFixed(2)}`)
    
    if (execution.splitResult) {
      const sr = execution.splitResult
      console.log(`   Chunks: ${sr.chunks.length}`)
      console.log(`   Protected MEV: $${sr.totalMevExposureUsd.toFixed(2)}`)
      console.log(`   Savings: $${(sim.estimatedLossUsd - sr.totalMevExposureUsd).toFixed(2)}`)
    }
    
    if (execution.optimizationStats) {
      console.log(`   Theoretical n*: ${execution.optimizationStats.theoreticalOptimum.toFixed(1)}`)
      console.log(`   Actual chunks: ${execution.optimizationStats.actualChunks}`)
      console.log(`   Savings: ${execution.optimizationStats.savingsPercent.toFixed(1)}%`)
    }
    console.log("═".repeat(70) + "\n")

    return {
      input: {
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        amountIn: intent.amountIn.toString(),
        chainId: intent.chainId,
      },
      simulation: {
        risk: sim.risk,
        adjustedRisk: sim.risk,  // temperature-based; no separate adjustment needed
        estimatedLossPercent: Number(sim.lossPercent.toFixed(3)),
        estimatedLossUsd: Number(sim.estimatedLossUsd.toFixed(2)),
        attackViable: sim.attackViable,
        attackerProfitUsd: Number(sim.attackerProfitUsd.toFixed(2)),
        sandwichGasCostUsd: Number(sim.gasData.sandwichGasCostUsd.toFixed(2)),
        safeChunkThresholdUsd: Number(sim.safeChunkThresholdUsd.toFixed(2)),
        mevTemperature: {
          score: sim.mevProfile.metrics.score,
          riskLevel: sim.mevProfile.metrics.riskLevel,
          victimRate: sim.mevProfile.metrics.victimRate,
          sandwichCount: sim.mevProfile.metrics.sandwichCount,
          totalLossUsd: sim.mevProfile.metrics.totalLossUsd,
          costMultiplier: sim.mevProfile.metrics.mevCostMultiplier,
        },
      },
      tradeSizeUsd: Number(tradeSizeUsd.toFixed(2)),
      execution: {
        strategyType: execution.strategyType,
        reasoning: execution.reasoning,
        optimizationStats: execution.optimizationStats || null,
        split: serializeChunks
          ? {
              chunks: serializeChunks,
              totalMevExposureUsd: execution.splitResult!.totalMevExposureUsd,
              allChunksSafe: execution.splitResult!.allChunksSafe,
              executionBlocks: execution.splitResult!.executionBlocks,
            }
          : null,
        privateTx: serializePrivateTx,
      },
      policy,
    }
  }
}