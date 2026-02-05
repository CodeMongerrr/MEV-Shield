import { SandwichSimulation } from "../perception/simulator"
import { UserPolicy } from "../core/types"
import { chainClients, getAvailableChains } from "../core/config"
import { estimateCrossChainCost } from "../actions/lifiRouter"
// import { estimatePrivateRelayCost } from "../actions/privateTx"

export interface OptimalRoute {
  totalChunks: number
  chunks: ChunkAllocation[]
  costs: CostBreakdown
  reasoning: string
}

export interface ChunkAllocation {
  index: number
  amountUsd: number
  amountWei: bigint
  chain: string
  usePrivateRelay: boolean
  mevExposure: number
  gasCost: number
  bridgeCost: number
  privateRelayCost: number
  totalCost: number
  blockDelay: number
}

export interface CostBreakdown {
  mevExposure: number
  gasFees: number
  bridgeFees: number
  privateRelayFees: number
  totalCost: number
  unprotectedCost: number
  savings: number
  savingsPercent: number
}

export interface LivePricing {
  ethPriceUsd: number
  gasPrice: Record<string, bigint> // chain -> wei
  bridgeCosts: Record<string, number> // chain -> USD for typical chunk
  privateRelayCostPerTx: number
}

const SWAP_GAS_UNITS = 180000n
const SANDWICH_GAS_UNITS = 300000n

// Fetch all live pricing data upfront
async function fetchLivePricing(
  tokenIn: string,
  tokenOut: string,
  typicalChunkWei: bigint,
  ethPriceUsd: number
): Promise<LivePricing> {
  console.log(`\n📡 Fetching live pricing...`)

  const pricing: LivePricing = {
    ethPriceUsd,
    gasPrice: {},
    bridgeCosts: {},
    privateRelayCostPerTx: 0,
  }

  // Fetch gas prices from all chains
  const chains = getAvailableChains()
  for (const chain of chains) {
    const client = chainClients[chain]
    if (client) {
      try {
        const gasPrice = await client.client.getGasPrice()
        pricing.gasPrice[chain] = gasPrice
        console.log(`   ⛓️ ${chain} gas: ${(Number(gasPrice) / 1e9).toFixed(3)} gwei`)
      } catch {
        console.log(`   ⛓️ ${chain} gas: ❌ failed`)
      }
    }
  }

  // Fetch bridge costs from LI.FI for non-ethereum chains
  for (const chain of chains) {
    if (chain === "ethereum") {
      pricing.bridgeCosts[chain] = 0
      continue
    }

    const estimate = await estimateCrossChainCost(
      "ethereum",
      chain,
      tokenIn,
      tokenOut,
      typicalChunkWei,
      "0x0000000000000000000000000000000000000001"
    )

    if (estimate) {
      pricing.bridgeCosts[chain] = estimate.totalCostUsd
      console.log(`   🌉 ${chain} bridge: $${estimate.totalCostUsd.toFixed(2)} (LI.FI)`)
    } else {
      pricing.bridgeCosts[chain] = Infinity // Mark as unavailable
      console.log(`   🌉 ${chain} bridge: ❌ unavailable`)
    }
  }

  // Estimate private relay cost (Flashbots priority fee)
  // Typical: 0.1-2 gwei priority fee * ~200k gas
  const ethGasPrice = pricing.gasPrice["ethereum"] || 0n
  const priorityFeeWei = ethGasPrice / 10n // ~10% of base fee as priority
  const privateRelayGasWei = priorityFeeWei * 200000n
  pricing.privateRelayCostPerTx = (Number(privateRelayGasWei) / 1e18) * ethPriceUsd
  console.log(`   🔒 Private relay: $${pricing.privateRelayCostPerTx.toFixed(4)}/tx`)

  return pricing
}

// Calculate MEV exposure for a given chunk size
// MEV scales quadratically: smaller chunks = disproportionately less MEV
function calculateChunkMev(
  chunkUsd: number,
  totalTradeUsd: number,
  fullTradeMev: number
): number {
  const ratio = chunkUsd / totalTradeUsd
  return fullTradeMev * ratio * ratio
}

// Calculate gas cost for a swap on a given chain
function calculateGasCost(
  chain: string,
  pricing: LivePricing
): number {
  const gasPrice = pricing.gasPrice[chain]
  if (!gasPrice) return Infinity

  const gasWei = SWAP_GAS_UNITS * gasPrice
  return (Number(gasWei) / 1e18) * pricing.ethPriceUsd
}

