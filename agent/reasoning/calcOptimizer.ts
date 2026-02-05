/**
 * CALCULUS-BASED MEV CHUNK OPTIMIZER (ENHANCED)
 * 
 * Improved Mathematical Model:
 * 
 * Total Cost C(n) = MEV(n, poolState) + Gas(n, size) + Bridge(chains) + Private(size) + Risk(n)
 * 
 * Key Improvements:
 *   1. MEV has profitability threshold - chunks below ~$500-1000 can't be profitably attacked
 *   2. Pool state degrades with each chunk - slippage compounds
 *   3. Bridge costs are amortized per chain (pay once to enter a chain)
 *   4. Private relay is a global strategy alternative, not per-chunk modifier
 *   5. Gas costs are size and route dependent
 *   6. Timing risk increases with chunk count
 *   7. Discrete strategy comparison before continuous optimization
 * 
 * Strategy Types:
 *   - Single Private: One protected swap, zero MEV, higher tip
 *   - Single Public: Accept full MEV, minimize gas
 *   - Public Chunking: Split to reduce MEV, threshold behavior
 *   - Cross-Chain: Route through L2s with amortized bridge cost
 */

import { SandwichSimulation } from "../perception/simulator"
import { UserPolicy } from "../core/types"
import { chainClients, getAvailableChains, publicClient } from "../core/config"
import { getLiFiQuote, CHAIN_IDS, getTokenOnChain } from "../actions/lifiRouter"

// ============================================================================
// TYPES
// ============================================================================

export interface LiveMarketData {
  ethPriceUsd: number
  timestamp: number
  chains: ChainPricing[]
  bridgeCosts: BridgeCost[]
  privateRelayCost: PrivateRelayCost
}

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
  estimatedCostUsd: number
  baseFeeGwei: number
}

export interface OptimizedPlan {
  chunkCount: number
  chunks: ChunkSpec[]
  costs: CostAnalysis
  mathematicalOptimum: number
  searchPath: SearchStep[]
  reasoning: string
}

export interface ChunkSpec {
  index: number
  sizePercent: number
  amountWei: bigint
  amountUsd: number
  chain: string
  usePrivateRelay: boolean
  mevExposure: number
  gasCost: number
  bridgeCost: number
  privateRelayCost: number
  totalCost: number
  isSafe: boolean
  blockDelay: number
}

export interface CostAnalysis {
  mevExposure: number
  gasFees: number
  bridgeFees: number
  privateRelayFees: number
  totalCost: number
  unprotectedCost: number
  savings: number
  savingsPercent: number
  costPerChunk: number
  marginalCostAtOptimum: number
}

export interface SearchStep {
  n: number
  cost: number
  derivative: number
  improvement: number
}

// For backward compatibility with existing ChunkPlan interface
export interface ChunkPlan {
  count: number
  sizes: number[]
  chains: string[]
  blockDelays: number[]
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
  blockDelay: number
}

// ============================================================================
// POOL STATE SIMULATION
// ============================================================================

interface PoolState {
  liquidityUsd: number
  reserve0: number
  reserve1: number
  priceImpactAccumulated: number
}

// MEV extraction efficiency (how much of available MEV bots capture)
const MEV_EXTRACTION_EFFICIENCY = 0.85

// Minimum profit margin bots need over gas costs
const BOT_PROFIT_MARGIN = 1.5

// Price volatility per block (used for timing risk)
// ~0.1% per block for major pairs, but we only care about adverse moves
// Using a much smaller figure since this is already captured in slippage
const BLOCK_TIME_SECONDS = 12
const PRICE_VOLATILITY_PER_BLOCK = 0.0002 // 0.02% per block, conservative

// Coordination overhead threshold - beyond this, complexity adds cost
const COORDINATION_OVERHEAD_THRESHOLD = 10
const COORDINATION_COST_PER_EXTRA_CHUNK = 0.50 // $0.50 per chunk beyond threshold

// ============================================================================
// LIVE PRICING FETCHER
// ============================================================================

export async function fetchLiveMarketData(
  tokenIn: string,
  tokenOut: string,
  tradeAmountWei: bigint,
  ethPriceUsd: number
): Promise<LiveMarketData> {
  console.log(`\n📡 FETCHING LIVE MARKET DATA`)

  const timestamp = Date.now()
  const chains: ChainPricing[] = []
  const bridgeCosts: BridgeCost[] = []

  const availableChains = getAvailableChains()
  console.log(`   ⛓️  Fetching gas from ${availableChains.length} chains...`)

  for (const chainName of availableChains) {
    const entry = chainClients[chainName]
    if (!entry) {
      chains.push(createUnavailableChain(chainName))
      continue
    }

    try {
      const gasPrice = await entry.client.getGasPrice()
      const gasPriceGwei = Number(gasPrice) / 1e9

      const swapGasUnits = getBaseSwapGasUnits(chainName)
      const sandwichGasUnits = swapGasUnits * 2 + 50000

      const swapGasCostWei = BigInt(swapGasUnits) * gasPrice
      const sandwichGasCostWei = BigInt(sandwichGasUnits) * gasPrice

      const swapGasCostUsd = (Number(swapGasCostWei) / 1e18) * ethPriceUsd
      const sandwichGasCostUsd = (Number(sandwichGasCostWei) / 1e18) * ethPriceUsd
      
      // MEV threshold: bots need profit margin over their gas costs
      const safeThresholdUsd = sandwichGasCostUsd * BOT_PROFIT_MARGIN

      chains.push({
        chain: chainName,
        chainId: entry.chainId,
        available: true,
        gasPrice,
        gasPriceGwei,
        swapGasCostUsd,
        sandwichGasCostUsd,
        safeThresholdUsd,
      })

      console.log(
        `   ⛓️  ${chainName.padEnd(10)} | gas: ${gasPriceGwei.toFixed(2).padStart(6)} gwei | ` +
        `swap: $${swapGasCostUsd.toFixed(3).padStart(6)} | safe: $${safeThresholdUsd.toFixed(2)}`
      )
    } catch (err) {
      console.log(`   ⛓️  ${chainName}: ❌ RPC failed`)
      chains.push(createUnavailableChain(chainName))
    }
  }

  // Fetch bridge costs from LI.FI
  console.log(`\n   🌉 Fetching bridge costs...`)
  const bridgeTestAmount = tradeAmountWei / 10n > 0n ? tradeAmountWei / 10n : 10n ** 17n

  for (const fromChain of availableChains) {
    for (const toChain of availableChains) {
      if (fromChain === toChain) continue

      const cost = await fetchBridgeCost(fromChain, toChain, tokenIn, tokenOut, bridgeTestAmount)
      bridgeCosts.push(cost)

      if (cost.available) {
        console.log(`   🌉 ${fromChain} → ${toChain}: $${cost.totalUsd.toFixed(2)}`)
      }
    }
  }

  // Calculate private relay cost
  const ethChain = chains.find(c => c.chain === "ethereum")
  const privateRelayCost = await calculatePrivateRelayCost(ethChain, ethPriceUsd)

  console.log(`   🔒 Private relay: $${privateRelayCost.estimatedCostUsd.toFixed(4)}/tx`)

  return { ethPriceUsd, timestamp, chains, bridgeCosts, privateRelayCost }
}

