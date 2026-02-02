import { SwapIntent } from "../core/types"
import { ChunkPlan } from "../reasoning/decisionEngine"
import { SandwichSimulation } from "../perception/simulator"
import { publicClient } from "../core/config"
import { parseAbi, getAddress } from "viem"

const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as const

const routerAbi = parseAbi([
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
])

export interface ChunkExecution {
  index: number
  sizePercent: number
  amountIn: bigint
  expectedOut: bigint
  minAmountOut: bigint
  priceImpactPercent: number
  mevExposureUsd: number
  safeTx: boolean // attacker profit < gas cost for this chunk
  route: {
    type: "SAME_CHAIN" | "CROSS_CHAIN"
    chain: string
    dex: string
    path: `0x${string}`[]
  }
  tx: {
    to: `0x${string}`
    data: `0x${string}`
    value: bigint
  } | null
  blockDelay: number // how many blocks to wait before executing this chunk
}

export interface SplitResult {
  chunks: ChunkExecution[]
  totalExpectedOut: bigint
  totalMinOut: bigint
  totalMevExposureUsd: number
  allChunksSafe: boolean
  executionBlocks: number // total blocks the full split spans
}

// Replicate AMM math here so we can simulate each chunk sequentially
// against progressively shifted reserves
function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const amountInWithFee = amountIn * 997n
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * 1000n + amountInWithFee
  return numerator / denominator
}

function sqrt(value: bigint): bigint {
  if (value <= 0n) return 0n
  if (value <= 3n) return 1n
  let z = value
  let x = value / 2n + 1n
  while (x < z) {
    z = x
    x = (value / x + x) / 2n
  }
  return z
}

function calculateOptimalFrontrun(reserveIn: bigint, userAmountIn: bigint): bigint {
  const gamma = 997n
  const base = 1000n
  const gammaR = (gamma * reserveIn) / base
  const gammaUser = (gamma * userAmountIn) / base
  const underSqrt = gammaR * (gammaR + gammaUser)
  const sqrtVal = sqrt(underSqrt)
  if (sqrtVal <= gammaR) return 0n
  return sqrtVal - gammaR
}

function simulateChunkSandwich(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint
): { cleanOut: bigint; attackerProfit: bigint; userLoss: bigint } {
  const cleanOut = getAmountOut(amountIn, reserveIn, reserveOut)

  const frontrun = calculateOptimalFrontrun(reserveIn, amountIn)
  if (frontrun <= 0n) {
    return { cleanOut, attackerProfit: 0n, userLoss: 0n }
  }

  const attackerBought = getAmountOut(frontrun, reserveIn, reserveOut)
  const rIn1 = reserveIn + frontrun
  const rOut1 = reserveOut - attackerBought

  const attackedOut = getAmountOut(amountIn, rIn1, rOut1)
  const rIn2 = rIn1 + amountIn
  const rOut2 = rOut1 - attackedOut

  const attackerSellRevenue = getAmountOut(attackerBought, rOut2, rIn2)
  const attackerProfit = attackerSellRevenue > frontrun
    ? attackerSellRevenue - frontrun
    : 0n

  const userLoss = cleanOut > attackedOut ? cleanOut - attackedOut : 0n

  return { cleanOut, attackerProfit, userLoss }
}

function bigintToNumber(val: bigint, decimals: number): number {
  const str = val.toString()
  if (str.length <= decimals) {
    return Number(val) / 10 ** decimals
  }
  const whole = str.slice(0, str.length - decimals)
  const frac = str.slice(str.length - decimals, str.length - decimals + 6)
  return parseFloat(`${whole}.${frac}`)
}

// Cross-chain target chains for splitting
const CROSS_CHAIN_TARGETS = [
  { chain: "ethereum", chainId: 1 },
  { chain: "arbitrum", chainId: 42161 },
  { chain: "base", chainId: 8453 },
]

