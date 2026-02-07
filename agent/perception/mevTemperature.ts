/**
 * MEV Temperature Calculator v3 — Unified MEV Analysis Engine
 * 
 * Replaces both the old simulator.ts AND poolHistory.ts with a single
 * data-driven MEV analysis pipeline based on historical swap data.
 *
 * CHANGES FROM v2:
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 1. PAGINATED FETCHING: Retrieves up to 100k+ swaps via multiple Graph API
 *    calls (The Graph caps at 1000 per query). Handles pools with < requested.
 * 2. ALL SLIPPAGE = MEV: Every swap with excess slippage above the AMM fee
 *    is treated as MEV activity, not just confirmed sandwiches. This catches
 *    JIT liquidity, atomic arb, and other extraction that doesn't leave
 *    obvious frontrun+backrun footprints.
 * 3. DETAILED LOGGING: Matches mevSearcher.js output style — top victims,
 *    sandwich details, attacker stats, arbitrage patterns.
 * 4. SIMULATION-COMPATIBLE: Exports MEVSimulationResult that replaces the
 *    old SandwichSimulation type consumed by calcOptimizer and the rest
 *    of the pipeline.
 * 5. BUG FIX: Correctly handles The Graph's already-decimal-normalized
 *    amount fields for reserve reconstruction and slippage calculation.
 */

// ============================================================================
// CORE TYPES
// ============================================================================

export interface MEVTemperatureMetrics {
  // Risk scoring (0-100)
  score: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  
  // Cost multipliers for optimizer
  mevCostMultiplier: number;      // 1.0 - 3.0x based on historical MEV intensity
  safeThresholdUsd: number;       // Empirical threshold where attacks become unprofitable
  
  // Statistical evidence
  victimRate: number;             // % of swaps that suffered MEV
  avgSlippage: number;            // Average slippage for victims
  maxSlippage: number;            // Worst observed slippage
  sandwichCount: number;          // Number of detected sandwiches
  totalLossUsd: number;           // Total USD lost to MEV in sample
  
  // Detailed breakdown
  significantVictimCount: number; // Swaps with slippage > threshold
  avgVictimSizeUsd: number;       // Average trade size of victims
  minAttackedSizeUsd: number;     // Smallest attacked trade
  maxAttackedSizeUsd: number;     // Largest attacked trade
  totalVolumeAnalyzedUsd: number; // Total volume in sample
  
  // Arbitrage
  arbPatternCount: number;
  topAttackers: Array<{
    address: string;
    attackCount: number;
    estimatedProfitUsd: number;
    victimLossUsd: number;
  }>;
  
  // Sample metadata
  sampleSize: number;
  poolLiquidity: number;
  timestamp: number;
}

export interface PoolMEVProfile {
  poolAddress: string;
  token0Symbol: string;
  token1Symbol: string;
  metrics: MEVTemperatureMetrics;
  
  // Optimizer integration helpers
  getAdjustedMEV(baseMEV: number): number;
  isChunkSafe(chunkSizeUsd: number): boolean;
  getRecommendedSplits(tradeSizeUsd: number): number;
}

/**
 * Simulation-compatible output that replaces the old SandwichSimulation.
 * Contains everything the optimizer, decision engine, executor, and agent need.
 */
export interface MEVSimulationResult {
  // Fields consumed by the optimizer
  estimatedLossUsd: number;
  ethPriceUsd: number;
  reserveIn: bigint;
  reserveOut: bigint;
  inDecimals: number;
  outDecimals: number;
  poolDepthUsd: number;
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;

  // MEV profile
  mevProfile: PoolMEVProfile;

  // Risk assessment
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  tradeToPoolRatio: number;
  isShallowPool: boolean;
  safeChunkThresholdUsd: number;

  // Fields needed by executor / agent
  cleanOutputRaw: bigint;
  attackedOutputRaw: bigint;
  lossPercent: number;
  attackViable: boolean;
  attackerProfitUsd: number;
  gasData: {
    gasPriceWei: bigint;
    sandwichGasCostWei: bigint;
    sandwichGasCostUsd: number;
  };
}

// ============================================================================
// INTERNAL TYPES
// ============================================================================

interface TemperatureSwapData {
  txHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp: number;
  from: string;
  to: string;
  sender: string;
  
  buyToken0: boolean;
  amountIn: number;
  amountOut: number;
  amountUSD: number;
  
  token0Symbol: string;
  token1Symbol: string;
  
  raw: {
    a0In: number;
    a0Out: number;
    a1In: number;
    a1Out: number;
  };
  
  reserve0Before: number;
  reserve1Before: number;
  reserve0After: number;
  reserve1After: number;
}

interface AnalyzedSwap extends TemperatureSwapData {
  expectedOut: number;
  slippage: number;
  priceImpact: number;
  loss: number;
  lossUSD: number;
  isSandwich: boolean;
  attacker?: string;
  frontTx?: TemperatureSwapData;
  backTx?: TemperatureSwapData;
  estimatedProfitUSD?: number;
  victimLossUSD: number;
  blockSpan?: number;
}

interface GraphSwap {
  id: string;
  logIndex: string;
  timestamp: string;
  from: string;
  to: string;
  sender: string;
  amount0In: string;
  amount0Out: string;
  amount1In: string;
  amount1Out: string;
  amountUSD: string;
  transaction: {
    id: string;
    blockNumber: string;
  };
  pair: {
    token0: {
      symbol: string;
      decimals: string;
    };
    token1: {
      symbol: string;
      decimals: string;
    };
  };
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  FEE: 0.003,
  MIN_SLIPPAGE_PCT: 0.3,           // Even 0.3% is significant MEV signal
  MIN_TRADE_SIZE_USD: 50,           // Catch smaller victims too
  MAX_REASONABLE_SLIPPAGE: 20,      // Cap for outlier filtering
  CONTEXT_WINDOW: 5,                // Lookback/lookahead for sandwich detection
  MAX_BLOCKS_BETWEEN_SANDWICH: 1,   // Most sandwiches are same-block or ±1
  MIN_SANDWICH_PROFIT_USD: 10,      // Lower threshold to catch more

  // Paginated fetching
  PAGE_SIZE: 3000,                  // The Graph max per query
  DEFAULT_TARGET_SWAPS: 10000,    // Target swap count
  MIN_SWAPS_FOR_ANALYSIS: 50,       // Minimum to produce meaningful metrics

