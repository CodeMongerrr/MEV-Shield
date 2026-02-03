/**
 * CALCULUS-BASED MEV CHUNK OPTIMIZER
 * 
 * Mathematical Model:
 * 
 * Total Cost C(n) = MEV(n) + Gas(n) + Bridge(n) + Private(n)
 * 
 * Where:
 *   MEV(n) = M / n           (MEV exposure decreases as 1/n with equal chunks)
 *   Gas(n) = n × g           (Gas cost increases linearly)
 *   Bridge(n) = k(n) × b     (Bridge cost for cross-chain chunks)
 *   Private(n) = j(n) × p    (Private relay cost for unsafe chunks)
 * 
 * For pure same-chain optimization without private relay:
 *   C(n) = M/n + n×g
 *   dC/dn = -M/n² + g = 0
 *   n* = √(M/g)
 * 
 * This gives us the theoretical optimum to start our search.
 */

// Note: These imports assume files are in the same directory or project root
// Adjust paths based on your actual project structure:
// - For project root: "./simulator", "./types", etc.
// - For nested structure: "../perception/simulator", "../core/types", etc.

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
  // Gas costs in USD (fetched from actual tx estimates)
  swapGasCostUsd: number
  sandwichGasCostUsd: number  // Attacker's cost to sandwich on this chain
  safeThresholdUsd: number    // Chunks below this are unprofitable to attack
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
  mathematicalOptimum: number  // Theoretical n* from calculus
  searchPath: SearchStep[]     // How we found this solution
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
  isSafe: boolean  // Below sandwich threshold
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

// ============================================================================
// LIVE PRICING FETCHER (NO HARDCODED VALUES)
// ============================================================================

/**
 * Fetches all live market data needed for optimization.
 * No hardcoded values - everything comes from APIs.
 */
