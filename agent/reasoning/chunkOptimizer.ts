import { SandwichSimulation } from "../perception/simulator"
import { UserPolicy } from "../core/types"
import { chainClients, getAvailableChains } from "../core/config"
import { estimateCrossChainCost } from "../actions/lifiRouter"

export interface ChunkPlan {
  count: number
  sizes: number[]
  chains: string[]
  blockDelays: number[]
  crossChain: boolean
  reasoning: string
  economics: ChunkEconomics[]
  totalCost: number
  costBreakdown: CostBreakdown
}

export interface CostBreakdown {
  totalMevExposure: number
  totalUserGas: number
  totalBridgeFees: number
  totalCost: number
  unprotectedCost: number
  savings: number
  savingsPercent: number
}

export interface ChainProfile {
  name: string
  available: boolean
  gasPriceGwei: number
  sandwichGasCostUsd: number
  safeThresholdUsd: number
  userSwapGasCostUsd: number
  bridgeCostUsd: number
  bridgeCostReal: boolean // true if from LI.FI, false if estimated
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

const SANDWICH_GAS_UNITS = 300000n
const SWAP_GAS_UNITS = 180000n

// Cache LI.FI quotes to avoid repeated API calls
const bridgeCostCache = new Map<string, { cost: number; timestamp: number }>()
const CACHE_TTL_MS = 60 * 1000 // 1 minute

async function getRealBridgeCost(
  fromChain: string,
  toChain: string,
  tokenIn: string,
  tokenOut: string,
  testAmount: bigint,
  userAddress: string
): Promise<number | null> {
  const cacheKey = `${fromChain}-${toChain}-${tokenIn}-${tokenOut}`
  const cached = bridgeCostCache.get(cacheKey)
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.cost
  }

  const estimate = await estimateCrossChainCost(
    fromChain,
    toChain,
    tokenIn,
    tokenOut,
    testAmount,
    userAddress
  )

  if (estimate) {
    bridgeCostCache.set(cacheKey, { cost: estimate.totalCostUsd, timestamp: Date.now() })
    return estimate.totalCostUsd
  }

  return null
}

export async function profileChains(
  ethPriceUsd: number,
  tokenIn: string,
  tokenOut: string,
  testAmount: bigint,
  userAddress: string
): Promise<Record<string, ChainProfile>> {
  const profiles: Record<string, ChainProfile> = {}
  const chains = getAvailableChains()

  console.log(`\n⛓️ Profiling chains with real bridge costs...`)

  for (const chainName of chains) {
    const entry = chainClients[chainName]
    if (!entry) {
      profiles[chainName] = {
        name: chainName,
        available: false,
        gasPriceGwei: 0,
        sandwichGasCostUsd: 0,
        safeThresholdUsd: 0,
        userSwapGasCostUsd: 0,
        bridgeCostUsd: 0,
        bridgeCostReal: false,
      }
      continue
    }

    try {
      const gasPrice = await entry.client.getGasPrice()
      const gasPriceGwei = Number(gasPrice) / 1e9

      const sandwichGasWei = SANDWICH_GAS_UNITS * gasPrice //needs to be more dynamic 
      const sandwichGasCostUsd = (Number(sandwichGasWei) / 1e18) * ethPriceUsd
      console.log(`   ${chainName}: gas=${gasPriceGwei.toFixed(3)} gwei | sandwich cost=$${sandwichGasCostUsd.toFixed(2)}`)
      const swapGasWei = SWAP_GAS_UNITS * gasPrice
      const userSwapGasCostUsd = (Number(swapGasWei) / 1e18) * ethPriceUsd

      const safeThresholdUsd = sandwichGasCostUsd * 2

      // Get real bridge cost from LI.FI for non-ethereum chains
      let bridgeCostUsd = 0
      let bridgeCostReal = false
      
      if (chainName !== "ethereum") {
        const realCost = await getRealBridgeCost(
          "ethereum",
          chainName,
          tokenIn,
          tokenOut,
          testAmount,
          userAddress
        )
        
        if (realCost !== null) {
          bridgeCostUsd = realCost
          bridgeCostReal = true
        } else {
          // Fallback estimates (conservative)
          bridgeCostUsd = chainName === "arbitrum" ? 15 : chainName === "base" ? 12 : 20
          bridgeCostReal = false
        }
      }

      profiles[chainName] = {
        name: chainName,
        available: true,
        gasPriceGwei,
        sandwichGasCostUsd,
        safeThresholdUsd,
        userSwapGasCostUsd,
        bridgeCostUsd,
        bridgeCostReal,
      }

      const bridgeInfo = bridgeCostReal ? `$${bridgeCostUsd.toFixed(2)} (LI.FI)` : `~$${bridgeCostUsd.toFixed(2)} (est)`
      console.log(
        `⛓️ ${chainName}: gas=${gasPriceGwei.toFixed(3)} gwei | ` +
        `safe threshold=$${safeThresholdUsd.toFixed(2)} | ` +
        `swap gas=$${userSwapGasCostUsd.toFixed(3)} | ` +
        `bridge=${chainName === "ethereum" ? "N/A" : bridgeInfo}`
      )
    } catch (err) {
      console.log(`⛓️ ${chainName}: ❌ RPC failed — ${(err as Error).message}`)
      profiles[chainName] = {
        name: chainName,
        available: false,
        gasPriceGwei: 0,
        sandwichGasCostUsd: 0,
        safeThresholdUsd: 0,
        userSwapGasCostUsd: 0,
        bridgeCostUsd: 0,
        bridgeCostReal: false,
      }
    }
  }

  return profiles
}