function createUnavailableChain(chainName: string): ChainPricing {
  return {
    chain: chainName,
    chainId: 0,
    available: false,
    gasPrice: 0n,
    gasPriceGwei: 0,
    swapGasCostUsd: Infinity,
    sandwichGasCostUsd: 0,
    safeThresholdUsd: 0,
  }
}

function getBaseSwapGasUnits(chain: string): number {
  const gasUnits: Record<string, number> = {
    ethereum: 180000,
    arbitrum: 700000,
    base: 200000,
    optimism: 250000,
    polygon: 200000,
  }
  return gasUnits[chain] || 200000
}

/**
 * Estimate gas cost with size and route complexity adjustments
 */
function estimateSwapGas(
  chunkSizeUsd: number,
  chainPricing: ChainPricing,
  ethPriceUsd: number
): number {
  const baseGas = getBaseSwapGasUnits(chainPricing.chain)
  
  // Larger chunks may require more complex routing to minimize slippage
  let complexityMultiplier = 1.0
  if (chunkSizeUsd > 50000) {
    complexityMultiplier = 1.5 // Multi-hop routes for very large swaps
  } else if (chunkSizeUsd > 10000) {
    complexityMultiplier = 1.3 // Moderately complex routing
  }
  
  const totalGasUnits = baseGas * complexityMultiplier
  const gasCostWei = BigInt(Math.floor(totalGasUnits)) * chainPricing.gasPrice
  return (Number(gasCostWei) / 1e18) * ethPriceUsd
}

async function fetchBridgeCost(
  fromChain: string,
  toChain: string,
  tokenIn: string,
  tokenOut: string,
  testAmount: bigint
): Promise<BridgeCost> {
  const fromChainId = CHAIN_IDS[fromChain]
  const toChainId = CHAIN_IDS[toChain]

  if (!fromChainId || !toChainId) {
    return { fromChain, toChain, feesUsd: Infinity, gasUsd: Infinity, totalUsd: Infinity, executionTime: Infinity, available: false }
  }

  const toTokenMapped = getTokenOnChain(tokenOut, fromChain, toChain)
  if (!toTokenMapped) {
    return { fromChain, toChain, feesUsd: Infinity, gasUsd: Infinity, totalUsd: Infinity, executionTime: Infinity, available: false }
  }

  try {
    const quote = await getLiFiQuote({
      fromChain: fromChainId,
      toChain: toChainId,
      fromToken: tokenIn,
      toToken: toTokenMapped,
      fromAmount: testAmount.toString(),
      fromAddress: "0x0000000000000000000000000000000000000001",
    })

    if (quote) {
      const feesUsd = quote.estimate.feeCosts.reduce((sum, f) => sum + parseFloat(f.amountUSD || "0"), 0)
      const gasUsd = quote.estimate.gasCosts.reduce((sum, g) => sum + parseFloat(g.amountUSD || "0"), 0)
      return { fromChain, toChain, feesUsd, gasUsd, totalUsd: feesUsd + gasUsd, executionTime: quote.estimate.executionDuration, available: true }
    }
  } catch {}

  return { fromChain, toChain, feesUsd: Infinity, gasUsd: Infinity, totalUsd: Infinity, executionTime: Infinity, available: false }
}

async function calculatePrivateRelayCost(ethChain: ChainPricing | undefined, ethPriceUsd: number): Promise<PrivateRelayCost> {
  if (!ethChain || !ethChain.available) {
    return { priorityFeeGwei: 0, estimatedCostUsd: Infinity, baseFeeGwei: 0 }
  }

  try {
    const priorityFee = await publicClient.request({ method: "eth_maxPriorityFeePerGas" as any })
    const priorityFeeGwei = Number(priorityFee) / 1e9
    const privateRelayGasWei = BigInt(Math.floor(priorityFeeGwei * 1e9)) * 200000n
    const estimatedCostUsd = (Number(privateRelayGasWei) / 1e18) * ethPriceUsd

    return { priorityFeeGwei, estimatedCostUsd, baseFeeGwei: ethChain.gasPriceGwei }
  } catch {
    const priorityFeeGwei = ethChain.gasPriceGwei * 0.1
    const privateRelayGasWei = BigInt(Math.floor(priorityFeeGwei * 1e9)) * 200000n
    const estimatedCostUsd = (Number(privateRelayGasWei) / 1e18) * ethPriceUsd

    return { priorityFeeGwei, estimatedCostUsd, baseFeeGwei: ethChain.gasPriceGwei }
  }
}

// Minimum tip required for private relay inclusion (builders won't process for less)
const MIN_PRIVATE_RELAY_TIP_USD = 0.50

/**
 * Size-dependent private relay cost
 * 
 * Private relay cost is based on:
 * 1. Network congestion (base priority fee)
 * 2. Trade size (larger trades need higher tips for priority)
 * 
 * Key insight: Builders compare total block value, not "percentage of user savings".
 * Hidden MEV helps builders include you, but does NOT increase what you must pay.
 * The tip is about getting inclusion, not about paying for MEV protection.
 */
