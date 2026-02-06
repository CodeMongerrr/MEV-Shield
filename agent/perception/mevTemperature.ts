/**
 * MEV Temperature Calculator - Refactored for CalcOptimizer Integration
 * 
 * Provides real-time MEV risk metrics to enhance chunk optimization:
 * - Pool-specific MEV profitability thresholds
 * - Historical sandwich attack frequency
 * - Average slippage rates for victim detection
 * - Dynamic risk multipliers for cost functions
 */

// ============================================================================
// CORE TYPES
// ============================================================================

export interface MEVTemperatureMetrics {
  // Risk scoring (0-100)
  score: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  
  // Cost multipliers for optimizer
  mevCostMultiplier: number; // 1.0 - 3.0x based on historical MEV intensity
  safeThresholdUsd: number; // Empirical threshold where attacks become unprofitable
  
  // Statistical evidence
  victimRate: number; // % of swaps that suffered MEV
  avgSlippage: number; // Average slippage for victims
  maxSlippage: number; // Worst observed slippage
  sandwichCount: number; // Number of detected sandwiches
  totalLossUsd: number; // Total USD lost to MEV in sample
  
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

// Internal types (not exported to avoid conflicts)
interface TemperatureSwapData {
  txHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp: number;
  from: string;
  to: string;
  
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

interface TemperatureMEVAnalysis {
  slippage: number;
  priceImpact: number;
  expectedOut: number;
  actualOut: number;
  loss: number;
  lossUSD: number;
  isSandwich: boolean;
  victimLossUSD: number;
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
  MIN_SLIPPAGE_PCT: 0.3,
  MIN_TRADE_SIZE_USD: 50,
  MAX_REASONABLE_SLIPPAGE: 20,
  CONTEXT_WINDOW: 5,
  MAX_BLOCKS_BETWEEN_SANDWICH: 1,
  MIN_SANDWICH_PROFIT_USD: 10,
  
  // Optimizer integration
  DEFAULT_SAMPLE_SIZE: 2000,
  CACHE_TTL_MS: 5 * 60 * 1000, // 5 minutes
} as const;

// ============================================================================
// GRAPH API
// ============================================================================

async function fetchSwapsFromGraph(
  poolAddress: string,
  limit: number,
  graphApiKey: string
): Promise<GraphSwap[]> {
  const query = `
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
  `;

  const response = await fetch(
    `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/EYCKATKGBKLWvSfwvBjzfCBmGwYNdVkduYXVivCsLRFu`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: {
          pool: poolAddress.toLowerCase(),
          first: limit,
        },
      }),
    }
  );

  const data = await response.json();
  
  if (data.errors) {
    throw new Error(`Graph API error: ${data.errors[0].message}`);
  }

  return data.data.swaps;
}

