export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"

export interface SwapIntent {
  user: string
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  chainId: number
}

export interface SimulationResult {
  lossPercent: number
  estimatedLossUsd: number
  risk: RiskLevel
}

export interface UserPolicy {
  privateThresholdUsd: number
  splitEnabled: boolean
  riskProfile: "conservative" | "balanced" | "aggressive"
}