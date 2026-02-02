import { UserPolicy } from "../core/types"
import { SandwichSimulation } from "../perception/simulator"

export interface ChunkPlan {
  count: number
  sizes: number[] // percentages of total, sum = 100
  crossChain: boolean
  reasoning: string
}

export type Strategy =
  | { type: "DIRECT"; reasoning: string }
  | { type: "MEV_ROUTE"; reasoning: string }
  | { type: "SPLIT"; plan: ChunkPlan; reasoning: string }
  | { type: "PRIVATE"; reasoning: string }
  | { type: "FULL_SHIELD"; plan: ChunkPlan; reasoning: string }

// Generate random unequal chunk sizes that sum to 100
function randomChunkSizes(count: number): number[] {
  // Generate random breakpoints
  const points: number[] = []
  for (let i = 0; i < count - 1; i++) {
    points.push(Math.random() * 100)
  }
  points.push(0)
  points.push(100)
  points.sort((a, b) => a - b)

  const sizes: number[] = []
  for (let i = 1; i < points.length; i++) {
    const size = Math.round(points[i] - points[i - 1])
    if (size > 0) sizes.push(size)
  }

  // If rounding killed a chunk, redistribute
  while (sizes.length < count) sizes.push(1)
  while (sizes.length > count) sizes.pop()

  // Fix sum to 100
  const sum = sizes.reduce((a, b) => a + b, 0)
  sizes[0] += 100 - sum

  return sizes
}

export function decide(sim: SandwichSimulation, policy: UserPolicy, tradeSizeUsd: number): Strategy {
  const { attackViable, safeChunkThresholdUsd, gasData } = sim

  console.log(`🧠 Deciding: risk=${sim.risk}, viable=${attackViable}, tradeSize=$${tradeSizeUsd.toFixed(2)}, gasCost=$${gasData.sandwichGasCostUsd.toFixed(2)}`)

  // If attack isn't even profitable after gas, no protection needed
  if (!attackViable) {
    return {
      type: "DIRECT",
      reasoning: `Attack not viable. Attacker profit ($${sim.attackerProfitUsd.toFixed(2)}) < gas cost ($${gasData.sandwichGasCostUsd.toFixed(2)}). Safe to execute directly.`,
    }
  }

  // Attack is viable. Calculate optimal chunks.
  // Each chunk must be below safeChunkThresholdUsd to be unprofitable to sandwich
  if (sim.risk === "MEDIUM" && tradeSizeUsd <= policy.privateThresholdUsd) {
    return {
      type: "MEV_ROUTE",
      reasoning: `Medium risk, trade ($${tradeSizeUsd.toFixed(0)}) below private threshold ($${policy.privateThresholdUsd}). Route through safer pools.`,
    }
  }

  // Calculate how many chunks we need so each chunk < safeChunkThresholdUsd
  const neededChunks = safeChunkThresholdUsd > 0
    ? Math.ceil(tradeSizeUsd / safeChunkThresholdUsd)
    : 2

  // Clamp between 2-7 chunks (more than 7 = too much gas overhead for user)
  const chunkCount = Math.max(2, Math.min(7, neededChunks))

  if (sim.risk === "MEDIUM") {
    const sizes = randomChunkSizes(chunkCount)
    return {
      type: "SPLIT",
      plan: {
        count: chunkCount,
        sizes,
        crossChain: false,
        reasoning: `Need ${chunkCount} chunks to get each below $${safeChunkThresholdUsd.toFixed(0)} safe threshold.`,
      },
      reasoning: `Medium risk, above threshold. Splitting into ${chunkCount} unequal chunks.`,
    }
  }

  if (sim.risk === "HIGH") {
    const sizes = randomChunkSizes(chunkCount)
    return {
      type: "SPLIT",
      plan: {
        count: chunkCount,
        sizes,
        crossChain: policy.riskProfile !== "aggressive",
        reasoning: `High risk. ${chunkCount} chunks, cross-chain to break attacker observation.`,
      },
      reasoning: `High risk. Splitting across ${chunkCount} chunks${policy.riskProfile !== "aggressive" ? " + cross-chain routing" : ""}.`,
    }
  }

  // CRITICAL
  const criticalChunks = Math.max(3, Math.min(7, neededChunks + 1))
  const sizes = randomChunkSizes(criticalChunks)
  return {
    type: "FULL_SHIELD",
    plan: {
      count: criticalChunks,
      sizes,
      crossChain: true,
      reasoning: `Critical risk. ${criticalChunks} chunks + cross-chain + private relay.`,
    },
    reasoning: `Critical risk. Full protection: ${criticalChunks} random chunks, cross-chain split, private relay.`,
  }
}