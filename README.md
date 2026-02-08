# 🛡️ MEV Shield

**Autonomous Execution Firewall for DeFi**

MEV Shield is a calculus-driven optimization engine that protects DeFi users from sandwich attacks and MEV extraction. It simulates attacks before they happen, derives optimal execution strategies using real mathematics, and stores user protection preferences as ENS text records — making MEV defense portable, decentralized, and identity-native.

Built for [ETHGlobal HackMoney 2026](https://ethglobal.com/events/hackmoney2026).

---

## The Problem

Every swap on a public DEX is visible in the mempool before it's mined. Sandwich bots exploit this by frontrunning your trade to move the price against you, then backrunning to capture the difference. Since 2020, over **$24 billion** has been extracted from DeFi users through MEV.

Existing solutions are binary — either use a private relay (which has costs) or don't (and get sandwiched). Nobody asks the real question: **what's the mathematically cheapest way to protect this specific trade?**

## The Solution

MEV Shield evaluates three strategies for every trade and picks the one with the lowest total cost:

| Strategy | How It Works | When It Wins |
|----------|-------------|--------------|
| **Single Public** | Normal swap, no protection | Trade is below bot profitability threshold |
| **Private Relay** | Route through Flashbots, hidden from mempool | Mid-size trades where relay tip < MEV exposure |
| **Optimal Chunking** | Split into n pieces sized below attack threshold | Whale trades where relay tip scales quadratically |

The optimizer adapts in real-time — three different trade sizes can produce three different optimal strategies.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Frontend (React)                     │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Swap Interface │  │ ENS Identity │  │ SetEnsPolicy │  │
│  │   (App.jsx)   │  │    Badge     │  │  (on-chain)  │  │
│  └───────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│          │                 │                  │          │
│  ┌───────┴─────────────────┴──────────────────┴───────┐  │
│  │         wagmi hooks: useEnsIdentity,               │  │
│  │         useEnsResolver, useEnsPolicy               │  │
│  └────────────────────────┬───────────────────────────┘  │
└───────────────────────────┼──────────────────────────────┘
                            │ HTTP
┌───────────────────────────┼──────────────────────────────┐
│                    Agent Backend (TS)                     │
│                           │                              │
│  ┌────────────────────────┴───────────────────────────┐  │
│  │              Express API Server                     │  │
│  │  POST /swap  GET /resolve  GET /policy  GET /pool   │  │
│  └──┬──────────────┬──────────────┬───────────────────┘  │
│     │              │              │                       │
│  ┌──┴───┐   ┌──────┴──────┐   ┌──┴────────────────┐     │
│  │ MEV  │   │     ENS     │   │  Pool Threat       │     │
│  │Shield│   │  Resolution │   │  Analyzer          │     │
│  │Agent │   │  + Policy   │   │  (Sandwich         │     │
│  │      │   │  Fetch      │   │   Detection)       │     │
│  └──┬───┘   └─────────────┘   └────────────────────┘     │
│     │                                                    │
│  ┌──┴──────────────────────────────────────────────────┐ │
│  │              Chunk Optimizer                         │ │
│  │  Sandwich Simulation → Cost Function → Newton-      │ │
│  │  Raphson → Grid Search → 3-Way Strategy Comparison  │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

---

## The Math

The core optimization minimizes total execution cost as a function of chunk count.

### Cost Function

```
C(n) = M/n + n·G
```

- **M** — Total MEV exposure (USD). Derived from sandwich simulation against live pool state.
- **n** — Number of chunks the trade is split into.
- **G** — Gas cost per swap (USD). Fetched from live gas oracles.

The first term (M/n) captures MEV reduction: sandwich profit scales with the square of trade size relative to pool liquidity (`MEV ∝ chunk²/L`), so splitting into n equal chunks reduces total MEV by a factor of n.

The second term (n·G) captures gas overhead: each chunk is a separate on-chain transaction.

### Analytical Optimum

Taking the derivative and setting it to zero:

```
dC/dn = −M/n² + G = 0
    →  n* = √(M/G)
```

The optimal chunk count is the square root of MEV-to-gas ratio.

### Newton-Raphson Refinement

The analytical solution assumes smooth, continuous costs. Real-world cost functions have discrete effects (threshold where chunks become safe, chain-specific gas, relay tip scaling), so MEV Shield refines using numerical Newton-Raphson:

1. Start at n₀ = √(M/G)
2. Evaluate C(n-1), C(n), C(n+1)
3. Compute central difference derivative: `dC ≈ (C(n+1) - C(n-1)) / 2`
4. Compute second derivative: `d²C ≈ C(n+1) - 2·C(n) + C(n-1)`
5. Newton step: `n ← n - dC/d²C`
6. Repeat until convergence, then grid search ±10 around result

### Private Relay Cost Model

Private relay cost is derived from the constant-product AMM invariant, not from fixed parameters:

1. **Price displacement**: `δ = Δx / reserveIn` — fractional pool displacement from the trade
2. **Created arbitrage**: `arb = k · L · δ²` — extractable value scales quadratically with displacement
3. **Builder payment**: Searchers capture ~60% of arb, bid ~70% to builder → effective tip ≈ 42% of theoretical arb
4. **User cost**: Must exceed best searcher bid by ~10% inclusion premium

This means private relay cost scales quadratically with trade size relative to pool depth — which is why it loses to chunking for large trades.

---

## ENS Integration

MEV Shield uses ENS text records as a **decentralized policy layer**. Protection preferences are stored on-chain under the `com.mevshield` namespace, portable across any wallet or dApp.

### Text Record Schema

| Key | Example | Description |
|-----|---------|-------------|
| `com.mevshield.riskProfile` | `conservative` | Execution style: conservative / balanced / aggressive |
| `com.mevshield.privateThreshold` | `5000` | USD threshold above which private relay is considered |
| `com.mevshield.splitEnabled` | `true` | Whether order splitting is allowed |
| `com.mevshield.maxChunks` | `10` | Maximum number of chunks permitted |
| `com.mevshield.preferredChains` | `ethereum,arbitrum` | Chains the user prefers for execution |
| `com.mevshield.slippageTolerance` | `50` | Acceptable slippage in basis points (50 = 0.5%) |

### How It Works

1. **Wallet connects** → frontend resolves ENS name via custom `useEnsIdentity` hook
2. **Backend reads policy** → `ens.ts` fetches all `com.mevshield.*` text records via viem
3. **Optimizer uses policy** → chunk limits, relay thresholds, and risk profile feed into the cost function
4. **User updates policy** → `SetEnsPolicy` component calls `PublicResolver.setText()` directly on-chain

No database. No API keys. Your MEV preferences live on your ENS name and travel with your identity.

### Custom ENS Code (Beyond RainbowKit)

- **`useEnsIdentity`** — wagmi v2 hook for bidirectional address ↔ ENS resolution with avatar support
- **`useEnsResolver`** — standalone hook that calls backend `/resolve` + `/policy` endpoints
- **`useEnsPolicy`** — reads all six `com.mevshield.*` text records as structured policy
- **`SetEnsPolicy`** — React component that writes ENS text records via `writeContract` to the PublicResolver
- **`ens.ts`** — backend module: forward/reverse resolution, text record reads, avatar fetch, policy parsing with caching

---

## Project Structure

```
mev-shield/
├── agent/
│   ├── api/
│   │   └── server.ts              # Express API: /swap, /resolve, /policy, /pool-threat
│   ├── core/
│   │   ├── agent.ts               # MEV Shield agent orchestrator
│   │   ├── types.ts               # SwapIntent, UserPolicy, SimulationResult
│   │   └── config.ts              # viem public client, chain config
│   ├── perception/
│   │   ├── ens.ts                 # ENS resolution + policy fetch (viem)
│   │   └── poolThreatAnalyzer.ts  # Historical sandwich detection via Uniswap subgraph
│   └── reasoning/
│       ├── chunkOptimizer.ts      # Core optimizer: simulation → Newton-Raphson → strategy comparison
│       └── decisionEngine.ts      # Strategy selection + execution plan builder
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx                # Main UI: swap form, results dashboard, ENS badge
│   │   ├── components/
│   │   │   ├── SetEnsPolicy.jsx   # On-chain ENS text record writer
│   │   │   └── Web3Provider.jsx   # RainbowKit + wagmi v2 provider setup
│   │   └── hooks/
│   │       ├── useEnsIdentity.ts  # wagmi v2 hook: address ↔ ENS bidirectional
│   │       └── useEnsResolver.js  # Standalone hook: backend-powered resolution
│   └── ...
│
└── README.md
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/swap` | Run full MEV analysis + optimization for a swap intent |
| `GET` | `/resolve?input=` | Resolve ENS name → address or address → ENS name |
| `GET` | `/policy?address=` | Fetch user's on-chain MEV Shield policy from ENS text records |
| `GET` | `/ens-keys` | Return the ENS text record key schema |
| `GET` | `/pool-threat?pool=` | Analyze historical sandwich attack frequency for a Uniswap pool |
| `POST` | `/pool-threat` | Same analysis with POST body parameters |

### Example: Swap Analysis

```bash
curl -X POST http://localhost:3001/swap \
  -H "Content-Type: application/json" \
  -d '{
    "user": "vitalik.eth",
    "tokenIn": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "tokenOut": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "amountIn": "5000000000000000000",
    "chainId": 1
  }'
```

Response includes: risk level, MEV exposure estimate, three-strategy cost comparison, optimal chunk breakdown, and the winning strategy recommendation.

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- An Ethereum RPC endpoint (Alchemy / Infura)
- A WalletConnect / Reown project ID (for frontend wallet connection)

### Backend

```bash
cd agent
npm install
cp .env.example .env  # Add your RPC URL
npm run dev            # Starts on :3001
```

### Frontend

```bash
cd frontend
npm install
cp .env.example .env  # Add Reown project ID
npm run dev            # Starts on :5173
```

### Environment Variables

```env
# Backend
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
PORT=3001

# Frontend
VITE_REOWN_PROJECT_ID=your_reown_project_id
VITE_API_BASE=http://localhost:3001
```

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Optimizer | TypeScript | Sandwich simulation, cost function, Newton-Raphson, strategy comparison |
| ENS | viem/ens, wagmi v2 | Text record reads/writes, bidirectional resolution |
| API | Express.js | REST endpoints for swap analysis, ENS resolution, pool threat |
| Frontend | React, RainbowKit | Swap interface, ENS identity badge, policy editor |
| Data | Uniswap V2 Subgraph | Historical swap data for sandwich detection |
| Wallet | wagmi v2, RainbowKit | Wallet connection, on-chain ENS writes |

---

## How MEV Shield Is Different

| Feature | Flashbots Protect | CoW Protocol | MEV Blocker | **MEV Shield** |
|---------|------------------|-------------|-------------|----------------|
| Private relay | ✅ | — | ✅ | ✅ |
| Order splitting | — | Batch auction | — | **Calculus-optimized chunking** |
| Optimal strategy selection | — | — | — | **3-way cost comparison per trade** |
| User-configurable policy | — | — | — | **ENS text records** |
| Pre-trade MEV simulation | — | — | — | **Full sandwich simulation** |
| Analytical chunk optimization | — | — | — | **n* = √(M/G) + Newton-Raphson** |

---

## Scope & Transparency

This project demonstrates the **optimization mathematics and ENS policy architecture** for MEV protection. The demo runs simulations against live Ethereum mainnet data — real gas prices, real pool liquidity, real sandwich modeling.

There are no deployed smart contracts or transaction builders. Demonstrating actual MEV protection requires high volumes of capital moving on-chain. The metrics generated are near-accurate representations of what execution costs would be, derived from real chain state.

The innovation is the math, the adaptive strategy selection, and the use of ENS as a decentralized settings layer — not a transaction execution engine.

---

## Prize Tracks

- **🎉 Integrate ENS** ($3,500 pool) — Custom wagmi hooks, ENS text records as policy storage, functional on-chain reads/writes
- **🥇 Most Creative Use of ENS for DeFi** ($1,500) — ENS as a portable, decentralized configuration layer for MEV protection preferences

---

## License

MIT

---

Built with frustration about losing money to sandwich bots, and calculus.
