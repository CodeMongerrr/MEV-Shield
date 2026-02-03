import { publicClient } from "../core/config"
import { parseAbi } from "viem"

const UNISWAP_V2_SUBGRAPH = "https://gateway.thegraph.com/api/subgraphs/id/EYCKATKGBKLWvSfwvBjzfCBmGwYNdVkduYXVivCsLRFu"

// You need a Graph API key for production, but the hosted service still works for now
// Free tier: https://thegraph.com/studio/
const GRAPH_API_KEY = process.env.GRAPH_API_KEY || ""

const pairAbi = parseAbi([
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
])

const erc20Abi = parseAbi([
  "function decimals() external view returns (uint8)",
])

// --- Types ---

export interface SlippageAnalysis {
  txHash: string
  blockNumber: number
  timestamp: number
  amountInUsd: number
  expectedOutUsd: number
  actualOutUsd: number
  slippageLossUsd: number
  slippagePercent: number
  theoreticalImpactPercent: number
  excessSlippagePercent: number // slippage beyond theoretical = likely MEV
  likelySandwiched: boolean
}

export interface PoolThreatProfile {
  poolAddress: string
  token0: string
  token1: string
  analyzedSwaps: number
  sandwichCount: number
  sandwichRate: number
  avgExcessSlippagePercent: number
  avgVictimSizeUsd: number
  minAttackedSizeUsd: number
  maxAttackedSizeUsd: number
  totalMevExtractedUsd: number
  recentVictims: SlippageAnalysis[]
  threatLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
  lastUpdated: number
}

interface GraphSwap {
  id: string
  transaction: { id: string; blockNumber: string; timestamp: string }
  amount0In: string
  amount0Out: string
  amount1In: string
  amount1Out: string
  amountUSD: string
  sender: string
  to: string
}

interface GraphResponse {
  data?: {
    swaps?: GraphSwap[]
  }
  errors?: any[]
}

// --- AMM Math ---

function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const amountInWithFee = amountIn * 997n
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * 1000n + amountInWithFee
  return numerator / denominator
}

// Theoretical price impact for a given trade size
function theoreticalPriceImpact(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): number {
  if (reserveIn <= 0n || reserveOut <= 0n) return 0
  
  // Spot price before swap
  const spotPrice = Number(reserveOut) / Number(reserveIn)
  
  // Execution price
  const amountOut = getAmountOut(amountIn, reserveIn, reserveOut)
  if (amountIn <= 0n) return 0
  const execPrice = Number(amountOut) / Number(amountIn)
  
  // Price impact = (spot - exec) / spot
  const impact = (spotPrice - execPrice) / spotPrice * 100
  return Math.max(0, impact)
}

// --- Graph Queries ---

async function fetchSwapsFromGraph(
  pairAddress: string,
  count: number = 100
): Promise<GraphSwap[]> {
  const query = `
    {
      swaps(
        first: ${count}
        where: { pair: "${pairAddress.toLowerCase()}" }
        orderBy: timestamp
        orderDirection: desc
      ) {
        id
        transaction { id blockNumber timestamp }
        amount0In
        amount0Out
        amount1In
        amount1Out
        amountUSD
        sender
        to
      }
    }
  `

  const url = GRAPH_API_KEY
    ? `https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/EYCKATKGBKLWvSfwvBjzfCBmGwYNdVkduYXVivCsLRFu`
    : "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2"

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    })

    const json: GraphResponse = await response.json()

    if (json.errors) {
      console.log(`⚠️ Graph errors:`, json.errors)
      return []
    }

    return json.data?.swaps || []
  } catch (err) {
    console.log(`⚠️ Graph fetch failed: ${(err as Error).message}`)
    return []
  }
}

// Fetch historical reserves at a specific block
async function getReservesAtBlock(
  pairAddress: string,
  blockNumber: bigint
): Promise<{ reserve0: bigint; reserve1: bigint } | null> {
  try {
    const reserves = await publicClient.readContract({
      address: pairAddress as `0x${string}`,
      abi: pairAbi,
      functionName: "getReserves",
      blockNumber,
    })
    return {
      reserve0: BigInt(reserves[0]),
      reserve1: BigInt(reserves[1]),
    }
  } catch {
    return null
  }
}

// --- Slippage Analysis ---

