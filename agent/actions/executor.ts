import { Strategy } from "../reasoning/decisionEngine"
import { SwapIntent } from "../core/types"
import { SandwichSimulation } from "../perception/simulator"
import { buildSplitPlan, SplitResult } from "./splitter"

export interface ExecutionResult {
  strategyType: string
  reasoning: string
  splitResult: SplitResult | null
}

export async function execute(
  strategy: Strategy,
  intent: SwapIntent,
  sim: SandwichSimulation
): Promise<ExecutionResult> {
  console.log(`\n⚙️ Executing: ${strategy.type}`)
  console.log(`📋 ${strategy.reasoning}`)

  switch (strategy.type) {
    case "DIRECT":
      console.log("→ Public mempool, no protection")
      return { strategyType: "DIRECT", reasoning: strategy.reasoning, splitResult: null }

    case "MEV_ROUTE":
      console.log("→ Routing through safer pools")
      return { strategyType: "MEV_ROUTE", reasoning: strategy.reasoning, splitResult: null }

    case "SPLIT": {
      console.log(`→ Building split plan: ${strategy.plan.count} chunks`)
      const splitResult = await buildSplitPlan(intent, strategy.plan, sim)
      return { strategyType: "SPLIT", reasoning: strategy.reasoning, splitResult }
    }

    case "PRIVATE":
      console.log("→ Private relay submission")
      return { strategyType: "PRIVATE", reasoning: strategy.reasoning, splitResult: null }

    case "FULL_SHIELD": {
      console.log(`→ FULL SHIELD: ${strategy.plan.count} chunks + private + cross-chain`)
      const splitResult = await buildSplitPlan(intent, strategy.plan, sim)
      return { strategyType: "FULL_SHIELD", reasoning: strategy.reasoning, splitResult }
    }
  }
}