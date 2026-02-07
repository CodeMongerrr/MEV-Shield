/**
 * MEV Searcher Detection - Advanced v2.0
 * Converted to TypeScript module for integration as a separate endpoint.
 * 
 * LOGIC IS UNCHANGED from the original JS script.
 * Only structural changes: module exports, types, https → fetch-compatible.
 */

import https from "https"

// ============================================================================
// TYPES
// ============================================================================

interface GraphSwap {
  id: string
  logIndex: string
  timestamp: string
  from: string
  to: string
  sender: string
  amount0In: string
  amount0Out: string
  amount1In: string
  amount1Out: string
  amountUSD: string
  transaction: {
    id: string
    blockNumber: string
  }
  pair: {
    token0: { symbol: string; decimals: string }
    token1: { symbol: string; decimals: string }
  }
}

interface NormalizedSwap {
  txHash: string
  blockNumber: number
  logIndex: number
  timestamp: number
  from: string
  to: string
  sender: string
  buyToken0: boolean
  amountIn: number
  amountOut: number
  amountUSD: number
  token0Symbol: string
  token1Symbol: string
  raw: { a0In: number; a0Out: number; a1In: number; a1Out: number }
  reserve0Before: number
  reserve1Before: number
  reserve0After: number
  reserve1After: number
}

interface AnalyzedSwap extends NormalizedSwap {
  expectedOut: number
  slippage: number
  priceImpact: number
  loss: number
  lossUSD: number
  isSandwich: boolean
  attacker?: string
  frontTx?: NormalizedSwap
  victimTx?: NormalizedSwap
  backTx?: NormalizedSwap
  estimatedProfitUSD?: number
  profitToken?: number
  victimLossUSD?: number
  blockSpan?: number
}

export interface PoolThreatResponse {
  poolAddress: string
  analyzedSwaps: number
  sandwichCount: number
  sandwichRate: number
  avgExcessSlippage: number
  totalMevExtracted: number
  minAttackedSizeUsd: number | null
  maxAttackedSizeUsd: number | null
  threatLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "EXTREME"
}

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  GRAPH_HOST: "gateway.thegraph.com",
  GRAPH_PATH: `/api/${process.env.GRAPH_API_KEY}/subgraphs/id/EYCKATKGBKLWvSfwvBjzfCBmGwYNdVkduYXVivCsLRFu`,

  SWAPS_TO_FETCH: 3000,
  CONTEXT_WINDOW: 5,

  FEE: 0.003,

  MIN_SLIPPAGE_PCT: 0.3,
  MIN_TRADE_SIZE_USD: 50,
  MAX_REASONABLE_SLIPPAGE: 20,
  MIN_SANDWICH_PROFIT_USD: 10,
  MAX_BLOCKS_BETWEEN_SANDWICH: 1,
}

// ============================================================================
// HELPERS
// ============================================================================

function isLikelyValidTrade(swap: NormalizedSwap): boolean {
  if (swap.amountOut <= 0) return false
  if (swap.amountIn <= 0) return false
  const outputRatio = swap.amountOut / swap.amountIn
  if (outputRatio < 0.000001) return false
  return true
}

function graphRequest(query: string, variables: Record<string, any> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query, variables })

    const req = https.request(
      {
        hostname: CONFIG.GRAPH_HOST,
        path: CONFIG.GRAPH_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
        },
      },
      (res) => {
        let body = ""
        res.on("data", (d: Buffer) => (body += d))
        res.on("end", () => {
          if (body.startsWith("<")) {
            return reject(
              new Error("Graph returned HTML – check API key or endpoint")
            )
          }
          try {
            const json = JSON.parse(body)
            if (json.errors) {
              return reject(new Error(json.errors[0].message))
            }
            resolve(json.data)
          } catch (e: any) {
            reject(new Error(`JSON parse error: ${e.message}`))
          }
        })
      }
    )

    req.on("error", reject)
    req.write(payload)
    req.end()
  })
}

// ============================================================================
// FETCH SWAPS
// ============================================================================

async function fetchLastSwaps(pool: string, limit: number): Promise<GraphSwap[]> {
  console.log(`[PoolThreat] Fetching last ${limit} swaps...`)

  const q = `
    query ($pool: String!, $first: Int!) {
      swaps(
        where: { pair: $pool }
        orderBy: timestamp
        orderDirection: desc
        first: $first
      ) {
        id
        logIndex
        timestamp
        from
        to
        sender
        amount0In
        amount0Out
        amount1In
        amount1Out
        amountUSD
        transaction { 
          id 
          blockNumber
        }
        pair {
          token0 { 
            symbol 
            decimals
          }
          token1 { 
            symbol 
            decimals
          }
        }
      }
    }
  `

  const data = await graphRequest(q, {
    pool: pool.toLowerCase(),
    first: limit,
  })

  console.log(`[PoolThreat] ✓ Fetched ${data.swaps.length} swaps`)
  return data.swaps
}