async function analyzeSwapSlippage(
  swap: GraphSwap,
  pairAddress: string,
  token0Decimals: number,
  token1Decimals: number
): Promise<SlippageAnalysis | null> {
  const blockNumber = BigInt(swap.transaction.blockNumber)
  
  // Get reserves at the block BEFORE this swap
  const preBlockReserves = await getReservesAtBlock(pairAddress, blockNumber - 1n)
  if (!preBlockReserves) {
    console.log(`   ⚠️ Block ${blockNumber}: Could not fetch reserves`)
    return null
  }

  // Determine swap direction
  const amount0In = BigInt(Math.floor(parseFloat(swap.amount0In) * 10 ** token0Decimals))
  const amount1In = BigInt(Math.floor(parseFloat(swap.amount1In) * 10 ** token1Decimals))
  const amount0Out = BigInt(Math.floor(parseFloat(swap.amount0Out) * 10 ** token0Decimals))
  const amount1Out = BigInt(Math.floor(parseFloat(swap.amount1Out) * 10 ** token1Decimals))

  // Debug: log raw values from Graph
  console.log(`   📊 Block ${blockNumber}: amount0In=${swap.amount0In}, amount1In=${swap.amount1In}, amount0Out=${swap.amount0Out}, amount1Out=${swap.amount1Out}, amountUSD=${swap.amountUSD}`)

  let amountIn: bigint
  let actualOut: bigint
  let reserveIn: bigint
  let reserveOut: bigint
  let inDecimals: number
  let outDecimals: number
  let direction: string

  if (parseFloat(swap.amount0In) > 0) {
    // Swapping token0 for token1
    amountIn = amount0In
    actualOut = amount1Out
    reserveIn = preBlockReserves.reserve0
    reserveOut = preBlockReserves.reserve1
    inDecimals = token0Decimals
    outDecimals = token1Decimals
    direction = "token0→token1"
  } else {
    // Swapping token1 for token0
    amountIn = amount1In
    actualOut = amount0Out
    reserveIn = preBlockReserves.reserve1
    reserveOut = preBlockReserves.reserve0
    inDecimals = token1Decimals
    outDecimals = token0Decimals
    direction = "token1→token0"
  }

  console.log(`   📊 Direction: ${direction}, amountIn=${amountIn.toString()}, actualOut=${actualOut.toString()}`)
  console.log(`   📊 Pre-reserves: in=${reserveIn.toString()}, out=${reserveOut.toString()}`)

  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
    console.log(`   ⚠️ Invalid values, skipping`)
    return null
  }

  // Calculate expected output using pre-swap reserves
  const expectedOut = getAmountOut(amountIn, reserveIn, reserveOut)
  
  console.log(`   📊 Expected out: ${expectedOut.toString()}, Actual out: ${actualOut.toString()}`)

  // Calculate theoretical price impact (what slippage SHOULD be)
  const theoreticalImpact = theoreticalPriceImpact(amountIn, reserveIn, reserveOut)

  // Actual slippage
  const slippageLoss = expectedOut > actualOut ? expectedOut - actualOut : 0n
  const slippagePercent = expectedOut > 0n 
    ? Number(slippageLoss * 10000n / expectedOut) / 100 
    : 0

  // Excess slippage beyond theoretical = likely MEV extraction
  const excessSlippage = Math.max(0, slippagePercent - theoreticalImpact)

  console.log(`   📊 Slippage: ${slippagePercent.toFixed(4)}%, Theoretical: ${theoreticalImpact.toFixed(4)}%, Excess: ${excessSlippage.toFixed(4)}%`)

  // Convert to USD (using the Graph's amountUSD as reference)
  const amountInUsd = parseFloat(swap.amountUSD) || 0
  const expectedOutUsd = amountInUsd
  const slippageLossUsd = expectedOutUsd * (slippagePercent / 100)
  const actualOutUsd = expectedOutUsd - slippageLossUsd

  // Likely sandwiched if excess slippage > 0.1%
  const likelySandwiched = excessSlippage > 0.1

  if (likelySandwiched) {
    console.log(`   🥪 SANDWICH DETECTED: $${amountInUsd.toFixed(0)} swap lost ${excessSlippage.toFixed(3)}% excess slippage`)
  }

  return {
    txHash: swap.transaction.id,
    blockNumber: parseInt(swap.transaction.blockNumber),
    timestamp: parseInt(swap.transaction.timestamp),
    amountInUsd,
    expectedOutUsd,
    actualOutUsd,
    slippageLossUsd,
    slippagePercent,
    theoreticalImpactPercent: theoreticalImpact,
    excessSlippagePercent: excessSlippage,
    likelySandwiched,
  }
}
// --- Main Analysis ---