function estimateChunkMev(chunkValueUsd: number, totalTradeUsd: number, fullTradeMevUsd: number): number {
  const ratio = chunkValueUsd / totalTradeUsd
  return fullTradeMevUsd * ratio * ratio
}

export async function optimizeChunks(
  sim: SandwichSimulation,
  policy: UserPolicy,
  tradeSizeUsd: number
): Promise<ChunkPlan> {
  const ethPriceUsd = sim.ethPriceUsd

  console.log(`\n🧮 Optimizing chunks for $${tradeSizeUsd.toFixed(2)} trade...`)
  console.log(`📊 Unprotected MEV loss: $${sim.estimatedLossUsd.toFixed(2)}`)

  // Use 10% of trade as test amount for bridge quotes
  const testAmount = sim.reserveIn / 10n > 0n ? sim.reserveIn / 10n : 1000000000000000000n

  // Profile chains with real bridge costs
  const chainProfiles = await profileChains(
    ethPriceUsd,
    sim.tokenIn,
    sim.tokenOut,
    testAmount,
    "0x0000000000000000000000000000000000000001"
  )

  const availableChains = Object.entries(chainProfiles)
    .filter(([_, p]) => p.available)
    .map(([name]) => name)

  console.log(`⛓️ Available chains: ${availableChains.join(", ")}`)

  if (availableChains.length === 0) {
    return singleChunkFallback(tradeSizeUsd, sim)
  }

  // Check if cross-chain is even worth it
  const minBridgeCost = Math.min(
    ...Object.values(chainProfiles)
      .filter(p => p.available && p.name !== "ethereum")
      .map(p => p.bridgeCostUsd)
  )

  const crossChainWorthIt = minBridgeCost < sim.estimatedLossUsd / 7 // Bridge must be cheaper than ~14% of MEV loss per chunk

  if (!crossChainWorthIt) {
    console.log(`⚠️ Bridge costs ($${minBridgeCost.toFixed(2)}+) too high for cross-chain. Staying on Ethereum.`)
  }

  // Evaluate chunk counts 2-7
  let bestPlan: ChunkPlan | null = null
  let bestTotalCost = Infinity

  for (let numChunks = 2; numChunks <= 7; numChunks++) {
    const plan = optimizeForChunkCount(
      numChunks,
      tradeSizeUsd,
      sim.estimatedLossUsd,
      chainProfiles,
      crossChainWorthIt ? availableChains : ["ethereum"],
      policy
    )

    if (plan.totalCost < bestTotalCost) {
      bestTotalCost = plan.totalCost
      bestPlan = plan
    }

    const breakdown = plan.costBreakdown
    console.log(
      `   ${numChunks} chunks: ` +
      `MEV=$${breakdown.totalMevExposure.toFixed(2)} + ` +
      `Gas=$${breakdown.totalUserGas.toFixed(2)} + ` +
      `Bridge=$${breakdown.totalBridgeFees.toFixed(2)} = ` +
      `$${breakdown.totalCost.toFixed(2)} ` +
      `(saves $${breakdown.savings.toFixed(2)}, ${breakdown.savingsPercent.toFixed(1)}%)`
    )
  }

  if (!bestPlan) return singleChunkFallback(tradeSizeUsd, sim)

  // Print final summary
  const b = bestPlan.costBreakdown
  console.log(`\n✅ Optimal: ${bestPlan.count} chunks`)
  console.log(`┌─────────────────────────────────────────────────────┐`)
  console.log(`│  COST BREAKDOWN                                     │`)
  console.log(`├─────────────────────────────────────────────────────┤`)
  console.log(`│  Unprotected MEV loss:     $${b.unprotectedCost.toFixed(2).padStart(10)}            │`)
  console.log(`│  ─────────────────────────────────────────────────  │`)
  console.log(`│  With MEV Shield:                                   │`)
  console.log(`│    MEV exposure:           $${b.totalMevExposure.toFixed(2).padStart(10)}            │`)
  console.log(`│    User gas fees:          $${b.totalUserGas.toFixed(2).padStart(10)}            │`)
  console.log(`│    Bridge fees:            $${b.totalBridgeFees.toFixed(2).padStart(10)}            │`)
  console.log(`│  ─────────────────────────────────────────────────  │`)
  console.log(`│  TOTAL COST:               $${b.totalCost.toFixed(2).padStart(10)}            │`)
  console.log(`│  SAVINGS:                  $${b.savings.toFixed(2).padStart(10)} (${b.savingsPercent.toFixed(1)}%)     │`)
  console.log(`└─────────────────────────────────────────────────────┘`)

  bestPlan.economics.forEach((e, i) => {
    const safeIcon = e.safe ? "✅" : "⚠️"
    console.log(
      `   Chunk ${i}: ${e.sizePercent}% = $${e.valueUsd.toFixed(0)} on ${e.chain} | ` +
      `mev=$${e.mevExposureUsd.toFixed(2)} gas=$${e.userGasCostUsd.toFixed(2)} bridge=$${e.bridgeCostUsd.toFixed(2)} | ` +
      `total=$${e.totalCostUsd.toFixed(2)} ${safeIcon} | delay=${e.blockDelay}`
    )
  })

  console.log(`   Reasoning: ${bestPlan.reasoning}\n`)

  return bestPlan
}

