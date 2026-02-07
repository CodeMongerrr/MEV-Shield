// /**
//  * SPLITTER v2
//  * Optimized for large chunk counts from calculus optimizer.
//  * 
//  * Key changes:
//  * - Batch processing for many chunks
//  * - Efficient AMM simulation with progressive reserves
//  * - Parallel LI.FI requests for cross-chain chunks
//  */

// import { SwapIntent } from "../core/types"
// import { ChunkPlan } from "../reasoning/calcOptimizer"
// import { MEVSimulationResult } from "../perception/mevTemperature"
// import { publicClient } from "../core/config"
// import { parseAbi, encodeFunctionData } from "viem"
// import { buildCrossChainTx, CrossChainTx } from "./lifiRouter"

// const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as const

// const routerAbi = parseAbi([
//   "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
// ])

// export interface ChunkExecution {
//   index: number
//   sizePercent: number
//   amountIn: bigint
//   expectedOut: bigint
//   minAmountOut: bigint
//   priceImpactPercent: number
//   mevExposureUsd: number
//   safeTx: boolean
//   route: {
//     type: "SAME_CHAIN" | "CROSS_CHAIN"
//     chain: string
//     dex: string
//     path: `0x${string}`[]
//   }
//   tx: {
//     to: `0x${string}`
//     data: `0x${string}`
//     value: bigint
//   } | null
//   crossChainTx: CrossChainTx | null
//   blockDelay: number
// }

// export interface SplitResult {
//   chunks: ChunkExecution[]
//   totalExpectedOut: bigint
//   totalMinOut: bigint
//   totalMevExposureUsd: number
//   allChunksSafe: boolean
//   executionBlocks: number
// }

// // ============================================================================
// // AMM MATH
// // ============================================================================

// function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
//   if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
//   const amountInWithFee = amountIn * 997n
//   const numerator = amountInWithFee * reserveOut
//   const denominator = reserveIn * 1000n + amountInWithFee
//   return numerator / denominator
// }

// function sqrt(value: bigint): bigint {
//   if (value <= 0n) return 0n
//   if (value <= 3n) return 1n
//   let z = value
//   let x = value / 2n + 1n
//   while (x < z) {
//     z = x
//     x = (value / x + x) / 2n
//   }
//   return z
// }

// function calculateOptimalFrontrun(reserveIn: bigint, userAmountIn: bigint): bigint {
//   const gamma = 997n
//   const base = 1000n
//   const gammaR = (gamma * reserveIn) / base
//   const gammaUser = (gamma * userAmountIn) / base
//   const underSqrt = gammaR * (gammaR + gammaUser)
//   const sqrtVal = sqrt(underSqrt)
//   if (sqrtVal <= gammaR) return 0n
//   return sqrtVal - gammaR
// }

// function simulateChunkSandwich(
//   amountIn: bigint,
//   reserveIn: bigint,
//   reserveOut: bigint
// ): { cleanOut: bigint; attackerProfit: bigint; userLoss: bigint } {
//   const cleanOut = getAmountOut(amountIn, reserveIn, reserveOut)
//   const frontrun = calculateOptimalFrontrun(reserveIn, amountIn)
  
//   if (frontrun <= 0n) {
//     return { cleanOut, attackerProfit: 0n, userLoss: 0n }
//   }

//   const attackerBought = getAmountOut(frontrun, reserveIn, reserveOut)
//   const rIn1 = reserveIn + frontrun
//   const rOut1 = reserveOut - attackerBought

//   const attackedOut = getAmountOut(amountIn, rIn1, rOut1)
//   const rIn2 = rIn1 + amountIn
//   const rOut2 = rOut1 - attackedOut

//   const attackerSellRevenue = getAmountOut(attackerBought, rOut2, rIn2)
//   const attackerProfit = attackerSellRevenue > frontrun ? attackerSellRevenue - frontrun : 0n
//   const userLoss = cleanOut > attackedOut ? cleanOut - attackedOut : 0n

