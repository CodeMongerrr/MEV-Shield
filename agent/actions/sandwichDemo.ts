import { createPublicClient, http, getAddress } from "viem"
import { mainnet } from "viem/chains"

// -------------------- CONSTANTS --------------------

const PAIR = getAddress("0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc") // WETH/USDC
const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")

// Public RPC (works with eth_call)
const RPC = "https://ethereum.publicnode.com"

// -------------------- ABI --------------------

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

// -------------------- UNISWAP MATH --------------------

function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint) {
  const amountInWithFee = amountIn * 997n
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * 1000n + amountInWithFee
  return numerator / denominator
}

// -------------------- SANDWICH SIMULATION --------------------

function simulateSandwich(
  reserveEth: bigint,
  reserveUsdc: bigint,
  attackerIn: bigint,
  victimIn: bigint
) {

  // FRONT RUN (attacker buys USDC with ETH)
  const attackerUsdc = getAmountOut(attackerIn, reserveEth, reserveUsdc)

  let rEth = reserveEth + attackerIn
  let rUsdc = reserveUsdc - attackerUsdc

  // VICTIM SWAP
  const victimUsdc = getAmountOut(victimIn, rEth, rUsdc)

  rEth += victimIn
  rUsdc -= victimUsdc

  // BACK RUN (attacker sells USDC back to ETH)
  const attackerEthBack = getAmountOut(attackerUsdc, rUsdc, rEth)

  const profit = attackerEthBack - attackerIn

  return {
    profitEth: Number(profit) / 1e18,
    victimUsdc: Number(victimUsdc) / 1e6,
    attackerUsdc: Number(attackerUsdc) / 1e6
  }
}

// -------------------- MAIN --------------------

async function main() {

  const client = createPublicClient({
    chain: mainnet,
    transport: http(RPC)
  })

  console.log("Fetching live Uniswap liquidity...\n")

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

  const midPrice =
    (Number(reserveUsdc) / 1e6) /
    (Number(reserveWeth) / 1e18)

  console.log("WETH liquidity:", Number(reserveWeth)/1e18)
  console.log("USDC liquidity:", Number(reserveUsdc)/1e6)
  console.log("Mid Price (ETH -> USDC):", midPrice.toFixed(2), "\n")

  // Victim swap (you can change this for the demo)
  const victimTrade = 20n * 10n**18n

  const normalVictimOut = getAmountOut(victimTrade, reserveWeth, reserveUsdc)

  console.log("Victim intends to swap 20 ETH")
  console.log("Victim would normally receive:", Number(normalVictimOut)/1e6, "USDC\n")

  console.log("Scanning attacker trade sizes...\n")

  let bestSize = 0
  let bestProfit = -999
  let victimAfterAttack = 0

  for (let i = 1; i <= 80; i++) {

    const attacker = BigInt(i) * 10n**17n // 0.1 ETH steps

    const sim = simulateSandwich(
      reserveWeth,
      reserveUsdc,
      attacker,
      victimTrade
    )

    if (sim.profitEth > bestProfit) {
      bestProfit = sim.profitEth
      bestSize = i / 10
      victimAfterAttack = sim.victimUsdc
    }

    console.log(
      "Attacker:", (i/10).toFixed(1), "ETH",
      "| Profit:", sim.profitEth.toFixed(6), "ETH"
    )
  }

  const victimLoss = (Number(normalVictimOut)/1e6) - victimAfterAttack

  console.log("\n==============================")
  console.log("OPTIMAL SANDWICH FOUND")
  console.log("==============================\n")

  console.log("Best attacker size:", bestSize, "ETH")
  console.log("Attacker profit:", bestProfit.toFixed(6), "ETH")
  console.log("Victim receives:", victimAfterAttack.toFixed(2), "USDC")
  console.log("Victim loss:", victimLoss.toFixed(2), "USDC")
}

main().catch(console.error)