  // Display
  TOP_VICTIMS_TO_SHOW: 20,
  TOP_SANDWICHES_TO_SHOW: 15,
  TOP_ATTACKERS_TO_SHOW: 5,

  // Optimizer integration
  CACHE_TTL_MS: 5 * 60 * 1000,     // 5 minutes
} as const;

// ============================================================================
// GRAPH API — PAGINATED FETCHING
// ============================================================================

async function fetchSwapPage(
  poolAddress: string,
  limit: number,
  graphApiKey: string,
  lastTimestamp?: string,
  lastLogIndex?: string,
): Promise<GraphSwap[]> {
  // Build where clause for cursor-based pagination
  // The Graph doesn't support offset, so we paginate by timestamp + logIndex
  let whereClause = `pair: "${poolAddress.toLowerCase()}"`;
  if (lastTimestamp) {
    whereClause += `, timestamp_lte: "${lastTimestamp}"`;
  }

  const query = `
    query ($first: Int!) {
      swaps(
        where: { ${whereClause} }
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
          token0 { symbol decimals }
          token1 { symbol decimals }
        }
      }
    }
  `;

  const response = await fetch(
    `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/EYCKATKGBKLWvSfwvBjzfCBmGwYNdVkduYXVivCsLRFu`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { first: limit },
      }),
    }
  );

  const data = await response.json();

  if (data.errors) {
    throw new Error(`Graph API error: ${data.errors[0].message}`);
  }

  return data.data?.swaps ?? [];
}

/**
 * Fetch up to `targetSwaps` swaps via paginated Graph API calls.
 * Handles edge case where pool has fewer swaps than requested.
 */
async function fetchAllSwaps(
  poolAddress: string,
  targetSwaps: number,
  graphApiKey: string,
): Promise<GraphSwap[]> {
  const allSwaps: GraphSwap[] = [];
  let lastTimestamp: string | undefined;
  let lastId: string | undefined;
  let pageCount = 0;
  const seenIds = new Set<string>();

  console.log(`   📡 Fetching up to ${targetSwaps.toLocaleString()} swaps (${CONFIG.PAGE_SIZE}/page)...`);

  while (allSwaps.length < targetSwaps) {
    const remaining = Math.min(CONFIG.PAGE_SIZE, targetSwaps - allSwaps.length);
    const page = await fetchSwapPage(
      poolAddress,
      remaining,
      graphApiKey,
      lastTimestamp,
    );
    pageCount++;

    if (page.length === 0) {
      console.log(`   📡 Page ${pageCount}: 0 swaps — pool exhausted`);
      break;
    }

    // Deduplicate (pagination by timestamp can produce overlaps)
    let newCount = 0;
    for (const swap of page) {
      if (!seenIds.has(swap.id)) {
        seenIds.add(swap.id);
        allSwaps.push(swap);
        newCount++;
      }
    }

    const lastSwap = page[page.length - 1];
    const newTimestamp = lastSwap.timestamp;

    // If timestamp didn't change, we're stuck — break to avoid infinite loop
    if (lastTimestamp === newTimestamp && newCount === 0) {
      console.log(`   📡 Page ${pageCount}: pagination stuck at timestamp ${newTimestamp}, stopping`);
      break;
    }

    lastTimestamp = newTimestamp;
    lastId = lastSwap.id;

    console.log(
      `   📡 Page ${pageCount}: +${newCount} new swaps (total: ${allSwaps.length.toLocaleString()})` +
      (page.length < remaining ? ' — no more data' : '')
    );

    // If page returned fewer than requested, pool is exhausted
    if (page.length < remaining) break;

    // Small delay to be nice to The Graph
    if (allSwaps.length < targetSwaps) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`   ✓ Fetched ${allSwaps.length.toLocaleString()} total swaps in ${pageCount} pages\n`);
  return allSwaps;
}

async function fetchCurrentReserves(
  poolAddress: string,
  graphApiKey: string,
): Promise<{ reserve0: number; reserve1: number }> {
  const query = `
    query ($pool: String!) {
      pair(id: $pool) {
        reserve0
        reserve1
      }
    }
  `;

  const response = await fetch(
    `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/EYCKATKGBKLWvSfwvBjzfCBmGwYNdVkduYXVivCsLRFu`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { pool: poolAddress.toLowerCase() },
      }),
    }
  );

  const data = await response.json();

  if (data.errors) {
    throw new Error(`Graph API error: ${data.errors[0].message}`);
  }

  return {
    reserve0: Number(data.data.pair.reserve0),
    reserve1: Number(data.data.pair.reserve1),
  };
}

// ============================================================================
// DATA PROCESSING — Matches mevSearcher.js exactly
// ============================================================================

function isValidTrade(swap: TemperatureSwapData): boolean {
  if (swap.amountOut <= 0 || swap.amountIn <= 0) return false;
  const outputRatio = swap.amountOut / swap.amountIn;
  if (outputRatio < 0.000001) return false;
  return true;
}