// ============================================================================
// NORMALIZATION
// ============================================================================

function normalize(swaps: GraphSwap[]): NormalizedSwap[] {
  const normalized = swaps
    .map((s): NormalizedSwap | null => {
      const a0In = Number(s.amount0In)
      const a0Out = Number(s.amount0Out)
      const a1In = Number(s.amount1In)
      const a1Out = Number(s.amount1Out)

      if (a0In === 0 && a1In === 0) return null
      if (a0Out === 0 && a1Out === 0) return null

      const buyToken0 = a1In > 0 && a0Out > 0

      const d0 = Number(s.pair.token0.decimals)
      const d1 = Number(s.pair.token1.decimals)

      const amountIn = buyToken0 ? a1In / 10 ** d1 : a0In / 10 ** d0
      const amountOut = buyToken0 ? a0Out / 10 ** d0 : a1Out / 10 ** d1

      const amountUSD = Number(s.amountUSD || 0)

      return {
        txHash: s.transaction.id,
        blockNumber: Number(s.transaction.blockNumber),
        logIndex: Number(s.logIndex),
        timestamp: Number(s.timestamp),
        from: s.from,
        to: s.to,
        sender: s.sender,

        buyToken0,
        amountIn,
        amountOut,
        amountUSD,

        token0Symbol: s.pair.token0.symbol,
        token1Symbol: s.pair.token1.symbol,

        raw: { a0In, a0Out, a1In, a1Out },

        reserve0Before: 0,
        reserve1Before: 0,
        reserve0After: 0,
        reserve1After: 0,
      }
    })
    .filter((s): s is NormalizedSwap => s !== null)
    .filter(isLikelyValidTrade)

  console.log(`[PoolThreat] Filtered to ${normalized.length} valid trades`)
  return normalized
}

function sortChronologically(swaps: NormalizedSwap[]): NormalizedSwap[] {
  return swaps.sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex
  )
}

// ============================================================================
// RESERVE RECONSTRUCTION
// ============================================================================

async function fetchCurrentReserves(pool: string): Promise<{ reserve0: number; reserve1: number }> {
  const q = `
    query ($pool: String!) {
      pair(id: $pool) {
        reserve0
        reserve1
        token0 { symbol }
        token1 { symbol }
      }
    }
  `
  const data = await graphRequest(q, { pool: pool.toLowerCase() })
  console.log(
    `[PoolThreat] Current reserves: ${Number(data.pair.reserve0).toFixed(2)} ${data.pair.token0.symbol} / ${Number(data.pair.reserve1).toFixed(2)} ${data.pair.token1.symbol}`
  )
  return {
    reserve0: Number(data.pair.reserve0),
    reserve1: Number(data.pair.reserve1),
  }
}

function reconstructReserves(swaps: NormalizedSwap[], current: { reserve0: number; reserve1: number }): void {
  console.log("[PoolThreat] Reconstructing reserves at each swap point...")

  let r0 = current.reserve0
  let r1 = current.reserve1

  for (let i = swaps.length - 1; i >= 0; i--) {
    const s = swaps[i]

    s.reserve0After = r0
    s.reserve1After = r1

    r0 = r0 - s.raw.a0Out + s.raw.a0In
    r1 = r1 - s.raw.a1Out + s.raw.a1In

    r0 = Math.max(r0, 1)
    r1 = Math.max(r1, 1)

    s.reserve0Before = r0
    s.reserve1Before = r1
  }

  console.log("[PoolThreat] ✓ Reserves reconstructed")
}

// ============================================================================
// MEV MATH
// ============================================================================

function expectedOut(amountIn: number, reserveIn: number, reserveOut: number, fee: number = CONFIG.FEE): number {
  if (reserveIn <= 0 || reserveOut <= 0 || amountIn <= 0) return 0
  const amountInWithFee = amountIn * (1 - fee)
  return (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee)
}

function slippagePct(expected: number, actual: number): number {
  if (expected <= 0 || actual < 0) return 0
  const slip = ((expected - actual) / expected) * 100
  return Math.max(0, Math.min(slip, CONFIG.MAX_REASONABLE_SLIPPAGE))
}