export async function buildSplitPlan(
  intent: SwapIntent,
  plan: ChunkPlan,
  sim: SandwichSimulation
): Promise<SplitResult> {
  const amountIn = BigInt(intent.amountIn)
  const tokenIn = intent.tokenIn as `0x${string}`
  const tokenOut = intent.tokenOut as `0x${string}`

  // Current gas economics
  const gasPrice = sim.gasData.gasPriceWei
  const sandwichGasCostWei = 300000n * gasPrice

  // ETH price from simulation data
  const ethPriceUsd = sim.cleanOutputRaw > 0n && amountIn > 0n
    ? bigintToNumber(sim.cleanOutputRaw, sim.outDecimals) / bigintToNumber(amountIn, 18)
    : 2500

  const sandwichGasCostUsd = bigintToNumber(sandwichGasCostWei, 18) * ethPriceUsd

  // Convert percentage sizes to actual bigint amounts
  // Must handle remainder so total = exact amountIn
  const chunkAmounts: bigint[] = []
  let allocated = 0n
  for (let i = 0; i < plan.sizes.length; i++) {
    if (i === plan.sizes.length - 1) {
      // Last chunk gets the remainder — no dust left behind
      chunkAmounts.push(amountIn - allocated)
    } else {
      const chunk = (amountIn * BigInt(plan.sizes[i])) / 100n
      chunkAmounts.push(chunk)
      allocated += chunk
    }
  }

  // Simulate each chunk sequentially against progressively shifting reserves
  // After chunk N executes, the pool reserves change, affecting chunk N+1
  let currentReserveIn = sim.reserveIn
  let currentReserveOut = sim.reserveOut

  const chunks: ChunkExecution[] = []
  let totalExpectedOut = 0n
  let totalMinOut = 0n
  let totalMevExposure = 0
  let allSafe = true

  for (let i = 0; i < chunkAmounts.length; i++) {
    const chunkAmount = chunkAmounts[i]

    // Simulate this chunk's sandwich against current reserves
    const chunkSim = simulateChunkSandwich(chunkAmount, currentReserveIn, currentReserveOut)

    // Clean output for this chunk
    const expectedOut = chunkSim.cleanOut

    // Attacker economics for this specific chunk
    const attackerProfitEth = bigintToNumber(chunkSim.attackerProfit, 18)
    const attackerProfitUsd = attackerProfitEth * ethPriceUsd
    const chunkSafe = attackerProfitUsd <= sandwichGasCostUsd

    if (!chunkSafe) allSafe = false

    // MEV exposure for this chunk
    const chunkLossUsd = bigintToNumber(chunkSim.userLoss, sim.outDecimals)
    totalMevExposure += chunkLossUsd

    // Price impact: how much does this chunk alone move the price?
    // (expectedOut / chunkAmount) vs (reserveOut / reserveIn) = spot price
    const spotPrice = currentReserveIn > 0n
      ? bigintToNumber(currentReserveOut, sim.outDecimals) / bigintToNumber(currentReserveIn, 18)
      : 0
    const execPrice = chunkAmount > 0n
      ? bigintToNumber(expectedOut, sim.outDecimals) / bigintToNumber(chunkAmount, 18)
      : 0
    const priceImpact = spotPrice > 0 ? ((spotPrice - execPrice) / spotPrice) * 100 : 0

    // Min output: apply user's max slippage (default 0.5%)
    // For now hardcoded, will come from ENS policy later
    const slippageBps = 50n // 0.5%
    const minOut = (expectedOut * (10000n - slippageBps)) / 10000n

    totalExpectedOut += expectedOut
    totalMinOut += minOut

    // Assign route: distribute across chains if cross-chain enabled
    let route: ChunkExecution["route"]
    if (plan.crossChain && i > 0) {
      // First chunk stays on source chain, rest distribute across chains
      const targetIdx = (i - 1) % (CROSS_CHAIN_TARGETS.length - 1) + 1
      const target = CROSS_CHAIN_TARGETS[targetIdx]
      route = {
        type: "CROSS_CHAIN",
        chain: target.chain,
        dex: "lifi", // LI.FI handles cross-chain routing
        path: [tokenIn, tokenOut],
      }
    } else {
      route = {
        type: "SAME_CHAIN",
        chain: "ethereum",
        dex: "uniswap_v2",
        path: [tokenIn, tokenOut],
      }
    }

    // Block delay: stagger execution across blocks
    // First chunk: immediate. Rest: 1-3 block gaps, randomized
    const blockDelay = i === 0 ? 0 : Math.floor(Math.random() * 3) + 1

    // Build unsigned tx calldata for same-chain chunks
    let tx: ChunkExecution["tx"] = null
    if (route.type === "SAME_CHAIN") {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300) // 5 min
      // Encode swapExactTokensForTokens calldata
      const { encodeFunctionData } = await import("viem")
      const data = encodeFunctionData({
        abi: routerAbi,
        functionName: "swapExactTokensForTokens",
        args: [chunkAmount, minOut, [tokenIn, tokenOut], intent.user as `0x${string}`, deadline],
      })

      tx = {
        to: UNISWAP_V2_ROUTER,
        data,
        value: 0n,
      }
    }
    // Cross-chain chunks would get LI.FI tx data — implemented in lifiRouter.ts

    chunks.push({
      index: i,
      sizePercent: plan.sizes[i],
      amountIn: chunkAmount,
      expectedOut,
      minAmountOut: minOut,
      priceImpactPercent: Number(priceImpact.toFixed(4)),
      mevExposureUsd: Number(chunkLossUsd.toFixed(2)),
      safeTx: chunkSafe,
      route,
      tx,
      blockDelay,
    })

    // Update reserves for next chunk simulation
    // After this chunk executes (clean, no attacker), reserves shift
    currentReserveIn = currentReserveIn + chunkAmount
    currentReserveOut = currentReserveOut - expectedOut

    console.log(
      `📦 Chunk ${i}: ${plan.sizes[i]}% | ` +
      `in=${bigintToNumber(chunkAmount, 18).toFixed(4)} ETH | ` +
      `out=$${bigintToNumber(expectedOut, sim.outDecimals).toFixed(2)} | ` +
      `impact=${priceImpact.toFixed(3)}% | ` +
      `mev=$${chunkLossUsd.toFixed(2)} | ` +
      `safe=${chunkSafe} | ` +
      `${route.type}:${route.chain} | ` +
      `delay=${blockDelay} blocks`
    )
  }

  const executionBlocks = chunks.reduce((max, c) => Math.max(max, c.blockDelay), 0) + 1

  console.log(`\n📊 Split Summary:`)
  console.log(`   Total expected: $${bigintToNumber(totalExpectedOut, sim.outDecimals).toFixed(2)}`)
  console.log(`   Total min out:  $${bigintToNumber(totalMinOut, sim.outDecimals).toFixed(2)}`)
  console.log(`   Total MEV exposure: $${totalMevExposure.toFixed(2)}`)
  console.log(`   All chunks safe: ${allSafe}`)
  console.log(`   Execution span: ${executionBlocks} blocks\n`)

  return {
    chunks,
    totalExpectedOut,
    totalMinOut,
    totalMevExposureUsd: Number(totalMevExposure.toFixed(2)),
    allChunksSafe: allSafe,
    executionBlocks,
  }
}