function estimateSizeAdjustedPrivateRelayCost(
  tradeSizeUsd: number,
  basePrivateRelayCost: PrivateRelayCost,
  ethPriceUsd: number
): number {
  // Size multiplier: larger trades pay more for priority inclusion
  let sizeMultiplier = 1.0
  if (tradeSizeUsd > 100000) {
    sizeMultiplier = 2.5
  } else if (tradeSizeUsd > 50000) {
    sizeMultiplier = 2.0
  } else if (tradeSizeUsd > 10000) {
    sizeMultiplier = 1.5
  }
  
  // Priority fee based on network conditions, scaled by size
  const adjustedPriorityFeeGwei = Math.max(
    basePrivateRelayCost.priorityFeeGwei * sizeMultiplier,
    1.0  // Minimum 1 gwei priority fee
  )
  const priorityFeeWei = BigInt(Math.floor(adjustedPriorityFeeGwei * 1e9))
  const estimatedGas = 180000n
  
  const congestionTip = (Number(priorityFeeWei * estimatedGas) / 1e18) * ethPriceUsd
  
  // Return the higher of congestion-based tip or minimum viable tip
  return Math.max(congestionTip, MIN_PRIVATE_RELAY_TIP_USD)
}

// ============================================================================
// IMPROVED MEV MODEL WITH THRESHOLD AND POOL STATE
// ============================================================================

/**
 * Initialize pool state for simulation
 * In practice, this would come from on-chain data
 */
function initializePoolState(tradeSizeUsd: number, fullMev: number): PoolState {
  // Estimate pool liquidity from MEV (MEV is roughly proportional to trade^2 / liquidity)
  // If MEV = k * trade^2 / liquidity, then liquidity ≈ k * trade^2 / MEV
  const estimatedLiquidity = fullMev > 0 
    ? Math.max(tradeSizeUsd * 10, (tradeSizeUsd * tradeSizeUsd) / (fullMev * 10))
    : tradeSizeUsd * 100
  
  return {
    liquidityUsd: estimatedLiquidity,
    reserve0: estimatedLiquidity / 2,
    reserve1: estimatedLiquidity / 2,
    priceImpactAccumulated: 0,
  }
}

/**
 * Calculate MEV for a single chunk with threshold behavior
 * - Below profitability threshold: MEV ≈ 0 (bots won't attack)
 * - Above threshold: MEV proportional to slippage (quadratic in size for constant product)
 */
function calculateChunkMevWithThreshold(
  chunkSizeUsd: number,
  poolState: PoolState,
  chainPricing: ChainPricing
): number {
  // MEV profitability threshold: bots need their gas cost * margin
  const profitabilityThreshold = chainPricing.sandwichGasCostUsd * BOT_PROFIT_MARGIN
  
  // Slippage factor: quadratic relationship in constant product pools
  // slippage ≈ (trade_size / liquidity)^1.3 (slightly super-linear due to price impact)
  const slippageFactor = Math.pow(chunkSizeUsd / poolState.liquidityUsd, 1.3)
  
  // Potential extractable MEV before gas costs
  const potentialMev = chunkSizeUsd * slippageFactor * MEV_EXTRACTION_EFFICIENCY
  
  // If potential MEV is below threshold, bots won't attack
  if (potentialMev < profitabilityThreshold) {
    return 0
  }
  
  // Net MEV is what remains after bot costs (bots pass some savings to user)
  // In practice, competition means bots extract less than 100%
  return Math.max(0, potentialMev - profitabilityThreshold * 0.3)
}

/**
 * Apply swap impact to pool state
 * Simulates how reserves change after a swap
 * 
 * Key insight: Arbitrage resets pools between blocks, so price impact
 * mean-reverts rather than accumulating indefinitely.
 */
function applySwapImpact(poolState: PoolState, swapSizeUsd: number): PoolState {
  // Price impact from this swap
  const priceImpact = swapSizeUsd / poolState.liquidityUsd
  
  // Mean reversion: arbitrageurs partially reset the pool between swaps
  // ~60% of previous impact reverts before next chunk executes
  const MEAN_REVERSION = 0.6
  const newPriceImpactAccumulated = poolState.priceImpactAccumulated * (1 - MEAN_REVERSION) + priceImpact
  
  // Effective liquidity decreases as price moves away from equilibrium
  const liquidityDegradation = 1 + newPriceImpactAccumulated * 0.5
  
  // Floor: liquidity can't degrade below 50% of initial (arb keeps it bounded)
  const effectiveLiquidity = Math.max(
    poolState.liquidityUsd / liquidityDegradation,
    poolState.liquidityUsd * 0.5
  )
  
  return {
    liquidityUsd: effectiveLiquidity,
    reserve0: poolState.reserve0 * (1 - priceImpact / 2),
    reserve1: poolState.reserve1 * (1 + priceImpact / 2),
    priceImpactAccumulated: newPriceImpactAccumulated,
  }
}

/**
 * Calculate theoretical optimum with threshold-adjusted formula
 */
function calculateTheoreticalOptimum(fullMev: number, gasPerSwap: number, safeThreshold: number): number {
  if (gasPerSwap <= 0) return 1
  
  // Classic formula: n* = sqrt(M/g)
  const classicOptimum = Math.sqrt(fullMev / gasPerSwap)
  
  // Adjust for threshold: if chunks become safe before classic optimum, stop earlier
  // More chunks means smaller chunks, which may fall below threshold
  return Math.max(1, Math.min(classicOptimum, fullMev / safeThreshold))
}

function costDerivative(n: number, fullMev: number, gasPerSwap: number): number {
  return -fullMev / (n * n) + gasPerSwap
}

// ============================================================================
// AMORTIZED BRIDGE COST CALCULATION
// ============================================================================

/**
 * Calculate bridge costs with amortization
 * Pay once to enter each chain, not per chunk
 */