function calculatePriceImpact(amountIn: number, reserveIn: number, reserveOut: number): number {
  if (reserveIn <= 0 || reserveOut <= 0 || amountIn <= 0) return 0
  const spotPrice = reserveOut / reserveIn
  const effectivePrice = expectedOut(amountIn, reserveIn, reserveOut) / amountIn
  return Math.abs(((spotPrice - effectivePrice) / spotPrice) * 100)
}

// ============================================================================
// ADVANCED SANDWICH DETECTION
// ============================================================================

function detectSandwich(
  victim: NormalizedSwap & { lossUSD?: number; slippage?: number },
  before: NormalizedSwap[],
  after: NormalizedSwap[],
  _allSwaps: NormalizedSwap[]
): Partial<AnalyzedSwap> {
  const victimBlock = victim.blockNumber

  const beforeWindow = before.filter(
    (s) =>
      s.blockNumber >= victimBlock - CONFIG.MAX_BLOCKS_BETWEEN_SANDWICH &&
      s.blockNumber <= victimBlock
  )

  const afterWindow = after.filter(
    (s) =>
      s.blockNumber >= victimBlock &&
      s.blockNumber <= victimBlock + CONFIG.MAX_BLOCKS_BETWEEN_SANDWICH
  )

  for (const front of beforeWindow) {
    if (front.from === victim.from) continue
    if (front.sender === victim.sender && front.sender !== front.from) continue
    if (front.buyToken0 !== victim.buyToken0) continue
    if (front.blockNumber > victimBlock) continue
    if (front.blockNumber === victimBlock && front.logIndex >= victim.logIndex) continue
    if (front.amountUSD < 10) continue

    for (const back of afterWindow) {
      if (back.from !== front.from) continue
      if (back.buyToken0 === front.buyToken0) continue
      if (back.blockNumber < victimBlock) continue
      if (back.blockNumber === victimBlock && back.logIndex <= victim.logIndex) continue
      if (back.amountUSD < 10) continue

      const profit = calculateSandwichProfit(front, victim, back)

      if (profit.profitUSD < CONFIG.MIN_SANDWICH_PROFIT_USD) continue
      if (profit.profitUSD > victim.amountUSD * 10) continue

      return {
        isSandwich: true,
        attacker: front.from,
        frontTx: front,
        victimTx: victim,
        backTx: back,
        estimatedProfitUSD: profit.profitUSD,
        profitToken: profit.profitToken,
        victimLossUSD: profit.victimLossUSD,
        blockSpan: back.blockNumber - front.blockNumber,
      }
    }
  }

  return { isSandwich: false }
}

function calculateSandwichProfit(
  front: NormalizedSwap,
  victim: NormalizedSwap & { lossUSD?: number; slippage?: number },
  back: NormalizedSwap
): { profitUSD: number; profitToken: number; victimLossUSD: number } {
  let profitUSD = 0
  let victimLossUSD = 0

  if (front.amountUSD > 0 && back.amountUSD > 0) {
    if (front.buyToken0) {
      profitUSD = Math.max(0, back.amountUSD - front.amountUSD)
    } else {
      profitUSD = Math.max(0, back.amountUSD - front.amountUSD)
    }
  }

  if (victim.lossUSD && !isNaN(victim.lossUSD) && victim.lossUSD > 0) {
    victimLossUSD = victim.lossUSD
  } else if (victim.amountUSD > 0 && victim.slippage && victim.slippage > 0) {
    victimLossUSD = victim.amountUSD * (Math.min(victim.slippage, CONFIG.MAX_REASONABLE_SLIPPAGE) / 100)
  }

  return {
    profitUSD,
    profitToken: back.amountOut - front.amountIn,
    victimLossUSD,
  }
}

// ============================================================================
// ANALYSIS
// ============================================================================

