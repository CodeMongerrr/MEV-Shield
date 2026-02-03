import { SwapIntent } from "../core/types"
import { ChunkPlan } from "../reasoning/chunkOptimizer"
import { SandwichSimulation } from "../perception/simulator"
import { parseAbi } from "viem"
import { buildCrossChainTx, CrossChainTx } from "./lifiRouter"

const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as const

const routerAbi = parseAbi([
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
])

/* ---------------- FIXED POINT % MATH ---------------- */

const PERCENT_SCALE = 1_000_000n as bigint
const HUNDRED_PERCENT = 100n * PERCENT_SCALE

function percentToScaled(p: number): bigint {
  return BigInt(Math.round(p * 1_000_000))
}
/* ---------------- TYPES (UNCHANGED) ---------------- */

export interface ChunkExecution {
  index: number
  sizePercent: number
  amountIn: bigint
  expectedOut: bigint
  minAmountOut: bigint
  priceImpactPercent: number
  mevExposureUsd: number
  safeTx: boolean
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
  crossChainTx: CrossChainTx | null
  blockDelay: number
}

export interface SplitResult {
  chunks: ChunkExecution[]
  totalExpectedOut: bigint
  totalMinOut: bigint
  totalMevExposureUsd: number
  allChunksSafe: boolean
  executionBlocks: number
}

/* ---------------- AMM MATH ---------------- */

function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const amountInWithFee = amountIn * 997n
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee)
}

function sqrt(value: bigint): bigint {
  if (value <= 3n) return value > 0n ? 1n : 0n
  let z = value
  let x = value / 2n + 1n
  while (x < z) {
    z = x
    x = (value / x + x) / 2n
  }
  return z
}

function calculateOptimalFrontrun(reserveIn: bigint, userAmountIn: bigint): bigint {
  const gammaR = (997n * reserveIn) / 1000n
  const gammaUser = (997n * userAmountIn) / 1000n
  const root = sqrt(gammaR * (gammaR + gammaUser))
  return root > gammaR ? root - gammaR : 0n
}

function simulateChunkSandwich(amountIn: bigint, reserveIn: bigint, reserveOut: bigint) {
  const cleanOut = getAmountOut(amountIn, reserveIn, reserveOut)
  const frontrun = calculateOptimalFrontrun(reserveIn, amountIn)
  if (frontrun === 0n) return { cleanOut, attackerProfit: 0n, userLoss: 0n }

  const attackerBought = getAmountOut(frontrun, reserveIn, reserveOut)
  const rIn1 = reserveIn + frontrun
  const rOut1 = reserveOut - attackerBought

  const attackedOut = getAmountOut(amountIn, rIn1, rOut1)
  const rIn2 = rIn1 + amountIn
  const rOut2 = rOut1 - attackedOut

  const attackerSellRevenue = getAmountOut(attackerBought, rOut2, rIn2)
  const attackerProfit = attackerSellRevenue > frontrun ? attackerSellRevenue - frontrun : 0n
  const userLoss = cleanOut > attackedOut ? cleanOut - attackedOut : 0n

  return { cleanOut, attackerProfit, userLoss }
}

function bigintToNumber(val: bigint, decimals: number): number {
  return Number(val) / 10 ** decimals
}

/* ---------------- MAIN ENGINE ---------------- */