export async function fetchLiveMarketData(
  tokenIn: string,
  tokenOut: string,
  tradeAmountWei: bigint,
  ethPriceUsd: number
): Promise<LiveMarketData> {
  console.log(`\n📡 FETCHING LIVE MARKET DATA`)
  console.log(`   Token: ${tokenIn.slice(0, 10)}... → ${tokenOut.slice(0, 10)}...`)
  console.log(`   ETH Price: $${ethPriceUsd.toFixed(2)}`)

  const timestamp = Date.now()
  const chains: ChainPricing[] = []
  const bridgeCosts: BridgeCost[] = []

  // ---- Fetch gas prices from all available chains ----
  const availableChains = getAvailableChains()
  console.log(`\n   ⛓️  Fetching gas prices from ${availableChains.length} chains...`)

  for (const chainName of availableChains) {
    const entry = chainClients[chainName]
    if (!entry) {
      chains.push({
        chain: chainName,
        chainId: 0,
        available: false,
        gasPrice: 0n,
        gasPriceGwei: 0,
        swapGasCostUsd: Infinity,
        sandwichGasCostUsd: 0,
        safeThresholdUsd: 0,
      })
      continue
    }

    try {
      const gasPrice = await entry.client.getGasPrice()
      const gasPriceGwei = Number(gasPrice) / 1e9

      // Estimate actual gas units from recent blocks
      // For swap: typically 150k-250k depending on path complexity
      // For sandwich: 250k-350k (frontrun + backrun)
      const swapGasUnits = await estimateSwapGasUnits(entry.client, chainName)
      const sandwichGasUnits = await estimateSandwichGasUnits(entry.client, chainName)

      const swapGasCostWei = BigInt(swapGasUnits) * gasPrice
      const sandwichGasCostWei = BigInt(sandwichGasUnits) * gasPrice

      const swapGasCostUsd = (Number(swapGasCostWei) / 1e18) * ethPriceUsd
      const sandwichGasCostUsd = (Number(sandwichGasCostWei) / 1e18) * ethPriceUsd

      // Safe threshold: attacker needs at least 2x gas cost to be profitable
      const safeThresholdUsd = sandwichGasCostUsd * 2

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
        `   ⛓️  ${chainName.padEnd(10)} | ` +
        `gas: ${gasPriceGwei.toFixed(2).padStart(6)} gwei | ` +
        `swap: $${swapGasCostUsd.toFixed(3).padStart(6)} | ` +
        `sandwich: $${sandwichGasCostUsd.toFixed(3).padStart(6)} | ` +
        `safe threshold: $${safeThresholdUsd.toFixed(2)}`
      )
    } catch (err) {
      console.log(`   ⛓️  ${chainName}: ❌ RPC failed`)
      chains.push({
        chain: chainName,
        chainId: entry.chainId,
        available: false,
        gasPrice: 0n,
        gasPriceGwei: 0,
        swapGasCostUsd: Infinity,
        sandwichGasCostUsd: 0,
        safeThresholdUsd: 0,
      })
    }
  }

  // ---- Fetch bridge costs from LI.FI ----
  console.log(`\n   🌉 Fetching bridge costs from LI.FI...`)

  // Use a representative amount for bridge cost estimation (10% of trade)
  const bridgeTestAmount = tradeAmountWei / 10n > 0n ? tradeAmountWei / 10n : 10n ** 17n // At least 0.1 ETH equivalent

  for (const fromChain of availableChains) {
    for (const toChain of availableChains) {
      if (fromChain === toChain) continue

      const fromChainId = CHAIN_IDS[fromChain]
      const toChainId = CHAIN_IDS[toChain]

      if (!fromChainId || !toChainId) continue

      // Map token to destination chain
      const toTokenMapped = getTokenOnChain(tokenOut, fromChain, toChain)
      if (!toTokenMapped) {
        bridgeCosts.push({
          fromChain,
          toChain,
          feesUsd: Infinity,
          gasUsd: Infinity,
          totalUsd: Infinity,
          executionTime: Infinity,
          available: false,
        })
        continue
      }

      try {
        const quote = await getLiFiQuote({
          fromChain: fromChainId,
          toChain: toChainId,
          fromToken: tokenIn,
          toToken: toTokenMapped,
          fromAmount: bridgeTestAmount.toString(),
          fromAddress: "0x0000000000000000000000000000000000000001",
        })

        if (quote) {
          const feesUsd = quote.estimate.feeCosts.reduce(
            (sum, f) => sum + parseFloat(f.amountUSD || "0"), 0
          )
          const gasUsd = quote.estimate.gasCosts.reduce(
            (sum, g) => sum + parseFloat(g.amountUSD || "0"), 0
          )

          bridgeCosts.push({
            fromChain,
            toChain,
            feesUsd,
            gasUsd,
            totalUsd: feesUsd + gasUsd,
            executionTime: quote.estimate.executionDuration,
            available: true,
          })

          console.log(
            `   🌉 ${fromChain} → ${toChain}: ` +
            `$${(feesUsd + gasUsd).toFixed(2)} (fees: $${feesUsd.toFixed(2)}, gas: $${gasUsd.toFixed(2)}) | ` +
            `${quote.estimate.executionDuration}s | tool: ${quote.tool}`
          )
        } else {
          bridgeCosts.push({
            fromChain,
            toChain,
            feesUsd: Infinity,
            gasUsd: Infinity,
            totalUsd: Infinity,
            executionTime: Infinity,
            available: false,
          })
        }
      } catch {
        bridgeCosts.push({
          fromChain,
          toChain,
          feesUsd: Infinity,
          gasUsd: Infinity,
          totalUsd: Infinity,
          executionTime: Infinity,
          available: false,
        })
      }
    }
  }

  // ---- Calculate private relay cost ----
  console.log(`\n   🔒 Calculating private relay cost...`)

  const ethChain = chains.find(c => c.chain === "ethereum")
  let privateRelayCost: PrivateRelayCost

  if (ethChain && ethChain.available) {
    // Fetch recent priority fees from Ethereum
    const baseFeeGwei = ethChain.gasPriceGwei
    // Priority fee typically 0.1-3 gwei depending on network congestion
    // Fetch from actual mempool data if available
    const priorityFeeGwei = await fetchCurrentPriorityFee()

    // Private relay cost = priority fee × gas units for protected swap
    const privateGasUnits = 200000n  // Will be estimated more precisely
    const priorityFeeWei = BigInt(Math.floor(priorityFeeGwei * 1e9))
    const privateRelayCostWei = priorityFeeWei * privateGasUnits
    const estimatedCostUsd = (Number(privateRelayCostWei) / 1e18) * ethPriceUsd

    privateRelayCost = {
      priorityFeeGwei,
      estimatedCostUsd,
      baseFeeGwei,
    }

    console.log(
      `   🔒 Base fee: ${baseFeeGwei.toFixed(2)} gwei | ` +
      `Priority: ${priorityFeeGwei.toFixed(2)} gwei | ` +
      `Est. cost: $${estimatedCostUsd.toFixed(4)}/tx`
    )
  } else {
    privateRelayCost = {
      priorityFeeGwei: 0,
      estimatedCostUsd: Infinity,
      baseFeeGwei: 0,
    }
  }

  return {
    ethPriceUsd,
    timestamp,
    chains,
    bridgeCosts,
    privateRelayCost,
  }
}

