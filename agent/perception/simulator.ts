import { SimulationResult, SwapIntent } from "../core/types"

export async function simulate(intent: SwapIntent): Promise<SimulationResult> {
  // TEMP FAKE LOGIC — replace with real fork sim later
  const lossPercent = Math.random() * 3

  let risk: SimulationResult["risk"] = "LOW"
  if (lossPercent > 2) risk = "CRITICAL"
  else if (lossPercent > 0.5) risk = "HIGH"
  else if (lossPercent > 0.1) risk = "MEDIUM"

  return {
    lossPercent,
    estimatedLossUsd: lossPercent * 100,
    risk,
  }
}