//   return { cleanOut, attackerProfit, userLoss }
// }

// function bigintToNumber(val: bigint, decimals: number): number {
//   const str = val.toString()
//   if (str.length <= decimals) {
//     return Number(val) / 10 ** decimals
//   }
//   const whole = str.slice(0, str.length - decimals)
//   const frac = str.slice(str.length - decimals, str.length - decimals + 6)
//   return parseFloat(`${whole}.${frac}`)
// }

// // ============================================================================
// // MAIN SPLIT BUILDER
// // ============================================================================

// export async function buildSplitPlan(
//   intent: SwapIntent,
//   plan: ChunkPlan,
//   sim: MEVSimulationResult,
// ): Promise<SplitResult> {
//   const amountIn = BigInt(intent.amountIn)
//   const tokenIn = intent.tokenIn as `0x${string}`
//   const tokenOut = intent.tokenOut as `0x${string}`
//   const numChunks = plan.count

//   console.log(`\n📦 BUILDING SPLIT PLAN: ${numChunks} chunks`)

//   // Gas economics
//   const gasPrice = sim.gasData.gasPriceWei
//   const sandwichGasCostWei = 300000n * gasPrice
//   const ethPriceUsd = sim.ethPriceUsd
//   const sandwichGasCostUsd = bigintToNumber(sandwichGasCostWei, 18) * ethPriceUsd

//   // Convert percentages to amounts
//   const chunkAmounts = calculateChunkAmounts(amountIn, plan.sizes)

//   // Simulate all chunks against progressive reserves
//   let currentReserveIn = sim.reserveIn
//   let currentReserveOut = sim.reserveOut

//   const chunks: ChunkExecution[] = []
//   let totalExpectedOut = 0n
//   let totalMinOut = 0n
//   let totalMevExposure = 0
//   let allSafe = true

//   // Process chunks (with batched logging for large counts)
//   const logEvery = numChunks > 20 ? Math.floor(numChunks / 10) : 1

//   for (let i = 0; i < numChunks; i++) {
//     const chunkAmount = chunkAmounts[i]
//     const chunkSim = simulateChunkSandwich(chunkAmount, currentReserveIn, currentReserveOut)

//     let expectedOut = chunkSim.cleanOut
//     const attackerProfitEth = bigintToNumber(chunkSim.attackerProfit, 18)
//     const attackerProfitUsd = attackerProfitEth * ethPriceUsd
//     const chunkSafe = attackerProfitUsd <= sandwichGasCostUsd

//     if (!chunkSafe) allSafe = false

//     const chunkLossUsd = bigintToNumber(chunkSim.userLoss, sim.outDecimals)
//     totalMevExposure += chunkLossUsd

//     // Price impact
//     const spotPrice = currentReserveIn > 0n
//       ? bigintToNumber(currentReserveOut, sim.outDecimals) / bigintToNumber(currentReserveIn, 18)
//       : 0
//     const execPrice = chunkAmount > 0n
//       ? bigintToNumber(expectedOut, sim.outDecimals) / bigintToNumber(chunkAmount, 18)
//       : 0
//     const priceImpact = spotPrice > 0 ? ((spotPrice - execPrice) / spotPrice) * 100 : 0

//     // Min output with slippage
//     const slippageBps = 50n
//     let minOut = (expectedOut * (10000n - slippageBps)) / 10000n

//     totalExpectedOut += expectedOut
//     totalMinOut += minOut

//     // Route assignment
//     const assignedChain = plan.chains?.[i] || "ethereum"
//     const route: ChunkExecution["route"] = assignedChain !== "ethereum"
//       ? { type: "CROSS_CHAIN", chain: assignedChain, dex: "lifi", path: [tokenIn, tokenOut] }
//       : { type: "SAME_CHAIN", chain: "ethereum", dex: "uniswap_v2", path: [tokenIn, tokenOut] }

//     const blockDelay = plan.blockDelays?.[i] ?? (i === 0 ? 0 : 1)