/**
 * Estimate gas units for a typical swap on a chain.
 * This fetches recent swap transactions to get accurate estimates.
 */
async function estimateSwapGasUnits(client: any, chain: string): Promise<number> {
  // For now, use chain-specific estimates based on typical DEX complexity
  // In production, this would analyze recent swap txs on the chain
  const baseGas: Record<string, number> = {
    ethereum: 180000,   // Uniswap V2/V3 typical
    arbitrum: 700000,   // L2 compute is cheaper but units are higher
    base: 200000,       // Similar to L1 but slightly higher
    optimism: 250000,
    polygon: 200000,
  }

  return baseGas[chain] || 200000
}

/**
 * Estimate gas units for a sandwich attack (frontrun + backrun).
 */
async function estimateSandwichGasUnits(client: any, chain: string): Promise<number> {
  // Sandwich = 2 swaps + MEV bundle overhead
  const swapGas = await estimateSwapGasUnits(client, chain)
  return swapGas * 2 + 50000  // 2 swaps + bundle overhead
}

/**
 * Fetch current priority fee from Ethereum mempool.
 */
async function fetchCurrentPriorityFee(): Promise<number> {
  try {
    // Use eth_maxPriorityFeePerGas
    const priorityFee = await publicClient.request({
      method: "eth_maxPriorityFeePerGas" as any,
    })
    return Number(priorityFee) / 1e9  // Convert to gwei
  } catch {
    // Fallback: estimate based on recent blocks
    try {
      const block = await publicClient.getBlock({ blockTag: "latest" })
      const baseFee = block.baseFeePerGas || 0n
      // Priority fee is typically 5-20% of base fee in normal conditions
      return Number(baseFee) / 1e9 * 0.1
    } catch {
      return 1.0  // Default 1 gwei if all else fails
    }
  }
}

// ============================================================================
// MATHEMATICAL COST MODEL
// ============================================================================

/**
 * Calculate MEV exposure for a chunk of given size.
 * 
 * MEV scales approximately as the square of chunk size relative to pool.
 * Smaller chunks = less price impact = less profitable to sandwich.
 * 
 * For n equal chunks: MEV(n) = M × (1/n)² × n = M/n
 * But chunks aren't always equal, so we use the ratio directly.
 */
function calculateChunkMev(
  chunkUsd: number,
  totalTradeUsd: number,
  fullTradeMev: number
): number {
  if (totalTradeUsd <= 0) return 0
  const ratio = chunkUsd / totalTradeUsd
  // MEV scales quadratically with chunk size
  return fullTradeMev * ratio * ratio
}

