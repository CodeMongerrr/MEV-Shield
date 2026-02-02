import { SimulationResult, UserPolicy } from "../core/types"

export type Strategy =
  | { type: "DIRECT" }
  | { type: "SPLIT"; chunks: number }
  | { type: "PRIVATE" }
  | { type: "FULL_SHIELD" }

export function decide(sim: SimulationResult, policy: UserPolicy): Strategy {
  if (sim.risk === "LOW") return { type: "DIRECT" }

  if (sim.risk === "MEDIUM" && sim.estimatedLossUsd < policy.privateThresholdUsd)
    return { type: "SPLIT", chunks: 2 }

  if (sim.risk === "HIGH") return { type: "SPLIT", chunks: 3 }

  return { type: "FULL_SHIELD" }
}