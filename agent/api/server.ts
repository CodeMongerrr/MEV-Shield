import express from "express"
import { MEVShieldAgent } from "../core/agent"
import { registerPoolThreatRoute } from "./poolThreatRoute"
import { resolveUserInput, fetchUserPolicy } from "../perception/ens"

export async function startServer() {
  const app = express()
  registerPoolThreatRoute(app)

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Headers", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    if (req.method === "OPTIONS") return res.status(200).end()
    next()
  })

  app.use(express.json())

  const agent = new MEVShieldAgent()

  app.post("/swap", async (req, res) => {
    const result = await agent.handleSwap(req.body)
    res.json(result)
  })

  // ENS resolution endpoint
  app.get("/resolve", async (req, res) => {
    const input = req.query.input as string
    if (!input) return res.status(400).json({ error: "Missing input param" })
    const result = await resolveUserInput(input)
    res.json(result)
  })

  // ENS policy endpoint — read user's on-chain MEV Shield config
  app.get("/policy", async (req, res) => {
    const address = req.query.address as string
    if (!address || !/^0x[a-fA-F0-9]{40}$/i.test(address)) {
      return res.status(400).json({ error: "Invalid address" })
    }
    const policy = await fetchUserPolicy(address)
    res.json(policy)
  })

  app.listen(3001, () => console.log("🚀 Agent API on :3001"))
}