function calculateAmortizedBridgeCosts(
  chunks: { chain: string; amountUsd: number }[],
  marketData: LiveMarketData,
  sourceChain: string = "ethereum"
): { perChainCosts: Map<string, number>; totalBridgeCost: number } {
  const chainAmounts = new Map<string, number>()
  
  // Aggregate total amount per chain
  for (const chunk of chunks) {
    if (chunk.chain !== sourceChain) {
      const current = chainAmounts.get(chunk.chain) || 0
      chainAmounts.set(chunk.chain, current + chunk.amountUsd)
    }
  }
  
  const perChainCosts = new Map<string, number>()
  let totalBridgeCost = 0
  
  // Pay bridge cost once per chain
  for (const [chain, _totalAmount] of chainAmounts.entries()) {
    const bridgeCost = marketData.bridgeCosts.find(
      b => b.fromChain === sourceChain && b.toChain === chain && b.available
    )
    
    if (bridgeCost) {
      // Bridge cost is paid once, not per chunk
      perChainCosts.set(chain, bridgeCost.totalUsd)
      totalBridgeCost += bridgeCost.totalUsd
    }
  }
  
  return { perChainCosts, totalBridgeCost }
}

// ============================================================================
// TIMING AND COORDINATION RISK
// ============================================================================

/**
 * Calculate timing risk from extended execution window
 * 
 * Key insight: Timing risk applies to unexecuted remainder, not full notional.
 * With more chunks, each chunk's exposure window is shorter.
 * 
 * Risk ≈ (tradeSize / n) × σ × sqrt(n) = tradeSize × σ / sqrt(n)
 * 
 * So risk DECREASES with more splitting (diversification effect).
 */
function calculateTimingRisk(chunkCount: number, tradeSizeUsd: number): number {
  if (chunkCount <= 1) return 0
  
  // Risk decreases with sqrt(n) - more chunks = less timing exposure per chunk
  const volatilityRisk = tradeSizeUsd * PRICE_VOLATILITY_PER_BLOCK / Math.sqrt(chunkCount)
  
  return volatilityRisk
}

/**
 * Coordination overhead for complex multi-chunk strategies
 * Beyond a threshold, each additional chunk adds operational complexity
 */
function calculateCoordinationOverhead(chunkCount: number): number {
  if (chunkCount <= COORDINATION_OVERHEAD_THRESHOLD) {
    return 0
  }
  // Linear overhead for complexity beyond threshold
  return (chunkCount - COORDINATION_OVERHEAD_THRESHOLD) * COORDINATION_COST_PER_EXTRA_CHUNK
}

// ============================================================================
// STRATEGY EVALUATION
// ============================================================================

interface StrategyResult {
  type: "single_private" | "single_public" | "public_chunking" | "cross_chain"
  chunks: ChunkSpec[]
  costs: {
    mev: number
    gas: number
    bridge: number
    privateRelay: number
    timing: number
    coordination: number
    total: number
  }
}

/**
 * Evaluate single private swap strategy
 */
function evaluateSinglePrivateStrategy(
  tradeSizeUsd: number,
  fullMev: number,
  marketData: LiveMarketData,
  ethPriceUsd: number
): StrategyResult {
  const ethChain = marketData.chains.find(c => c.chain === "ethereum" && c.available)
  
  if (!ethChain) {
    return {
      type: "single_private",
      chunks: [],
      costs: { mev: Infinity, gas: Infinity, bridge: 0, privateRelay: Infinity, timing: 0, coordination: 0, total: Infinity }
    }
  }
  
  const gasCost = estimateSwapGas(tradeSizeUsd, ethChain, ethPriceUsd)
  const privateRelayCost = estimateSizeAdjustedPrivateRelayCost(
    tradeSizeUsd, 
    marketData.privateRelayCost, 
    ethPriceUsd
  )
  
  return {
    type: "single_private",
    chunks: [{
      index: 0,
      sizePercent: 100,
      amountWei: 0n,
      amountUsd: tradeSizeUsd,
      chain: "ethereum",
      usePrivateRelay: true,
      mevExposure: 0,
      gasCost,
      bridgeCost: 0,
      privateRelayCost,
      totalCost: gasCost + privateRelayCost,
      isSafe: true,
      blockDelay: 0,
    }],
    costs: {
      mev: 0,
      gas: gasCost,
      bridge: 0,
      privateRelay: privateRelayCost,
      timing: 0,
      coordination: 0,
      total: gasCost + privateRelayCost,
    }
  }
}

/**
 * Evaluate single public swap strategy (accept full MEV)
 */
function evaluateSinglePublicStrategy(
  tradeSizeUsd: number,
  fullMev: number,
  marketData: LiveMarketData,
  ethPriceUsd: number
): StrategyResult {
  // Find cheapest chain for single swap
  let bestChain = "ethereum"
  let bestGasCost = Infinity
  let bestBridgeCost = 0
  
  for (const chainData of marketData.chains) {
    if (!chainData.available) continue
    
    const gasCost = estimateSwapGas(tradeSizeUsd, chainData, ethPriceUsd)
    let bridgeCost = 0
    
    if (chainData.chain !== "ethereum") {
      const bridge = marketData.bridgeCosts.find(
        b => b.fromChain === "ethereum" && b.toChain === chainData.chain && b.available
      )
      if (!bridge) continue
      bridgeCost = bridge.totalUsd
    }
    
    const totalCost = gasCost + bridgeCost
    if (totalCost < bestGasCost + bestBridgeCost) {
      bestChain = chainData.chain
      bestGasCost = gasCost
      bestBridgeCost = bridgeCost
    }
  }
  
  // Cross-chain MEV reduction
  const crossChainMevFactor = bestChain === "ethereum" ? 1.0 : 0.3
  const effectiveMev = fullMev * crossChainMevFactor
  
  return {
    type: "single_public",
    chunks: [{
      index: 0,
      sizePercent: 100,
      amountWei: 0n,
      amountUsd: tradeSizeUsd,
      chain: bestChain,
      usePrivateRelay: false,
      mevExposure: effectiveMev,
      gasCost: bestGasCost,
      bridgeCost: bestBridgeCost,
      privateRelayCost: 0,
      totalCost: effectiveMev + bestGasCost + bestBridgeCost,
      isSafe: false,
      blockDelay: 0,
    }],
    costs: {
      mev: effectiveMev,
      gas: bestGasCost,
      bridge: bestBridgeCost,
      privateRelay: 0,
      timing: 0,
      coordination: 0,
      total: effectiveMev + bestGasCost + bestBridgeCost,
    }
  }
}