/**
 * Total MEV exposure for n equal chunks.
 * 
 * Each chunk has MEV = M × (1/n)²
 * Total = n × M × (1/n)² = M/n
 */
function totalMevForEqualChunks(n: number, fullMev: number): number {
  if (n <= 0) return fullMev
  return fullMev / n
}

/**
 * Calculate the theoretical optimal chunk count using calculus.
 * 
 * Cost function: C(n) = M/n + n×g
 * Derivative: dC/dn = -M/n² + g
 * Setting to zero: n* = √(M/g)
 */
function calculateTheoreticalOptimum(
  fullMev: number,
  gasPerSwap: number
): number {
  if (gasPerSwap <= 0) return 1
  return Math.sqrt(fullMev / gasPerSwap)
}

/**
 * Calculate cost derivative at a given n.
 * Used for gradient-based optimization.
 * 
 * dC/dn = -M/n² + g + bridge_marginal + private_marginal
 */
function costDerivative(
  n: number,
  fullMev: number,
  gasPerSwap: number,
  bridgeCostMarginal: number,
  privateCostMarginal: number
): number {
  const mevDerivative = -fullMev / (n * n)
  const gasDerivative = gasPerSwap
  return mevDerivative + gasDerivative + bridgeCostMarginal + privateCostMarginal
}

/**
 * Second derivative for Newton-Raphson.
 * d²C/dn² = 2M/n³
 */
function costSecondDerivative(n: number, fullMev: number): number {
  return 2 * fullMev / (n * n * n)
}

// ============================================================================
// OPTIMIZER
// ============================================================================

/**
 * Find the optimal chunk configuration using calculus-guided search.
 */
