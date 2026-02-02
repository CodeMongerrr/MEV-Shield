import { SimulationResult, SwapIntent } from "../core/types"
import { publicClient } from "../core/config"
import { parseAbi, getAddress } from "viem"

const UNISWAP_V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" as const

const factoryAbi = parseAbi([
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
])

const pairAbi = parseAbi([
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
])

// --- Core AMM Math ---

function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amountInWithFee = amountIn * 997n
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * 1000n + amountInWithFee
  return numerator / denominator
}

// Integer square root (Babylonian method)
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

// --- Optimal Sandwich Math ---
// Based on: "Quantifying Blockchain Extractable Value: How dark is the forest?"
// The optimal frontrun amount that maximizes attacker profit:
//
// For Uniswap V2 with fee factor γ = 0.997:
// optimal_in = sqrt(γ * reserveIn * userAmountIn * (γ * reserveIn + userAmountIn * γ)) 
//              - reserveIn * γ
//
// Simplified form:
// optimal_in = sqrt(reserveIn * userAmountIn * 997 * 997 / 1000000 + (reserveIn * 997/1000)^2)
//              - reserveIn * 997 / 1000

function calculateOptimalFrontrun(reserveIn: bigint, userAmountIn: bigint): bigint {
  // γ = 997/1000 (Uniswap V2 fee)
  const gamma = 997n
  const base = 1000n

  // term1 = γ * reserveIn
  const gammaR = (gamma * reserveIn) / base

  // Under the sqrt: gammaR * (gammaR + γ * userAmountIn)
  const gammaUser = (gamma * userAmountIn) / base
  const underSqrt = gammaR * (gammaR + gammaUser)

  const sqrtVal = sqrt(underSqrt)

  if (sqrtVal <= gammaR) return 0n

  return sqrtVal - gammaR
}

// Simulate full sandwich and return attacker economics
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
  // Clean execution
  const cleanOut = getAmountOut(amountIn, reserveIn, reserveOut)

  // Step 1: Attacker frontruns
  const attackerBought = getAmountOut(frontrunAmount, reserveIn, reserveOut)
  const rIn1 = reserveIn + frontrunAmount
  const rOut1 = reserveOut - attackerBought

  // Step 2: User swaps against shifted reserves
  const attackedOut = getAmountOut(amountIn, rIn1, rOut1)
  const rIn2 = rIn1 + amountIn
  const rOut2 = rOut1 - attackedOut

  // Step 3: Attacker backruns (sells tokens bought in step 1)
  // Note: attacker sells tokenOut back to tokenIn
  const attackerSellRevenue = getAmountOut(attackerBought, rOut2, rIn2)

  // Attacker profit in tokenIn terms (before gas)
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

// --- Extended result for decision engine ---
export interface SandwichSimulation {
  // Basic risk output
  lossPercent: number
  estimatedLossUsd: number
  risk: SimulationResult["risk"]
  // Detailed economics
  cleanOutputRaw: bigint
  attackedOutputRaw: bigint
  userLossRaw: bigint
  attackerProfitRaw: bigint
  optimalFrontrunRaw: bigint
  attackerProfitUsd: number
  gasData: {
    gasPriceWei: bigint
    sandwichGasCostWei: bigint  // 2 txs
    sandwichGasCostUsd: number
  }
  // Is attack profitable after gas?
  attackViable: boolean
  // How much does each chunk need to be worth to be safe?
  safeChunkThresholdUsd: number
  // Pool info
  poolAddress: string
  reserveIn: bigint
  reserveOut: bigint
  outDecimals: number
}