/**
 * Simulate sequential chunk execution with pool state tracking
 */
function simulateSequentialExecution(
  n: number,
  tradeSizeUsd: number,
  fullMev: number,
  marketData: LiveMarketData,
  ethPriceUsd: number,
  policy: UserPolicy,
  verbose: boolean = false
): {
  chunks: ChunkSpec[]
  totalMev: number
  totalGas: number
  totalBridge: number
  totalPrivate: number
  timingRisk: number
  coordinationOverhead: number
  totalCost: number
} {
  const chunkSizeUsd = tradeSizeUsd / n
  const chunks: ChunkSpec[] = []
  
  // Initialize pool state
  let poolState = initializePoolState(tradeSizeUsd, fullMev)
  
  if (verbose) {
    console.log(`\n   📊 Simulating n=${n}: chunk=$${chunkSizeUsd.toFixed(2)}, pool liquidity=$${poolState.liquidityUsd.toFixed(0)}`)
  }
  
  let totalMev = 0
  let totalGas = 0
  let totalPrivate = 0
  
  // Track chain usage for amortized bridge costs
  const chainAllocations: { chain: string; amountUsd: number }[] = []
  
  for (let i = 0; i < n; i++) {
    // Find optimal chain for this chunk given current pool state
    const optimal = findOptimalChainForChunkWithPoolState(
      chunkSizeUsd,
      poolState,
      i,
      marketData,
      ethPriceUsd,
      policy
    )
    
    chainAllocations.push({ chain: optimal.chain, amountUsd: chunkSizeUsd })
    
    totalMev += optimal.effectiveMev
    totalGas += optimal.gasCost
    totalPrivate += optimal.privateRelayCost
    
    if (verbose && i < 3) {
      console.log(`      chunk ${i}: MEV=$${optimal.effectiveMev.toFixed(4)}, gas=$${optimal.gasCost.toFixed(4)}, private=$${optimal.privateRelayCost.toFixed(4)}, safe=${optimal.isSafe}`)
    }
    
    // Update pool state after this swap
    poolState = applySwapImpact(poolState, chunkSizeUsd)
    
    const blockDelay = i === 0 ? 0 : (optimal.chain === "ethereum" ? 1 : 2)
    
    chunks.push({
      index: i,
      sizePercent: 100 / n,
      amountWei: 0n,
      amountUsd: chunkSizeUsd,
      chain: optimal.chain,
      usePrivateRelay: optimal.usePrivateRelay,
      mevExposure: optimal.effectiveMev,
      gasCost: optimal.gasCost,
      bridgeCost: 0, // Will be set after amortization
      privateRelayCost: optimal.privateRelayCost,
      totalCost: optimal.effectiveMev + optimal.gasCost + optimal.privateRelayCost,
      isSafe: optimal.isSafe,
      blockDelay,
    })
  }
  
  // Calculate amortized bridge costs
  const { perChainCosts, totalBridgeCost } = calculateAmortizedBridgeCosts(chainAllocations, marketData)
  
  // Distribute bridge costs to first chunk on each chain
  const chainFirstChunk = new Map<string, number>()
  for (let i = 0; i < chunks.length; i++) {
    const chain = chunks[i].chain
    if (chain !== "ethereum" && !chainFirstChunk.has(chain)) {
      chainFirstChunk.set(chain, i)
      const bridgeCost = perChainCosts.get(chain) || 0
      chunks[i].bridgeCost = bridgeCost
      chunks[i].totalCost += bridgeCost
    }
  }
  
  // Add timing and coordination costs
  const timingRisk = calculateTimingRisk(n, tradeSizeUsd)
  const coordinationOverhead = calculateCoordinationOverhead(n)
  
  const totalCost = totalMev + totalGas + totalBridgeCost + totalPrivate + timingRisk + coordinationOverhead
  
  if (verbose) {
    console.log(`      TOTALS: MEV=$${totalMev.toFixed(2)}, gas=$${totalGas.toFixed(2)}, bridge=$${totalBridgeCost.toFixed(2)}, private=$${totalPrivate.toFixed(2)}, timing=$${timingRisk.toFixed(2)}, coord=$${coordinationOverhead.toFixed(2)} → TOTAL=$${totalCost.toFixed(2)}`)
  }
  
  return {
    chunks,
    totalMev,
    totalGas,
    totalBridge: totalBridgeCost,
    totalPrivate,
    timingRisk,
    coordinationOverhead,
    totalCost,
  }
}

/**
 * Find optimal chain for chunk with pool state awareness
 */
function findOptimalChainForChunkWithPoolState(
  chunkSizeUsd: number,
  poolState: PoolState,
  chunkIndex: number,
  marketData: LiveMarketData,
  ethPriceUsd: number,
  policy: UserPolicy
): {
  chain: string
  usePrivateRelay: boolean
  gasCost: number
  privateRelayCost: number
  effectiveMev: number
  isSafe: boolean
} {
  let bestOption = {
    chain: "ethereum",
    usePrivateRelay: false,
    gasCost: Infinity,
    privateRelayCost: 0,
    effectiveMev: Infinity,
    isSafe: false,
  }
  let bestTotalCost = Infinity
  
  for (const chainData of marketData.chains) {
    if (!chainData.available) continue
    
    const gasCost = estimateSwapGas(chunkSizeUsd, chainData, ethPriceUsd)
    
    // Calculate MEV with threshold behavior
    const chunkMev = calculateChunkMevWithThreshold(chunkSizeUsd, poolState, chainData)
    
    // Cross-chain MEV reduction
    const crossChainMevFactor = chainData.chain === "ethereum" ? 1.0 : 0.3
    const effectiveMev = chunkMev * crossChainMevFactor
    
    // A chunk is "safe" if MEV is zero or negligible (below bot profitability threshold)
    // The safeThresholdUsd is the MEV threshold, not the chunk size threshold!
    const isSafe = effectiveMev < 0.01 // Less than 1 cent MEV = effectively safe
    
    const publicCost = effectiveMev + gasCost
    
    if (publicCost < bestTotalCost) {
      bestOption = {
        chain: chainData.chain,
        usePrivateRelay: false,
        gasCost,
        privateRelayCost: 0,  // Public route = no private relay cost
        effectiveMev,
        isSafe,
      }
      bestTotalCost = publicCost
    }
    
    // Private relay option (Ethereum only, for UNSAFE chunks with meaningful MEV)
    // Only consider private relay if there's actual MEV to hide
    if (chainData.chain === "ethereum" && !isSafe && effectiveMev > 0.50) {
      const privateRelayCost = estimateSizeAdjustedPrivateRelayCost(
        chunkSizeUsd,
        marketData.privateRelayCost,
        ethPriceUsd
      )
      const privateCost = gasCost + privateRelayCost
      
      if (privateCost < bestTotalCost) {
        bestOption = {
          chain: "ethereum",
          usePrivateRelay: true,
          gasCost,
          privateRelayCost,
          effectiveMev: 0,
          isSafe: true,
        }
        bestTotalCost = privateCost
      }
    }
  }
  
  return bestOption
}