function optimizeForChunkCount(
  numChunks: number,
  tradeSizeUsd: number,
  fullMevUsd: number,
  chainProfiles: Record<string, ChainProfile>,
  availableChains: string[],
  policy: UserPolicy
): ChunkPlan {
  const dollarPerPercent = tradeSizeUsd / 100

  // Calculate base even split with randomization
  const basePercent = Math.floor(100 / numChunks)
  const remainder = 100 - basePercent * numChunks
  const sizes: number[] = []
  for (let i = 0; i < numChunks; i++) {
    sizes.push(basePercent + (i < remainder ? 1 : 0))
  }

  // Add controlled randomization
  for (let i = 0; i < numChunks - 1; i++) {
    const maxShift = Math.max(1, Math.floor(sizes[i] * 0.3))
    const shift = Math.floor(Math.random() * maxShift) + 1
    if (sizes[i] - shift >= 2 && sizes[i + 1] + shift <= 50) {
      sizes[i] -= shift
      sizes[i + 1] += shift
    }
  }

  // Shuffle
  for (let i = sizes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[sizes[i], sizes[j]] = [sizes[j], sizes[i]]
  }

  // Assign chains to minimize cost
  const economics: ChunkEconomics[] = []
  const chainUsageCounts: Record<string, number> = {}
  availableChains.forEach((c) => (chainUsageCounts[c] = 0))

  for (let i = 0; i < numChunks; i++) {
    const chunkValueUsd = sizes[i] * dollarPerPercent
    const chunkMevUsd = estimateChunkMev(chunkValueUsd, tradeSizeUsd, fullMevUsd)

    // First chunk must be ethereum
    if (i === 0) {
      const profile = chainProfiles["ethereum"]!
      const safe = chunkValueUsd <= profile.safeThresholdUsd
      economics.push({
        index: i,
        sizePercent: sizes[i],
        valueUsd: chunkValueUsd,
        chain: "ethereum",
        mevExposureUsd: safe ? 0 : chunkMevUsd,
        userGasCostUsd: profile.userSwapGasCostUsd,
        bridgeCostUsd: 0,
        totalCostUsd: (safe ? 0 : chunkMevUsd) + profile.userSwapGasCostUsd,
        safe,
        blockDelay: 0,
      })
      chainUsageCounts["ethereum"]++
      continue
    }

    // Evaluate each chain
    let bestChain = "ethereum"
    let bestCost = Infinity
    let bestEcon: ChunkEconomics | null = null

    for (const chainName of availableChains) {
      const profile = chainProfiles[chainName]
      if (!profile || !profile.available) continue

      const safe = chunkValueUsd <= profile.safeThresholdUsd
      const mevCost = safe ? 0 : chunkMevUsd
      const gasCost = profile.userSwapGasCostUsd
      const bridgeCost = profile.bridgeCostUsd

      // Penalize overusing one chain
      const usagePenalty = chainUsageCounts[chainName] > 1 ? chainUsageCounts[chainName] * 0.5 : 0

      const totalCost = mevCost + gasCost + bridgeCost + usagePenalty

      if (totalCost < bestCost) {
        bestCost = totalCost
        bestChain = chainName
        bestEcon = {
          index: i,
          sizePercent: sizes[i],
          valueUsd: chunkValueUsd,
          chain: chainName,
          mevExposureUsd: mevCost,
          userGasCostUsd: gasCost,
          bridgeCostUsd: bridgeCost,
          totalCostUsd: mevCost + gasCost + bridgeCost,
          safe,
          blockDelay: 0,
        }
      }
    }

    if (bestEcon) {
      economics.push(bestEcon)
      chainUsageCounts[bestChain]++
    }
  }

  // Assign block delays
  const delayMultiplier = policy.riskProfile === "conservative" ? 2 : policy.riskProfile === "aggressive" ? 1 : 1
  for (let i = 0; i < economics.length; i++) {
    if (i === 0) {
      economics[i].blockDelay = 0
    } else {
      const isXChain = economics[i].chain !== "ethereum"
      const baseDelay = isXChain ? 2 : 1
      economics[i].blockDelay = Math.min(baseDelay * delayMultiplier, 4)
    }
  }

  // Calculate totals
  const totalMev = economics.reduce((s, e) => s + e.mevExposureUsd, 0)
  const totalGas = economics.reduce((s, e) => s + e.userGasCostUsd, 0)
  const totalBridge = economics.reduce((s, e) => s + e.bridgeCostUsd, 0)
  const totalCost = totalMev + totalGas + totalBridge
  const savings = fullMevUsd - totalCost
  const savingsPercent = fullMevUsd > 0 ? (savings / fullMevUsd) * 100 : 0

  const allSafe = economics.every((e) => e.safe)
  const usedChains = [...new Set(economics.map((e) => e.chain))]
  const crossChain = usedChains.length > 1

  const costBreakdown: CostBreakdown = {
    totalMevExposure: totalMev,
    totalUserGas: totalGas,
    totalBridgeFees: totalBridge,
    totalCost,
    unprotectedCost: fullMevUsd,
    savings,
    savingsPercent,
  }

  const reasoning = buildReasoning(numChunks, usedChains, costBreakdown, allSafe)

  return {
    count: numChunks,
    sizes,
    chains: economics.map((e) => e.chain),
    blockDelays: economics.map((e) => e.blockDelay),
    crossChain,
    reasoning,
    economics,
    totalCost,
    costBreakdown,
  }
}