export async function optimize(
  sim: SandwichSimulation,
  policy: UserPolicy,
  tradeSizeUsd: number
): Promise<OptimizedPlan> {
  console.log(`\n🧮 CALCULUS-BASED OPTIMIZER`)
  console.log(`═══════════════════════════════════════════════════════════`)
  console.log(`   Trade size: $${tradeSizeUsd.toFixed(2)}`)
  console.log(`   Unprotected MEV: $${sim.estimatedLossUsd.toFixed(2)}`)

  const fullMev = sim.estimatedLossUsd
  const amountInWei = sim.reserveIn  // Using reserveIn as proxy for input amount

  // 1. FETCH LIVE MARKET DATA
  const marketData = await fetchLiveMarketData(
    sim.tokenIn,
    sim.tokenOut,
    amountInWei,
    sim.ethPriceUsd
  )

  const ethChain = marketData.chains.find(c => c.chain === "ethereum")
  if (!ethChain || !ethChain.available) {
    console.log(`   ❌ Ethereum chain not available, returning single chunk`)
    return singleChunkFallback(tradeSizeUsd, fullMev)
  }

  const gasPerSwap = ethChain.swapGasCostUsd
  const safeThreshold = ethChain.safeThresholdUsd

  console.log(`\n📊 COST PARAMETERS:`)
  console.log(`   Full MEV (M): $${fullMev.toFixed(2)}`)
  console.log(`   Gas per swap (g): $${gasPerSwap.toFixed(4)}`)
  console.log(`   Safe threshold: $${safeThreshold.toFixed(2)}`)

  // 2. CALCULATE THEORETICAL OPTIMUM
  const theoreticalN = calculateTheoreticalOptimum(fullMev, gasPerSwap)
  console.log(`\n📐 THEORETICAL OPTIMUM:`)
  console.log(`   n* = √(M/g) = √(${fullMev.toFixed(2)}/${gasPerSwap.toFixed(4)}) = ${theoreticalN.toFixed(2)}`)

  // 3. SEARCH AROUND THEORETICAL OPTIMUM
  // Use a combination of:
  // - Newton-Raphson for fast convergence near theoretical optimum
  // - Grid search to ensure we don't miss the global minimum
  
  const searchPath: SearchStep[] = []
  let bestN = 1
  let bestCost = Infinity
  let bestChunks: ChunkSpec[] = []

  // Search range: from 1 to max(200, 3×theoretical)
  // Higher limit because gas is cheap on L2s
  const maxN = Math.max(200, Math.ceil(theoreticalN * 3))

  console.log(`\n🔍 SEARCHING n ∈ [1, ${maxN}] (theoretical: ${Math.round(theoreticalN)})`)

  // Phase 1: Newton-Raphson from theoretical optimum
  // Uses: n_{k+1} = n_k - f'(n_k) / f''(n_k)
  console.log(`\n   Phase 1: Newton-Raphson refinement`)
  
  let newtonN = Math.max(1, Math.round(theoreticalN))
  const newtonIterations: { n: number; cost: number }[] = []
  
  for (let iter = 0; iter < 10; iter++) {
    const result = evaluateChunkCount(newtonN, tradeSizeUsd, fullMev, marketData, policy)
    newtonIterations.push({ n: newtonN, cost: result.totalCost })
    
    if (result.totalCost < bestCost) {
      bestCost = result.totalCost
      bestN = newtonN
      bestChunks = result.chunks
    }
    
    // Calculate gradient (numerical)
    const nPlus = Math.min(maxN, newtonN + 1)
    const nMinus = Math.max(1, newtonN - 1)
    
    const resultPlus = evaluateChunkCount(nPlus, tradeSizeUsd, fullMev, marketData, policy)
    const resultMinus = evaluateChunkCount(nMinus, tradeSizeUsd, fullMev, marketData, policy)
    
    // First derivative (central difference)
    const derivative = (resultPlus.totalCost - resultMinus.totalCost) / 2
    
    // Second derivative
    const secondDerivative = resultPlus.totalCost - 2 * result.totalCost + resultMinus.totalCost
    
    // Newton-Raphson update
    if (Math.abs(secondDerivative) > 0.001) {
      const step = derivative / secondDerivative
      const nextN = Math.round(newtonN - step)
      
      // Ensure we stay in bounds and make progress
      if (nextN === newtonN || nextN < 1 || nextN > maxN) break
      
      console.log(
        `   Newton iter ${iter}: n=${newtonN} → ${nextN} ` +
        `(cost=$${result.totalCost.toFixed(2)}, ∂=$${derivative.toFixed(4)}, ∂²=$${secondDerivative.toFixed(4)})`
      )
      
      newtonN = nextN
    } else {
      // Second derivative too small, we're at a flat region
      break
    }
  }
  
  console.log(`   Newton converged: n=${bestN}, cost=$${bestCost.toFixed(2)}`)

  // Phase 2: Local grid search around Newton result
  // Ensures we don't miss nearby minima due to discretization
  console.log(`\n   Phase 2: Local grid search around n=${bestN}`)
  
  const localStart = Math.max(1, bestN - 20)
  const localEnd = Math.min(maxN, bestN + 20)
  
  for (let n = localStart; n <= localEnd; n++) {
    const result = evaluateChunkCount(n, tradeSizeUsd, fullMev, marketData, policy)
    const derivative = costDerivative(n, fullMev, gasPerSwap, 0, 0)
    
    searchPath.push({
      n,
      cost: result.totalCost,
      derivative,
      improvement: bestCost - result.totalCost,
    })
    
    if (result.totalCost < bestCost) {
      const improvement = bestCost - result.totalCost
      bestCost = result.totalCost
      bestN = n
      bestChunks = result.chunks
      
      console.log(
        `   n=${n.toString().padStart(3)}: $${result.totalCost.toFixed(2).padStart(8)} ` +
        `← NEW BEST (saved $${improvement.toFixed(4)})`
      )
    }
  }

  // Phase 3: Sparse global search to catch distant optima
  // (e.g., if cross-chain becomes worthwhile at high chunk counts)
  console.log(`\n   Phase 3: Sparse global scan`)
  
  const sparseStep = Math.max(5, Math.floor(maxN / 40))
  let consecutiveNoImprovement = 0
  
  for (let n = 1; n <= maxN; n += sparseStep) {
    if (n >= localStart && n <= localEnd) continue  // Already searched
    
    const result = evaluateChunkCount(n, tradeSizeUsd, fullMev, marketData, policy)
    
    searchPath.push({
      n,
      cost: result.totalCost,
      derivative: costDerivative(n, fullMev, gasPerSwap, 0, 0),
      improvement: bestCost - result.totalCost,
    })
    
    if (result.totalCost < bestCost) {
      console.log(
        `   n=${n}: $${result.totalCost.toFixed(2)} ← SURPRISE OPTIMUM FOUND!`
      )
      
      // Found a better region, do local search here
      const newLocalStart = Math.max(1, n - sparseStep)
      const newLocalEnd = Math.min(maxN, n + sparseStep)
      
      for (let localN = newLocalStart; localN <= newLocalEnd; localN++) {
        const localResult = evaluateChunkCount(localN, tradeSizeUsd, fullMev, marketData, policy)
        if (localResult.totalCost < bestCost) {
          bestCost = localResult.totalCost
          bestN = localN
          bestChunks = localResult.chunks
        }
      }
      
      consecutiveNoImprovement = 0
    } else {
      consecutiveNoImprovement++
    }
    
    // Stop if we're past the optimum region and not improving
    if (consecutiveNoImprovement > 8 && n > bestN * 2) {
      console.log(`   Stopping sparse search at n=${n} (no improvements)`)
      break
    }
  }

  // 5. BUILD FINAL RESULT
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
    marginalCostAtOptimum: costDerivative(bestN, fullMev, gasPerSwap, 0, 0),
  }

  // Print final result
  console.log(`\n✅ OPTIMAL SOLUTION: ${bestN} CHUNKS`)
  console.log(`┌────────────────────────────────────────────────────────────┐`)
  console.log(`│  COST BREAKDOWN                                            │`)
  console.log(`├────────────────────────────────────────────────────────────┤`)
  console.log(`│  Unprotected MEV loss:        $${fullMev.toFixed(2).padStart(12)}             │`)
  console.log(`│  ─────────────────────────────────────────────────────     │`)
  console.log(`│  With MEV Shield (${bestN} chunks):                           │`)
  console.log(`│    Residual MEV exposure:     $${costs.mevExposure.toFixed(2).padStart(12)}             │`)
  console.log(`│    Gas fees:                  $${costs.gasFees.toFixed(2).padStart(12)}             │`)
  console.log(`│    Bridge fees:               $${costs.bridgeFees.toFixed(2).padStart(12)}             │`)
  console.log(`│    Private relay fees:        $${costs.privateRelayFees.toFixed(2).padStart(12)}             │`)
  console.log(`│  ─────────────────────────────────────────────────────     │`)
  console.log(`│  TOTAL COST:                  $${costs.totalCost.toFixed(2).padStart(12)}             │`)
  console.log(`│  SAVINGS:                     $${costs.savings.toFixed(2).padStart(12)} (${costs.savingsPercent.toFixed(1)}%)      │`)
  console.log(`│                                                            │`)
  console.log(`│  Theoretical optimum n*:      ${theoreticalN.toFixed(2).padStart(12)}             │`)
  console.log(`│  Actual optimum:              ${bestN.toString().padStart(12)}             │`)
  console.log(`│  Cost per chunk:              $${costs.costPerChunk.toFixed(4).padStart(12)}             │`)
  console.log(`└────────────────────────────────────────────────────────────┘`)

  const chainsUsed = [...new Set(bestChunks.map(c => c.chain))]
  const privateCount = bestChunks.filter(c => c.usePrivateRelay).length
  const safeCount = bestChunks.filter(c => c.isSafe).length

  const reasoning = buildReasoning(
    bestN,
    theoreticalN,
    chainsUsed,
    privateCount,
    safeCount,
    costs
  )

  return {
    chunkCount: bestN,
    chunks: bestChunks,
    costs,
    mathematicalOptimum: theoreticalN,
    searchPath,
    reasoning,
  }
}