function normalizeSwaps(rawSwaps: GraphSwap[]): TemperatureSwapData[] {
  return rawSwaps
    .map((s): TemperatureSwapData | null => {
      const a0In = Number(s.amount0In);
      const a0Out = Number(s.amount0Out);
      const a1In = Number(s.amount1In);
      const a1Out = Number(s.amount1Out);

      if (a0In === 0 && a1In === 0) return null;
      if (a0Out === 0 && a1Out === 0) return null;

      const buyToken0 = a1In > 0 && a0Out > 0;
      const d0 = Number(s.pair.token0.decimals);
      const d1 = Number(s.pair.token1.decimals);

      // The Graph returns amounts as raw token values (not decimal-adjusted).
      // We normalize them identically to mevSearcher.js.
      const amountIn = buyToken0 ? a1In / 10 ** d1 : a0In / 10 ** d0;
      const amountOut = buyToken0 ? a0Out / 10 ** d0 : a1Out / 10 ** d1;

      return {
        txHash: s.transaction.id,
        blockNumber: Number(s.transaction.blockNumber),
        logIndex: Number(s.logIndex),
        timestamp: Number(s.timestamp),
        from: s.from,
        to: s.to,
        sender: s.sender ?? s.from,

        buyToken0,
        amountIn,
        amountOut,
        amountUSD: Number(s.amountUSD || 0),

        token0Symbol: s.pair.token0.symbol,
        token1Symbol: s.pair.token1.symbol,

        raw: { a0In, a0Out, a1In, a1Out },

        reserve0Before: 0,
        reserve1Before: 0,
        reserve0After: 0,
        reserve1After: 0,
      };
    })
    .filter((s): s is TemperatureSwapData => s !== null)
    .filter(isValidTrade)
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

function reconstructReserves(
  swaps: TemperatureSwapData[],
  currentReserves: { reserve0: number; reserve1: number },
): void {
  let r0 = currentReserves.reserve0;
  let r1 = currentReserves.reserve1;

  // Walk backwards from most recent, undoing each swap's effect
  for (let i = swaps.length - 1; i >= 0; i--) {
    const s = swaps[i];
    s.reserve0After = r0;
    s.reserve1After = r1;

    r0 = Math.max(1, r0 - s.raw.a0Out + s.raw.a0In);
    r1 = Math.max(1, r1 - s.raw.a1Out + s.raw.a1In);

    s.reserve0Before = r0;
    s.reserve1Before = r1;
  }
}

// ============================================================================
// MEV MATH — Identical to mevSearcher.js
// ============================================================================

function expectedOut(
  amountIn: number,
  reserveIn: number,
  reserveOut: number,
  fee: number = CONFIG.FEE,
): number {
  if (reserveIn <= 0 || reserveOut <= 0 || amountIn <= 0) return 0;
  const amountInWithFee = amountIn * (1 - fee);
  return (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
}

function slippagePct(expected: number, actual: number): number {
  if (expected <= 0 || actual < 0) return 0;
  const slip = ((expected - actual) / expected) * 100;
  return Math.max(0, Math.min(slip, CONFIG.MAX_REASONABLE_SLIPPAGE));
}

function calculatePriceImpact(amountIn: number, reserveIn: number, reserveOut: number): number {
  if (reserveIn <= 0 || reserveOut <= 0 || amountIn <= 0) return 0;
  const spotPrice = reserveOut / reserveIn;
  const effectivePrice = expectedOut(amountIn, reserveIn, reserveOut) / amountIn;
  return Math.abs(((spotPrice - effectivePrice) / spotPrice) * 100);
}

// ============================================================================
// SANDWICH DETECTION — From mevSearcher.js
// ============================================================================

interface SandwichResult {
  isSandwich: boolean;
  attacker?: string;
  frontTx?: TemperatureSwapData;
  backTx?: TemperatureSwapData;
  estimatedProfitUSD?: number;
  victimLossUSD: number;
  blockSpan?: number;
}

function calculateSandwichProfit(
  front: AnalyzedSwap,
  victim: AnalyzedSwap,
  back: AnalyzedSwap,
): { profitUSD: number; victimLossUSD: number } {
  let profitUSD = 0;
  let victimLossUSD = 0;

  if (front.amountUSD > 0 && back.amountUSD > 0) {
    profitUSD = Math.max(0, back.amountUSD - front.amountUSD);
  }

  if (victim.lossUSD && !isNaN(victim.lossUSD) && victim.lossUSD > 0) {
    victimLossUSD = victim.lossUSD;
  } else if (victim.amountUSD > 0 && victim.slippage > 0) {
    victimLossUSD = victim.amountUSD * (Math.min(victim.slippage, CONFIG.MAX_REASONABLE_SLIPPAGE) / 100);
  }

  return { profitUSD, victimLossUSD };
}

function detectSandwich(
  victim: AnalyzedSwap,
  before: AnalyzedSwap[],
  after: AnalyzedSwap[],
): SandwichResult {
  const victimBlock = victim.blockNumber;

  const beforeWindow = before.filter(
    (s) =>
      s.blockNumber >= victimBlock - CONFIG.MAX_BLOCKS_BETWEEN_SANDWICH &&
      s.blockNumber <= victimBlock,
  );

  const afterWindow = after.filter(
    (s) =>
      s.blockNumber >= victimBlock &&
      s.blockNumber <= victimBlock + CONFIG.MAX_BLOCKS_BETWEEN_SANDWICH,
  );

  for (const front of beforeWindow) {
    if (front.from === victim.from) continue;
    if (front.sender === victim.sender && front.sender !== front.from) continue;
    if (front.buyToken0 !== victim.buyToken0) continue;
    if (front.blockNumber > victimBlock) continue;
    if (front.blockNumber === victimBlock && front.logIndex >= victim.logIndex) continue;
    if (front.amountUSD < 10) continue;

    for (const back of afterWindow) {
      if (back.from !== front.from) continue;
      if (back.buyToken0 === front.buyToken0) continue;
      if (back.blockNumber < victimBlock) continue;
      if (back.blockNumber === victimBlock && back.logIndex <= victim.logIndex) continue;
      if (back.amountUSD < 10) continue;

      const profit = calculateSandwichProfit(front, victim, back);
      if (profit.profitUSD < CONFIG.MIN_SANDWICH_PROFIT_USD) continue;
      if (profit.profitUSD > victim.amountUSD * 10) continue;

      return {
        isSandwich: true,
        attacker: front.from,
        frontTx: front,
        backTx: back,
        estimatedProfitUSD: profit.profitUSD,
        victimLossUSD: profit.victimLossUSD,
        blockSpan: back.blockNumber - front.blockNumber,
      };
    }
  }

  return { isSandwich: false, victimLossUSD: 0 };
}

// ============================================================================
// ARBITRAGE DETECTION — From mevSearcher.js
// ============================================================================

interface ArbPattern {
  address: string;
  tradeCount: number;
  totalValueUSD: number;
  blocks: number[];
}

function detectArbitrage(swaps: TemperatureSwapData[]): ArbPattern[] {
  const addressSwaps = new Map<string, TemperatureSwapData[]>();

  swaps.forEach((s) => {
    if (!addressSwaps.has(s.from)) addressSwaps.set(s.from, []);
    addressSwaps.get(s.from)!.push(s);
  });

  const arbPatterns: ArbPattern[] = [];

  for (const [address, trades] of addressSwaps) {
    if (trades.length < 2) continue;
    const buyToken0 = trades.filter((t) => t.buyToken0);
    const sellToken0 = trades.filter((t) => !t.buyToken0);

    if (buyToken0.length > 0 && sellToken0.length > 0) {
      const totalValueUSD = trades.reduce((sum, t) => sum + (t.amountUSD || 0), 0);
      if (totalValueUSD > 5000) {
        arbPatterns.push({
          address,
          tradeCount: trades.length,
          totalValueUSD,
          blocks: [...new Set(trades.map((t) => t.blockNumber))].slice(0, 10),
        });
      }
    }
  }

  return arbPatterns.sort((a, b) => b.totalValueUSD - a.totalValueUSD);
}

// ============================================================================
// FULL ANALYSIS — Incorporates mevSearcher.js analyze() + reporting
// ============================================================================

function analyzeSwaps(swaps: TemperatureSwapData[]): AnalyzedSwap[] {
  return swaps.map((s, i) => {
    const before = swaps.slice(Math.max(0, i - CONFIG.CONTEXT_WINDOW), i) as AnalyzedSwap[];
    const after = swaps.slice(i + 1, i + CONFIG.CONTEXT_WINDOW + 1) as AnalyzedSwap[];

    const rIn = s.buyToken0 ? s.reserve1Before : s.reserve0Before;
    const rOut = s.buyToken0 ? s.reserve0Before : s.reserve1Before;

    const exp = expectedOut(s.amountIn, rIn, rOut);
    const slip = slippagePct(exp, s.amountOut);
    const impact = calculatePriceImpact(s.amountIn, rIn, rOut);
    const loss = Math.max(0, exp - s.amountOut);
    const lossUSD = s.amountUSD > 0 && slip > 0 ? s.amountUSD * (slip / 100) : 0;

    const analyzed: AnalyzedSwap = {
      ...s,
      expectedOut: exp,
      slippage: slip,
      priceImpact: impact,
      loss,
      lossUSD: isNaN(lossUSD) || !isFinite(lossUSD) ? 0 : lossUSD,
      isSandwich: false,
      victimLossUSD: 0,
    };

    // Must run sandwich detection on the already-analyzed object
    const sandwich = detectSandwich(analyzed, before, after);
    analyzed.isSandwich = sandwich.isSandwich;
    analyzed.attacker = sandwich.attacker;
    analyzed.frontTx = sandwich.frontTx;
    analyzed.backTx = sandwich.backTx;
    analyzed.estimatedProfitUSD = sandwich.estimatedProfitUSD;
    analyzed.victimLossUSD = sandwich.victimLossUSD;
    analyzed.blockSpan = sandwich.blockSpan;

    return analyzed;
  });
}

// ============================================================================
// REPORTING — mevSearcher.js style logs
// ============================================================================

function printStatistics(results: AnalyzedSwap[]): void {
  console.log(`\n╔════════════════════════════════════════════════════════╗`);
  console.log(`║           MEV DETECTION STATISTICS                     ║`);
  console.log(`╚════════════════════════════════════════════════════════╝\n`);

  const victims = results.filter(
    (r) =>
      r.slippage >= CONFIG.MIN_SLIPPAGE_PCT &&
      r.amountUSD >= CONFIG.MIN_TRADE_SIZE_USD &&
      r.slippage <= CONFIG.MAX_REASONABLE_SLIPPAGE,
  );

  const sandwiches = results.filter((r) => r.isSandwich);

  const totalLossUSD = victims.reduce((sum, v) => sum + (v.lossUSD || 0), 0);
  const avgSlippage = victims.length > 0
    ? victims.reduce((sum, v) => sum + v.slippage, 0) / victims.length
    : 0;
  const maxSlippage = victims.length > 0
    ? Math.max(...victims.map((v) => v.slippage))
    : 0;

  const sandwichProfitUSD = sandwiches.reduce((sum, s) => sum + (s.estimatedProfitUSD || 0), 0);
  const sandwichVictimLossUSD = sandwiches.reduce((sum, s) => sum + (s.victimLossUSD || 0), 0);

  console.log(`Total swaps analyzed:           ${results.length}`);
  console.log(`Significant MEV victims:        ${victims.length} (${((victims.length / results.length) * 100).toFixed(1)}%)`);
  console.log(`  └─ Min trade size: $${CONFIG.MIN_TRADE_SIZE_USD}, Min slippage: ${CONFIG.MIN_SLIPPAGE_PCT}%`);
  console.log(`Sandwich attacks detected:      ${sandwiches.length}`);

  if (victims.length > 0) {
    console.log(`Average slippage (victims):     ${avgSlippage.toFixed(2)}%`);
    console.log(`Maximum slippage:               ${maxSlippage.toFixed(2)}%`);
    console.log(`Total victim losses (USD):      $${totalLossUSD.toFixed(2)}`);
    console.log(`  └─ Sandwich victim losses:    $${sandwichVictimLossUSD.toFixed(2)}`);
  }

  if (sandwiches.length > 0) {
    console.log(`Est. sandwich profits (USD):    $${sandwichProfitUSD.toFixed(2)}`);

    const blockSpans = sandwiches.map((s) => s.blockSpan ?? 0);
    const avgBlockSpan = blockSpans.reduce((a, b) => a + b, 0) / blockSpans.length;
    console.log(`Avg sandwich block span:        ${avgBlockSpan.toFixed(1)} blocks`);

    const sameBlock = sandwiches.filter((s) => (s.blockSpan ?? 0) === 0).length;
    console.log(`  └─ Same-block sandwiches:     ${sameBlock}`);
    console.log(`  └─ Cross-block sandwiches:    ${sandwiches.length - sameBlock}`);
  }

  console.log('');
}

function printTopVictims(results: AnalyzedSwap[]): void {
  const victims = results
    .filter(
      (r) =>
        r.slippage >= CONFIG.MIN_SLIPPAGE_PCT &&
        r.amountUSD >= CONFIG.MIN_TRADE_SIZE_USD &&
        r.slippage <= CONFIG.MAX_REASONABLE_SLIPPAGE,
    )
    .sort((a, b) => b.lossUSD - a.lossUSD)
    .slice(0, CONFIG.TOP_VICTIMS_TO_SHOW);

  if (!victims.length) {
    console.log('No significant MEV victims found.\n');
    return;
  }

  console.log(`╔════════════════════════════════════════════════════════╗`);
  console.log(`║  TOP ${CONFIG.TOP_VICTIMS_TO_SHOW} WORST MEV VICTIMS (by $loss)                   ║`);
  console.log(`╚════════════════════════════════════════════════════════╝\n`);

  victims.forEach((v, i) => {
    const direction = v.buyToken0
      ? `${v.token1Symbol} → ${v.token0Symbol}`
      : `${v.token0Symbol} → ${v.token1Symbol}`;

    console.log(`${(i + 1).toString().padStart(2)}. ${v.isSandwich ? '🚨' : '⚠️ '} Block ${v.blockNumber} | ${direction}`);
    console.log(`    Tx: ${v.txHash}`);
    console.log(`    Trader: ${v.from}`);
    console.log(`    Trade Size: $${v.amountUSD.toFixed(2)}`);
    console.log(`    Slippage: ${v.slippage.toFixed(2)}% | Loss: $${v.lossUSD.toFixed(2)}`);

    if (v.isSandwich) {
      console.log(`    🚨 SANDWICHED by ${v.attacker}`);
    }
    console.log('');
  });
}

function printDetailedSandwiches(results: AnalyzedSwap[]): void {
  const sandwiches = results.filter((r) => r.isSandwich);

  if (!sandwiches.length) {
    console.log('No sandwich attacks detected.\n');
    return;
  }

  console.log(`╔════════════════════════════════════════════════════════╗`);
  console.log(`║          DETAILED SANDWICH ANALYSIS                    ║`);
  console.log(`╚════════════════════════════════════════════════════════╝\n`);

  // Attacker stats
  const byAttacker = new Map<string, AnalyzedSwap[]>();
  sandwiches.forEach((s) => {
    const key = s.attacker ?? 'unknown';
    if (!byAttacker.has(key)) byAttacker.set(key, []);
    byAttacker.get(key)!.push(s);
  });

  const attackerStats = Array.from(byAttacker.entries())
    .map(([attacker, attacks]) => ({
      attacker,
      count: attacks.length,
      totalProfit: attacks.reduce((sum, a) => sum + (a.estimatedProfitUSD || 0), 0),
      totalVictimLoss: attacks.reduce((sum, a) => sum + (a.victimLossUSD || 0), 0),
    }))
    .sort((a, b) => b.totalProfit - a.totalProfit);

  console.log('Top Attackers:\n');
  attackerStats.slice(0, CONFIG.TOP_ATTACKERS_TO_SHOW).forEach((stat, i) => {
    console.log(`${i + 1}. ${stat.attacker}`);
    console.log(`   Attacks: ${stat.count}`);
    console.log(`   Estimated Profit: $${stat.totalProfit.toFixed(2)}`);
    console.log(`   Victim Losses: $${stat.totalVictimLoss.toFixed(2)}\n`);
  });

  console.log('\nDetailed Sandwich Examples:\n');
  sandwiches
    .sort((a, b) => (b.estimatedProfitUSD ?? 0) - (a.estimatedProfitUSD ?? 0))
    .slice(0, CONFIG.TOP_SANDWICHES_TO_SHOW)
    .forEach((s, i) => {
      console.log(`━━━ Sandwich #${i + 1} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Attacker: ${s.attacker}`);
      console.log(`Profit: $${(s.estimatedProfitUSD ?? 0).toFixed(2)} | Victim Loss: $${s.victimLossUSD.toFixed(2)}\n`);

      if (s.frontTx) {
        console.log(`  🔴 FRONT-RUN (Block ${s.frontTx.blockNumber}, Index ${s.frontTx.logIndex})`);
        console.log(`     Size: $${s.frontTx.amountUSD.toFixed(2)}\n`);
      }

      console.log(`  🎯 VICTIM (Block ${s.blockNumber}, Index ${s.logIndex})`);
      console.log(`     Trader: ${s.from}`);
      console.log(`     Size: $${s.amountUSD.toFixed(2)} | Slippage: ${s.slippage.toFixed(2)}%\n`);

      if (s.backTx) {
        console.log(`  🟢 BACK-RUN (Block ${s.backTx.blockNumber}, Index ${s.backTx.logIndex})`);
        console.log(`     Size: $${s.backTx.amountUSD.toFixed(2)}\n`);
      }
    });
}

function printArbitragePatterns(swaps: TemperatureSwapData[]): void {
  const arbPatterns = detectArbitrage(swaps);

  if (!arbPatterns.length) {
    console.log('No significant arbitrage patterns detected.\n');
    return;
  }

  console.log(`╔════════════════════════════════════════════════════════╗`);
  console.log(`║          POTENTIAL ARBITRAGE ACTIVITY                  ║`);
  console.log(`╚════════════════════════════════════════════════════════╝\n`);

  arbPatterns.slice(0, 10).forEach((arb, i) => {
    console.log(`${i + 1}. ${arb.address}`);
    console.log(`   Trades: ${arb.tradeCount} | Volume: $${arb.totalValueUSD.toFixed(2)}\n`);
  });
}

// ============================================================================
// MEV TEMPERATURE CALCULATION
// ============================================================================

function calculateMEVTemperature(
  results: AnalyzedSwap[],
  swaps: TemperatureSwapData[],
  poolLiquidity: number,
): MEVTemperatureMetrics {
  // ALL significant-slippage swaps are treated as MEV victims
  // (not just confirmed sandwiches — catches JIT, atomic arb, etc.)
  const victims = results.filter(
    (r) =>
      r.slippage >= CONFIG.MIN_SLIPPAGE_PCT &&
      r.amountUSD >= CONFIG.MIN_TRADE_SIZE_USD &&
      r.slippage <= CONFIG.MAX_REASONABLE_SLIPPAGE,
  );

  const sandwiches = results.filter((r) => r.isSandwich);

  const victimRate = results.length > 0 ? (victims.length / results.length) * 100 : 0;
  const avgSlippage = victims.length > 0
    ? victims.reduce((sum, v) => sum + v.slippage, 0) / victims.length
    : 0;
  const maxSlippage = victims.length > 0
    ? Math.max(...victims.map((v) => v.slippage))
    : 0;
  const totalLossUsd = victims.reduce((sum, v) => sum + v.lossUSD, 0);
  const sandwichCount = sandwiches.length;
  const totalVolumeAnalyzedUsd = results.reduce((sum, r) => sum + r.amountUSD, 0);

  // Victim size statistics
  const victimSizes = victims.map((v) => v.amountUSD).sort((a, b) => a - b);
  const avgVictimSizeUsd = victims.length > 0
    ? victims.reduce((sum, v) => sum + v.amountUSD, 0) / victims.length
    : 0;
  const minAttackedSizeUsd = victimSizes.length > 0 ? victimSizes[0] : 0;
  const maxAttackedSizeUsd = victimSizes.length > 0 ? victimSizes[victimSizes.length - 1] : 0;

  // ── MEV Temperature Score (0-100) ──────────────────────────────────────
  //
  // Three components weighted to capture different MEV signals:
  //
  // 1. Victim rate (0-40 pts): What fraction of trades get hit?
  //    6.2% victim rate → 62 → capped at 40
  //
  // 2. Average slippage severity (0-30 pts): How bad is the damage?
  //    0.57% avg slippage → 1.71 pts (mild pool)
  //    3% avg slippage → 9 pts (hot pool)
  //
  // 3. Sandwich density (0-30 pts): Confirmed sandwich attacks per swap
  //    Also boosted by total loss relative to volume
  //
  const victimRateScore = Math.min(40, victimRate * 6);
  const slippageScore = Math.min(30, avgSlippage * 3);

  // Sandwich score: direct sandwich count OR high total loss relative to volume
  const sandwichDensity = results.length > 0 ? (sandwichCount / results.length) * 100 : 0;
  const lossToVolumeRatio = totalVolumeAnalyzedUsd > 0 ? (totalLossUsd / totalVolumeAnalyzedUsd) * 100 : 0;
  const sandwichScore = Math.min(30, Math.max(
    sandwichDensity * 30,         // Direct sandwich signal
    lossToVolumeRatio * 100,      // Loss/volume signal (catches non-sandwich MEV)
  ));

  const score = Math.min(100, victimRateScore + slippageScore + sandwichScore);

  // Risk level
  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  if (score >= 75) riskLevel = 'EXTREME';
  else if (score >= 50) riskLevel = 'HIGH';
  else if (score >= 25) riskLevel = 'MEDIUM';
  else riskLevel = 'LOW';

  // Empirical safe threshold from victim distribution
  // 10th percentile of victim sizes — trades below this rarely get hit
  const p10Index = Math.floor(victimSizes.length * 0.1);
  const empiricalThreshold = victimSizes.length > 10
    ? victimSizes[p10Index]
    : 500; // Default $500 if insufficient data

  // MEV cost multiplier: 1.0x to 3.0x
  const mevCostMultiplier = 1.0 + (score / 100) * 2.0;

  // Arbitrage patterns
  const arbPatterns = detectArbitrage(swaps);

  // Attacker stats
  const byAttacker = new Map<string, AnalyzedSwap[]>();
  sandwiches.forEach((s) => {
    const key = s.attacker ?? 'unknown';
    if (!byAttacker.has(key)) byAttacker.set(key, []);
    byAttacker.get(key)!.push(s);
  });

  const topAttackers = Array.from(byAttacker.entries())
    .map(([address, attacks]) => ({
      address,
      attackCount: attacks.length,
      estimatedProfitUsd: attacks.reduce((sum, a) => sum + (a.estimatedProfitUSD || 0), 0),
      victimLossUsd: attacks.reduce((sum, a) => sum + (a.victimLossUSD || 0), 0),
    }))
    .sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd)
    .slice(0, CONFIG.TOP_ATTACKERS_TO_SHOW);

  return {
    score: Math.round(score * 100) / 100,
    riskLevel,
    mevCostMultiplier,
    safeThresholdUsd: Math.max(empiricalThreshold, 100),
    victimRate: Math.round(victimRate * 100) / 100,
    avgSlippage: Math.round(avgSlippage * 100) / 100,
    maxSlippage: Math.round(maxSlippage * 100) / 100,
    sandwichCount,
    totalLossUsd: Math.round(totalLossUsd * 100) / 100,

    significantVictimCount: victims.length,
    avgVictimSizeUsd: Math.round(avgVictimSizeUsd * 100) / 100,
    minAttackedSizeUsd: Math.round(minAttackedSizeUsd * 100) / 100,
    maxAttackedSizeUsd: Math.round(maxAttackedSizeUsd * 100) / 100,
    totalVolumeAnalyzedUsd: Math.round(totalVolumeAnalyzedUsd * 100) / 100,

    arbPatternCount: arbPatterns.length,
    topAttackers,

    sampleSize: results.length,
    poolLiquidity,
    timestamp: Date.now(),
  };
}

// ============================================================================
// POOL MEV PROFILE (Optimizer Integration)
// ============================================================================

class PoolMEVProfileImpl implements PoolMEVProfile {
  constructor(
    public poolAddress: string,
    public token0Symbol: string,
    public token1Symbol: string,
    public metrics: MEVTemperatureMetrics,
  ) {}

  getAdjustedMEV(baseMEV: number): number {
    return baseMEV * this.metrics.mevCostMultiplier;
  }

  isChunkSafe(chunkSizeUsd: number): boolean {
    return chunkSizeUsd < this.metrics.safeThresholdUsd;
  }

  getRecommendedSplits(tradeSizeUsd: number): number {
    const { score, safeThresholdUsd } = this.metrics;
    if (tradeSizeUsd < 1000) return 1;
    if (tradeSizeUsd < safeThresholdUsd) return 1;

    const minSplitsForSafety = Math.ceil(tradeSizeUsd / safeThresholdUsd);
    const temperatureMultiplier = score >= 75 ? 1.5 : score >= 50 ? 1.25 : 1.0;

    return Math.min(Math.ceil(minSplitsForSafety * temperatureMultiplier), 10);
  }
}

// ============================================================================
// CACHING
// ============================================================================

interface CacheEntry {
  profile: PoolMEVProfile;
  expiresAt: number;
}

const mevProfileCache = new Map<string, CacheEntry>();

function getCachedProfile(poolAddress: string): PoolMEVProfile | null {
  const key = poolAddress.toLowerCase();
  const entry = mevProfileCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    mevProfileCache.delete(key);
    return null;
  }
  return entry.profile;
}

