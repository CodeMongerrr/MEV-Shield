import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"

const RPC_URL = process.env.RPC_URL

if (!RPC_URL) {
  console.error("❌ RPC_URL missing in .env")
  process.exit(1)
}

export const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
})