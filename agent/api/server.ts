import express from "express"
import { MEVShieldAgent } from "../core/agent"
import { registerPoolThreatRoute } from "./poolThreatRoute"
registerPoolThreatRoute(app)
export async function startServer() {
  const app = express()
  
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

  if (req.method === "OPTIONS") {
    return res.status(200).end()
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