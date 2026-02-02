import { SwapIntent } from "../core/types"
import { SandwichSimulation } from "../perception/simulator"
import { publicClient } from "../core/config"
import { parseAbi, encodeFunctionData, serializeTransaction, keccak256 } from "viem"

// Known private relay endpoints
// In production, user or config would select which to use
const PRIVATE_RELAYS = {
  flashbots: {
    name: "Flashbots Protect",
    rpcUrl: "https://rpc.flashbots.net",
    // Flashbots Protect drops tx if not mined in 25 blocks
    maxBlockWait: 25,
    // No extra fee, but priority fee goes to builder
    extraCost: 0,
  },
  mevBlocker: {
    name: "MEV Blocker",
    rpcUrl: "https://rpc.mevblocker.io",
    maxBlockWait: 25,
    extraCost: 0,
  },
  securerpc: {
    name: "SecureRPC",
    rpcUrl: "https://api.securerpc.com/v1",
    maxBlockWait: 50,
    extraCost: 0,
  },
} as const

type RelayName = keyof typeof PRIVATE_RELAYS

const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as const

const routerAbi = parseAbi([
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
])

const erc20Abi = parseAbi([
  "function decimals() external view returns (uint8)",
  "function allowance(address owner, address spender) external view returns (uint256)",
])

export interface PrivateTxPlan {
  relay: {
    name: string
    rpcUrl: string
    maxBlockWait: number
  }
  tx: {
    to: `0x${string}`
    data: `0x${string}`
    value: bigint
    gasLimit: bigint
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
  }
  economics: {
    mevSavedUsd: number
    gasCostUsd: number
    priorityFeeUsd: number
    netSavingsUsd: number
    worthIt: boolean
    reasoning: string
  }
  // The tx that would need to be signed by user wallet
  unsignedTxHash: string
}

// Select best relay based on current conditions
function selectRelay(sim: SandwichSimulation): RelayName {
  // Flashbots is default — most reliable, largest builder network
  // MEV Blocker is backup — different builder set, good for redundancy
  // SecureRPC if others have issues

  // For high-value trades, we could submit to multiple relays
  // For now, single relay selection
  if (sim.risk === "CRITICAL") {
    // Flashbots has the most builder connections
    return "flashbots"
  }
  return "flashbots"
}

// Calculate the priority fee needed to get included via private relay
// Builders prioritize by effective gas price. We need to be competitive
// with other txs in the block without overpaying.
async function calculatePriorityFee(sim: SandwichSimulation): Promise<{
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}> {
  // Get current base fee from latest block
  const block = await publicClient.getBlock({ blockTag: "latest" })
  const baseFee = block.baseFeePerGas ?? 0n

  // For private relay, priority fee determines builder inclusion priority
  // Too low = tx sits for many blocks. Too high = overpaying.
  //
  // Strategy: set priority fee relative to MEV saved.
  // If we're saving $100 in MEV, paying $2-5 in priority fee is fine.
  // Rule: priority fee = min(2 gwei, 5% of MEV saved converted to gas terms)

  const mevSavedWei = sim.attackerProfitRaw // attacker's would-be profit = our savings
  // 5% of MEV saved, converted to per-gas-unit
  const gasUnits = 200000n // estimated gas for swap
  const fivePercentMev = gasUnits > 0n ? (mevSavedWei * 5n) / (100n * gasUnits) : 0n

  // Floor: 0.1 gwei, Cap: 5 gwei
  const minPriority = 100000000n   // 0.1 gwei
  const maxPriority = 5000000000n  // 5 gwei

  let priorityFee = fivePercentMev
  if (priorityFee < minPriority) priorityFee = minPriority
  if (priorityFee > maxPriority) priorityFee = maxPriority

  // maxFeePerGas = 2x baseFee + priority (handles base fee volatility)
  const maxFee = baseFee * 2n + priorityFee

  return {
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: priorityFee,
  }
}