// ============================================================================
// CROSS-CHAIN CHUNK ALLOCATION (Legacy compatibility)
// ============================================================================

function findOptimalChainForChunk(
  chunkMev: number,
  chunkIndex: number,
  marketData: LiveMarketData,
  policy: UserPolicy
): {
  chain: string
  usePrivateRelay: boolean
  gasCost: number
  bridgeCost: number
  privateRelayCost: number
  effectiveMev: number
  totalCost: number
  isSafe: boolean
} {
  let bestOption = {
    chain: "ethereum",
    usePrivateRelay: false,
    gasCost: Infinity,
    bridgeCost: 0,
    privateRelayCost: 0,
    effectiveMev: chunkMev,
    totalCost: Infinity,
    isSafe: false,
  }

  for (const chainData of marketData.chains) {
    if (!chainData.available) continue

    const gasCost = chainData.swapGasCostUsd
    const isSafe = chunkMev < chainData.safeThresholdUsd

    let bridgeCost = 0
    if (chainData.chain !== "ethereum") {
      const bridge = marketData.bridgeCosts.find(
        b => b.fromChain === "ethereum" && b.toChain === chainData.chain && b.available
      )
      if (!bridge) continue
      bridgeCost = bridge.totalUsd
    }

    // Cross-chain MEV reduction (harder to sandwich across chains)
    const crossChainMevFactor = chainData.chain === "ethereum" ? 1.0 : 0.3
    const publicMev = isSafe ? 0 : chunkMev * crossChainMevFactor
    const publicCost = publicMev + gasCost + bridgeCost

    if (publicCost < bestOption.totalCost) {
      bestOption = {
        chain: chainData.chain,
        usePrivateRelay: false,
        gasCost,
        bridgeCost,
        privateRelayCost: 0,
        effectiveMev: publicMev,
        totalCost: publicCost,
        isSafe,
      }
    }

    // Private relay option (Ethereum only)
    if (chainData.chain === "ethereum" && !isSafe) {
      const privateRelayCost = estimateSizeAdjustedPrivateRelayCost(
        0, // chunkSizeUsd not available in this legacy function, use base cost
        marketData.privateRelayCost,
        marketData.ethPriceUsd
      )
      const privateCost = gasCost + privateRelayCost
      if (privateCost < bestOption.totalCost) {
        bestOption = {
          chain: "ethereum",
          usePrivateRelay: true,
          gasCost,
          bridgeCost: 0,
          privateRelayCost,
          effectiveMev: 0,
          totalCost: privateCost,
          isSafe: true,
        }
      }
    }
  }

  return bestOption
}

function evaluateChunkCount(
  n: number,
  tradeSizeUsd: number,
  fullMev: number,
  marketData: LiveMarketData,
  policy: UserPolicy,
  verbose: boolean = false
): {
  chunks: ChunkSpec[]
  totalCost: number
  mevExposure: number
  gasFees: number
  bridgeFees: number
  privateRelayFees: number
  timingRisk: number
  coordinationOverhead: number
} {
  const ethPriceUsd = marketData.ethPriceUsd
  
  // Use the improved sequential execution simulation
  const result = simulateSequentialExecution(n, tradeSizeUsd, fullMev, marketData, ethPriceUsd, policy, verbose)
  
  return {
    chunks: result.chunks,
    totalCost: result.totalCost,
    mevExposure: result.totalMev,
    gasFees: result.totalGas,
    bridgeFees: result.totalBridge,
    privateRelayFees: result.totalPrivate,
    timingRisk: result.timingRisk,
    coordinationOverhead: result.coordinationOverhead,
  }
}

// ============================================================================
// MAIN OPTIMIZER
// ============================================================================