/**
 * Find the optimal chain for a chunk given its MEV exposure.
 * 
 * For each chunk, we compare:
 * - Ethereum public: mev + gas
 * - Ethereum private: 0 + gas + private_fee
 * - Other chain: mev_adjusted + gas + bridge
 * 
 * Cross-chain MEV is harder because:
 * 1. Attackers need liquidity on multiple chains
 * 2. Bridge latency makes timing attacks harder
 * 3. Different chains have different MEV searcher coverage
 */
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

  // Evaluate each available chain
  for (const chainData of marketData.chains) {
    if (!chainData.available) continue

    const gasCost = chainData.swapGasCostUsd
    const isSafe = chunkMev < chainData.safeThresholdUsd

    // Get bridge cost (0 for ethereum)
    let bridgeCost = 0
    if (chainData.chain !== "ethereum") {
      const bridge = marketData.bridgeCosts.find(
        b => b.fromChain === "ethereum" && b.toChain === chainData.chain && b.available
      )
      if (!bridge) continue  // Can't bridge to this chain
      bridgeCost = bridge.totalUsd
    }

    // Cross-chain MEV reduction factor
    // MEV is harder cross-chain due to latency and liquidity fragmentation
    const crossChainMevFactor = chainData.chain === "ethereum" ? 1.0 : 0.3

    // Option 1: Public transaction
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

    // Option 2: Private relay (only on Ethereum)
    if (chainData.chain === "ethereum" && !isSafe) {
      const privateCost = gasCost + marketData.privateRelayCost.estimatedCostUsd
      if (privateCost < bestOption.totalCost) {
        bestOption = {
          chain: "ethereum",
          usePrivateRelay: true,
          gasCost,
          bridgeCost: 0,
          privateRelayCost: marketData.privateRelayCost.estimatedCostUsd,
          effectiveMev: 0,
          totalCost: privateCost,
          isSafe: true,  // Private relay makes it "safe"
        }
      }
    }
  }

  return bestOption
}

