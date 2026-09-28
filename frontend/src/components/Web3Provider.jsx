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
import { WagmiProvider, http } from "wagmi"
import { mainnet } from "wagmi/chains"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RainbowKitProvider,
  getDefaultConfig,
} from "@rainbow-me/rainbowkit"
import "@rainbow-me/rainbowkit/styles.css"
import { WALLETCONNECT_PROJECT_ID, MAINNET_RPC_URL } from "../config"

const config = getDefaultConfig({
  appName: "MEV Shield",
  // Get a free project ID at https://cloud.reown.com and set VITE_WALLETCONNECT_PROJECT_ID
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [mainnet],
  transports: {
    [mainnet.id]: http(MAINNET_RPC_URL),
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
