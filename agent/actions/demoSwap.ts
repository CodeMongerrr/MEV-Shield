import { createPublicClient, http, getAddress } from "viem"
import { mainnet } from "viem/chains"

// WETH/USDC pair
const PAIR = getAddress("0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc")

const pairAbi = [
  {
    name: "getReserves",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" }
    ]
  },
  {
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }]
  }
] as const

const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")

function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint) {
  const amountInWithFee = amountIn * 997n
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * 1000n + amountInWithFee
  return numerator / denominator
}

async function main() {

  const client = createPublicClient({
    chain: mainnet,
    transport: http("https://ethereum.publicnode.com")
  })

  const token0 = await client.readContract({
    address: PAIR,
    abi: pairAbi,
    functionName: "token0"
  })

  const reserves = await client.readContract({
    address: PAIR,
    abi: pairAbi,
    functionName: "getReserves"
  })

  let reserveWeth: bigint
  let reserveUsdc: bigint

  if (token0.toLowerCase() === WETH.toLowerCase()) {
    reserveWeth = reserves[0]
    reserveUsdc = reserves[1]
  } else {
    reserveWeth = reserves[1]
    reserveUsdc = reserves[0]
  }

  console.log("Current WETH liquidity:", Number(reserveWeth)/1e18)
  console.log("Current USDC liquidity:", Number(reserveUsdc)/1e6)

  console.log("\nTrade Size vs Slippage\n")

  for (let eth = 1; eth <= 50; eth += 5) {

    const amountIn = BigInt(eth) * 10n**18n
    const out = getAmountOut(amountIn, reserveWeth, reserveUsdc)

const midPrice =
  (Number(reserveUsdc) / 1e6) /
  (Number(reserveWeth) / 1e18)    
const executionPrice = (Number(out) / 1e6) / eth
const slippage = ((midPrice - executionPrice) / midPrice) * 100
    console.log(
      eth, "ETH ->",
      Number(out)/1e6, "USDC | Slippage:",
      slippage.toFixed(3), "%"
    )
  }
}

main()