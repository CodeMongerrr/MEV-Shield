import { Strategy } from "../reasoning/decisionEngine"
import { SwapIntent } from "../core/types"
import { SandwichSimulation } from "../perception/simulator"
import { buildSplitPlan, SplitResult } from "./splitter"
import { buildPrivateTx, PrivateTxPlan } from "./privateTx"

export interface ExecutionResult {
  strategyType: string
  reasoning: string
  splitResult: SplitResult | null
  privateTxPlan: PrivateTxPlan | null
}

export async function execute(
  strategy: Strategy,
  intent: SwapIntent,
  sim: SandwichSimulation
): Promise<ExecutionResult> {
  console.log(`\n⚙️ Executing: ${strategy.type}`)
  console.log(`📋 ${strategy.reasoning}`)

  const amountIn = BigInt(intent.amountIn)
  // Default min output: 0.5% slippage from clean output
  const defaultMinOut = (sim.cleanOutputRaw * 9950n) / 10000n

  switch (strategy.type) {
    case "DIRECT":
      console.log("→ Public mempool, no protection")
      return { strategyType: "DIRECT", reasoning: strategy.reasoning, splitResult: null, privateTxPlan: null }

    case "MEV_ROUTE":
      console.log("→ Routing through safer pools")
      return { strategyType: "MEV_ROUTE", reasoning: strategy.reasoning, splitResult: null, privateTxPlan: null }

    case "SPLIT": {
      console.log(`→ Building split plan: ${strategy.plan.count} chunks`)
      const splitResult = await buildSplitPlan(intent, strategy.plan, sim)
      return { strategyType: "SPLIT", reasoning: strategy.reasoning, splitResult, privateTxPlan: null }
    }

    case "PRIVATE": {
      console.log("→ Building private relay submission")
      const privateTxPlan = await buildPrivateTx(intent, sim, amountIn, defaultMinOut)

      // If private relay isn't worth the priority fee, fall back to split
      if (!privateTxPlan.economics.worthIt) {
        console.log("⚠️ Private relay not economical, falling back to split")
        const fallbackPlan = { count: 3, sizes: [40, 35, 25], crossChain: false, reasoning: "Fallback from uneconomical private relay" }
        const splitResult = await buildSplitPlan(intent, fallbackPlan, sim)
        return { strategyType: "SPLIT_FALLBACK", reasoning: privateTxPlan.economics.reasoning, splitResult, privateTxPlan }
      }

      return { strategyType: "PRIVATE", reasoning: strategy.reasoning, splitResult: null, privateTxPlan }
    }

    case "FULL_SHIELD": {
      console.log(`→ FULL SHIELD: split + private + cross-chain`)
      // Split first
      const splitResult = await buildSplitPlan(intent, strategy.plan, sim)

      // Build private tx for any chunks that are still unsafe
      const unsafeChunks = splitResult.chunks.filter((c) => !c.safeTx)
      let privateTxPlan: PrivateTxPlan | null = null

      if (unsafeChunks.length > 0) {
        // Build private relay plan for the largest unsafe chunk
        const largest = unsafeChunks.reduce((a, b) => (a.amountIn > b.amountIn ? a : b))
        const chunkMinOut = (largest.expectedOut * 9950n) / 10000n
        privateTxPlan = await buildPrivateTx(intent, sim, largest.amountIn, chunkMinOut)
        console.log(`🔒 ${unsafeChunks.length} unsafe chunks — largest routed through private relay`)
      }

      return { strategyType: "FULL_SHIELD", reasoning: strategy.reasoning, splitResult, privateTxPlan }
    }
  }
}