// Calculate the cost of sandwiching on a given chain (attacker's cost)
function calculateSandwichCost(
  chain: string,
  pricing: LivePricing
): number {
  const gasPrice = pricing.gasPrice[chain]
  if (!gasPrice) return 0

  const gasWei = SANDWICH_GAS_UNITS * gasPrice
  return (Number(gasWei) / 1e18) * pricing.ethPriceUsd
}

// Check if a chunk is "safe" (sandwich not profitable for attacker)
function isChunkSafe(
  chunkMev: number,
  chain: string,
  pricing: LivePricing
): boolean {
  const attackerCost = calculateSandwichCost(chain, pricing)
  return chunkMev < attackerCost
}

// Calculate total cost for a specific configuration
function evaluateConfiguration(
  numChunks: number,
  chainAllocation: string[], // which chain for each chunk
  usePrivateRelay: boolean[], // whether to use private relay for each chunk
  tradeSizeUsd: number,
  fullTradeMev: number,
  pricing: LivePricing
): { totalCost: number; breakdown: CostBreakdown; chunks: ChunkAllocation[] } {
  const chunkSize = tradeSizeUsd / numChunks
  const chunks: ChunkAllocation[] = []

  let totalMev = 0
  let totalGas = 0
  let totalBridge = 0
  let totalPrivate = 0

  for (let i = 0; i < numChunks; i++) {
    const chain = chainAllocation[i]
    const isPrivate = usePrivateRelay[i]

    const chunkMev = calculateChunkMev(chunkSize, tradeSizeUsd, fullTradeMev)
    const gasCost = calculateGasCost(chain, pricing)
    const bridgeCost = pricing.bridgeCosts[chain] || 0
    const privateRelayCost = isPrivate ? pricing.privateRelayCostPerTx : 0

    // If using private relay, MEV exposure is 0
    // If chunk is "safe" (below attack threshold), MEV exposure is 0
    const safe = isChunkSafe(chunkMev, chain, pricing)
    const effectiveMev = isPrivate ? 0 : (safe ? 0 : chunkMev)

    totalMev += effectiveMev
    totalGas += gasCost
    totalBridge += bridgeCost
    totalPrivate += privateRelayCost

    chunks.push({
      index: i,
      amountUsd: chunkSize,
      amountWei: 0n, // Will be calculated later
      chain,
      usePrivateRelay: isPrivate,
      mevExposure: effectiveMev,
      gasCost,
      bridgeCost,
      privateRelayCost,
      totalCost: effectiveMev + gasCost + bridgeCost + privateRelayCost,
      blockDelay: i === 0 ? 0 : (chain === "ethereum" ? 1 : 2),
    })
  }

  const totalCost = totalMev + totalGas + totalBridge + totalPrivate
  const savings = fullTradeMev - totalCost
  const savingsPercent = fullTradeMev > 0 ? (savings / fullTradeMev) * 100 : 0

  return {
    totalCost,
    breakdown: {
      mevExposure: totalMev,
      gasFees: totalGas,
      bridgeFees: totalBridge,
      privateRelayFees: totalPrivate,
      totalCost,
      unprotectedCost: fullTradeMev,
      savings,
      savingsPercent,
    },
    chunks,
  }
}

// Find optimal chain for a chunk given its MEV exposure
function findOptimalChainForChunk(
  chunkMev: number,
  pricing: LivePricing,
  availableChains: string[]
): { chain: string; usePrivate: boolean; cost: number } {
  let bestChain = "ethereum"
  let bestUsePrivate = false
  let bestCost = Infinity

  for (const chain of availableChains) {
    const gasCost = calculateGasCost(chain, pricing)
    const bridgeCost = pricing.bridgeCosts[chain] || Infinity
    const safe = isChunkSafe(chunkMev, chain, pricing)

    // Option 1: Public tx on this chain
    const publicCost = (safe ? 0 : chunkMev) + gasCost + bridgeCost
    if (publicCost < bestCost) {
      bestCost = publicCost
      bestChain = chain
      bestUsePrivate = false
    }

    // Option 2: Private relay (only on ethereum)
    if (chain === "ethereum") {
      const privateCost = 0 + gasCost + pricing.privateRelayCostPerTx
      if (privateCost < bestCost) {
        bestCost = privateCost
        bestChain = chain
        bestUsePrivate = true
      }
    }
  }

  return { chain: bestChain, usePrivate: bestUsePrivate, cost: bestCost }
}