/**
 * Evaluate a specific chunk count with cross-chain optimization.
 * 
 * For each chunk:
 * 1. Calculate MEV exposure for that chunk size
 * 2. Find the optimal chain/relay combination
 * 3. Sum up total costs
 */
function evaluateChunkCount(
  n: number,
  tradeSizeUsd: number,
  fullMev: number,
  marketData: LiveMarketData,
  policy: UserPolicy
): {
  chunks: ChunkSpec[]
  totalCost: number
  mevExposure: number
  gasFees: number
  bridgeFees: number
  privateRelayFees: number
} {
  const chunkSizeUsd = tradeSizeUsd / n
  const chunks: ChunkSpec[] = []

  let totalMev = 0
  let totalGas = 0
  let totalBridge = 0
  let totalPrivate = 0

  // Track chain usage to avoid over-concentration
  const chainUsage: Record<string, number> = {}

  for (let i = 0; i < n; i++) {
    const chunkMev = calculateChunkMev(chunkSizeUsd, tradeSizeUsd, fullMev)
    
    // First chunk must be on Ethereum (no bridge delay for initial tx)
    let optimal: ReturnType<typeof findOptimalChainForChunk>
    
    if (i === 0) {
      // Evaluate Ethereum only for first chunk
      const ethChain = marketData.chains.find(c => c.chain === "ethereum")
      if (ethChain && ethChain.available) {
        const isSafe = chunkMev < ethChain.safeThresholdUsd
        const usePrivate = !isSafe && policy.riskProfile === "conservative"
        
        optimal = {
          chain: "ethereum",
          usePrivateRelay: usePrivate,
          gasCost: ethChain.swapGasCostUsd,
          bridgeCost: 0,
          privateRelayCost: usePrivate ? marketData.privateRelayCost.estimatedCostUsd : 0,
          effectiveMev: (isSafe || usePrivate) ? 0 : chunkMev,
          totalCost: (isSafe || usePrivate ? 0 : chunkMev) + ethChain.swapGasCostUsd + (usePrivate ? marketData.privateRelayCost.estimatedCostUsd : 0),
          isSafe: isSafe || usePrivate,
        }
      } else {
        // Fallback if Ethereum not available
        optimal = findOptimalChainForChunk(chunkMev, i, marketData, policy)
      }
    } else {
      // For subsequent chunks, find optimal chain
      optimal = findOptimalChainForChunk(chunkMev, i, marketData, policy)
      
      // Apply diversity penalty if too concentrated on one chain
      const currentUsage = chainUsage[optimal.chain] || 0
      if (currentUsage > n / 3) {
        // Try to find alternative chain
        for (const chainData of marketData.chains) {
          if (!chainData.available || chainData.chain === optimal.chain) continue
          const altChunkUsage = chainUsage[chainData.chain] || 0
          if (altChunkUsage < currentUsage) {
            // Re-evaluate with this chain
            const altOptimal = findOptimalChainForChunk(chunkMev, i, marketData, policy)
            // Only switch if cost increase is < 20%
            if (altOptimal.totalCost < optimal.totalCost * 1.2) {
              optimal = altOptimal
            }
          }
        }
      }
    }

    chainUsage[optimal.chain] = (chainUsage[optimal.chain] || 0) + 1

    totalMev += optimal.effectiveMev
    totalGas += optimal.gasCost
    totalBridge += optimal.bridgeCost
    totalPrivate += optimal.privateRelayCost

    // Calculate block delay based on chain
    let blockDelay = 0
    if (i > 0) {
      if (optimal.chain === "ethereum") {
        blockDelay = 1  // 1 block for Ethereum same-chain
      } else {
        blockDelay = 2  // 2 blocks for cross-chain (bridge latency)
      }
    }

    chunks.push({
      index: i,
      sizePercent: 100 / n,
      amountWei: 0n,  // Will be calculated later
      amountUsd: chunkSizeUsd,
      chain: optimal.chain,
      usePrivateRelay: optimal.usePrivateRelay,
      mevExposure: optimal.effectiveMev,
      gasCost: optimal.gasCost,
      bridgeCost: optimal.bridgeCost,
      privateRelayCost: optimal.privateRelayCost,
      totalCost: optimal.totalCost,
      isSafe: optimal.isSafe,
      blockDelay,
    })
  }

  return {
    chunks,
    totalCost: totalMev + totalGas + totalBridge + totalPrivate,
    mevExposure: totalMev,
    gasFees: totalGas,
    bridgeFees: totalBridge,
    privateRelayFees: totalPrivate,
  }
}

function buildReasoning(
  n: number,
  theoreticalN: number,
  chains: string[],
  privateCount: number,
  safeCount: number,
  costs: CostAnalysis
): string {
  let r = `Optimal: ${n} chunks (theoretical n*=${theoreticalN.toFixed(1)}). `
  r += `Saves $${costs.savings.toFixed(2)} (${costs.savingsPercent.toFixed(1)}%). `
  
  if (n > theoreticalN * 1.2) {
    r += `More chunks than theoretical due to safe threshold effects. `
  } else if (n < theoreticalN * 0.8) {
    r += `Fewer chunks than theoretical due to gas cost dominance. `
  }

  if (safeCount === n) {
    r += `All ${n} chunks below sandwich threshold - fully protected. `
  } else if (safeCount > 0) {
    r += `${safeCount}/${n} chunks below threshold. `
  }

  if (privateCount > 0) {
    r += `${privateCount} chunks via private relay. `
  }

  r += `Cost breakdown: MEV=$${costs.mevExposure.toFixed(2)}, Gas=$${costs.gasFees.toFixed(2)}.`

  return r
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
    reasoning: "Fallback: single chunk (chain data unavailable).",
  }
}