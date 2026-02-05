import "dotenv/config"
import { startServer } from "./api/server"

console.log("🛡️ MEV Shield Agent v2 - Calculus-Based Optimizer")
console.log("═══════════════════════════════════════════════════════════")
console.log("Features:")
console.log("  • Mathematically optimal chunk count (n* = √(M/g))")
console.log("  • No arbitrary chunk limits")
console.log("  • Live gas pricing from all chains")
console.log("  • Live bridge costs from LI.FI")
console.log("  • Newton-Raphson optimization")
console.log("═══════════════════════════════════════════════════════════\n")

startServer()