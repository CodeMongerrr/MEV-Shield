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

// --- Core AMM Math ---

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
  frontrunAmount: bigint
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

  const attackerBought = getAmountOut(frontrunAmount, reserveIn, reserveOut)
  const rIn1 = reserveIn + frontrunAmount
  const rOut1 = reserveOut - attackerBought

  const attackedOut = getAmountOut(amountIn, rIn1, rOut1)
  const rIn2 = rIn1 + amountIn
  const rOut2 = rOut1 - attackedOut

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

// --- Extended result ---

const SANDWICH_GAS_UNITS = 300000n

export interface SandwichSimulation {
  lossPercent: number
  estimatedLossUsd: number
  risk: RiskLevel
  cleanOutputRaw: bigint
  attackedOutputRaw: bigint
  userLossRaw: bigint
  attackerProfitRaw: bigint
  optimalFrontrunRaw: bigint
  attackerProfitUsd: number
  gasData: {
    gasPriceWei: bigint
    sandwichGasCostWei: bigint
    sandwichGasCostUsd: number
  }
  attackViable: boolean
  safeChunkThresholdUsd: number
  poolAddress: string
  reserveIn: bigint
  reserveOut: bigint
  outDecimals: number
  inDecimals: number
  ethPriceUsd: number
  poolThreat: PoolThreatProfile
  adjustedRisk: RiskLevel
  tokenIn: string
  tokenOut: string
}