// Sandwich gas estimate: frontrun (~150k) + backrun (~150k)
const SANDWICH_GAS_UNITS = 300000n

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

    // Get reserves
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

    const isToken0In = getAddress(intent.tokenIn) === getAddress(token0)
    const r0 = BigInt(reserves[0])
    const r1 = BigInt(reserves[1])
    const [rIn, rOut] = isToken0In ? [r0, r1] : [r1, r0]

    // Output token decimals
    const outDecimals = intent.tokenOut.toLowerCase() === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" ? 6 : 18

    // Calculate optimal frontrun
    const optimalFrontrun = calculateOptimalFrontrun(rIn, amountIn)

    // Run full sandwich simulation
    const result = simulateSandwich(amountIn, rIn, rOut, optimalFrontrun)

    // Gas economics
    const sandwichGasCostWei = SANDWICH_GAS_UNITS * gasPrice
    // Convert gas cost to ETH, then to USD (rough: attacker profit is in tokenIn which is WETH)
    const gasCostEth = bigintToNumber(sandwichGasCostWei, 18)
    const attackerProfitEth = bigintToNumber(result.attackerProfit, 18)

    // We need ETH price to convert gas cost to USD
    // Use the pool itself: if tokenIn is WETH and tokenOut is USDC, 
    // cleanOut / amountIn gives us ETH price
    const ethPriceUsd = amountIn > 0n
      ? bigintToNumber(result.cleanOut, outDecimals) / bigintToNumber(amountIn, 18)
      : 2500 // fallback

    const gasCostUsd = gasCostEth * ethPriceUsd
    const attackerProfitUsd = attackerProfitEth * ethPriceUsd
    const attackViable = attackerProfitUsd > gasCostUsd

    // User loss
    const userLossUsd = bigintToNumber(result.userLoss, outDecimals)
    const cleanOutUsd = bigintToNumber(result.cleanOut, outDecimals)
    const lossPercent = cleanOutUsd > 0 ? (userLossUsd / cleanOutUsd) * 100 : 0

    // Risk level based on attacker viability AND loss magnitude
    let risk: SimulationResult["risk"] = "LOW"
    if (!attackViable) {
      risk = "LOW" // Not profitable to attack
    } else if (lossPercent > 2) {
      risk = "CRITICAL"
    } else if (lossPercent > 0.5) {
      risk = "HIGH"
    } else if (lossPercent > 0.1) {
      risk = "MEDIUM"
    }

    // Safe chunk threshold: the trade size below which sandwich gas cost > profit
    // This is what the decision engine uses to calculate chunk count
    const safeChunkThresholdUsd = gasCostUsd * 2 // 2x gas cost = not worth attacking

    console.log(`\n🏊 Pool: ${pairAddress}`)
    console.log(`🏊 Reserves: ${rIn.toString()} / ${rOut.toString()}`)
    console.log(`⛽ Gas price: ${bigintToNumber(gasPrice, 9).toFixed(2)} gwei`)
    console.log(`⛽ Sandwich gas cost: $${gasCostUsd.toFixed(2)}`)
    console.log(`💰 Clean output: $${cleanOutUsd.toFixed(2)}`)
    console.log(`🥪 Attacked output: $${bigintToNumber(result.attackedOut, outDecimals).toFixed(2)}`)
    console.log(`📉 User loss: $${userLossUsd.toFixed(2)} (${lossPercent.toFixed(3)}%)`)
    console.log(`🤖 Optimal frontrun: ${bigintToNumber(optimalFrontrun, 18).toFixed(6)} ETH`)
    console.log(`💀 Attacker profit (pre-gas): $${attackerProfitUsd.toFixed(2)}`)
    console.log(`💀 Attacker profit (post-gas): $${(attackerProfitUsd - gasCostUsd).toFixed(2)}`)
    console.log(`💀 Attack viable: ${attackViable}`)
    console.log(`🛡️ Safe chunk threshold: $${safeChunkThresholdUsd.toFixed(2)}`)
    console.log(`⚠️  Risk: ${risk}\n`)

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
      outDecimals,
    }
  } catch (err) {
    console.error("❌ Simulation failed:", err)
    const gasPrice = await publicClient.getGasPrice().catch(() => 30000000000n)
    return emptyResult(gasPrice)
  }
}

function emptyResult(gasPrice: bigint): SandwichSimulation {
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
      sandwichGasCostWei: SANDWICH_GAS_UNITS * gasPrice,
      sandwichGasCostUsd: 0,
    },
    attackViable: false,
    safeChunkThresholdUsd: 0,
    poolAddress: "",
    reserveIn: 0n,
    reserveOut: 0n,
    outDecimals: 18,
  }
}