# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased](https://github.com/CodeMongerrr/MEV-Shield/compare/v1.0.0...HEAD)

## [1.0.0](https://github.com/CodeMongerrr/MEV-Shield/releases/tag/v1.0.0) - 2026-09-29

First tagged release. It packages the ETHGlobal HackMoney 2026 build from 2 to 8 February 2026, with the fixes needed to install, typecheck and build from a clean clone, and a Cloudflare Workers port so it can be hosted.

### Added

- Sandwich simulator that replays a front run, the victim swap and a back run on live Uniswap V2 reserves with exact integer math
- Route search over every mix of a Flashbots private relay share and a public chunk count up to the user's chunk cap, priced by sandwich loss, gas, builder tip and price drift
- Private relay cost model derived from the arbitrage a trade leaves behind in a constant product pool
- ENS policy layer that reads six `com.mevshield.*` text records in the agent and writes them from the dashboard
- Pool threat scan that flags likely sandwiched swaps from the Uniswap V2 subgraph
- React dashboard with wallet connection, an ENS policy editor and the full cost breakdown
- Landing view that explains the tool in two sentences and runs a 250 WETH to USDT example without a wallet
- Cloudflare Workers entry for the API (`agent/worker.ts`, `agent/wrangler.toml`) with the same routes as the Express server, a `/health` route, a CORS allow list, a per IP rate limit and input checks for `/swap`
- Static assets Worker config for the dashboard (`frontend/wrangler.toml`) with single page app fallback
- MIT license, this changelog, a CI workflow for typecheck, build and a Worker bundle check, and `.env.example` files for both packages
- `typecheck`, `build` and `start` scripts for the agent

### Changed

- The API port now comes from `PORT` and defaults to 3001
- The dashboard reads the API URL, WalletConnect project ID and RPC URL from `VITE_API_URL`, `VITE_WALLETCONNECT_PROJECT_ID` and `VITE_MAINNET_RPC_URL`. The names `VITE_API_BASE` and `VITE_REOWN_PROJECT_ID` also work
- The dashboard stacks its panels on narrow screens
- README rewritten to match the code, with a reproducible sample request and an honest list of limitations
- Agent startup banner now lists what the agent actually does

### Fixed

- Agent typecheck errors in `executor.ts` and `calcOptimizer.ts`, and the ES2020 target that broke the `ox` types viem ships
- `npm ci` failing in the dashboard on the RainbowKit and wagmi peer range
- The server reporting success when its port was already in use
- The route search now honors the `maxChunks` limit from ENS instead of always searching up to 100 public chunks
- An empty WalletConnect project ID in `.env.local` no longer blanks the dashboard

### Removed

- Hard coded WalletConnect project ID in the dashboard
- Documentation for Newton-Raphson refinement and a `/ens-keys` endpoint, neither of which exists in the code