async function fetchCurrentReserves(
  poolAddress: string,
  graphApiKey: string
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
// DATA PROCESSING
// ============================================================================

function isValidTrade(swap: TemperatureSwapData): boolean {
  if (swap.amountOut <= 0 || swap.amountIn <= 0) return false;
  if (swap.amountOut / swap.amountIn < 0.000001) return false;
  return true;
}

function normalizeSwaps(rawSwaps: GraphSwap[]): TemperatureSwapData[] {
  return rawSwaps
    .map((s) => {
      const a0In = Number(s.amount0In);
      const a0Out = Number(s.amount0Out);
      const a1In = Number(s.amount1In);
      const a1Out = Number(s.amount1Out);

      if (a0In === 0 && a1In === 0) return null;
      if (a0Out === 0 && a1Out === 0) return null;

      const buyToken0 = a1In > 0 && a0Out > 0;
      const d0 = Number(s.pair.token0.decimals);
      const d1 = Number(s.pair.token1.decimals);

      const amountIn = buyToken0 ? a1In / 10 ** d1 : a0In / 10 ** d0;
      const amountOut = buyToken0 ? a0Out / 10 ** d0 : a1Out / 10 ** d1;

      return {
        txHash: s.transaction.id,
        blockNumber: Number(s.transaction.blockNumber),
        logIndex: Number(s.logIndex),
        timestamp: Number(s.timestamp),
        from: s.from,
        to: s.to,

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
  currentReserves: { reserve0: number; reserve1: number }
): void {
  let r0 = currentReserves.reserve0;
  let r1 = currentReserves.reserve1;

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
// MEV ANALYSIS
// ============================================================================

function expectedOut(
  amountIn: number,
  reserveIn: number,
  reserveOut: number,
  fee: number = CONFIG.FEE
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

function detectSandwich(
  victim: TemperatureSwapData & TemperatureMEVAnalysis,
  before: (TemperatureSwapData & TemperatureMEVAnalysis)[],
  after: (TemperatureSwapData & TemperatureMEVAnalysis)[]
): boolean {
  const victimBlock = victim.blockNumber;

  const beforeWindow = before.filter(
    (s) =>
      s.blockNumber >= victimBlock - CONFIG.MAX_BLOCKS_BETWEEN_SANDWICH &&
      s.blockNumber <= victimBlock
  );

  const afterWindow = after.filter(
    (s) =>
      s.blockNumber >= victimBlock &&
      s.blockNumber <= victimBlock + CONFIG.MAX_BLOCKS_BETWEEN_SANDWICH
  );

  for (const front of beforeWindow) {
    if (front.from === victim.from) continue;
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

      const profitUSD = Math.abs(back.amountUSD - front.amountUSD);
      if (profitUSD < CONFIG.MIN_SANDWICH_PROFIT_USD) continue;
      if (profitUSD > victim.amountUSD * 10) continue;

      return true;
    }
  }

  return false;
}

function analyzeSwaps(swaps: TemperatureSwapData[]): (TemperatureSwapData & TemperatureMEVAnalysis)[] {
  return swaps.map((s, i) => {
    const before = swaps
      .slice(Math.max(0, i - CONFIG.CONTEXT_WINDOW), i)
      .map((swap) => ({ ...swap } as TemperatureSwapData & TemperatureMEVAnalysis));
    
    const after = swaps
      .slice(i + 1, i + CONFIG.CONTEXT_WINDOW + 1)
      .map((swap) => ({ ...swap } as TemperatureSwapData & TemperatureMEVAnalysis));

    const rIn = s.buyToken0 ? s.reserve1Before : s.reserve0Before;
    const rOut = s.buyToken0 ? s.reserve0Before : s.reserve1Before;

    const exp = expectedOut(s.amountIn, rIn, rOut);
    const slip = slippagePct(exp, s.amountOut);
    const loss = Math.max(0, exp - s.amountOut);
    const lossUSD = s.amountUSD > 0 && slip > 0 ? s.amountUSD * (slip / 100) : 0;

    const analyzed: TemperatureSwapData & TemperatureMEVAnalysis = {
      ...s,
      expectedOut: exp,
      slippage: slip,
      priceImpact: slip,
      actualOut: s.amountOut,
      loss,
      lossUSD: isNaN(lossUSD) || !isFinite(lossUSD) ? 0 : lossUSD,
      isSandwich: false,
      victimLossUSD: 0,
    };

    analyzed.isSandwich = detectSandwich(analyzed, before, after);
    analyzed.victimLossUSD = analyzed.isSandwich ? analyzed.lossUSD : 0;

    return analyzed;
  });
}

// ============================================================================
// MEV TEMPERATURE CALCULATION
// ============================================================================

function calculateMEVTemperature(
  results: (TemperatureSwapData & TemperatureMEVAnalysis)[],
  poolLiquidity: number
): MEVTemperatureMetrics {
  const victims = results.filter(
    (r) =>
      r.slippage >= CONFIG.MIN_SLIPPAGE_PCT &&
      r.amountUSD >= CONFIG.MIN_TRADE_SIZE_USD &&
      r.slippage <= CONFIG.MAX_REASONABLE_SLIPPAGE
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

  // Calculate MEV Temperature Score (0-100)
  const victimRateScore = Math.min(40, victimRate * 10);
  const slippageScore = Math.min(30, avgSlippage * 3);
  const sandwichScore = Math.min(30, (sandwichCount / results.length) * 3000);

  const score = Math.min(100, victimRateScore + slippageScore + sandwichScore);

  // Determine risk level
  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  if (score >= 75) riskLevel = 'EXTREME';
  else if (score >= 50) riskLevel = 'HIGH';
  else if (score >= 25) riskLevel = 'MEDIUM';
  else riskLevel = 'LOW';

  // Calculate empirical safe threshold from victim distribution
  // Find the 10th percentile of victim trade sizes - trades below this rarely get attacked
  const victimSizes = victims.map(v => v.amountUSD).sort((a, b) => a - b);
  const p10Index = Math.floor(victimSizes.length * 0.1);
  const empiricalThreshold = victimSizes.length > 10 
    ? victimSizes[p10Index] 
    : 500; // Default $500 if insufficient data

  // MEV cost multiplier: how much to scale base MEV estimates
  // Higher temperature = more aggressive bots = higher extraction efficiency
  const mevCostMultiplier = 1.0 + (score / 100) * 2.0; // 1.0x to 3.0x

  return {
    score: Math.round(score * 100) / 100,
    riskLevel,
    mevCostMultiplier,
    safeThresholdUsd: Math.max(empiricalThreshold, 100),
    victimRate: Math.round(victimRate * 100) / 100,
    avgSlippage: Math.round(avgSlippage * 100) / 100,
    maxSlippage: Math.round(maxSlippage * 100) / 100,
    totalLossUsd: Math.round(totalLossUsd * 100) / 100,
    sandwichCount,
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
    public metrics: MEVTemperatureMetrics
  ) {}

  /**
   * Adjust base MEV estimate using pool-specific risk multiplier
   * CalcOptimizer can use this to scale MEV predictions
   */
  getAdjustedMEV(baseMEV: number): number {
    return baseMEV * this.metrics.mevCostMultiplier;
  }

  /**
   * Check if chunk size is below empirical attack threshold
   * CalcOptimizer uses this to determine if chunks are "safe"
   */
  isChunkSafe(chunkSizeUsd: number): boolean {
    return chunkSizeUsd < this.metrics.safeThresholdUsd;
  }

  /**
   * Get recommended splits based on temperature and trade size
   * Provides heuristic starting point for CalcOptimizer
   */
  getRecommendedSplits(tradeSizeUsd: number): number {
    const { score, safeThresholdUsd } = this.metrics;
    
    // Don't split small trades
    if (tradeSizeUsd < 1000) return 1;
    
    // If already below threshold, no split needed
    if (tradeSizeUsd < safeThresholdUsd) return 1;
    
    // Calculate splits to get chunks below threshold
    const minSplitsForSafety = Math.ceil(tradeSizeUsd / safeThresholdUsd);
    
    // Add extra splits based on temperature for very high-risk pools
    const temperatureMultiplier = score >= 75 ? 1.5 : score >= 50 ? 1.25 : 1.0;
    
    return Math.min(
      Math.ceil(minSplitsForSafety * temperatureMultiplier),
      10 // Cap at 10 splits
    );
  }
}

// ============================================================================
// CACHING LAYER
// ============================================================================

interface CacheEntry {
  profile: PoolMEVProfile;
  expiresAt: number;
}

const mevProfileCache = new Map<string, CacheEntry>();

function getCacheKey(poolAddress: string): string {
  return poolAddress.toLowerCase();
}

function getCachedProfile(poolAddress: string): PoolMEVProfile | null {
  const key = getCacheKey(poolAddress);
  const entry = mevProfileCache.get(key);
  
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    mevProfileCache.delete(key);
    return null;
  }
  
  return entry.profile;
}

function cacheProfile(poolAddress: string, profile: PoolMEVProfile): void {
  const key = getCacheKey(poolAddress);
  mevProfileCache.set(key, {
    profile,
    expiresAt: Date.now() + CONFIG.CACHE_TTL_MS,
  });
}

// ============================================================================
// MAIN API
// ============================================================================

/**
 * Fetch MEV profile for a pool with caching
 * 
 * This is the main entry point for CalcOptimizer integration.
 * Returns cached data if available and fresh, otherwise fetches new data.
 * 
 * @example
 * ```typescript
 * const profile = await fetchPoolMEVProfile(
 *   '0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc', // WETH/USDC
 *   process.env.GRAPH_API_KEY!
 * );
 * 
 * // Use in CalcOptimizer
 * const adjustedMEV = profile.getAdjustedMEV(baseMEVEstimate);
 * const isSafe = profile.isChunkSafe(chunkSizeUsd);
 * ```
 */
export async function fetchPoolMEVProfile(
  poolAddress: string,
  graphApiKey: string,
  options: {
    sampleSize?: number;
    bypassCache?: boolean;
  } = {}
): Promise<PoolMEVProfile> {
  // Check cache first
  if (!options.bypassCache) {
    const cached = getCachedProfile(poolAddress);
    if (cached) {
      console.log(`   🔥 MEV Temperature (cached): ${cached.metrics.score}/100 (${cached.metrics.riskLevel})`);
      return cached;
    }
  }

  const sampleSize = options.sampleSize || CONFIG.DEFAULT_SAMPLE_SIZE;

  console.log(`   📊 Analyzing pool MEV temperature...`);

  // Fetch data
  const rawSwaps = await fetchSwapsFromGraph(poolAddress, sampleSize, graphApiKey);
  const currentReserves = await fetchCurrentReserves(poolAddress, graphApiKey);

  if (rawSwaps.length === 0) {
    throw new Error(`No swap data available for pool ${poolAddress}`);
  }

  // Process swaps
  const swaps = normalizeSwaps(rawSwaps);
  reconstructReserves(swaps, currentReserves);

  // Analyze MEV
  const results = analyzeSwaps(swaps);

  // Calculate pool liquidity
  const poolLiquidity = currentReserves.reserve0 + currentReserves.reserve1;

  // Calculate temperature
  const metrics = calculateMEVTemperature(results, poolLiquidity);

  // Create profile
  const profile = new PoolMEVProfileImpl(
    poolAddress,
    swaps[0].token0Symbol,
    swaps[0].token1Symbol,
    metrics
  );

  // Cache it
  cacheProfile(poolAddress, profile);

  console.log(`   🔥 MEV Temperature: ${metrics.score}/100 (${metrics.riskLevel})`);
  console.log(`      Safe threshold: $${metrics.safeThresholdUsd.toFixed(2)}`);
  console.log(`      Victim rate: ${metrics.victimRate.toFixed(1)}%`);
  console.log(`      Cost multiplier: ${metrics.mevCostMultiplier.toFixed(2)}x`);

  return profile;
}

/**
 * Clear the MEV profile cache
 * Useful for testing or forcing fresh data
 */
export function clearMEVProfileCache(): void {
  mevProfileCache.clear();
}

/**
 * Get cache statistics
 */
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