//     // Build transaction
//     let tx: ChunkExecution["tx"] = null
//     let crossChainTx: CrossChainTx | null = null

//     if (route.type === "SAME_CHAIN") {
//       const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
//       const data = encodeFunctionData({
//         abi: routerAbi,
//         functionName: "swapExactTokensForTokens",
//         args: [chunkAmount, minOut, [tokenIn, tokenOut], intent.user as `0x${string}`, deadline],
//       })
//       tx = { to: UNISWAP_V2_ROUTER, data, value: 0n }
//     } else {
//       // Cross-chain via LI.FI
//       crossChainTx = await buildCrossChainTx("ethereum", route.chain, tokenIn, tokenOut, chunkAmount, intent.user)
//       if (crossChainTx) {
//         expectedOut = crossChainTx.estimatedOutput
//         minOut = crossChainTx.minOutput
//       }
//     }

//     chunks.push({
//       index: i,
//       sizePercent: plan.sizes[i],
//       amountIn: chunkAmount,
//       expectedOut,
//       minAmountOut: minOut,
//       priceImpactPercent: Number(priceImpact.toFixed(4)),
//       mevExposureUsd: Number(chunkLossUsd.toFixed(2)),
//       safeTx: chunkSafe,
//       route,
//       tx,
//       crossChainTx,
//       blockDelay,
//     })

//     // Update reserves
//     currentReserveIn = currentReserveIn + chunkAmount
//     currentReserveOut = currentReserveOut - expectedOut

//     // Batched logging
//     if (i % logEvery === 0 || i === numChunks - 1) {
//       const safeIcon = chunkSafe ? "✓" : "✗"
//       console.log(
//         `   📦 ${i.toString().padStart(3)}/${numChunks}: ` +
//         `${plan.sizes[i].toFixed(1).padStart(5)}% | ` +
//         `$${bigintToNumber(expectedOut, sim.outDecimals).toFixed(2).padStart(10)} | ` +
//         `mev=$${chunkLossUsd.toFixed(2).padStart(6)} | ` +
//         `${safeIcon} | ${route.chain}`
//       )
//     }
//   }

//   const executionBlocks = chunks.reduce((max, c) => Math.max(max, c.blockDelay), 0) + 1

//   // Summary
//   const chainsUsed = [...new Set(chunks.map(c => c.route.chain))]
//   const safeCount = chunks.filter(c => c.safeTx).length

//   console.log(`\n📊 SPLIT SUMMARY:`)
//   console.log(`   Chunks: ${numChunks} (${safeCount} safe, ${numChunks - safeCount} unsafe)`)
//   console.log(`   Chains: ${chainsUsed.join(", ")}`)
//   console.log(`   Expected output: $${bigintToNumber(totalExpectedOut, sim.outDecimals).toFixed(2)}`)
//   console.log(`   Min output: $${bigintToNumber(totalMinOut, sim.outDecimals).toFixed(2)}`)
//   console.log(`   Total MEV exposure: $${totalMevExposure.toFixed(2)}`)
//   console.log(`   Execution span: ${executionBlocks} blocks`)

//   return {
//     chunks,
//     totalExpectedOut,
//     totalMinOut,
//     totalMevExposureUsd: Number(totalMevExposure.toFixed(2)),
//     allChunksSafe: allSafe,
//     executionBlocks,
//   }
// }

// /**
//  * Convert percentage sizes to bigint amounts.
//  * Ensures total equals exact input (no dust).
//  */
// function calculateChunkAmounts(totalAmount: bigint, sizes: number[]): bigint[] {
//   const amounts: bigint[] = []
//   let allocated = 0n

//   for (let i = 0; i < sizes.length; i++) {
//     if (i === sizes.length - 1) {
//       amounts.push(totalAmount - allocated)
//     } else {
//       // Handle both integer percentages and decimals
//       const percent = sizes[i]
//       const chunk = (totalAmount * BigInt(Math.round(percent * 100))) / 10000n
//       amounts.push(chunk)
//       allocated += chunk
//     }
//   }

//   return amounts
// }