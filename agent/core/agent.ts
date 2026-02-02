import { SwapIntent } from "./types"
import { simulate, SandwichSimulation } from "../perception/simulator"
import { fetchUserPolicy } from "../perception/ens"
import { decide } from "../reasoning/decisionEngine"
import { execute } from "../actions/executor"

export class MEVShieldAgent {
  async handleSwap(intent: SwapIntent) {
    console.log("🛡 Agent received swap intent:", intent.tokenIn, "→", intent.tokenOut)

    const policy = await fetchUserPolicy(intent.user)
    const sim = await simulate(intent)

    // Trade size from clean output
    const tradeSizeUsd = sim.cleanOutputRaw > 0n
      ? Number(sim.cleanOutputRaw) / 10 ** sim.outDecimals
      : 0

    const strategy = decide(sim, policy, tradeSizeUsd)

    console.log("🧠 Strategy:", JSON.stringify(strategy, null, 2))

    await execute(strategy, intent)

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
      strategy,
      policy,
    }
  }
}