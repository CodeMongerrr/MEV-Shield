/**
 * MEV SHIELD AGENT v2
 * Main entry point that orchestrates simulation, decision, and execution.
 * 
 * CHANGES: Enhanced API response with full optimizer data, market data,
 * and strategy comparison details.
 */

import { SwapIntent } from "./types"
import { simulate } from "../perception/simulator"
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
    const sim = await simulate(intent)

    const tradeSizeUsd = sim.cleanOutputRaw > 0n
      ? Number(sim.cleanOutputRaw) / 10 ** sim.outDecimals
      : 0

    // 3. Decide optimal strategy
    const strategy = await decide(sim, policy, tradeSizeUsd)

    // 4. Execute strategy
    const execution = await execute(strategy, intent, sim)

    // 5. Serialize response — ENHANCED
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

    // ── Build the enhanced comparison from the optimizer data stored on the strategy ──
    let comparison: any = null
    if ((strategy as any).plan?.costBreakdown || execution.optimizationStats) {
      // The optimizer plan is on the strategy object for SPLIT/FULL_SHIELD
      const plan = (strategy as any).plan
      if (plan) {
        comparison = {
          directSwap: {
            mevLoss: sim.estimatedLossUsd,
            gasCost: Number((sim.gasData.gasPriceWei * 180000n).toString()) / 1e18 * sim.ethPriceUsd,
            totalCost: sim.estimatedLossUsd + Number((sim.gasData.gasPriceWei * 180000n).toString()) / 1e18 * sim.ethPriceUsd,
          },
          privateRelay: serializePrivateTx ? {
            mevLoss: 0,
            gasCost: serializePrivateTx.economics.gasCostUsd,
            privateTip: serializePrivateTx.economics.priorityFeeUsd,
            totalCost: serializePrivateTx.economics.gasCostUsd + serializePrivateTx.economics.priorityFeeUsd,
          } : null,
          optimizedPath: {
            mevLoss: plan.costBreakdown.totalMevExposure,
            gasCost: plan.costBreakdown.totalUserGas,
            bridgeCost: plan.costBreakdown.totalBridgeFees,
            privateRelayCost: 0,
            timingRisk: 0,
            totalCost: plan.costBreakdown.totalCost,
            description: plan.reasoning,
          },
          winner: execution.strategyType === "DIRECT" ? "DIRECT_SWAP" :
                  execution.strategyType === "PRIVATE" ? "PRIVATE_RELAY" : "OPTIMIZED_PATH",
          recommendation: plan.reasoning,
        }
      }
    }

    // ── Try to extract detailed comparison from the optimizer result ──
    // The optimizer's OptimizedPlan has a .comparison field — we need to
    // thread it through. The decision engine's `optimize()` call returns it.
    // We'll attach it from the strategy if available.
    const optimizerComparison = (strategy as any)._optimizerResult?.comparison ?? null
    const optimizerCosts = (strategy as any)._optimizerResult?.costs ?? null

    return {
      input: {
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        amountIn: intent.amountIn.toString(),
        chainId: intent.chainId,
      },
      simulation: {
        risk: sim.risk,
        adjustedRisk: sim.adjustedRisk,
        estimatedLossPercent: Number(sim.lossPercent.toFixed(3)),
        estimatedLossUsd: Number(sim.estimatedLossUsd.toFixed(2)),
        attackViable: sim.attackViable,
        attackerProfitUsd: Number(sim.attackerProfitUsd.toFixed(2)),
        sandwichGasCostUsd: Number(sim.gasData.sandwichGasCostUsd.toFixed(4)),
        safeChunkThresholdUsd: Number(sim.safeChunkThresholdUsd.toFixed(2)),
        optimalFrontrunEth: Number(sim.optimalFrontrunRaw.toString()) / 1e18,
        cleanOutputUsd: Number(
          (Number(sim.cleanOutputRaw) / 10 ** sim.outDecimals).toFixed(2)
        ),
        attackedOutputUsd: Number(
          (Number(sim.attackedOutputRaw) / 10 ** sim.outDecimals).toFixed(2)
        ),
        poolAddress: sim.poolAddress,
        poolDepthUsd: Number(sim.poolDepthUsd.toFixed(2)),
        tradeToPoolRatio: Number((sim.tradeToPoolRatio * 100).toFixed(4)),
        isShallowPool: sim.isShallowPool,
        ethPriceUsd: Number(sim.ethPriceUsd.toFixed(2)),
        gasData: {
          gasPriceGwei: Number((Number(sim.gasData.gasPriceWei) / 1e9).toFixed(4)),
          sandwichGasCostUsd: Number(sim.gasData.sandwichGasCostUsd.toFixed(4)),
        },
        poolThreat: {
          sandwichRate: sim.poolThreat.sandwichRate,
          avgExcessSlippage: sim.poolThreat.avgExcessSlippagePercent,
          totalMevExtracted: sim.poolThreat.totalMevExtractedUsd,
          analyzedSwaps: sim.poolThreat.analyzedSwaps,
          sandwichCount: sim.poolThreat.sandwichCount,
          minAttackedSizeUsd: sim.poolThreat.minAttackedSizeUsd,
          maxAttackedSizeUsd: sim.poolThreat.maxAttackedSizeUsd,
          threatLevel: sim.poolThreat.threatLevel,
        },
        mevTemperature: null as any, // Will be populated if available
      },
      tradeSizeUsd: Number(tradeSizeUsd.toFixed(2)),
      execution: {
        strategyType: execution.strategyType,
        reasoning: execution.reasoning,
        optimizationStats: execution.optimizationStats || null,
        comparison: optimizerComparison ?? comparison ?? null,
        costs: optimizerCosts ?? null,
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