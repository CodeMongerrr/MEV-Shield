/**
 * Cloudflare Workers entry for the MEV Shield API.
 *
 * Serves the same routes as api/server.ts with a plain fetch handler and the
 * existing analysis modules, unchanged. The Node server (index.ts) still works.
 *
 *   POST /swap                  full analysis, body { user, tokenIn, tokenOut, amountIn, chainId }
 *   GET  /resolve?input=        ENS name or address
 *   GET  /policy?address=       MEV Shield policy from ENS text records
 *   GET  /pool-threat?pool=     sandwich scan of a pool (also POST { pool }), needs GRAPH_API_KEY
 *   GET  /health                liveness and config check, no RPC calls
 *
 * Bindings (see wrangler.toml)
 *   RPC_URL                 secret, required
 *   GRAPH_API_KEY           secret, optional (only /pool-threat and the pool history inside /swap)
 *   ARBITRUM_RPC_URL, BASE_RPC_URL  optional
 *   ALLOWED_ORIGIN          comma separated origins for CORS, default "*"
 *   RATE_LIMIT_PER_MINUTE   tokens per client IP per minute, default 30, "0" disables
 *   DEBUG_LOGS              "1" keeps the step by step console.log output of the analysis
 */

import type { MEVShieldAgent } from "./core/agent"
import type { SwapIntent } from "./core/types"

export interface Env {
  RPC_URL?: string
  GRAPH_API_KEY?: string
  ARBITRUM_RPC_URL?: string
  BASE_RPC_URL?: string
  ALLOWED_ORIGIN?: string
  RATE_LIMIT_PER_MINUTE?: string
  DEBUG_LOGS?: string
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const MAX_BODY_BYTES = 16 * 1024
// Used when a /swap request has no user. Same placeholder as the README sample request.
const PLACEHOLDER_USER = "0x0000000000000000000000000000000000000001"

class BadRequest extends Error {}

// ── Lazy module loading ─────────────────────────────────────────────────────
// core/config.ts reads process.env and exits when RPC_URL is missing, the
// moment it is first imported. Copy the bindings into process.env first and
// import the analysis modules only after RPC_URL has been checked.

type Modules = {
  agent: MEVShieldAgent
  ens: typeof import("./perception/ens")
  poolThreat: typeof import("./perception/poolThreatAnalyzer")
}

let modulesPromise: Promise<Modules> | null = null

function loadModules(env: Env): Promise<Modules> {
  if (!modulesPromise) {
    // The analysis logs every step with console.log, which costs a few ms of CPU
    // per /swap. Keep it off in production unless DEBUG_LOGS is "1".
    if (env.DEBUG_LOGS !== "1") console.log = () => {}
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string" && process.env[key] === undefined) process.env[key] = value
    }
    modulesPromise = Promise.all([
      import("./core/agent"),
      import("./perception/ens"),
      import("./perception/poolThreatAnalyzer"),
    ]).then(([agentModule, ens, poolThreat]) => ({
      agent: new agentModule.MEVShieldAgent(),
      ens,
      poolThreat,
    }))
    modulesPromise.catch(() => {
      modulesPromise = null
    })
  }
  return modulesPromise
}

// ── Rate limit ──────────────────────────────────────────────────────────────
// Token bucket per client IP, held in memory. Each isolate has its own map,
// so the limit applies per isolate (roughly per Cloudflare location), not
// globally. Good enough to stop one visitor from draining the RPC quota.

const buckets = new Map<string, { tokens: number; updated: number }>()
const ROUTE_COST: Record<string, number> = { "/swap": 5, "/pool-threat": 5 }

function takeTokens(ip: string, cost: number, perMinute: number): number {
  const now = Date.now()
  const refillPerMs = perMinute / 60_000
  let bucket = buckets.get(ip)
  if (!bucket) {
    if (buckets.size > 10_000) buckets.clear()
    bucket = { tokens: perMinute, updated: now }
    buckets.set(ip, bucket)
  }
  bucket.tokens = Math.min(perMinute, bucket.tokens + (now - bucket.updated) * refillPerMs)
  bucket.updated = now
  const needed = Math.min(cost, perMinute)
  if (bucket.tokens >= needed) {
    bucket.tokens -= needed
    return 0
  }
  return Math.ceil((needed - bucket.tokens) / refillPerMs / 1000)
}

// ── Pool threat cache (same 5 minute TTL as api/poolThreatRoute.ts) ────────

const poolThreatCache = new Map<string, { data: unknown; ts: number }>()
const POOL_THREAT_TTL_MS = 5 * 60 * 1000

// ── Helpers ─────────────────────────────────────────────────────────────────

function corsHeaders(request: Request, env: Env): Headers | null {
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean)
  const origin = request.headers.get("Origin")
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  })
  if (allowed.includes("*")) headers.set("Access-Control-Allow-Origin", "*")
  else if (origin && allowed.includes(origin)) headers.set("Access-Control-Allow-Origin", origin)
  else if (origin) return null
  return headers
}

function json(data: unknown, status: number, cors: Headers, extra: Record<string, string> = {}): Response {
  const headers = new Headers(cors)
  headers.set("Content-Type", "application/json; charset=utf-8")
  headers.set("Cache-Control", "no-store")
  for (const [k, v] of Object.entries(extra)) headers.set(k, v)
  return new Response(JSON.stringify(data), { status, headers })
}

