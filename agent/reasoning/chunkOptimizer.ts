import { SandwichSimulation } from "../perception/simulator"
import { UserPolicy } from "../core/types"
import { chainClients, getAvailableChains } from "../core/config"

export interface ChunkPlan {
  count: number
  sizes: number[]
  chains: string[]
  blockDelays: number[]
  crossChain: boolean
  reasoning: string
  economics: ChunkEconomics[]
  totalCost: number
}

export interface ChainProfile {
  name: string
  available: boolean
  gasPriceGwei: number
  sandwichGasCostUsd: number  // attacker's cost to sandwich on this chain
  safeThresholdUsd: number    // chunk value below which attack is unprofitable
  userSwapGasCostUsd: number  // user's cost to execute a swap on this chain
  bridgeCostUsd: number       // cost to bridge from ethereum to this chain
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

// Bridge costs are variable but we can estimate conservatively
// These are rough averages for standard ERC20 bridges
const BRIDGE_COST_ESTIMATES: Record<string, number> = {
  ethereum: 0,      // no bridge needed
  arbitrum: 2.50,   // ~$2-3 via native bridge or hop
  base: 1.80,       // ~$1.50-2 via native bridge
}

export async function profileChains(ethPriceUsd: number): Promise<Record<string, ChainProfile>> {
  const profiles: Record<string, ChainProfile> = {}
  const chains = getAvailableChains()

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
      }
      continue
    }

    try {
      const gasPrice = await entry.client.getGasPrice()
      const gasPriceGwei = Number(gasPrice) / 1e9

      // Attacker's sandwich cost on this chain
      const sandwichGasWei = SANDWICH_GAS_UNITS * gasPrice
      const sandwichGasCostUsd = (Number(sandwichGasWei) / 1e18) * ethPriceUsd

      // User's swap cost on this chain
      const swapGasWei = SWAP_GAS_UNITS * gasPrice
      const userSwapGasCostUsd = (Number(swapGasWei) / 1e18) * ethPriceUsd

      // Safe threshold: chunk must be below this to be unprofitable to attack
      // Attacker needs profit > gas cost, so threshold = 2x gas cost (margin of safety)
      const safeThresholdUsd = sandwichGasCostUsd * 2

      const bridgeCostUsd = BRIDGE_COST_ESTIMATES[chainName] ?? 3.0

      profiles[chainName] = {
        name: chainName,
        available: true,
        gasPriceGwei,
        sandwichGasCostUsd,
        safeThresholdUsd,
        userSwapGasCostUsd,
        bridgeCostUsd,
      }

      console.log(
        `⛓️ ${chainName}: gas=${gasPriceGwei.toFixed(3)} gwei | ` +
        `attacker cost=$${sandwichGasCostUsd.toFixed(3)} | ` +
        `safe threshold=$${safeThresholdUsd.toFixed(3)} | ` +
        `user swap=$${userSwapGasCostUsd.toFixed(3)} | ` +
        `bridge=$${bridgeCostUsd.toFixed(2)}`
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
      }
    }
  }

  return profiles
}

// Core AMM math for MEV estimation per chunk
function estimateChunkMev(chunkValueUsd: number, totalTradeUsd: number, fullTradeMevUsd: number): number {
  // MEV scales roughly quadratically with trade size relative to pool
  // mev(chunk) / mev(total) ≈ (chunk/total)^2
  // This is because sandwich profit depends on price impact which is proportional to trade size
  const ratio = chunkValueUsd / totalTradeUsd
  return fullTradeMevUsd * ratio * ratio
}

