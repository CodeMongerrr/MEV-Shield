import { SwapIntent } from "./types"
import { simulate } from "../perception/simulator"
import { fetchUserPolicy } from "../perception/ens"
import { analyzePoolHistory } from "../perception/poolHistory/analyzer"
import { decide } from "../reasoning/decisionEngine"
import { execute } from "../actions/executor"

export class MEVShieldAgent {
  async handleSwap(intent: SwapIntent & { poolAddress?: string }) {
    console.log("🛡 Agent received swap intent:", intent.tokenIn, "→", intent.tokenOut)

    const policy = await fetchUserPolicy(intent.user)
    const sim = await simulate(intent)

    // Pool history analysis
    let poolAnalysis = null
    if (intent.poolAddress) {
      console.log("📊 Analyzing pool history for:", intent.poolAddress)
      poolAnalysis = await analyzePoolHistory(intent.poolAddress, 30)
      console.log(`   Toxicity: ${poolAnalysis.toxicityScore} | Attack Rate: ${(poolAnalysis.overallAttackRate * 100).toFixed(1)}% | Searchers: ${poolAnalysis.uniqueSearchers}`)
    }

    const tradeSizeUsd = sim.cleanOutputRaw > 0n
      ? Number(sim.cleanOutputRaw) / 10 ** sim.outDecimals
      : 0

    const strategy = await decide(sim, policy, tradeSizeUsd)

    console.log("🧠 Strategy:", JSON.stringify(strategy, null, 2))

    const execution = await execute(strategy, intent, sim)

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

    const serializePoolAnalysis = poolAnalysis
      ? {
          poolAddress: poolAnalysis.poolAddress,
          totalTransactions: poolAnalysis.totalTransactions,
          toxicityScore: poolAnalysis.toxicityScore,
          overallAttackRate: Number((poolAnalysis.overallAttackRate * 100).toFixed(2)),
          sandwichCount: poolAnalysis.sandwichAttacks.length,
          bucketStats: {
            LOW: {
              totalSwaps: poolAnalysis.bucketStats.LOW.totalSwaps,
              sandwichedSwaps: poolAnalysis.bucketStats.LOW.sandwichedSwaps,
              attackRate: Number((poolAnalysis.bucketStats.LOW.attackRate * 100).toFixed(2)),
              avgExtractionPercent: Number(poolAnalysis.bucketStats.LOW.avgExtractionPercent.toFixed(3)),
            },
            MEDIUM: {
              totalSwaps: poolAnalysis.bucketStats.MEDIUM.totalSwaps,
              sandwichedSwaps: poolAnalysis.bucketStats.MEDIUM.sandwichedSwaps,
              attackRate: Number((poolAnalysis.bucketStats.MEDIUM.attackRate * 100).toFixed(2)),
              avgExtractionPercent: Number(poolAnalysis.bucketStats.MEDIUM.avgExtractionPercent.toFixed(3)),
            },
            HIGH: {
              totalSwaps: poolAnalysis.bucketStats.HIGH.totalSwaps,
              sandwichedSwaps: poolAnalysis.bucketStats.HIGH.sandwichedSwaps,
              attackRate: Number((poolAnalysis.bucketStats.HIGH.attackRate * 100).toFixed(2)),
              avgExtractionPercent: Number(poolAnalysis.bucketStats.HIGH.avgExtractionPercent.toFixed(3)),
            },
          },
          uniqueSearchers: poolAnalysis.uniqueSearchers,
          topSearchers: poolAnalysis.topSearchers.map((s) => ({
            address: s.address,
            attackCount: s.attackCount,
            totalExtractedUsd: Number(s.totalExtractedUsd.toFixed(2)),
          })),
        }
      : null

    return {
      input: {
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        amountIn: intent.amountIn.toString(),
        chainId: intent.chainId,
        poolAddress: intent.poolAddress || null,
      },
      simulation: {
        risk: sim.risk,
        estimatedLossPercent: Number(sim.lossPercent.toFixed(3)),
        estimatedLossUsd: Number(sim.estimatedLossUsd.toFixed(2)),
        attackViable: sim.attackViable,
        attackerProfitUsd: Number(sim.attackerProfitUsd.toFixed(2)),
        sandwichGasCostUsd: Number(sim.gasData.sandwichGasCostUsd.toFixed(2)),
        safeChunkThresholdUsd: Number(sim.safeChunkThresholdUsd.toFixed(2)),
      },
      poolHistory: serializePoolAnalysis,
      tradeSizeUsd: Number(tradeSizeUsd.toFixed(2)),
      execution: {
        strategyType: execution.strategyType,
        reasoning: execution.reasoning,
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