// Main optimizer: find the global minimum cost
export async function findOptimalRoute(
  sim: SandwichSimulation,
  policy: UserPolicy,
  tradeSizeUsd: number
): Promise<OptimalRoute> {
  console.log(`\n🧮 DYNAMIC OPTIMIZER`)
  console.log(`   Trade size: $${tradeSizeUsd.toFixed(2)}`)
  console.log(`   Unprotected MEV: $${sim.estimatedLossUsd.toFixed(2)}`)

  const fullTradeMev = sim.estimatedLossUsd
  const ethPriceUsd = sim.ethPriceUsd

  // Typical chunk size for bridge cost estimation (~$15k)
  const typicalChunkUsd = 15000
  const typicalChunkWei = BigInt(Math.floor((typicalChunkUsd / ethPriceUsd) * 1e18))

  // Fetch all live pricing
  const pricing = await fetchLivePricing(
    sim.tokenIn,
    sim.tokenOut,
    typicalChunkWei,
    ethPriceUsd
  )

  const availableChains = getAvailableChains().filter(
    (c) => pricing.gasPrice[c] !== undefined
  )

  console.log(`\n🔍 Searching for optimal chunk count...`)

  // Search from 1 to 50 chunks (or until diminishing returns)
  let bestResult: { numChunks: number; totalCost: number; chunks: ChunkAllocation[]; breakdown: CostBreakdown } | null = null
  let previousCost = Infinity
  let noImprovementCount = 0

  for (let numChunks = 1; numChunks <= 50; numChunks++) {
    const chunkSize = tradeSizeUsd / numChunks
    const chunkMev = calculateChunkMev(chunkSize, tradeSizeUsd, fullTradeMev)

    // For each chunk, find optimal chain + private relay decision
    const chainAllocation: string[] = []
    const privateRelayAllocation: boolean[] = []

    for (let i = 0; i < numChunks; i++) {
      // First chunk must be ethereum (no bridge delay)
      if (i === 0) {
        const safe = isChunkSafe(chunkMev, "ethereum", pricing)
        const publicCost = (safe ? 0 : chunkMev) + calculateGasCost("ethereum", pricing)
        const privateCost = calculateGasCost("ethereum", pricing) + pricing.privateRelayCostPerTx

        if (privateCost < publicCost && !safe) {
          chainAllocation.push("ethereum")
          privateRelayAllocation.push(true)
        } else {
          chainAllocation.push("ethereum")
          privateRelayAllocation.push(false)
        }
      } else {
        const optimal = findOptimalChainForChunk(chunkMev, pricing, availableChains)
        chainAllocation.push(optimal.chain)
        privateRelayAllocation.push(optimal.usePrivate)
      }
    }

    const result = evaluateConfiguration(
      numChunks,
      chainAllocation,
      privateRelayAllocation,
      tradeSizeUsd,
      fullTradeMev,
      pricing
    )

    // Log every 5 chunks or when we find improvement
    if (numChunks <= 10 || numChunks % 5 === 0 || result.totalCost < (bestResult?.totalCost || Infinity)) {
      const b = result.breakdown
      console.log(
        `   ${numChunks.toString().padStart(2)} chunks: ` +
        `MEV=$${b.mevExposure.toFixed(2).padStart(7)} + ` +
        `Gas=$${b.gasFees.toFixed(2).padStart(6)} + ` +
        `Bridge=$${b.bridgeFees.toFixed(2).padStart(6)} + ` +
        `Private=$${b.privateRelayFees.toFixed(2).padStart(5)} = ` +
        `$${b.totalCost.toFixed(2).padStart(8)} ` +
        `(saves ${b.savingsPercent.toFixed(1)}%)`
      )
    }

    if (!bestResult || result.totalCost < bestResult.totalCost) {
      bestResult = {
        numChunks,
        totalCost: result.totalCost,
        chunks: result.chunks,
        breakdown: result.breakdown,
      }
      noImprovementCount = 0
    } else {
      noImprovementCount++
    }

    // Stop if cost is increasing consistently (we've passed the optimum)
    if (noImprovementCount >= 5 && result.totalCost > previousCost) {
      console.log(`   ... stopping at ${numChunks} chunks (diminishing returns)`)
      break
    }

    previousCost = result.totalCost
  }

  if (!bestResult) {
    // Fallback: single chunk
    return {
      totalChunks: 1,
      chunks: [{
        index: 0,
        amountUsd: tradeSizeUsd,
        amountWei: BigInt(Math.floor((tradeSizeUsd / ethPriceUsd) * 1e18)),
        chain: "ethereum",
        usePrivateRelay: false,
        mevExposure: fullTradeMev,
        gasCost: 0,
        bridgeCost: 0,
        privateRelayCost: 0,
        totalCost: fullTradeMev,
        blockDelay: 0,
      }],
      costs: {
        mevExposure: fullTradeMev,
        gasFees: 0,
        bridgeFees: 0,
        privateRelayFees: 0,
        totalCost: fullTradeMev,
        unprotectedCost: fullTradeMev,
        savings: 0,
        savingsPercent: 0,
      },
      reasoning: "Fallback: single chunk, no optimization possible.",
    }
  }

  // Calculate actual wei amounts for each chunk
  const totalWei = sim.reserveIn // This should be the actual input amount
  for (let i = 0; i < bestResult.chunks.length; i++) {
    const ratio = bestResult.chunks[i].amountUsd / tradeSizeUsd
    bestResult.chunks[i].amountWei = BigInt(Math.floor(Number(totalWei) * ratio))
  }

  // Print final result
  const b = bestResult.breakdown
  console.log(`\n✅ OPTIMAL: ${bestResult.numChunks} chunks`)
  console.log(`┌────────────────────────────────────────────────────────────┐`)
  console.log(`│  COST BREAKDOWN                                            │`)
  console.log(`├────────────────────────────────────────────────────────────┤`)
  console.log(`│  Unprotected MEV loss:        $${b.unprotectedCost.toFixed(2).padStart(12)}             │`)
  console.log(`│  ──────────────────────────────────────────────────────    │`)
  console.log(`│  With MEV Shield:                                          │`)
  console.log(`│    Residual MEV exposure:     $${b.mevExposure.toFixed(2).padStart(12)}             │`)
  console.log(`│    Gas fees (${bestResult.chunks.filter(c => !c.usePrivateRelay).length} public tx):     $${b.gasFees.toFixed(2).padStart(12)}             │`)
  console.log(`│    Bridge fees:               $${b.bridgeFees.toFixed(2).padStart(12)}             │`)
  console.log(`│    Private relay fees:        $${b.privateRelayFees.toFixed(2).padStart(12)}             │`)
  console.log(`│  ──────────────────────────────────────────────────────    │`)
  console.log(`│  TOTAL COST:                  $${b.totalCost.toFixed(2).padStart(12)}             │`)
  console.log(`│  SAVINGS:                     $${b.savings.toFixed(2).padStart(12)} (${b.savingsPercent.toFixed(1)}%)      │`)
  console.log(`└────────────────────────────────────────────────────────────┘`)

  // Print chunk details
  const chainCounts: Record<string, number> = {}
  let privateCount = 0
  for (const chunk of bestResult.chunks) {
    chainCounts[chunk.chain] = (chainCounts[chunk.chain] || 0) + 1
    if (chunk.usePrivateRelay) privateCount++
  }

  console.log(`\n📦 Chunk allocation:`)
  console.log(`   Chains: ${Object.entries(chainCounts).map(([c, n]) => `${c}(${n})`).join(", ")}`)
  console.log(`   Private relay: ${privateCount}/${bestResult.numChunks} chunks`)

  // Build reasoning
  const chainsUsed = [...new Set(bestResult.chunks.map((c) => c.chain))]
  let reasoning = `${bestResult.numChunks} chunks across ${chainsUsed.join("+")}. `
  reasoning += `Saves $${b.savings.toFixed(2)} (${b.savingsPercent.toFixed(1)}%). `
  if (privateCount > 0) {
    reasoning += `${privateCount} chunks via private relay. `
  }
  if (b.bridgeFees > 0) {
    reasoning += `Bridge fees: $${b.bridgeFees.toFixed(2)}. `
  }

  return {
    totalChunks: bestResult.numChunks,
    chunks: bestResult.chunks,
    costs: bestResult.breakdown,
    reasoning,
  }
}