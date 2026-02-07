const LIFI_API_BASE = "https://li.quest/v1"

export interface LiFiQuote {
  id: string
  type: string
  tool: string
  action: {
    fromChainId: number
    toChainId: number
    fromToken: TokenInfo
    toToken: TokenInfo
    fromAmount: string
    toAmount: string
    slippage: number
  }
  estimate: {
    fromAmount: string
    toAmount: string
    toAmountMin: string
    approvalAddress: string
    executionDuration: number
    feeCosts: FeeCost[]
    gasCosts: GasCost[]
  }
  transactionRequest: {
    to: string
    data: string
    value: string
    gasLimit: string
    gasPrice?: string
    chainId: number
  }
}

interface TokenInfo {
  address: string
  symbol: string
  decimals: number
  chainId: number
  name: string
}

interface FeeCost {
  name: string
  description: string
  percentage: string
  token: TokenInfo
  amount: string
  amountUSD: string
}

interface GasCost {
  type: string
  estimate: string
  limit: string
  amount: string
  amountUSD: string
  token: TokenInfo
}

export interface LiFiQuoteRequest {
  fromChain: number
  toChain: number
  fromToken: string
  toToken: string
  fromAmount: string
  fromAddress: string
  slippage?: number // 0.01 = 1%
}

// Chain IDs
export const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
  optimism: 10,
  polygon: 137,
}

// Common token addresses per chain
export const TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
  "WETH": {
    "ethereum": "0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2",
    "arbitrum": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    "base": "0x4200000000000000000000000000000000000006"
  },

  "USDC": {
    "ethereum": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "arbitrum": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  },

  "DAI": {
    "ethereum": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    "arbitrum": "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    "base": "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"
  },

  "WBTC": {
    "ethereum": "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    "arbitrum": "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    "base": "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c"
  },

  "UNI": {
    "ethereum": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    "arbitrum": "0xFa7F8980b0f1E64A2062791cc3b0871572F1f7f0",
    "base": "0x6d0f5149c502faf215c89ab306ec3e50b15e2892"
  },

  "LINK": {
    "ethereum": "0x514910771AF9Ca656af840dFF83E8264EcF986CA",
    "arbitrum": "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
    "base": "0x88Fb150B77dA4fC8f8F47F0a52b7aC0b2F9b18F9"
  },

  "AAVE": {
    "ethereum": "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DdAe9",
    "arbitrum": "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196",
    "base": "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB"
  },

  "CRV": {
    "ethereum": "0xD533a949740bb3306d119CC777fa900bA034cd52",
    "arbitrum": "0x11cDb42B0EB46D95f990Bedd4695A6e3fA034978",
    "base": "0x8Ee73cA8a3c5B3eF4C1e3C4F2d5C31cC3c9e6a7F"
  },

  "LDO": {
    "ethereum": "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32",
    "arbitrum": "0x13A6F538B8f3B6FfF7B6a0bAb8C7F42dC1A2b123",
    "base": "0xFdb794692724153d1488CcdBE0C56c252596735F"
  }
}

// Map token addresses across chains (same token, different address)
export function getTokenOnChain(tokenAddress: string, fromChain: string, toChain: string): string | null {
  // Find which token this is
  const fromTokens = TOKEN_ADDRESSES[fromChain]
  if (!fromTokens) return null

  let tokenSymbol: string | null = null
  for (const [symbol, addr] of Object.entries(fromTokens)) {
    if (addr.toLowerCase() === tokenAddress.toLowerCase()) {
      tokenSymbol = symbol
      break
    }
  }

  if (!tokenSymbol) return null

  // Get the address on the target chain
  const toTokens = TOKEN_ADDRESSES[toChain]
  if (!toTokens) return null

  // Handle USDC.e on Arbitrum
  if (tokenSymbol === "USDC" && toChain === "arbitrum") {
    return toTokens["USDC"] || toTokens["USDC.e"] || null
  }

  return toTokens[tokenSymbol] || null
}