// Find optimal chunk distribution minimizing total cost
export async function optimizeChunks(
  sim: SandwichSimulation,
  policy: UserPolicy,
  tradeSizeUsd: number
): Promise<ChunkPlan> {
  const ethPriceUsd = sim.cleanOutputRaw > 0n && sim.outDecimals > 0
    ? Number(sim.cleanOutputRaw) / 10 ** sim.outDecimals
    : 2500

  console.log(`\n🧮 Optimizing chunks for $${tradeSizeUsd.toFixed(2)} trade...`)

  // Profile all available chains
  const chainProfiles = await profileChains(ethPriceUsd)
  const availableChains = Object.entries(chainProfiles)
    .filter(([_, p]) => p.available)
    .map(([name]) => name)

  console.log(`⛓️ Available chains: ${availableChains.join(", ")}`)

  if (availableChains.length === 0) {
    console.log("❌ No chains available")
    return singleChunkFallback(tradeSizeUsd, sim)
  }

  // For each possible chunk count (2-7), find the best distribution
  // Then pick the chunk count with lowest total cost
  let bestPlan: ChunkPlan | null = null
  let bestTotalCost = Infinity

  for (let numChunks = 2; numChunks <= 7; numChunks++) {
    const plan = optimizeForChunkCount(
      numChunks,
      tradeSizeUsd,
      sim.estimatedLossUsd,
      chainProfiles,
      availableChains,
      policy
    )

    if (plan.totalCost < bestTotalCost) {
      bestTotalCost = plan.totalCost
      bestPlan = plan
    }

    console.log(`   ${numChunks} chunks: total cost = $${plan.totalCost.toFixed(2)} (mev=$${plan.economics.reduce((s, e) => s + e.mevExposureUsd, 0).toFixed(2)} + gas=$${plan.economics.reduce((s, e) => s + e.userGasCostUsd, 0).toFixed(2)} + bridge=$${plan.economics.reduce((s, e) => s + e.bridgeCostUsd, 0).toFixed(2)})`)
  }

  if (!bestPlan) return singleChunkFallback(tradeSizeUsd, sim)

  console.log(`\n✅ Optimal: ${bestPlan.count} chunks, total cost $${bestPlan.totalCost.toFixed(2)}`)
  bestPlan.economics.forEach((e, i) => {
    console.log(
      `   Chunk ${i}: ${e.sizePercent}% = $${e.valueUsd.toFixed(0)} on ${e.chain} | ` +
      `mev=$${e.mevExposureUsd.toFixed(2)} gas=$${e.userGasCostUsd.toFixed(2)} bridge=$${e.bridgeCostUsd.toFixed(2)} | ` +
      `total=$${e.totalCostUsd.toFixed(2)} ${e.safe ? "✅" : "⚠️"} | delay=${e.blockDelay}`
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
): ChunkPlan & { totalCost: number } {
  const dollarPerPercent = tradeSizeUsd / 100

  // Step 1: Calculate base even split
  const basePercent = Math.floor(100 / numChunks)
  const remainder = 100 - basePercent * numChunks
  const sizes: number[] = []
  for (let i = 0; i < numChunks; i++) {
    sizes.push(basePercent + (i < remainder ? 1 : 0))
  }

  // Step 2: Add controlled randomization (±20% of base, keeping sum at 100)
  // Swap random pairs to create unequal distribution
  for (let i = 0; i < numChunks - 1; i++) {
    const maxShift = Math.max(1, Math.floor(sizes[i] * 0.3))
    const shift = Math.floor(Math.random() * maxShift) + 1
    // Only shift if both chunks stay >= 2%
    if (sizes[i] - shift >= 2 && sizes[i + 1] + shift <= 50) {
      sizes[i] -= shift
      sizes[i + 1] += shift
    }
  }

  // Shuffle so the pattern isn't always small-to-large
  for (let i = sizes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[sizes[i], sizes[j]] = [sizes[j], sizes[i]]
  }

  // Step 3: Assign each chunk to the chain that minimizes its cost
  const economics: ChunkEconomics[] = []
  const chainUsageCounts: Record<string, number> = {}
  availableChains.forEach((c) => (chainUsageCounts[c] = 0))

  for (let i = 0; i < numChunks; i++) {
    const chunkValueUsd = sizes[i] * dollarPerPercent
    const chunkMevUsd = estimateChunkMev(chunkValueUsd, tradeSizeUsd, fullMevUsd)

    // First chunk must be ethereum (no bridge delay)
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

    // For remaining chunks: evaluate each chain and pick lowest total cost
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

      // Penalize overusing a single chain — attackers can detect patterns on one chain
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
          totalCostUsd: mevCost + gasCost + bridgeCost, // don't include penalty in reported cost
          safe,
          blockDelay: 0, // assigned below
        }
      }
    }

    if (bestEcon) {
      economics.push(bestEcon)
      chainUsageCounts[bestChain]++
    }
  }

  // Step 4: Assign block delays
  // Goal: spread chunks across blocks, more delay for conservative profiles
  const delayMultiplier = policy.riskProfile === "conservative" ? 2 : policy.riskProfile === "aggressive" ? 1 : 1
  for (let i = 0; i < economics.length; i++) {
    if (i === 0) {
      economics[i].blockDelay = 0
    } else {
      // Stagger: 1-3 blocks between each chunk
      // Cross-chain chunks need more delay (bridge confirmation)
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
  const allSafe = economics.every((e) => e.safe)

  const usedChains = [...new Set(economics.map((e) => e.chain))]
  const crossChain = usedChains.length > 1

  const executionBlocks = economics.reduce((max, e) => Math.max(max, e.blockDelay), 0) + 1

  const reasoning = buildReasoning(numChunks, economics, totalMev, totalGas, totalBridge, fullMevUsd, allSafe, usedChains)

  return {
    count: numChunks,
    sizes,
    chains: economics.map((e) => e.chain),
    blockDelays: economics.map((e) => e.blockDelay),
    crossChain,
    reasoning,
    economics,
    totalCost,
  }
}

function buildReasoning(
  numChunks: number,
  economics: ChunkEconomics[],
  totalMev: number,
  totalGas: number,
  totalBridge: number,
  originalMev: number,
  allSafe: boolean,
  usedChains: string[]
): string {
  const mevReduction = originalMev > 0 ? ((1 - totalMev / originalMev) * 100).toFixed(1) : "100"
  const unsafeCount = economics.filter((e) => !e.safe).length

  let reasoning = `${numChunks} chunks across ${usedChains.join("+")} reduces MEV exposure by ${mevReduction}%. `
  reasoning += `User overhead: $${(totalGas + totalBridge).toFixed(2)} (gas $${totalGas.toFixed(2)} + bridge $${totalBridge.toFixed(2)}). `

  if (allSafe) {
    reasoning += `All chunks below safe threshold — no chunk is profitable to sandwich.`
  } else {
    reasoning += `${unsafeCount} chunk(s) still above safe threshold — consider private relay for those.`
  }

  return reasoning
}

function singleChunkFallback(tradeSizeUsd: number, sim: SandwichSimulation): ChunkPlan {
  return {
    count: 1,
    sizes: [100],
    chains: ["ethereum"],
    blockDelays: [0],
    crossChain: false,
    reasoning: "No optimization possible — single chain only.",
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
  }
}