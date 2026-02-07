/**
 * MEV SHIELD - CALCULUS-BASED CHUNK OPTIMIZER v3
 * 
 * MAJOR CHANGES FROM v2:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 1. HARD CAP: Maximum 10 chunks (unless trade > $1M, then max 20)
 * 2. PROPER GAS MODELING: Each chunk pays its own swap gas fee (n chunks = n × gas)
 * 3. PRIVATE RELAY COMPARISON: Always shows cost of single private tx as baseline
 * 4. DETAILED LOGGING: Every price fetch, iteration, and cost component is logged
 * 5. FINAL COMPARISON TABLE: Shows single public, single private, vs optimal chunking
 * 6. NO OVER-CHUNKING: Algorithm considers cumulative gas costs properly
 * 
 * Cost Model:
 *   C(n) = Σ_i [ MEV_i(chunk_i) + SwapGas_i ] + BridgeCosts + TimingRisk
 */

import { SandwichSimulation } from "../perception/simulator"
import { UserPolicy } from "../core/types"
import { chainClients, getAvailableChains, publicClient } from "../core/config"
import { getLiFiQuote, CHAIN_IDS, getTokenOnChain } from "../actions/lifiRouter"
import { fetchPoolMEVProfile, PoolMEVProfile } from "../perception/mevTemperature"

// ============================================================================
// TYPES
// ============================================================================

export interface ChainPricing {
  chain: string
  chainId: number
  available: boolean
  gasPrice: bigint
  gasPriceGwei: number
  swapGasCostUsd: number
  sandwichGasCostUsd: number
  safeThresholdUsd: number
}

export interface BridgeCost {
  fromChain: string
  toChain: string
  feesUsd: number
  gasUsd: number
  totalUsd: number
  executionTime: number
  available: boolean
}

export interface PrivateRelayCost {
  priorityFeeGwei: number
  baseFeeGwei: number
  estimatedTipUsd: number
  totalSwapCostUsd: number
}

export interface LiveMarketData {
  ethPriceUsd: number
  timestamp: number
  chains: ChainPricing[]
  bridgeCosts: BridgeCost[]
  privateRelayCost: PrivateRelayCost
  mevProfile?: PoolMEVProfile
}

export interface ChunkSpec {
  index: number
  sizePercent: number
  amountUsd: number
  chain: string
  usePrivateRelay: boolean
  mevExposure: number
  gasCost: number
  bridgeCost: number
  privateRelayCost: number
  totalCost: number
  isSafe: boolean
}

export interface CostBreakdown {
  mevExposure: number
  gasFees: number
  bridgeFees: number
  privateRelayFees: number
  timingRisk: number
  totalCost: number
  unprotectedCost: number
  savings: number
  savingsPercent: number
}

export interface StrategyComparison {
  singlePublic: { mevLoss: number; gasCost: number; totalCost: number; description: string }
  singlePrivate: { mevLoss: number; gasCost: number; privateTip: number; totalCost: number; description: string }
  optimalChunking: { chunks: number; mevLoss: number; gasCost: number; bridgeCost: number; timingRisk: number; totalCost: number; description: string }
  winner: "SINGLE_PUBLIC" | "SINGLE_PRIVATE" | "CHUNKING"
  recommendation: string
}

export interface OptimizedPlan {
  chunkCount: number
  chunks: ChunkSpec[]
  costs: CostBreakdown
  comparison: StrategyComparison
  mathematicalOptimum: number
  reasoning: string
  logs: string[]
}

// Backward compatibility types
export interface ChunkPlan {
  count: number
  sizes: number[]
  chains: string[]
  crossChain: boolean
  reasoning: string
  economics: ChunkEconomics[]
  totalCost: number
  costBreakdown: {
    totalMevExposure: number
    totalUserGas: number
    totalBridgeFees: number
    totalCost: number
    unprotectedCost: number
    savings: number
    savingsPercent: number
  }
  blockDelays?: number[]
}

export interface ChunkEconomics {
  index: number
  sizePercent: number
  valueUsd: number
  chain: string
  mevExposureUsd: number
  userGasCostUsd: number
  bridgeCostUsd: number
  totalCostUsd: number
  safe: boolean
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_CHUNKS_NORMAL = 10
const MAX_CHUNKS_WHALE = 20
const WHALE_THRESHOLD_USD = 1_000_000
const MEV_EXTRACTION_EFFICIENCY = 0.85
const BOT_PROFIT_MARGIN = 1.5
const PRICE_VOLATILITY_PER_BLOCK = 0.0002
const MIN_PRIVATE_TIP_USD = 0.50
const PRIVATE_RELAY_GAS_UNITS = 180000

// ============================================================================
// LOGGING
// ============================================================================

class Logger {
  private logs: string[] = []
  log(msg: string) { console.log(msg); this.logs.push(msg) }
  section(t: string) { this.log(""); this.log("═".repeat(70)); this.log(`  ${t}`); this.log("═".repeat(70)) }
  subsection(t: string) { this.log(""); this.log(`── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`) }
  table(rows: [string, string][]) { const m = Math.max(...rows.map(([k]) => k.length)); rows.forEach(([k, v]) => this.log(`  ${k.padEnd(m + 2)} ${v}`)) }
  getLogs() { return this.logs }
}

function getSwapGasUnits(chain: string): number {
  return { ethereum: 180000, arbitrum: 700000, base: 200000, optimism: 250000, polygon: 200000 }[chain] || 200000
}

export async function fetchLiFiPriorityFee(chainId: number): Promise<bigint | null> {
  try {
    const res = await fetch(`https://li.quest/v1/gas/prices/${chainId}`)

    if (!res.ok) return null

    const data = await res.json()

    // choose landing tier (fast is realistic for protected tx)
    // values are wei per gas unit
    const priorityFeeWei = BigInt(data.fast)
    const baseFeeWei = BigInt(data.base)
    return priorityFeeWei
  } catch {
    return null
  }
}
