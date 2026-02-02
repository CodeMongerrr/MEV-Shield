import { SwapIntent } from "./types"
import { simulate } from "../perception/simulator"
import { fetchUserPolicy } from "../perception/ens"
import { decide } from "../reasoning/decisionEngine"
import { execute } from "../actions/executor"

export class MEVShieldAgent {
  async handleSwap(intent: SwapIntent) {
    console.log("🛡 Agent received swap intent")

    const policy = await fetchUserPolicy(intent.user)
    const sim = await simulate(intent)
    const strategy = decide(sim, policy)

    console.log("📊 Risk:", sim.risk, "| Loss:", sim.lossPercent.toFixed(2), "%")
    console.log("🧠 Strategy decided:", strategy.type)

    await execute(strategy, intent)

    return { sim, strategy }
  }
}