import "dotenv/config"
import { startServer } from "./api/server"

console.log("🛡️ MEV Shield Agent v1.0.0")
console.log("═══════════════════════════════════════════════════════════")
console.log("  • Integer sandwich simulation on live Uniswap V2 reserves")
console.log("  • Route search over private relay share × public chunk count")
console.log("  • Live gas from configured chains, USD prices from LI.FI")
console.log("  • ENS text record policy (com.mevshield.*)")
console.log("═══════════════════════════════════════════════════════════\n")

startServer()
