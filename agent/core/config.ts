import { createPublicClient, http, PublicClient } from "viem"
import { mainnet, arbitrum, base } from "viem/chains"

const RPC_URL = process.env.RPC_URL
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL
const BASE_RPC_URL = process.env.BASE_RPC_URL

if (!RPC_URL) {
  console.error("❌ RPC_URL missing in .env")
  process.exit(1)
}

export const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL),
})

// Use `any` for the client type to avoid chain-specific transaction type conflicts
export const chainClients: Record<string, { client: any; chainId: number } | null> = {
  ethereum: { client: publicClient, chainId: 1 },
  arbitrum: ARBITRUM_RPC_URL
    ? { client: createPublicClient({ chain: arbitrum, transport: http(ARBITRUM_RPC_URL) }), chainId: 42161 }
    : null,
  base: BASE_RPC_URL
    ? { client: createPublicClient({ chain: base, transport: http(BASE_RPC_URL) }), chainId: 8453 }
    : null,
}

export function getAvailableChains(): string[] {
  return Object.entries(chainClients)
    .filter(([_, v]) => v !== null)
    .map(([k]) => k)
}