export async function optimize(
  sim: SandwichSimulation,
  policy: UserPolicy,
  tradeSizeUsd: number
): Promise<OptimizedPlan> {
  console.log(`\n🧮 CALCULUS-BASED OPTIMIZER (ENHANCED)`)
  console.log(`═══════════════════════════════════════════════════════════`)
  console.log(`   Trade size: $${tradeSizeUsd.toFixed(2)}`)
  console.log(`   Unprotected MEV: $${sim.estimatedLossUsd.toFixed(2)}`)

  const fullMev = sim.estimatedLossUsd
  const amountInWei = sim.reserveIn

  // Fetch live market data
  const marketData = await fetchLiveMarketData(sim.tokenIn, sim.tokenOut, amountInWei, sim.ethPriceUsd)

  const ethChain = marketData.chains.find(c => c.chain === "ethereum")
  if (!ethChain || !ethChain.available) {
    console.log(`   ❌ Ethereum not available`)
    return singleChunkFallback(tradeSizeUsd, fullMev)
  }

  const gasPerSwap = ethChain.swapGasCostUsd
  const safeThreshold = ethChain.safeThresholdUsd
  
  // ========================================================================
  // PHASE 0: Evaluate discrete strategies
  // ========================================================================
  console.log(`\n📊 EVALUATING DISCRETE STRATEGIES:`)
  
  const singlePrivate = evaluateSinglePrivateStrategy(tradeSizeUsd, fullMev, marketData, marketData.ethPriceUsd)
  const singlePublic = evaluateSinglePublicStrategy(tradeSizeUsd, fullMev, marketData, marketData.ethPriceUsd)
  
  console.log(`   Single Private: $${singlePrivate.costs.total.toFixed(2)} (MEV=$0, tip=$${singlePrivate.costs.privateRelay.toFixed(2)})`)
  console.log(`   Single Public:  $${singlePublic.costs.total.toFixed(2)} (MEV=$${singlePublic.costs.mev.toFixed(2)})`)
  
  // ========================================================================
  // PHASE 1: Calculate theoretical optimum with threshold adjustment
  // ========================================================================
  const theoreticalN = calculateTheoreticalOptimum(fullMev, gasPerSwap, safeThreshold)

  console.log(`\n📐 THEORETICAL OPTIMUM:`)
  console.log(`   n* = √(M/g) adjusted for threshold = ${theoreticalN.toFixed(2)}`)
  console.log(`   Safe threshold: $${safeThreshold.toFixed(2)}`)

  // ========================================================================
  // PHASE 2: Newton-Raphson + grid search for chunking strategies
  // ========================================================================
  const searchPath: SearchStep[] = []
  let bestN = 1
  let bestCost = Math.min(singlePrivate.costs.total, singlePublic.costs.total)
  let bestChunks: ChunkSpec[] = bestCost === singlePrivate.costs.total 
    ? singlePrivate.chunks 
    : singlePublic.chunks
  let bestStrategy = bestCost === singlePrivate.costs.total ? "single_private" : "single_public"

  const maxN = Math.max(200, Math.ceil(theoreticalN * 3))

  console.log(`\n🔍 SEARCHING n ∈ [1, ${maxN}] for chunking strategies`)

  // Debug: Sample a few key n values to understand the cost landscape
  console.log(`\n   📈 Cost landscape samples:`)
  for (const sampleN of [2, 5, 10, 20, 50, 100]) {
    if (sampleN <= maxN) {
      const sample = evaluateChunkCount(sampleN, tradeSizeUsd, fullMev, marketData, policy)
      console.log(`      n=${sampleN.toString().padStart(3)}: total=$${sample.totalCost.toFixed(2).padStart(8)} (MEV=$${sample.mevExposure.toFixed(2).padStart(6)}, gas=$${sample.gasFees.toFixed(2).padStart(6)}, priv=$${sample.privateRelayFees.toFixed(2).padStart(6)}, timing=$${sample.timingRisk.toFixed(2).padStart(5)}, coord=$${sample.coordinationOverhead.toFixed(2).padStart(5)})`)
    }
  }

  // Phase 2a: Newton-Raphson
  console.log(`\n   Phase 2a: Newton-Raphson`)
  let newtonN = Math.max(2, Math.round(theoreticalN)) // Start from 2 for chunking

  // Log the first evaluation with verbose details
  console.log(`\n   📊 Initial evaluation at n=${newtonN}:`)
  const initialResult = evaluateChunkCount(newtonN, tradeSizeUsd, fullMev, marketData, policy, true)
  console.log(`   → Total: $${initialResult.totalCost.toFixed(2)} (MEV=$${initialResult.mevExposure.toFixed(2)}, gas=$${initialResult.gasFees.toFixed(2)}, private=$${initialResult.privateRelayFees.toFixed(2)}, timing=$${initialResult.timingRisk.toFixed(2)}, coord=$${initialResult.coordinationOverhead.toFixed(2)})`)

  for (let iter = 0; iter < 10; iter++) {
    const result = evaluateChunkCount(newtonN, tradeSizeUsd, fullMev, marketData, policy)

    if (result.totalCost < bestCost) {
      bestCost = result.totalCost
      bestN = newtonN
      bestChunks = result.chunks
      bestStrategy = "public_chunking"
    }

    const nPlus = Math.min(maxN, newtonN + 1)
    const nMinus = Math.max(1, newtonN - 1)

    const resultPlus = evaluateChunkCount(nPlus, tradeSizeUsd, fullMev, marketData, policy)
    const resultMinus = evaluateChunkCount(nMinus, tradeSizeUsd, fullMev, marketData, policy)

    const derivative = (resultPlus.totalCost - resultMinus.totalCost) / 2
    const secondDerivative = resultPlus.totalCost - 2 * result.totalCost + resultMinus.totalCost

    if (Math.abs(secondDerivative) > 0.001) {
      const step = derivative / secondDerivative
      const nextN = Math.round(newtonN - step)

      if (nextN === newtonN || nextN < 1 || nextN > maxN) break

      console.log(`   Newton ${iter}: n=${newtonN} → ${nextN} (cost=$${result.totalCost.toFixed(2)})`)
      newtonN = nextN
    } else {
      break
    }
  }

  console.log(`   Newton converged: n=${bestN}, cost=$${bestCost.toFixed(2)}`)

  // Phase 2b: Local grid search
  console.log(`\n   Phase 2b: Local search [${Math.max(1, bestN - 20)}, ${Math.min(maxN, bestN + 20)}]`)

  for (let n = Math.max(1, bestN - 20); n <= Math.min(maxN, bestN + 20); n++) {
    const result = evaluateChunkCount(n, tradeSizeUsd, fullMev, marketData, policy)

    searchPath.push({
      n,
      cost: result.totalCost,
      derivative: costDerivative(n, fullMev, gasPerSwap),
      improvement: bestCost - result.totalCost,
    })

    if (result.totalCost < bestCost) {
      bestCost = result.totalCost
      bestN = n
      bestChunks = result.chunks
      bestStrategy = n === 1 ? "single_public" : "public_chunking"
      console.log(`   n=${n}: $${result.totalCost.toFixed(2)} ← NEW BEST`)
    }
  }

  // ========================================================================
  // PHASE 3: Final strategy selection
  // ========================================================================
  console.log(`\n📋 STRATEGY COMPARISON:`)
  console.log(`   Best chunking (n=${bestN}): $${bestCost.toFixed(2)}`)
  
  // Re-check single strategies against best chunking
  if (singlePrivate.costs.total < bestCost) {
    bestCost = singlePrivate.costs.total
    bestN = 1
    bestChunks = singlePrivate.chunks
    bestStrategy = "single_private"
    console.log(`   → Single private wins: $${bestCost.toFixed(2)}`)
  } else if (singlePublic.costs.total < bestCost) {
    bestCost = singlePublic.costs.total
    bestN = 1
    bestChunks = singlePublic.chunks
    bestStrategy = "single_public"
    console.log(`   → Single public wins: $${bestCost.toFixed(2)}`)
  } else {
    console.log(`   → Chunking strategy wins: n=${bestN}, $${bestCost.toFixed(2)}`)
  }

  // Build result
  const savings = fullMev - bestCost
  const savingsPercent = fullMev > 0 ? (savings / fullMev) * 100 : 0

  const costs: CostAnalysis = {
    mevExposure: bestChunks.reduce((s, c) => s + c.mevExposure, 0),
    gasFees: bestChunks.reduce((s, c) => s + c.gasCost, 0),
    bridgeFees: bestChunks.reduce((s, c) => s + c.bridgeCost, 0),
    privateRelayFees: bestChunks.reduce((s, c) => s + c.privateRelayCost, 0),
    totalCost: bestCost,
    unprotectedCost: fullMev,
    savings,
    savingsPercent,
    costPerChunk: bestCost / bestN,
    marginalCostAtOptimum: costDerivative(bestN, fullMev, gasPerSwap),
  }

  // Print result
  console.log(`\n✅ OPTIMAL: ${bestN} CHUNKS (${bestStrategy})`)
  console.log(`┌────────────────────────────────────────────────────────────┐`)
  console.log(`│  Unprotected MEV:        $${fullMev.toFixed(2).padStart(12)}             │`)
  console.log(`│  ─────────────────────────────────────────────────────     │`)
  console.log(`│  MEV exposure:           $${costs.mevExposure.toFixed(2).padStart(12)}             │`)
  console.log(`│  Gas fees:               $${costs.gasFees.toFixed(2).padStart(12)}             │`)
  console.log(`│  Bridge fees:            $${costs.bridgeFees.toFixed(2).padStart(12)}             │`)
  console.log(`│  Private relay:          $${costs.privateRelayFees.toFixed(2).padStart(12)}             │`)
  console.log(`│  ─────────────────────────────────────────────────────     │`)
  console.log(`│  TOTAL COST:             $${costs.totalCost.toFixed(2).padStart(12)}             │`)
  console.log(`│  SAVINGS:                $${costs.savings.toFixed(2).padStart(12)} (${costs.savingsPercent.toFixed(1)}%)      │`)
  console.log(`│  Theoretical n*:         ${theoreticalN.toFixed(2).padStart(12)}             │`)
  console.log(`│  Strategy:               ${bestStrategy.padStart(12)}             │`)
  console.log(`└────────────────────────────────────────────────────────────┘`)

  const chainsUsed = [...new Set(bestChunks.map(c => c.chain))]
  const safeCount = bestChunks.filter(c => c.isSafe).length

  const reasoning = `Optimal: ${bestN} chunks via ${bestStrategy} (n*=${theoreticalN.toFixed(1)}). ` +
    `Saves $${savings.toFixed(2)} (${savingsPercent.toFixed(1)}%). ` +
    `${safeCount}/${bestN} chunks below MEV threshold. ` +
    `Chains: ${chainsUsed.join("+")}.`

  return { chunkCount: bestN, chunks: bestChunks, costs, mathematicalOptimum: theoreticalN, searchPath, reasoning }
}

