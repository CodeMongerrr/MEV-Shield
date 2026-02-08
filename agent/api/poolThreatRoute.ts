/**
 * Pool Threat History Endpoint
 * 
 * GET /pool-threat?pool=0x...
 * POST /pool-threat  { pool: "0x..." }
 * 
 * Returns JSON that maps directly to the Pool Threat History dashboard section.
 * Uses the MEV Searcher Detection v2.0 logic (unchanged) to analyze
 * sandwich attacks and slippage patterns on a given Uniswap V2 pool.
 * 
 * INTEGRATION:
 *   import { registerPoolThreatRoute } from "./routes/poolThreat"
 *   registerPoolThreatRoute(app)   // app is your Express instance
 */

import { Router, Request, Response } from "express"
import { analyzePoolThreat, PoolThreatResponse } from "../perception/poolThreatAnalyzer"

const router = Router()
router.use((req, res, next) => {
  const origin = req.headers.origin || "*"

  // allow origin
  res.setHeader("Access-Control-Allow-Origin", origin)

  // important for caching proxies
  res.setHeader("Vary", "Origin")

  // allow methods
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  )

  // CRITICAL: reflect requested headers
  const reqHeaders = req.headers["access-control-request-headers"]
  if (reqHeaders) {
    res.setHeader("Access-Control-Allow-Headers", reqHeaders)
  } else {
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  }

  // preflight cache (reduces spam OPTIONS)
  res.setHeader("Access-Control-Max-Age", "86400")

  // preflight response
  if (req.method === "OPTIONS") {
    return res.status(204).end()
  }

  next()
})
// Simple in-memory cache (pool → { data, timestamp })
const cache = new Map<string, { data: PoolThreatResponse; ts: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

router.get("/pool-threat", async (req: Request, res: Response) => {
  const pool = (req.query.pool as string)?.toLowerCase()
  if (!pool || !/^0x[a-f0-9]{40}$/i.test(pool)) {
    return res.status(400).json({ error: "Invalid or missing `pool` address query param" })
  }
  return handleAnalysis(pool, res)
})

router.post("/pool-threat", async (req: Request, res: Response) => {
  const pool = (req.body?.pool as string)?.toLowerCase()
  if (!pool || !/^0x[a-f0-9]{40}$/i.test(pool)) {
    return res.status(400).json({ error: "Invalid or missing `pool` in request body" })
  }
  return handleAnalysis(pool, res)
})

async function handleAnalysis(pool: string, res: Response) {
  // Check cache
  const cached = cache.get(pool)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return res.json(cached.data)
  }

  try {
    const result = await analyzePoolThreat(pool)
    cache.set(pool, { data: result, ts: Date.now() })
    return res.json(result)
  } catch (err: any) {
    console.error("[PoolThreat] Error:", err.message)
    return res.status(500).json({ error: err.message })
  }
}

export default router


/** Helper to register on an existing Express app */
export function registerPoolThreatRoute(app: any): void {
  app.use(router)
  
}