async function readJsonBody(request: Request): Promise<any> {
  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) throw new BadRequest("Request body too large")
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new BadRequest("Request body too large")
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    throw new BadRequest("Request body must be JSON")
  }
}

function parseSwapIntent(body: any): SwapIntent | string {
  if (!body || typeof body !== "object") return "Request body must be a JSON object"
  const user = body.user || PLACEHOLDER_USER
  if (typeof user !== "string" || !ADDRESS_RE.test(user)) {
    return "`user` must be a 0x address. Resolve ENS names with GET /resolve first"
  }
  if (typeof body.tokenIn !== "string" || !ADDRESS_RE.test(body.tokenIn)) return "`tokenIn` must be a 0x token address"
  if (typeof body.tokenOut !== "string" || !ADDRESS_RE.test(body.tokenOut)) return "`tokenOut` must be a 0x token address"
  if (body.tokenIn.toLowerCase() === body.tokenOut.toLowerCase()) return "`tokenIn` and `tokenOut` must differ"
  const amountIn = String(body.amountIn ?? "")
  if (!/^[0-9]{1,40}$/.test(amountIn) || BigInt(amountIn) === 0n) {
    return "`amountIn` must be a positive integer in the token's smallest unit, as a string"
  }
  const chainId = body.chainId === undefined ? 1 : Number(body.chainId)
  if (!Number.isInteger(chainId) || chainId <= 0) return "`chainId` must be a positive integer"
  return { user, tokenIn: body.tokenIn, tokenOut: body.tokenOut, amountIn: BigInt(amountIn), chainId }
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env)
    if (!cors) return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers: { "Content-Type": "application/json" } })
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })

    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, "") || "/"
    const method = request.method

    if (path === "/" || path === "/health") {
      return json(
        {
          ok: true,
          service: "mev-shield-api",
          rpcConfigured: Boolean(env.RPC_URL),
          poolThreatEnabled: Boolean(env.GRAPH_API_KEY),
          routes: ["POST /swap", "GET /resolve?input=", "GET /policy?address=", "GET /pool-threat?pool=", "GET /health"],
        },
        200,
        cors,
      )
    }

    const known =
      (path === "/swap" && method === "POST") ||
      ((path === "/resolve" || path === "/policy") && method === "GET") ||
      (path === "/pool-threat" && (method === "GET" || method === "POST"))
    if (!known) return json({ error: `No route for ${method} ${path}` }, 404, cors)

    const configured = Number(env.RATE_LIMIT_PER_MINUTE || 30)
    const perMinute = Number.isFinite(configured) ? configured : 30
    if (perMinute > 0) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown"
      const retryAfter = takeTokens(ip, ROUTE_COST[path] ?? 1, perMinute)
      if (retryAfter > 0) {
        return json({ error: "Too many requests. Please wait a minute and try again." }, 429, cors, { "Retry-After": String(retryAfter) })
      }
    }

    if (!env.RPC_URL) {
      return json({ error: "Server is missing RPC_URL. Set it as a Worker secret." }, 500, cors)
    }

    try {
      if (path === "/swap") {
        const body = await readJsonBody(request)
        const intent = parseSwapIntent(body)
        if (typeof intent === "string") return json({ error: intent }, 400, cors)
        const { agent } = await loadModules(env)
        return json(await agent.handleSwap(intent), 200, cors)
      }

      if (path === "/resolve") {
        const input = url.searchParams.get("input")
        if (!input || input.length > 255) return json({ error: "Missing or too long input param" }, 400, cors)
        const { ens } = await loadModules(env)
        return json(await ens.resolveUserInput(input), 200, cors)
      }

      if (path === "/policy") {
        const address = url.searchParams.get("address") ?? ""
        if (!ADDRESS_RE.test(address)) return json({ error: "Invalid address" }, 400, cors)
        const { ens } = await loadModules(env)
        return json(await ens.fetchUserPolicy(address), 200, cors)
      }

      // /pool-threat
      const pool = (method === "POST" ? (await readJsonBody(request))?.pool : url.searchParams.get("pool")) ?? ""
      if (typeof pool !== "string" || !ADDRESS_RE.test(pool)) {
        return json({ error: "Invalid or missing `pool` address" }, 400, cors)
      }
      if (!env.GRAPH_API_KEY) {
        return json(
          { error: "Pool threat scan is disabled on this deployment because GRAPH_API_KEY is not set. POST /swap still works." },
          503,
          cors,
        )
      }
      const key = pool.toLowerCase()
      const cached = poolThreatCache.get(key)
      if (cached && Date.now() - cached.ts < POOL_THREAT_TTL_MS) return json(cached.data, 200, cors)
      const { poolThreat } = await loadModules(env)
      const data = await poolThreat.analyzePoolThreat(key)
      poolThreatCache.set(key, { data, ts: Date.now() })
      return json(data, 200, cors)
    } catch (err) {
      if (err instanceof BadRequest) return json({ error: err.message }, 400, cors)
      console.error(`[worker] ${method} ${path} failed: ${(err as Error)?.message ?? err}`)
      return json({ error: "Internal error while running the analysis" }, 500, cors)
    }
  },
}