export async function analyzePoolThreat(
  poolAddress: string,
  ethPriceUsd: number,
  swapsToAnalyze: number = 10  // Reduced for debugging
): Promise<PoolThreatProfile> {
  console.log(`\n🔍 Analyzing pool threat via slippage: ${poolAddress}`)

  // Get pool tokens and decimals
  let token0: string, token1: string
  let token0Decimals: number, token1Decimals: number

  try {
    [token0, token1] = await Promise.all([
      publicClient.readContract({
        address: poolAddress as `0x${string}`,
        abi: pairAbi,
        functionName: "token0",
      }),
      publicClient.readContract({
        address: poolAddress as `0x${string}`,
        abi: pairAbi,
        functionName: "token1",
      }),
    ])

    const [dec0, dec1] = await Promise.all([
      publicClient.readContract({
        address: token0 as `0x${string}`,
        abi: erc20Abi,
        functionName: "decimals",
      }).catch(() => 18),
      publicClient.readContract({
        address: token1 as `0x${string}`,
        abi: erc20Abi,
        functionName: "decimals",
      }).catch(() => 18),
    ])

    token0Decimals = Number(dec0)
    token1Decimals = Number(dec1)
  } catch (err) {
    console.log(`⚠️ Failed to get pool info: ${(err as Error).message}`)
    return emptyProfile(poolAddress)
  }

  console.log(`   Token0: ${token0} (${token0Decimals} decimals)`)
  console.log(`   Token1: ${token1} (${token1Decimals} decimals)`)

  // Fetch swaps from The Graph
  console.log(`   Fetching last ${swapsToAnalyze} swaps from The Graph...`)
  const swaps = await fetchSwapsFromGraph(poolAddress, swapsToAnalyze)
  
  if (swaps.length === 0) {
    console.log(`   No swaps found`)
    return emptyProfile(poolAddress)
  }

  console.log(`   Found ${swaps.length} swaps, analyzing slippage...`)

  // Analyze each swap (limit concurrent RPC calls)
  const analyses: SlippageAnalysis[] = []
  const batchSize = 3

  for (let i = 0; i < swaps.length; i += batchSize) {
    const batch = swaps.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map((swap) => analyzeSwapSlippage(swap, poolAddress, token0Decimals, token1Decimals))
    )
    analyses.push(...results.filter((r): r is SlippageAnalysis => r !== null))
    
    // Rate limit
    if (i + batchSize < swaps.length) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  console.log(`   Analyzed ${analyses.length} swaps successfully`)

  // Filter to sandwiched swaps
  const sandwiched = analyses.filter((a) => a.likelySandwiched)
  const sandwichRate = analyses.length > 0 ? sandwiched.length / analyses.length : 0

  // Calculate metrics
  const victimSizes = sandwiched.map((s) => s.amountInUsd).filter((s) => s > 0)
  const excessSlippages = sandwiched.map((s) => s.excessSlippagePercent)
  const mevExtracted = sandwiched.reduce((sum, s) => sum + s.slippageLossUsd, 0)

  const avgExcessSlippage = excessSlippages.length > 0
    ? excessSlippages.reduce((a, b) => a + b, 0) / excessSlippages.length
    : 0

  const avgVictimSize = victimSizes.length > 0
    ? victimSizes.reduce((a, b) => a + b, 0) / victimSizes.length
    : 0

  const minAttackedSize = victimSizes.length > 0 ? Math.min(...victimSizes) : 0
  const maxAttackedSize = victimSizes.length > 0 ? Math.max(...victimSizes) : 0

  // Determine threat level
  let threatLevel: PoolThreatProfile["threatLevel"] = "LOW"
  if (sandwichRate > 0.3 || avgExcessSlippage > 1.0) {
    threatLevel = "CRITICAL"
  } else if (sandwichRate > 0.15 || avgExcessSlippage > 0.5) {
    threatLevel = "HIGH"
  } else if (sandwichRate > 0.05 || avgExcessSlippage > 0.2) {
    threatLevel = "MEDIUM"
  }

  console.log(`   Sandwiched swaps: ${sandwiched.length}/${analyses.length} (${(sandwichRate * 100).toFixed(1)}%)`)
  console.log(`   Avg excess slippage: ${avgExcessSlippage.toFixed(3)}%`)
  console.log(`   Total MEV extracted: $${mevExtracted.toFixed(2)}`)
  console.log(`   Min attacked size: $${minAttackedSize.toFixed(0)}`)
  console.log(`   Threat level: ${threatLevel}\n`)

  // Log some examples
  if (sandwiched.length > 0) {
    console.log(`   Recent sandwich victims:`)
    sandwiched.slice(0, 5).forEach((s) => {
      console.log(`     Block ${s.blockNumber}: $${s.amountInUsd.toFixed(0)} swap, ${s.slippagePercent.toFixed(2)}% slippage (${s.theoreticalImpactPercent.toFixed(2)}% expected), excess=${s.excessSlippagePercent.toFixed(2)}%`)
    })
  }

  return {
    poolAddress,
    token0,
    token1,
    analyzedSwaps: analyses.length,
    sandwichCount: sandwiched.length,
    sandwichRate,
    avgExcessSlippagePercent: avgExcessSlippage,
    avgVictimSizeUsd: avgVictimSize,
    minAttackedSizeUsd: minAttackedSize,
    maxAttackedSizeUsd: maxAttackedSize,
    totalMevExtractedUsd: mevExtracted,
    recentVictims: sandwiched.slice(0, 10),
    threatLevel,
    lastUpdated: Date.now(),
  }
}

function emptyProfile(poolAddress: string): PoolThreatProfile {
  return {
    poolAddress,
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
  }
}

// --- Cache ---

const profileCache = new Map<string, PoolThreatProfile>()
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

export async function getPoolThreatProfile(
  poolAddress: string,
  ethPriceUsd: number,
  forceRefresh: boolean = false
): Promise<PoolThreatProfile> {
  const cacheKey = poolAddress.toLowerCase()
  const cached = profileCache.get(cacheKey)

  if (!forceRefresh && cached && Date.now() - cached.lastUpdated < CACHE_TTL_MS) {
    console.log(`📋 Using cached threat profile for ${poolAddress}`)
    return cached
  }

  const profile = await analyzePoolThreat(poolAddress, ethPriceUsd)
  profileCache.set(cacheKey, profile)
  return profile
}