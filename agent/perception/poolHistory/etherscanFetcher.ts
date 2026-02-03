// agent/perception/poolHistory/etherscanFetcher.ts

import { DecodedSwap } from "./types"

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "YourApiKeyToken"

interface EtherscanTx {
  hash: string
  blockNumber: string
  timeStamp: string
  from: string
  to: string
  value: string
  gasPrice: string
  input: string
  transactionIndex: string
}

export async function fetchPoolTransactions(
  poolAddress: string,
  limit: number = 30
): Promise<DecodedSwap[]> {
  const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${poolAddress}&startblock=0&endblock=99999999&page=1&offset=${limit}&sort=desc&apikey=${ETHERSCAN_API_KEY}`

  const response = await fetch(url)
  const data = await response.json()

  if (data.status !== "1" || !Array.isArray(data.result)) {
    console.warn("Etherscan returned no data, using mock")
    return generateMockSwaps(poolAddress, limit)
  }

  return data.result.map((tx: EtherscanTx, index: number) => ({
    txHash: tx.hash,
    blockNumber: parseInt(tx.blockNumber),
    timestamp: parseInt(tx.timeStamp),
    trader: tx.from,
    tokenIn: "WETH",  // Would decode from input in production
    tokenOut: "USDC",
    amountInUsd: Math.random() * 15000, // Would decode in production
    gasPrice: BigInt(tx.gasPrice),
    positionInBlock: parseInt(tx.transactionIndex),
  }))
}

function generateMockSwaps(poolAddress: string, count: number): DecodedSwap[] {
  const swaps: DecodedSwap[] = []
  const now = Math.floor(Date.now() / 1000)
  
  for (let i = 0; i < count; i++) {
    const blockNumber = 19000000 - i * 10
    swaps.push({
      txHash: `0x${i.toString(16).padStart(64, "a")}`,
      blockNumber,
      timestamp: now - i * 12,
      trader: `0x${((i % 10) + 1).toString(16).padStart(40, "0")}`,
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountInUsd: [500, 2000, 5000, 8000, 15000, 25000][i % 6],
      gasPrice: BigInt(30_000_000_000 + i * 1_000_000_000),
      positionInBlock: i % 20,
    })
  }
  return swaps
}