function analyze(swaps: NormalizedSwap[]): AnalyzedSwap[] {
  console.log("[PoolThreat] Analyzing swaps for MEV patterns...")

  const results = swaps.map((s, i) => {
    const before = swaps.slice(Math.max(0, i - CONFIG.CONTEXT_WINDOW), i)
    const after = swaps.slice(i + 1, i + CONFIG.CONTEXT_WINDOW + 1)

    const rIn = s.buyToken0 ? s.reserve1Before : s.reserve0Before
    const rOut = s.buyToken0 ? s.reserve0Before : s.reserve1Before

    const exp = expectedOut(s.amountIn, rIn, rOut)
    const slip = slippagePct(exp, s.amountOut)
    const priceImpact = calculatePriceImpact(s.amountIn, rIn, rOut)
    const loss = Math.max(0, exp - s.amountOut)
    const lossUSD = s.amountUSD > 0 && slip > 0 ? s.amountUSD * (slip / 100) : 0

    const enriched = {
      ...s,
      expectedOut: exp,
      slippage: slip,
      priceImpact,
      loss,
      lossUSD: isNaN(lossUSD) || !isFinite(lossUSD) ? 0 : lossUSD,
    }

    const sandwichResult = detectSandwich(enriched as any, before, after, swaps)

    return {
      ...enriched,
      isSandwich: sandwichResult.isSandwich ?? false,
      attacker: sandwichResult.attacker,
      frontTx: sandwichResult.frontTx,
      victimTx: sandwichResult.victimTx,
      backTx: sandwichResult.backTx,
      estimatedProfitUSD: sandwichResult.estimatedProfitUSD,
      profitToken: sandwichResult.profitToken,
      victimLossUSD: sandwichResult.victimLossUSD,
      blockSpan: sandwichResult.blockSpan,
    } as AnalyzedSwap
  })

  console.log("[PoolThreat] ✓ Analysis complete")
  return results
}

// ============================================================================
// COMPUTE POOL THREAT RESPONSE (maps to dashboard section)
// ============================================================================

function computeThreatResponse(results: AnalyzedSwap[], poolAddress: string): PoolThreatResponse {
  const victims = results.filter(
    (r) =>
      r.slippage >= CONFIG.MIN_SLIPPAGE_PCT &&
      r.amountUSD >= CONFIG.MIN_TRADE_SIZE_USD &&
      r.slippage <= CONFIG.MAX_REASONABLE_SLIPPAGE
  )

  const sandwiches = results.filter((r) => r.isSandwich)

  const sandwichRate = results.length > 0 ? sandwiches.length / results.length : 0

  const avgExcessSlippage = victims.length > 0
    ? victims.reduce((sum, v) => sum + v.slippage, 0) / victims.length
    : 0

  const totalMevExtracted = victims.reduce((sum, v) => sum + (v.lossUSD || 0), 0)

  const sandwichVictimSizes = sandwiches
    .map((s) => s.victimTx?.amountUSD ?? s.amountUSD)
    .filter((v) => v > 0)

  const minAttackedSizeUsd = sandwichVictimSizes.length > 0
    ? Math.min(...sandwichVictimSizes)
    : null

  const maxAttackedSizeUsd = sandwichVictimSizes.length > 0
    ? Math.max(...sandwichVictimSizes)
    : null

  // Threat level derivation (same heuristic as original printStatistics)
  let threatLevel: PoolThreatResponse["threatLevel"] = "LOW"
  if (sandwichRate > 0.1 || totalMevExtracted > 10000) {
    threatLevel = "EXTREME"
  } else if (sandwichRate > 0.05 || totalMevExtracted > 5000) {
    threatLevel = "CRITICAL"
  } else if (sandwichRate > 0.02 || totalMevExtracted > 1000) {
    threatLevel = "HIGH"
  } else if (sandwichRate > 0.005 || totalMevExtracted > 100) {
    threatLevel = "MEDIUM"
  }

  return {
    poolAddress,
    analyzedSwaps: results.length,
    sandwichCount: sandwiches.length,
    sandwichRate: Number(sandwichRate.toFixed(6)),
    avgExcessSlippage: Number(avgExcessSlippage.toFixed(4)),
    totalMevExtracted: Number(totalMevExtracted.toFixed(2)),
    minAttackedSizeUsd,
    maxAttackedSizeUsd,
    threatLevel,
  }
}

// ============================================================================
// PUBLIC API — called by the endpoint handler
// ============================================================================

export async function analyzePoolThreat(poolAddress: string): Promise<PoolThreatResponse> {
  if (!process.env.GRAPH_API_KEY) {
    throw new Error("GRAPH_API_KEY environment variable not set")
  }

  const raw = await fetchLastSwaps(poolAddress, CONFIG.SWAPS_TO_FETCH)

  if (!raw.length) {
    return {
      poolAddress,
      analyzedSwaps: 0,
      sandwichCount: 0,
      sandwichRate: 0,
      avgExcessSlippage: 0,
      totalMevExtracted: 0,
      minAttackedSizeUsd: null,
      maxAttackedSizeUsd: null,
      threatLevel: "LOW",
    }
  }

  let swaps = normalize(raw)
  swaps = sortChronologically(swaps)

  const reserves = await fetchCurrentReserves(poolAddress)
  reconstructReserves(swaps, reserves)

  const results = analyze(swaps)

  return computeThreatResponse(results, poolAddress)
}