function cacheProfile(poolAddress: string, profile: PoolMEVProfile): void {
  mevProfileCache.set(poolAddress.toLowerCase(), {
    profile,
    expiresAt: Date.now() + CONFIG.CACHE_TTL_MS,
  });
}

// ============================================================================
// MAIN API: fetchPoolMEVProfile
// ============================================================================

/**
 * Fetch complete MEV profile for a pool — the core analysis engine.
 * 
 * Performs paginated swap fetching, reserve reconstruction, slippage analysis,
 * sandwich detection, and MEV temperature scoring. Produces detailed logs
 * matching the mevSearcher.js output style.
 */
export async function fetchPoolMEVProfile(
  poolAddress: string,
  graphApiKey: string,
  options: {
    sampleSize?: number;
    bypassCache?: boolean;
  } = {},
): Promise<PoolMEVProfile> {
  // Cache check
  if (!options.bypassCache) {
    const cached = getCachedProfile(poolAddress);
    if (cached) {
      console.log(`   🔥 MEV Temperature (cached): ${cached.metrics.score}/100 (${cached.metrics.riskLevel})`);
      return cached;
    }
  }

  const targetSwaps = options.sampleSize || CONFIG.DEFAULT_TARGET_SWAPS;

  console.log(`\n🔍 MEV Temperature Analysis`);
  console.log(`   Pool: ${poolAddress}`);
  console.log(`   Target: ${targetSwaps.toLocaleString()} swaps\n`);

  // --- Fetch all data ---
  const rawSwaps = await fetchAllSwaps(poolAddress, targetSwaps, graphApiKey);
  const currentReserves = await fetchCurrentReserves(poolAddress, graphApiKey);

  console.log(
    `   Current reserves: ${currentReserves.reserve0.toFixed(2)} / ${currentReserves.reserve1.toFixed(2)}\n`
  );

  if (rawSwaps.length < CONFIG.MIN_SWAPS_FOR_ANALYSIS) {
    console.log(`   ⚠️ Only ${rawSwaps.length} swaps available (min: ${CONFIG.MIN_SWAPS_FOR_ANALYSIS})`);
    // Return a conservative default profile
    const defaultMetrics: MEVTemperatureMetrics = {
      score: 25,
      riskLevel: 'MEDIUM',
      mevCostMultiplier: 1.5,
      safeThresholdUsd: 500,
      victimRate: 0,
      avgSlippage: 0,
      maxSlippage: 0,
      sandwichCount: 0,
      totalLossUsd: 0,
      significantVictimCount: 0,
      avgVictimSizeUsd: 0,
      minAttackedSizeUsd: 0,
      maxAttackedSizeUsd: 0,
      totalVolumeAnalyzedUsd: 0,
      arbPatternCount: 0,
      topAttackers: [],
      sampleSize: rawSwaps.length,
      poolLiquidity: currentReserves.reserve0 + currentReserves.reserve1,
      timestamp: Date.now(),
    };
    const profile = new PoolMEVProfileImpl(poolAddress, '?', '?', defaultMetrics);
    cacheProfile(poolAddress, profile);
    return profile;
  }

  // --- Process ---
  const swaps = normalizeSwaps(rawSwaps);
  console.log(`   Normalized to ${swaps.length} valid trades`);

  console.log(`   Reconstructing reserves...`);
  reconstructReserves(swaps, currentReserves);

  console.log(`   Analyzing MEV patterns...`);
  const results = analyzeSwaps(swaps);

  // --- Report (mevSearcher.js style) ---
  printStatistics(results);
  printTopVictims(results);
  printDetailedSandwiches(results);
  printArbitragePatterns(swaps);

  // --- Calculate temperature ---
  const poolLiquidity = currentReserves.reserve0 + currentReserves.reserve1;
  const metrics = calculateMEVTemperature(results, swaps, poolLiquidity);

  const token0Symbol = swaps.length > 0 ? swaps[0].token0Symbol : '?';
  const token1Symbol = swaps.length > 0 ? swaps[0].token1Symbol : '?';

  const profile = new PoolMEVProfileImpl(poolAddress, token0Symbol, token1Symbol, metrics);
  cacheProfile(poolAddress, profile);

  // Temperature summary
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🔥 MEV Temperature: ${metrics.score}/100 (${metrics.riskLevel})`);
  console.log(`   Safe threshold:    $${metrics.safeThresholdUsd.toFixed(2)}`);
  console.log(`   Victim rate:       ${metrics.victimRate.toFixed(1)}%`);
  console.log(`   Avg slippage:      ${metrics.avgSlippage.toFixed(2)}%`);
  console.log(`   Cost multiplier:   ${metrics.mevCostMultiplier.toFixed(2)}x`);
  console.log(`   Total losses:      $${metrics.totalLossUsd.toFixed(2)}`);
  console.log(`   Sample size:       ${metrics.sampleSize.toLocaleString()} swaps`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  return profile;
}

// ============================================================================
// MAIN API: analyzePool — Produces MEVSimulationResult for the optimizer
// ============================================================================

const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

/**
 * Full MEV analysis that replaces the old simulator.ts.
 * Fetches pool data on-chain + MEV temperature from The Graph,
 * then produces everything the optimizer / decision engine / executor need.
 */
export async function analyzePool(
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  graphApiKey: string,
  options?: { sampleSize?: number; bypassCache?: boolean },
): Promise<MEVSimulationResult> {
  const { publicClient } = await import('../core/config');
  const { parseAbi, getAddress } = await import('viem');

  const UNISWAP_V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f' as const;

  const factoryAbi = parseAbi([
    'function getPair(address tokenA, address tokenB) external view returns (address pair)',
  ]);
  const pairAbi = parseAbi([
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() external view returns (address)',
  ]);
  const erc20Abi = parseAbi([
    'function decimals() external view returns (uint8)',
  ]);

  // --- ETH price ---
  let ethPriceUsd = 2500;
  try {
    const res = await fetch(`https://li.quest/v1/token?chain=1&token=${WETH_ADDRESS}`);
    if (res.ok) {
      const data = await res.json();
      const price = Number(data.priceUSD);
      if (price > 0) ethPriceUsd = price;
    }
  } catch {}

  // --- Find pair ---
  const pairAddress = await publicClient.readContract({
    address: UNISWAP_V2_FACTORY,
    abi: factoryAbi,
    functionName: 'getPair',
    args: [tokenIn as `0x${string}`, tokenOut as `0x${string}`],
  });

  if (pairAddress === '0x0000000000000000000000000000000000000000') {
    throw new Error('No Uniswap V2 pair found');
  }

  // --- Reserves + token ordering ---
  const [reserves, token0] = await Promise.all([
    publicClient.readContract({ address: pairAddress, abi: pairAbi, functionName: 'getReserves' }),
    publicClient.readContract({ address: pairAddress, abi: pairAbi, functionName: 'token0' }),
  ]);

  const [inDecimals, outDecimals] = await Promise.all([
    publicClient.readContract({ address: tokenIn as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
    publicClient.readContract({ address: tokenOut as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
  ]);

  const isToken0In = getAddress(tokenIn) === getAddress(token0);
  const r0 = BigInt(reserves[0]);
  const r1 = BigInt(reserves[1]);
  const [rIn, rOut] = isToken0In ? [r0, r1] : [r1, r0];

  // --- Token out price ---
  let tokenOutPriceUsd = 0;
  try {
    const res = await fetch(`https://li.quest/v1/token?chain=1&token=${tokenOut}`);
    if (res.ok) {
      const data = await res.json();
      tokenOutPriceUsd = Number(data.priceUSD) || 0;
    }
  } catch {}

  // If tokenOut price unavailable, estimate from reserves
  if (tokenOutPriceUsd === 0 && ethPriceUsd > 0) {
    // If tokenIn is WETH-like, use reserve ratio
    const reserveInFloat = Number(rIn) / 10 ** Number(inDecimals);
    const reserveOutFloat = Number(rOut) / 10 ** Number(outDecimals);
    if (reserveInFloat > 0 && reserveOutFloat > 0) {
      const tokenInPriceUsd = ethPriceUsd; // assume tokenIn is ETH-priced
      tokenOutPriceUsd = (reserveInFloat * tokenInPriceUsd) / reserveOutFloat;
    }
  }

  // --- Pool depth ---
  const reserveInUsd = (Number(rIn) / 10 ** Number(inDecimals)) * ethPriceUsd;
  const reserveOutUsd = (Number(rOut) / 10 ** Number(outDecimals)) * tokenOutPriceUsd;
  const poolDepthUsd = reserveInUsd + reserveOutUsd;

  // --- Trade metrics ---
  const amountInBigInt = BigInt(amountIn);
  const tradeValueUsd = (Number(amountInBigInt) / 10 ** Number(inDecimals)) * ethPriceUsd;
  const tradeToPoolRatio = poolDepthUsd > 0 ? tradeValueUsd / poolDepthUsd : Infinity;
  const isShallowPool = tradeToPoolRatio > 0.10;

  // --- Clean output (constant-product AMM) ---
  const amountInWithFee = amountInBigInt * 997n;
  const cleanOutputRaw = rIn > 0n ? (amountInWithFee * rOut) / (rIn * 1000n + amountInWithFee) : 0n;

  // --- Gas data ---
  const gasPrice = await publicClient.getGasPrice();
  const sandwichGasCostWei = 300_000n * gasPrice;
  const sandwichGasCostUsd = (Number(sandwichGasCostWei) / 1e18) * ethPriceUsd;

  // --- MEV Temperature (the core analysis) ---
  const mevProfile = await fetchPoolMEVProfile(pairAddress, graphApiKey, options);

  // --- Estimate loss from MEV temperature ---
  // Uses quadratic model: MEV ≈ tradeSize² / (2 × poolDepth) × efficiency × multiplier
  const extractionEfficiency = 0.85;
  const baseMev = poolDepthUsd > 0
    ? (tradeValueUsd ** 2) / (2 * poolDepthUsd) * extractionEfficiency
    : 0;
  const estimatedLossUsd = mevProfile.getAdjustedMEV(baseMev);

  // --- Attacked output estimate ---
  const cleanOutFloat = Number(cleanOutputRaw);
  const outPriceForCalc = tokenOutPriceUsd > 0 ? tokenOutPriceUsd : ethPriceUsd;
  const cleanOutUsd = (cleanOutFloat / 10 ** Number(outDecimals)) * outPriceForCalc;
  const lossRatio = cleanOutUsd > 0 ? estimatedLossUsd / cleanOutUsd : 0;
  const attackedOutputRaw = BigInt(Math.floor(cleanOutFloat * Math.max(0, 1 - lossRatio)));
  const lossPercent = lossRatio * 100;

  // --- Attacker profit estimate ---
  const attackerProfitUsd = Math.max(0, estimatedLossUsd - sandwichGasCostUsd);
  const attackViable = attackerProfitUsd > 0;

  // --- Safe chunk threshold ---
  const safeChunkThresholdUsd = Math.max(
    mevProfile.metrics.safeThresholdUsd,
    Math.sqrt(2 * poolDepthUsd * sandwichGasCostUsd),
  );

  // --- Risk from temperature ---
  const score = mevProfile.metrics.score;
  let risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  if (score >= 75) risk = 'CRITICAL';
  else if (score >= 50) risk = 'HIGH';
  else if (score >= 25) risk = 'MEDIUM';
  else risk = 'LOW';

  // --- Summary logging ---
  console.log(`\n╔════════════════════════════════════════════════════════╗`);
  console.log(`║           MEV POOL ANALYSIS SUMMARY                    ║`);
  console.log(`╚════════════════════════════════════════════════════════╝\n`);
  console.log(`🏊 Pool: ${pairAddress}`);
  console.log(`🏊 Reserves: ${rIn.toString()} / ${rOut.toString()}`);
  console.log(`🏊 Pool depth: $${poolDepthUsd.toFixed(0)} | Trade/pool: ${(tradeToPoolRatio * 100).toFixed(2)}%${isShallowPool ? ' ⚠️ SHALLOW' : ''}`);
  console.log(`🔥 MEV Temperature: ${mevProfile.metrics.score}/100 (${mevProfile.metrics.riskLevel})`);
  console.log(`📉 Estimated MEV loss: $${estimatedLossUsd.toFixed(2)} (${lossPercent.toFixed(3)}%)`);
  console.log(`💀 Attacker profit: $${attackerProfitUsd.toFixed(2)} (${attackViable ? 'viable' : 'not viable'})`);
  console.log(`🛡️ Safe chunk threshold: $${safeChunkThresholdUsd.toFixed(2)}`);
  console.log(`⚠️ Risk: ${risk}\n`);

  return {
    estimatedLossUsd,
    ethPriceUsd,
    reserveIn: rIn,
    reserveOut: rOut,
    inDecimals: Number(inDecimals),
    outDecimals: Number(outDecimals),
    poolDepthUsd,
    poolAddress: pairAddress,
    tokenIn,
    tokenOut,
    mevProfile,
    risk,
    tradeToPoolRatio,
    isShallowPool,
    safeChunkThresholdUsd,
    cleanOutputRaw,
    attackedOutputRaw,
    lossPercent,
    attackViable,
    attackerProfitUsd,
    gasData: {
      gasPriceWei: gasPrice,
      sandwichGasCostWei,
      sandwichGasCostUsd,
    },
  };
}

// ============================================================================
// CACHE UTILITIES
// ============================================================================

export function clearMEVProfileCache(): void {
  mevProfileCache.clear();
}

export function getMEVCacheStats(): {
  size: number;
  entries: Array<{ pool: string; score: number; expiresIn: number }>;
} {
  const entries = Array.from(mevProfileCache.entries()).map(([pool, entry]) => ({
    pool,
    score: entry.profile.metrics.score,
    expiresIn: Math.max(0, entry.expiresAt - Date.now()),
  }));
  return { size: mevProfileCache.size, entries };
}