export async function buildPrivateTx(
  intent: SwapIntent,
  sim: SandwichSimulation,
  amountIn: bigint,
  minAmountOut: bigint
): Promise<PrivateTxPlan> {
  const tokenIn = intent.tokenIn as `0x${string}`
  const tokenOut = intent.tokenOut as `0x${string}`
  const user = intent.user as `0x${string}`

  // Select relay
  const relayName = selectRelay(sim)
  const relay = PRIVATE_RELAYS[relayName]

  // Calculate gas parameters
  const { maxFeePerGas, maxPriorityFeePerGas } = await calculatePriorityFee(sim)

  // Build swap calldata
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
  const data = encodeFunctionData({
    abi: routerAbi,
    functionName: "swapExactTokensForTokens",
    args: [amountIn, minAmountOut, [tokenIn, tokenOut], user, deadline],
  })

  // Estimate gas
  let gasLimit: bigint
  try {
    gasLimit = await publicClient.estimateGas({
      account: user,
      to: UNISWAP_V2_ROUTER,
      data,
      value: 0n,
    })
    // Add 20% buffer for safety
    gasLimit = (gasLimit * 120n) / 100n
  } catch {
    // If estimation fails (likely because we don't have user's state),
    // use conservative estimate
    gasLimit = 250000n
  }

  // Economics calculation
  const gasCostWei = gasLimit * maxFeePerGas
  const priorityFeeTotalWei = gasLimit * maxPriorityFeePerGas

  // Get ETH price from simulation
  const inDecimals = await publicClient.readContract({
    address: tokenIn,
    abi: erc20Abi,
    functionName: "decimals",
  }).catch(() => 18)

  const ethPriceUsd = sim.cleanOutputRaw > 0n && amountIn > 0n
    ? Number(sim.cleanOutputRaw) / 10 ** sim.outDecimals / (Number(amountIn) / 10 ** Number(inDecimals))
    : 2500

  const gasCostUsd = (Number(gasCostWei) / 1e18) * ethPriceUsd
  const priorityFeeUsd = (Number(priorityFeeTotalWei) / 1e18) * ethPriceUsd
  const mevSavedUsd = sim.estimatedLossUsd // what user would lose without protection

  // Net savings = MEV saved - extra gas cost from priority fee
  // (base fee is paid regardless, priority fee is the extra cost of private relay)
  const netSavingsUsd = mevSavedUsd - priorityFeeUsd

  const worthIt = netSavingsUsd > 0

  const tx = {
    to: UNISWAP_V2_ROUTER,
    data,
    value: 0n,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  }

  // Hash for reference (not a real tx hash since it's unsigned)
  const txId = keccak256(data)

  const economics = {
    mevSavedUsd: Number(mevSavedUsd.toFixed(2)),
    gasCostUsd: Number(gasCostUsd.toFixed(2)),
    priorityFeeUsd: Number(priorityFeeUsd.toFixed(2)),
    netSavingsUsd: Number(netSavingsUsd.toFixed(2)),
    worthIt,
    reasoning: worthIt
      ? `Private relay saves $${netSavingsUsd.toFixed(2)} net. MEV prevented: $${mevSavedUsd.toFixed(2)}, priority fee cost: $${priorityFeeUsd.toFixed(2)}.`
      : `Private relay NOT worth it. MEV risk ($${mevSavedUsd.toFixed(2)}) < priority fee cost ($${priorityFeeUsd.toFixed(2)}). Falling back to split execution.`,
  }

  console.log(`\n🔒 Private TX Plan:`)
  console.log(`   Relay: ${relay.name} (${relay.rpcUrl})`)
  console.log(`   Gas limit: ${gasLimit.toString()}`)
  console.log(`   Max fee: ${Number(maxFeePerGas) / 1e9} gwei`)
  console.log(`   Priority fee: ${Number(maxPriorityFeePerGas) / 1e9} gwei`)
  console.log(`   MEV saved: $${mevSavedUsd.toFixed(2)}`)
  console.log(`   Priority fee cost: $${priorityFeeUsd.toFixed(2)}`)
  console.log(`   Net savings: $${netSavingsUsd.toFixed(2)}`)
  console.log(`   Worth it: ${worthIt}\n`)

  return {
    relay: {
      name: relay.name,
      rpcUrl: relay.rpcUrl,
      maxBlockWait: relay.maxBlockWait,
    },
    tx,
    economics,
    unsignedTxHash: txId,
  }
}