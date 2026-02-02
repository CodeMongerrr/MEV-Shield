import { SwapIntent } from "./types"
import { simulate } from "../perception/simulator"
import { fetchUserPolicy } from "../perception/ens"
import { decide } from "../reasoning/decisionEngine"
import { execute } from "../actions/executor"

export class MEVShieldAgent {
  async handleSwap(intent: SwapIntent) {
    console.log("🛡 Agent received swap intent:", intent.tokenIn, "→", intent.tokenOut)

    const policy = await fetchUserPolicy(intent.user)
    const sim = await simulate(intent)

    const tradeSizeUsd = sim.cleanOutputRaw > 0n
      ? Number(sim.cleanOutputRaw) / 10 ** sim.outDecimals
      : 0

    const strategy = decide(sim, policy, tradeSizeUsd)
    const execution = await execute(strategy, intent, sim)

    // Serialize bigints for JSON response
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

    return {
      input: {
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        amountIn: intent.amountIn.toString(),
        chainId: intent.chainId,
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
      },
      policy,
    }
  }
}