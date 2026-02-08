import express from "express"
import { MEVShieldAgent } from "../core/agent"
import { registerPoolThreatRoute } from "./poolThreatRoute"
export async function startServer() {
  const app = express()
  registerPoolThreatRoute(app)

app.use((req, res, next) => {
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
app.use(express.json())

  const agent = new MEVShieldAgent()
  app.post("/swap", async (req, res) => {
    const result = await agent.handleSwap(req.body)
    res.json(result)
  })

  app.listen(3001, () => console.log("🚀 Agent API on :3001"))
}