// ============================================================================
// BACKWARD COMPATIBILITY: Convert to ChunkPlan
// ============================================================================

export function toChunkPlan(opt: OptimizedPlan): ChunkPlan {
  return {
    count: opt.chunkCount,
    sizes: opt.chunks.map(c => c.sizePercent),
    chains: opt.chunks.map(c => c.chain),
    blockDelays: opt.chunks.map(c => c.blockDelay),
    crossChain: new Set(opt.chunks.map(c => c.chain)).size > 1,
    reasoning: opt.reasoning,
    economics: opt.chunks.map(c => ({
      index: c.index,
      sizePercent: c.sizePercent,
      valueUsd: c.amountUsd,
      chain: c.chain,
      mevExposureUsd: c.mevExposure,
      userGasCostUsd: c.gasCost,
      bridgeCostUsd: c.bridgeCost,
      totalCostUsd: c.totalCost,
      safe: c.isSafe,
      blockDelay: c.blockDelay,
    })),
    totalCost: opt.costs.totalCost,
    costBreakdown: {
      totalMevExposure: opt.costs.mevExposure,
      totalUserGas: opt.costs.gasFees,
      totalBridgeFees: opt.costs.bridgeFees,
      totalCost: opt.costs.totalCost,
      unprotectedCost: opt.costs.unprotectedCost,
      savings: opt.costs.savings,
      savingsPercent: opt.costs.savingsPercent,
    },
  }
}

// Legacy function name for backward compatibility
export async function optimizeChunks(
  sim: SandwichSimulation,
  policy: UserPolicy,
  tradeSizeUsd: number
): Promise<ChunkPlan> {
  const optimized = await optimize(sim, policy, tradeSizeUsd)
  return toChunkPlan(optimized)
}

function singleChunkFallback(tradeSizeUsd: number, fullMev: number): OptimizedPlan {
  return {
    chunkCount: 1,
    chunks: [{
      index: 0,
      sizePercent: 100,
      amountWei: 0n,
      amountUsd: tradeSizeUsd,
      chain: "ethereum",
      usePrivateRelay: false,
      mevExposure: fullMev,
      gasCost: 0,
      bridgeCost: 0,
      privateRelayCost: 0,
      totalCost: fullMev,
      isSafe: false,
      blockDelay: 0,
    }],
    costs: {
      mevExposure: fullMev,
      gasFees: 0,
      bridgeFees: 0,
      privateRelayFees: 0,
      totalCost: fullMev,
      unprotectedCost: fullMev,
      savings: 0,
      savingsPercent: 0,
      costPerChunk: fullMev,
      marginalCostAtOptimum: 0,
    },
    mathematicalOptimum: 1,
    searchPath: [],
    reasoning: "Fallback: single chunk.",
  }
}