export async function simulate(intent: SwapIntent): Promise<SandwichSimulation> {
  try {
    const amountIn = BigInt(intent.amountIn)

    // Fetch gas price
    const gasPrice = await publicClient.getGasPrice()

    // Find pair
    const pairAddress = await publicClient.readContract({
      address: UNISWAP_V2_FACTORY,
      abi: factoryAbi,
      functionName: "getPair",
      args: [intent.tokenIn as `0x${string}`, intent.tokenOut as `0x${string}`],
    })

    if (pairAddress === "0x0000000000000000000000000000000000000000") {
      console.log("❌ No V2 pair found")
      return emptyResult(gasPrice)
    }

    // Get reserves and token order
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

    // Get decimals for both tokens
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

    // Calculate optimal frontrun
    const optimalFrontrun = calculateOptimalFrontrun(rIn, amountIn)

    // Run full sandwich simulation
    const result = simulateSandwich(amountIn, rIn, rOut, optimalFrontrun)

    // Gas economics
    const sandwichGasCostWei = SANDWICH_GAS_UNITS * gasPrice
    const gasCostEth = bigintToNumber(sandwichGasCostWei, 18)
    const attackerProfitEth = bigintToNumber(result.attackerProfit, Number(inDecimals))

    // ETH price: cleanOut (in output token, likely USDC) / amountIn (in ETH)
    const cleanOutUsd = bigintToNumber(result.cleanOut, Number(outDecimals))
    const amountInEth = bigintToNumber(amountIn, Number(inDecimals))
    const ethPriceUsd = amountInEth > 0 ? cleanOutUsd / amountInEth : 2500

    const gasCostUsd = gasCostEth * ethPriceUsd
    const attackerProfitUsd = attackerProfitEth * ethPriceUsd
    const attackViable = attackerProfitUsd > gasCostUsd

    // User loss
    const userLossUsd = bigintToNumber(result.userLoss, Number(outDecimals))
    const lossPercent = cleanOutUsd > 0 ? (userLossUsd / cleanOutUsd) * 100 : 0

    // Base risk level
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

    const safeChunkThresholdUsd = gasCostUsd * 2

    console.log(`⛽ Gas price: ${bigintToNumber(gasPrice, 9).toFixed(2)} gwei`)
    console.log(`⛽ Sandwich gas cost: $${gasCostUsd.toFixed(2)}`)
    console.log(`💰 Clean output: $${cleanOutUsd.toFixed(2)}`)
    console.log(`🥪 Attacked output: $${bigintToNumber(result.attackedOut, Number(outDecimals)).toFixed(2)}`)
    console.log(`📉 User loss: $${userLossUsd.toFixed(2)} (${lossPercent.toFixed(3)}%)`)
    console.log(`🤖 Optimal frontrun: ${bigintToNumber(optimalFrontrun, Number(inDecimals)).toFixed(6)}`)
    console.log(`💀 Attacker profit (pre-gas): $${attackerProfitUsd.toFixed(2)}`)
    console.log(`💀 Attacker profit (post-gas): $${(attackerProfitUsd - gasCostUsd).toFixed(2)}`)
    console.log(`💀 Attack viable: ${attackViable}`)
    console.log(`🛡️ Safe chunk threshold: $${safeChunkThresholdUsd.toFixed(2)}`)
    console.log(`⚠️  Risk: ${risk}`)

    // Fetch historical threat profile
    const poolThreat = await getPoolThreatProfile(pairAddress, ethPriceUsd)

    // Adjust risk based on historical activity
    let adjustedRisk: RiskLevel = risk
    if (poolThreat.threatLevel === "CRITICAL" && risk !== "CRITICAL") {
      adjustedRisk = risk === "LOW" ? "MEDIUM" : risk === "MEDIUM" ? "HIGH" : "CRITICAL"
      console.log(`⚠️ Risk elevated ${risk} → ${adjustedRisk} due to pool history (${(poolThreat.sandwichRate * 100).toFixed(1)}% sandwich rate, ${poolThreat.avgExcessSlippagePercent.toFixed(2)}% avg excess slippage)`)
    } else if (poolThreat.threatLevel === "HIGH" && risk === "LOW") {
      adjustedRisk = "MEDIUM"
      console.log(`⚠️ Risk elevated LOW → MEDIUM due to high MEV activity ($${poolThreat.totalMevExtractedUsd.toFixed(0)} extracted recently)`)
    } else if (poolThreat.sandwichRate < 0.02 && poolThreat.avgExcessSlippagePercent < 0.1 && risk === "MEDIUM") {
      adjustedRisk = "LOW"
      console.log(`✅ Risk lowered MEDIUM → LOW — pool has minimal historical MEV activity`)
    }

    // Check if trade size is below historical attack threshold
    if (poolThreat.minAttackedSizeUsd > 0 && cleanOutUsd < poolThreat.minAttackedSizeUsd * 0.8) {
      console.log(`✅ Trade ($${cleanOutUsd.toFixed(0)}) below historical attack threshold ($${poolThreat.minAttackedSizeUsd.toFixed(0)}) — likely safe`)
      if (adjustedRisk !== "LOW") {
        adjustedRisk = "LOW"
      }
    }

    console.log(`🎯 Adjusted risk: ${adjustedRisk}\n`)

    return {
      lossPercent,
      estimatedLossUsd: userLossUsd,
      risk,
      cleanOutputRaw: result.cleanOut,
      attackedOutputRaw: result.attackedOut,
      userLossRaw: result.userLoss,
      attackerProfitRaw: result.attackerProfit,
      optimalFrontrunRaw: optimalFrontrun,
      attackerProfitUsd,
      gasData: {
        gasPriceWei: gasPrice,
        sandwichGasCostWei,
        sandwichGasCostUsd: gasCostUsd,
      },
      attackViable,
      safeChunkThresholdUsd,
      poolAddress: pairAddress,
      reserveIn: rIn,
      reserveOut: rOut,
      outDecimals: Number(outDecimals),
      inDecimals: Number(inDecimals),
      ethPriceUsd,
      poolThreat,
      adjustedRisk,
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
    }
  } catch (err) {
    console.error("❌ Simulation failed:", err)
    const gasPrice = await publicClient.getGasPrice().catch(() => 30000000000n)
    return emptyResult(gasPrice)
  }
}

function emptyResult(gasPrice: bigint): SandwichSimulation {
  const sandwichGasCostWei = SANDWICH_GAS_UNITS * gasPrice
  return {
    lossPercent: 0,
    estimatedLossUsd: 0,
    risk: "MEDIUM",
    cleanOutputRaw: 0n,
    attackedOutputRaw: 0n,
    userLossRaw: 0n,
    attackerProfitRaw: 0n,
    optimalFrontrunRaw: 0n,
    attackerProfitUsd: 0,
    gasData: {
      gasPriceWei: gasPrice,
      sandwichGasCostWei,
      sandwichGasCostUsd: 0,
    },
    attackViable: false,
    safeChunkThresholdUsd: 0,
    poolAddress: "",
    reserveIn: 0n,
    reserveOut: 0n,
    outDecimals: 18,
    inDecimals: 18,
    ethPriceUsd: 2500,
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
    adjustedRisk: "MEDIUM",
    tokenIn: "",
    tokenOut: "",
  }
}