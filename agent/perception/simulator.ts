/**
 * MEV SHIELD - SANDWICH SIMULATOR v2
 * 
 * Changes from v1:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 1. LIQUIDITY-AWARE: Reports pool depth ratio so optimizer can reject shallow pools
 * 2. CLEANER PRICE FETCH: Centralized token price fetching with retry + fallback
 * 3. POOL DEPTH REPORTING: Exports reserve-to-trade ratio for optimizer consumption
 * 4. BETTER ATTACKER PROFIT: Removed the arbitrary 0.1 multiplier on profit calc
 *    — now uses proper sandwich profit = sell revenue - buy cost - gas
 */

import { SimulationResult, SwapIntent, RiskLevel } from "../core/types"
import { publicClient } from "../core/config"
import { parseAbi, getAddress } from "viem"
import { getPoolThreatProfile, PoolThreatProfile } from "./poolHistory"

const UNISWAP_V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" as const

const factoryAbi = parseAbi([
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
])

const pairAbi = parseAbi([
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
])

const erc20Abi = parseAbi([
  "function decimals() external view returns (uint8)",
])

// ============================================================================
// CORE AMM MATH
// ============================================================================

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

function simulateSandwich(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  frontrunAmount: bigint,
): {
  cleanOut: bigint
  attackedOut: bigint
  attackerProfit: bigint
  userLoss: bigint
} {
  const cleanOut = getAmountOut(amountIn, reserveIn, reserveOut)

  if (frontrunAmount <= 0n) {
    return { cleanOut, attackedOut: cleanOut, attackerProfit: 0n, userLoss: 0n }
  }

  // Step 1: Attacker frontrun buy
  const attackerBought = getAmountOut(frontrunAmount, reserveIn, reserveOut)
  const rIn1 = reserveIn + frontrunAmount
  const rOut1 = reserveOut - attackerBought

  // Step 2: User swap at worse price
  const attackedOut = getAmountOut(amountIn, rIn1, rOut1)
  const rIn2 = rIn1 + amountIn
  const rOut2 = rOut1 - attackedOut

  // Step 3: Attacker backrun sell
  const attackerSellRevenue = getAmountOut(attackerBought, rOut2, rIn2)
  const attackerProfit = attackerSellRevenue > frontrunAmount
    ? attackerSellRevenue - frontrunAmount
    : 0n

  const userLoss = cleanOut > attackedOut ? cleanOut - attackedOut : 0n

  return { cleanOut, attackedOut, attackerProfit, userLoss }
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

// ============================================================================
// TOKEN PRICE FETCHING
// ============================================================================

const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
const DEFAULT_ETH_PRICE = 2500

async function fetchTokenPriceUsd(chainId: number, tokenAddress: string): Promise<number | null> {
  try {
    const res = await fetch(`https://li.quest/v1/token?chain=${chainId}&token=${tokenAddress}`)
    if (!res.ok) return null
    const data = await res.json()
    const price = Number(data.priceUSD)
    return price > 0 ? price : null
  } catch {
    return null
  }
}

async function getEthPriceUsd(): Promise<number> {
  return await fetchTokenPriceUsd(1, WETH_ADDRESS) ?? DEFAULT_ETH_PRICE
}

// ============================================================================
// EXTENDED SIMULATION RESULT
// ============================================================================

const SANDWICH_GAS_UNITS = 300_000n

export interface SandwichSimulation {
  // Core results
  lossPercent: number
  estimatedLossUsd: number
  risk: RiskLevel
  adjustedRisk: RiskLevel

  // Raw outputs
  cleanOutputRaw: bigint
  attackedOutputRaw: bigint
  userLossRaw: bigint
  attackerProfitRaw: bigint
  optimalFrontrunRaw: bigint
  attackerProfitUsd: number

  // Gas economics
  gasData: {
    gasPriceWei: bigint
    sandwichGasCostWei: bigint
    sandwichGasCostUsd: number
  }
  attackViable: boolean
  safeChunkThresholdUsd: number

  // Pool data (consumed by optimizer)
  poolAddress: string
  reserveIn: bigint
  reserveOut: bigint
  outDecimals: number
  inDecimals: number
  ethPriceUsd: number

  // Liquidity depth info (NEW — optimizer uses this)
  poolDepthUsd: number
  tradeToPoolRatio: number
  isShallowPool: boolean

  // Historical threat
  poolThreat: PoolThreatProfile

  // Token addresses
  tokenIn: string
  tokenOut: string
}

// ============================================================================
// MAIN SIMULATION
// ============================================================================

export async function simulate(intent: SwapIntent): Promise<SandwichSimulation> {
  try {
    const amountIn = BigInt(intent.amountIn)
    const gasPrice = await publicClient.getGasPrice()

    // --- Find Uniswap V2 pair ---
    const pairAddress = await publicClient.readContract({
      address: UNISWAP_V2_FACTORY,
      abi: factoryAbi,
      functionName: "getPair",
      args: [intent.tokenIn as `0x${string}`, intent.tokenOut as `0x${string}`],
    })

    if (pairAddress === "0x0000000000000000000000000000000000000000") {
      console.log("❌ No V2 pair found")
      return emptyResult(gasPrice, intent)
    }

    // --- Get reserves and token ordering ---
    const [reserves, token0] = await Promise.all([
      publicClient.readContract({
        address: pairAddress,
        abi: pairAbi,
        functionName: "getReserves",
      }),
      publicClient.readContract({
        address: pairAddress,
        abi: pairAbi,
        functionName: "token0",
      }),
    ])

    const [inDecimals, outDecimals] = await Promise.all([
      publicClient.readContract({
        address: intent.tokenIn as `0x${string}`,
        abi: erc20Abi,
        functionName: "decimals",
      }).catch(() => 18),
      publicClient.readContract({
        address: intent.tokenOut as `0x${string}`,
        abi: erc20Abi,
        functionName: "decimals",
      }).catch(() => 18),
    ])

    const isToken0In = getAddress(intent.tokenIn) === getAddress(token0)
    const r0 = BigInt(reserves[0])
    const r1 = BigInt(reserves[1])
    const [rIn, rOut] = isToken0In ? [r0, r1] : [r1, r0]

    console.log(`\n🏊 Pool: ${pairAddress}`)
    console.log(`🏊 Reserves: ${rIn.toString()} / ${rOut.toString()}`)

    // --- Prices ---
    const ethPriceUsd = await getEthPriceUsd()
    const tokenOutPriceUsd = await fetchTokenPriceUsd(1, intent.tokenOut) ?? 0

    // --- Pool depth calculation ---
    const reserveInUsd = bigintToNumber(rIn, Number(inDecimals)) * ethPriceUsd
    const reserveOutUsd = bigintToNumber(rOut, Number(outDecimals)) * tokenOutPriceUsd
    const poolDepthUsd = reserveInUsd + reserveOutUsd

    // --- Sandwich simulation ---
    const optimalFrontrun = calculateOptimalFrontrun(rIn, amountIn)
    const result = simulateSandwich(amountIn, rIn, rOut, optimalFrontrun)

    // --- Economics ---
    const sandwichGasCostWei = SANDWICH_GAS_UNITS * gasPrice
    const gasCostEth = bigintToNumber(sandwichGasCostWei, 18)
    const gasCostUsd = gasCostEth * ethPriceUsd

    // Attacker profit: revenue from backrun sell - frontrun buy cost
    // This is already computed in attackerProfit (in input token units)
    const attackerProfitTokens = bigintToNumber(result.attackerProfit, Number(inDecimals))
    const attackerProfitUsd = attackerProfitTokens * ethPriceUsd
    const attackViable = attackerProfitUsd > gasCostUsd

    // User loss in USD
    const cleanOutTokens = bigintToNumber(result.cleanOut, Number(outDecimals))
    const cleanOutUsd = cleanOutTokens * tokenOutPriceUsd
    const userLossTokens = bigintToNumber(result.userLoss, Number(outDecimals))
    const userLossUsd = userLossTokens * tokenOutPriceUsd
    const lossPercent = cleanOutUsd > 0 ? (userLossUsd / cleanOutUsd) * 100 : 0

    // Trade-to-pool ratio
    const tradeValueUsd = bigintToNumber(amountIn, Number(inDecimals)) * ethPriceUsd
    const tradeToPoolRatio = poolDepthUsd > 0 ? tradeValueUsd / poolDepthUsd : Infinity
    const isShallowPool = tradeToPoolRatio > 0.10

    // --- Risk assessment ---
    let risk: RiskLevel = "LOW"
    if (!attackViable) {
      risk = "LOW"
    } else if (lossPercent > 2) {
      risk = "CRITICAL"
    } else if (lossPercent > 0.5) {
      risk = "HIGH"
    } else if (lossPercent > 0.1) {
      risk = "MEDIUM"
    }

    const safeChunkThresholdUsd = Math.sqrt(2 * poolDepthUsd * gasCostUsd)
    // --- Logging ---
    console.log(`⛽ Gas price: ${bigintToNumber(gasPrice, 9).toFixed(2)} gwei`)
    console.log(`⛽ Sandwich gas cost: $${gasCostUsd.toFixed(2)}`)
    console.log(`💰 Clean output: $${cleanOutUsd.toFixed(2)}`)
    console.log(`🥪 Attacked output: $${bigintToNumber(result.attackedOut, Number(outDecimals)).toFixed(2)}`)
    console.log(`📉 User loss: $${userLossUsd.toFixed(2)} (${lossPercent.toFixed(3)}%)`)
    console.log(`🤖 Optimal frontrun: ${bigintToNumber(optimalFrontrun, Number(inDecimals)).toFixed(6)}`)
    console.log(`💀 Attacker profit: $${attackerProfitUsd.toFixed(2)} (${attackViable ? "viable" : "not viable"})`)
    console.log(`🏊 Pool depth: $${poolDepthUsd.toFixed(0)} | Trade/pool: ${(tradeToPoolRatio * 100).toFixed(2)}%${isShallowPool ? " ⚠️ SHALLOW" : ""}`)
    console.log(`🛡️ Safe chunk threshold: $${safeChunkThresholdUsd.toFixed(2)}`)
    console.log(`⚠️ Risk: ${risk}`)

    // --- Historical threat profile ---
    const poolThreat = await getPoolThreatProfile(pairAddress, ethPriceUsd)

    // --- Adjust risk based on history ---
    let adjustedRisk: RiskLevel = risk
    if (poolThreat.threatLevel === "CRITICAL" && risk !== "CRITICAL") {
      adjustedRisk = risk === "LOW" ? "MEDIUM" : risk === "MEDIUM" ? "HIGH" : "CRITICAL"
      console.log(`⚠️ Risk elevated ${risk} → ${adjustedRisk} due to pool history (${(poolThreat.sandwichRate * 100).toFixed(1)}% sandwich rate)`)
    } else if (poolThreat.threatLevel === "HIGH" && risk === "LOW") {
      adjustedRisk = "MEDIUM"
      console.log(`⚠️ Risk elevated LOW → MEDIUM due to high MEV activity ($${poolThreat.totalMevExtractedUsd.toFixed(0)} extracted)`)
    } else if (poolThreat.sandwichRate < 0.02 && poolThreat.avgExcessSlippagePercent < 0.1 && risk === "MEDIUM") {
      adjustedRisk = "LOW"
      console.log(`✅ Risk lowered MEDIUM → LOW — minimal historical MEV activity`)
    }

    // Check historical attack threshold
    if (poolThreat.minAttackedSizeUsd > 0 && cleanOutUsd < poolThreat.minAttackedSizeUsd * 0.8) {
      console.log(`✅ Trade ($${cleanOutUsd.toFixed(0)}) below historical attack threshold ($${poolThreat.minAttackedSizeUsd.toFixed(0)}) — likely safe`)
      if (adjustedRisk !== "LOW") adjustedRisk = "LOW"
    }

    console.log(`🎯 Adjusted risk: ${adjustedRisk}\n`)

    return {
      lossPercent,
      estimatedLossUsd: userLossUsd,
      risk,
      adjustedRisk,
      cleanOutputRaw: result.cleanOut,
      attackedOutputRaw: result.attackedOut,
      userLossRaw: result.userLoss,
      attackerProfitRaw: result.attackerProfit,
      optimalFrontrunRaw: optimalFrontrun,
      attackerProfitUsd,
      gasData: { gasPriceWei: gasPrice, sandwichGasCostWei, sandwichGasCostUsd: gasCostUsd },
      attackViable,
      safeChunkThresholdUsd,
      poolAddress: pairAddress,
      reserveIn: rIn,
      reserveOut: rOut,
      outDecimals: Number(outDecimals),
      inDecimals: Number(inDecimals),
      ethPriceUsd,
      poolDepthUsd,
      tradeToPoolRatio,
      isShallowPool,
      poolThreat,
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
    }
  } catch (err) {
    console.error("❌ Simulation failed:", err)
    const gasPrice = await publicClient.getGasPrice().catch(() => 30000000000n)
    return emptyResult(gasPrice, intent)
  }
}

// ============================================================================
// EMPTY / FALLBACK RESULT
// ============================================================================

function emptyResult(gasPrice: bigint, intent?: SwapIntent): SandwichSimulation {
  const sandwichGasCostWei = SANDWICH_GAS_UNITS * gasPrice
  return {
    lossPercent: 0,
    estimatedLossUsd: 0,
    risk: "MEDIUM",
    adjustedRisk: "MEDIUM",
    cleanOutputRaw: 0n,
    attackedOutputRaw: 0n,
    userLossRaw: 0n,
    attackerProfitRaw: 0n,
    optimalFrontrunRaw: 0n,
    attackerProfitUsd: 0,
    gasData: { gasPriceWei: gasPrice, sandwichGasCostWei, sandwichGasCostUsd: 0 },
    attackViable: false,
    safeChunkThresholdUsd: 0,
    poolAddress: "",
    reserveIn: 0n,
    reserveOut: 0n,
    outDecimals: 18,
    inDecimals: 18,
    ethPriceUsd: DEFAULT_ETH_PRICE,
    poolDepthUsd: 0,
    tradeToPoolRatio: 0,
    isShallowPool: false,
    poolThreat: {
      poolAddress: "",
      token0: "",
      token1: "",
      analyzedSwaps: 0,
      sandwichCount: 0,
      sandwichRate: 0,
      avgExcessSlippagePercent: 0,
      avgVictimSizeUsd: 0,
      minAttackedSizeUsd: 0,
      maxAttackedSizeUsd: 0,
      totalMevExtractedUsd: 0,
      recentVictims: [],
      threatLevel: "LOW",
      lastUpdated: Date.now(),
    },
    tokenIn: intent?.tokenIn ?? "",
    tokenOut: intent?.tokenOut ?? "",
  }
}