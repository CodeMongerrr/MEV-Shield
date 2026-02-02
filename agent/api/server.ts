import express from "express"
import { MEVShieldAgent } from "../core/agent"

export async function startServer() {
  const app = express()
  app.use(express.json())

  const agent = new MEVShieldAgent()

  app.post("/swap", async (req, res) => {
    const result = await agent.handleSwap(req.body)
    res.json(result)
  })

  app.listen(3001, () => console.log("🚀 Agent API on :3001"))
}