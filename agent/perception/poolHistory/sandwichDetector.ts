// agent/perception/poolHistory/sandwichDetector.ts

import { DecodedSwap, SandwichAttack } from "./types"

export function detectSandwiches(swaps: DecodedSwap[]): SandwichAttack[] {
  const attacks: SandwichAttack[] = []
  
  // Group by block
  const byBlock = new Map<number, DecodedSwap[]>()
  for (const swap of swaps) {
    const list = byBlock.get(swap.blockNumber) || []
    list.push(swap)
    byBlock.set(swap.blockNumber, list)
  }

  for (const [blockNum, blockSwaps] of byBlock) {
    if (blockSwaps.length < 3) continue
    
    // Sort by position in block
    const sorted = [...blockSwaps].sort((a, b) => a.positionInBlock - b.positionInBlock)
    
    // Find sandwich patterns
    for (let i = 0; i < sorted.length - 2; i++) {
      const front = sorted[i]
      
      for (let j = i + 1; j < sorted.length - 1; j++) {
        const victim = sorted[j]
        
        // Skip if same trader (can't sandwich yourself)
        if (front.trader.toLowerCase() === victim.trader.toLowerCase()) continue
        
        for (let k = j + 1; k < sorted.length; k++) {
          const back = sorted[k]
          
          // Check if front and back are same attacker
          if (front.trader.toLowerCase() !== back.trader.toLowerCase()) continue
          
          // Check gas price ordering (attacker pays more)
          if (front.gasPrice <= victim.gasPrice) continue
          
          // Found a sandwich!
          const victimLossPercent = Math.min(
            5,
            (Number(front.amountInUsd) / Number(victim.amountInUsd)) * 2
          )
          
          const extractedValueUsd = victim.amountInUsd * (victimLossPercent / 100)
          
          attacks.push({
            frontrunTx: front,
            victimTx: victim,
            backrunTx: back,
            attackerAddress: front.trader,
            extractedValueUsd,
            victimLossPercent,
          })
        }
      }
    }
  }
  
  return attacks
}