export async function getLiFiQuote(request: LiFiQuoteRequest): Promise<LiFiQuote | null> {
  const params = new URLSearchParams({
    fromChain: request.fromChain.toString(),
    toChain: request.toChain.toString(),
    fromToken: request.fromToken,
    toToken: request.toToken,
    fromAmount: request.fromAmount,
    fromAddress: request.fromAddress,
    slippage: (request.slippage || 0.005).toString(), // Default 0.5%
  })

  const url = `${LIFI_API_BASE}/quote?${params.toString()}`

  try {
    console.log(`   🌉 Fetching LI.FI quote: ${request.fromChain} → ${request.toChain}`)

    const response = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
    })

    if (!response.ok) {
      const error = await response.text()
      console.log(`   ⚠️ LI.FI error (${response.status}): ${error.substring(0, 200)}`)
      return null
    }

    const quote: LiFiQuote = await response.json()

    // Log quote details
    const feesUsd = quote.estimate.feeCosts.reduce((sum, f) => sum + parseFloat(f.amountUSD || "0"), 0)
    const gasUsd = quote.estimate.gasCosts.reduce((sum, g) => sum + parseFloat(g.amountUSD || "0"), 0)
    const toAmountNum = parseFloat(quote.estimate.toAmount) / 10 ** quote.action.toToken.decimals

    console.log(`   🌉 Quote received: ${toAmountNum.toFixed(4)} ${quote.action.toToken.symbol}`)
    console.log(`   🌉 Fees: $${feesUsd.toFixed(2)} | Gas: $${gasUsd.toFixed(2)} | Duration: ${quote.estimate.executionDuration}s`)

    return quote
  } catch (err) {
    console.log(`   ⚠️ LI.FI fetch failed: ${(err as Error).message}`)
    return null
  }
}

export interface CrossChainTx {
  to: `0x${string}`
  data: `0x${string}`
  value: bigint
  chainId: number
  gasLimit: bigint
  estimatedOutput: bigint
  minOutput: bigint
  feesUsd: number
  gasUsd: number
  executionDuration: number
  tool: string // which bridge/dex LI.FI is using
}

export async function buildCrossChainTx(
  fromChain: string,
  toChain: string,
  fromToken: string,
  toToken: string,
  amountIn: bigint,
  userAddress: string
): Promise<CrossChainTx | null> {
  const fromChainId = CHAIN_IDS[fromChain]
  const toChainId = CHAIN_IDS[toChain]

  if (!fromChainId || !toChainId) {
    console.log(`   ⚠️ Unknown chain: ${fromChain} or ${toChain}`)
    return null
  }

  // Map token to destination chain
  const toTokenMapped = getTokenOnChain(toToken, fromChain, toChain)
  if (!toTokenMapped) {
    console.log(`   ⚠️ Cannot map token ${toToken} from ${fromChain} to ${toChain}`)
    return null
  }

  const quote = await getLiFiQuote({
    fromChain: fromChainId,
    toChain: toChainId,
    fromToken,
    toToken: toTokenMapped,
    fromAmount: amountIn.toString(),
    fromAddress: userAddress,
  })

  if (!quote || !quote.transactionRequest) {
    return null
  }

  const feesUsd = quote.estimate.feeCosts.reduce((sum, f) => sum + parseFloat(f.amountUSD || "0"), 0)
  const gasUsd = quote.estimate.gasCosts.reduce((sum, g) => sum + parseFloat(g.amountUSD || "0"), 0)

  return {
    to: quote.transactionRequest.to as `0x${string}`,
    data: quote.transactionRequest.data as `0x${string}`,
    value: BigInt(quote.transactionRequest.value || "0"),
    chainId: quote.transactionRequest.chainId,
    gasLimit: BigInt(quote.transactionRequest.gasLimit || "500000"),
    estimatedOutput: BigInt(quote.estimate.toAmount),
    minOutput: BigInt(quote.estimate.toAmountMin),
    feesUsd,
    gasUsd,
    executionDuration: quote.estimate.executionDuration,
    tool: quote.tool,
  }
}

// Get just the cost estimate without building full tx
export async function estimateCrossChainCost(
  fromChain: string,
  toChain: string,
  fromToken: string,
  toToken: string,
  amountIn: bigint,
  userAddress: string
): Promise<{ feesUsd: number; gasUsd: number; totalCostUsd: number; outputAmount: bigint } | null> {
  const fromChainId = CHAIN_IDS[fromChain]
  const toChainId = CHAIN_IDS[toChain]

  if (!fromChainId || !toChainId) return null

  const toTokenMapped = getTokenOnChain(toToken, fromChain, toChain)
  if (!toTokenMapped) return null

  const quote = await getLiFiQuote({
    fromChain: fromChainId,
    toChain: toChainId,
    fromToken,
    toToken: toTokenMapped,
    fromAmount: amountIn.toString(),
    fromAddress: userAddress,
  })

  if (!quote) return null

  const feesUsd = quote.estimate.feeCosts.reduce((sum, f) => sum + parseFloat(f.amountUSD || "0"), 0)
  const gasUsd = quote.estimate.gasCosts.reduce((sum, g) => sum + parseFloat(g.amountUSD || "0"), 0)

  return {
    feesUsd,
    gasUsd,
    totalCostUsd: feesUsd + gasUsd,
    outputAmount: BigInt(quote.estimate.toAmount),
  }
}