function buildReasoning(
  numChunks: number,
  usedChains: string[],
  breakdown: CostBreakdown,
  allSafe: boolean
): string {
  let reasoning = `${numChunks} chunks across ${usedChains.join("+")}. `
  reasoning += `Saves $${breakdown.savings.toFixed(2)} (${breakdown.savingsPercent.toFixed(1)}% of MEV loss). `
  reasoning += `User pays $${(breakdown.totalUserGas + breakdown.totalBridgeFees).toFixed(2)} in fees. `

  if (allSafe) {
    reasoning += `All chunks below sandwich threshold.`
  } else {
    reasoning += `Some chunks still above threshold — private relay recommended.`
  }

  return reasoning
}

function singleChunkFallback(tradeSizeUsd: number, sim: SandwichSimulation): ChunkPlan {
  const costBreakdown: CostBreakdown = {
    totalMevExposure: sim.estimatedLossUsd,
    totalUserGas: 0,
    totalBridgeFees: 0,
    totalCost: sim.estimatedLossUsd,
    unprotectedCost: sim.estimatedLossUsd,
    savings: 0,
    savingsPercent: 0,
  }

  return {
    count: 1,
    sizes: [100],
    chains: ["ethereum"],
    blockDelays: [0],
    crossChain: false,
    reasoning: "No optimization possible — single chunk on Ethereum.",
    economics: [{
      index: 0,
      sizePercent: 100,
      valueUsd: tradeSizeUsd,
      chain: "ethereum",
      mevExposureUsd: sim.estimatedLossUsd,
      userGasCostUsd: 0,
      bridgeCostUsd: 0,
      totalCostUsd: sim.estimatedLossUsd,
      safe: false,
      blockDelay: 0,
    }],
    totalCost: sim.estimatedLossUsd,
    costBreakdown,
  }
}