export async function buildSplitPlan(
  intent: SwapIntent,
  plan: ChunkPlan,
  sim: SandwichSimulation
): Promise<SplitResult> {

  const amountIn: bigint =
  typeof intent.amountIn === "bigint"
    ? intent.amountIn
    : BigInt(intent.amountIn)
  const tokenIn = intent.tokenIn as `0x${string}`
  const tokenOut = intent.tokenOut as `0x${string}`

  /* SAFE SPLIT */

  const chunkAmounts: bigint[] = []
  let allocated = 0n

  for (let i = 0; i < plan.sizes.length; i++) {
    if (i === plan.sizes.length - 1) {
      chunkAmounts.push(amountIn - allocated)
    } else {
      const scaled = percentToScaled(plan.sizes[i])
      const chunk = (amountIn * scaled) / HUNDRED_PERCENT
      chunkAmounts.push(chunk)
      allocated += chunk
    }
  }

  let currentReserveIn = sim.reserveIn
  let currentReserveOut = sim.reserveOut

  const chunks: ChunkExecution[] = []
  let totalExpectedOut = 0n
  let totalMinOut = 0n
  let totalMevExposure = 0
  let allSafe = true

  const gasPrice = sim.gasData.gasPriceWei
  const sandwichGasCostWei = 300000n * gasPrice

  const ethPriceUsd =
    bigintToNumber(sim.cleanOutputRaw, sim.outDecimals) /
    bigintToNumber(amountIn, 18)

  const sandwichGasCostUsd =
    bigintToNumber(sandwichGasCostWei, 18) * ethPriceUsd

  for (let i = 0; i < chunkAmounts.length; i++) {
    const chunkAmount = chunkAmounts[i]
    const chunkSim = simulateChunkSandwich(chunkAmount, currentReserveIn, currentReserveOut)

    let expectedOut = chunkSim.cleanOut

    const attackerProfitUsd =
      bigintToNumber(chunkSim.attackerProfit, 18) * ethPriceUsd

    const chunkSafe = attackerProfitUsd <= sandwichGasCostUsd
    if (!chunkSafe) allSafe = false

    const chunkLossUsd = bigintToNumber(chunkSim.userLoss, sim.outDecimals)
    totalMevExposure += chunkLossUsd

    const spotPrice =
      bigintToNumber(currentReserveOut, sim.outDecimals) /
      bigintToNumber(currentReserveIn, 18)

    const execPrice =
      bigintToNumber(expectedOut, sim.outDecimals) /
      bigintToNumber(chunkAmount, 18)

    const priceImpact = ((spotPrice - execPrice) / spotPrice) * 100

    const minOut = (expectedOut * 9950n) / 10000n

    totalExpectedOut += expectedOut
    totalMinOut += minOut

    let tx: ChunkExecution["tx"] = null
    let crossChainTx: CrossChainTx | null = null

    if (!plan.chains?.[i] || plan.chains[i] === "ethereum") {
      const { encodeFunctionData } = await import("viem")
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)

      const data = encodeFunctionData({
        abi: routerAbi,
        functionName: "swapExactTokensForTokens",
        args: [chunkAmount, minOut, [tokenIn, tokenOut], intent.user as `0x${string}`, deadline],
      })

      tx = { to: UNISWAP_V2_ROUTER, data, value: 0n }
    } else {
      crossChainTx = await buildCrossChainTx(
        "ethereum",
        plan.chains[i],
        tokenIn,
        tokenOut,
        chunkAmount,
        intent.user
      )

      if (crossChainTx) {
        expectedOut = crossChainTx.estimatedOutput
      }
    }

    chunks.push({
      index: i,
      sizePercent: plan.sizes[i],
      amountIn: chunkAmount,
      expectedOut,
      minAmountOut: minOut,
      priceImpactPercent: Number(priceImpact.toFixed(4)),
      mevExposureUsd: Number(chunkLossUsd.toFixed(2)),
      safeTx: chunkSafe,
      route: {
        type: crossChainTx ? "CROSS_CHAIN" : "SAME_CHAIN",
        chain: crossChainTx ? plan.chains[i] : "ethereum",
        dex: crossChainTx ? "lifi" : "uniswap_v2",
        path: [tokenIn, tokenOut],
      },
      tx,
      crossChainTx,
      blockDelay: plan.blockDelays?.[i] ?? (i === 0 ? 0 : 1),
    })

    currentReserveIn += chunkAmount
    currentReserveOut -= expectedOut
  }

  return {
    chunks,
    totalExpectedOut,
    totalMinOut,
    totalMevExposureUsd: Number(totalMevExposure.toFixed(2)),
    allChunksSafe: allSafe,
    executionBlocks: chunks.reduce((m, c) => Math.max(m, c.blockDelay), 0) + 1,
  }
}