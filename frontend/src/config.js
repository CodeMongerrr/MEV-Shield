// Build time configuration. Vite inlines import.meta.env.VITE_* values when `npm run build` runs,
// so set them in .env.local for local work or as build variables on the host.
// The older names VITE_API_BASE and VITE_REOWN_PROJECT_ID are still accepted.

const env = import.meta.env

// URL of the MEV Shield agent API, for example https://mev-shield-api.<subdomain>.workers.dev
export const API_BASE = (env.VITE_API_URL || env.VITE_API_BASE || "http://localhost:3001").replace(/\/+$/, "")

// WalletConnect (Reown) project ID. Only needed to connect a wallet, the analysis works without one.
// "YOUR_PROJECT_ID" makes RainbowKit fall back to its example ID, which is fine for local work.
export const WALLETCONNECT_PROJECT_ID =
  env.VITE_WALLETCONNECT_PROJECT_ID || env.VITE_REOWN_PROJECT_ID || "YOUR_PROJECT_ID"

// Optional RPC for the dashboard's wagmi client
export const MAINNET_RPC_URL = env.VITE_MAINNET_RPC_URL || "https://eth.llamarpc.com"
