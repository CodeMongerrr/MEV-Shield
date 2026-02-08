/**
 * Web3Provider — wagmi v2 + RainbowKit setup
 *
 * Wrap your <App /> with this to enable:
 *   - useEnsIdentity / useEnsPolicy wagmi hooks
 *   - Wallet connection (RainbowKit)
 *   - On-chain ENS text record writing (SetEnsPolicy component)
 *
 * Install:
 *   npm install wagmi viem @tanstack/react-query @rainbow-me/rainbowkit
 */

import React from "react"
import { WagmiProvider, createConfig, http } from "wagmi"
import { mainnet } from "wagmi/chains"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RainbowKitProvider,
  getDefaultConfig,
} from "@rainbow-me/rainbowkit"
import "@rainbow-me/rainbowkit/styles.css"

const config = getDefaultConfig({
  appName: "MEV Shield",
  // Get a free project ID at https://cloud.walletconnect.com
  projectId: "55f53bbc51596960347001e0a1a37847" || "YOUR_PROJECT_ID",
  chains: [mainnet],
  transports: {
    [mainnet.id]: http("" || "https://eth.llamarpc.com"),
  },
})

const queryClient = new QueryClient()

export default function Web3Provider({ children }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}