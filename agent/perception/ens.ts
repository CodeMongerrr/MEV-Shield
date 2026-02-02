import { UserPolicy } from "../core/types"

export async function fetchUserPolicy(address: string): Promise<UserPolicy> {
  // Later: read ENS text records
  return {
    privateThresholdUsd: 5000,
    splitEnabled: true,
    riskProfile: "balanced",
  }
}