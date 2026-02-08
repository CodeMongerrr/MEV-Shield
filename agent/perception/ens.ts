/**
 * ENS Policy Resolution for MEV Shield
 *
 * Reads user's MEV protection preferences from ENS text records.
 * Records used (all under the "com.mevshield" namespace):
 *
 *   com.mevshield.riskProfile      — "conservative" | "balanced" | "aggressive"
 *   com.mevshield.privateThreshold — USD threshold for private relay (e.g. "5000")
 *   com.mevshield.splitEnabled     — "true" | "false"
 *   com.mevshield.maxChunks        — max chunks allowed (e.g. "10")
 *   com.mevshield.preferredChains  — comma-separated chains (e.g. "ethereum,arbitrum")
 *   com.mevshield.slippageTolerance — basis points (e.g. "50" = 0.5%)
 *
 * WHY ENS:
 *   Users store their MEV protection preferences on-chain once, and every
 *   interaction with MEV Shield automatically uses them. No centralised
 *   database needed — the user's identity IS their configuration store.
 */

import { UserPolicy } from "../core/types"
import { publicClient } from "../core/config"
import { normalize } from "viem/ens"

// ============================================================================
// ENS TEXT RECORD KEYS
// ============================================================================

export const ENS_KEYS = {
  riskProfile: "com.mevshield.riskProfile",
  privateThreshold: "com.mevshield.privateThreshold",
  splitEnabled: "com.mevshield.splitEnabled",
  maxChunks: "com.mevshield.maxChunks",
  preferredChains: "com.mevshield.preferredChains",
  slippageTolerance: "com.mevshield.slippageTolerance",
} as const

export type ENSKeyName = keyof typeof ENS_KEYS

// ============================================================================
// DEFAULTS
// ============================================================================

const DEFAULT_POLICY: UserPolicy = {
  privateThresholdUsd: 5000,
  splitEnabled: true,
  riskProfile: "balanced",
  maxChunks: 10,
  preferredChains: ["ethereum"],
  slippageTolerance: 50, // 0.5% in bps
}

// ============================================================================
// CACHE
// ============================================================================

const policyCache = new Map<string, { policy: UserPolicy; ensName: string | null; ts: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ============================================================================
// ENS RESOLUTION PRIMITIVES
// ============================================================================

/**
 * Reverse-resolve an address to its primary ENS name.
 * Returns null if no name is set.
 */
export async function resolveEnsName(address: string): Promise<string | null> {
  try {
    const name = await publicClient.getEnsName({
      address: address as `0x${string}`,
    })
    return name ?? null
  } catch (err) {
    console.log(`   ENS reverse lookup failed for ${address.slice(0, 10)}…: ${(err as Error).message?.slice(0, 80)}`)
    return null
  }
}

/**
 * Forward-resolve an ENS name to an address.
 */
export async function resolveEnsAddress(name: string): Promise<string | null> {
  try {
    const address = await publicClient.getEnsAddress({
      name: normalize(name),
    })
    return address ?? null
  } catch (err) {
    console.log(`   ENS forward lookup failed for ${name}: ${(err as Error).message?.slice(0, 80)}`)
    return null
  }
}

/**
 * Fetch the ENS avatar URL for a name (used by frontend identity badge).
 */
export async function resolveEnsAvatar(name: string): Promise<string | null> {
  try {
    const avatar = await publicClient.getEnsAvatar({
      name: normalize(name),
    })
    return avatar ?? null
  } catch {
    return null
  }
}

/**
 * Read a single ENS text record.
 */
async function getEnsText(name: string, key: string): Promise<string | null> {
  try {
    const value = await publicClient.getEnsText({
      name: normalize(name),
      key,
    })
    return value ?? null
  } catch {
    return null
  }
}

// ============================================================================
// BATCH RECORD READING
// ============================================================================

/**
 * Read ALL com.mevshield.* text records in parallel.
 * Returns a map of key → value (null if not set).
 */
async function readAllMevShieldRecords(
  ensName: string
): Promise<Record<string, string | null>> {
  const keys = Object.values(ENS_KEYS)

  const results = await Promise.allSettled(
    keys.map((key) => getEnsText(ensName, key))
  )

  const records: Record<string, string | null> = {}
  keys.forEach((key, i) => {
    const r = results[i]
    records[key] = r.status === "fulfilled" ? r.value : null
  })

  return records
}

// ============================================================================
// POLICY PARSING
// ============================================================================

/**
 * Parse raw ENS text records into a validated UserPolicy.
 * Invalid or missing values fall back to defaults.
 */
function parsePolicy(records: Record<string, string | null>): UserPolicy {
  const policy = { ...DEFAULT_POLICY }

  // Risk profile
  const rp = records[ENS_KEYS.riskProfile]?.toLowerCase()
  if (rp === "conservative" || rp === "balanced" || rp === "aggressive") {
    policy.riskProfile = rp
  }

  // Private threshold
  const pt = parseFloat(records[ENS_KEYS.privateThreshold] ?? "")
  if (!isNaN(pt) && pt > 0 && pt < 1_000_000) {
    policy.privateThresholdUsd = pt
  }

  // Split enabled
  const se = records[ENS_KEYS.splitEnabled]?.toLowerCase()
  if (se === "true" || se === "false") {
    policy.splitEnabled = se === "true"
  }

  // Max chunks
  const mc = parseInt(records[ENS_KEYS.maxChunks] ?? "")
  if (!isNaN(mc) && mc >= 1 && mc <= 50) {
    policy.maxChunks = mc
  }

  // Preferred chains
  const pc = records[ENS_KEYS.preferredChains]
  if (pc) {
    const chains = pc
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean)
    if (chains.length > 0) {
      policy.preferredChains = chains
    }
  }

  // Slippage tolerance (bps)
  const st = parseInt(records[ENS_KEYS.slippageTolerance] ?? "")
  if (!isNaN(st) && st >= 1 && st <= 1000) {
    policy.slippageTolerance = st
  }

  return policy
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Fetch user's MEV Shield policy from ENS.
 *
 * 1. Reverse-resolve address → ENS name
 * 2. Read com.mevshield.* text records
 * 3. Parse and validate into UserPolicy
 * 4. Cache result
 *
 * Falls back to defaults if no ENS name or no records set.
 */
export async function fetchUserPolicy(address: string): Promise<UserPolicy & { _ensName?: string | null; _policySource?: string }> {
  const key = address.toLowerCase()

  // Check cache
  const cached = policyCache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    console.log(`   📋 ENS policy (cached): ${cached.policy.riskProfile}, threshold=$${cached.policy.privateThresholdUsd}`)
    return { ...cached.policy, _ensName: cached.ensName, _policySource: cached.ensName ? "ens" : "defaults" }
  }

  console.log(`\n🔍 Resolving ENS policy for ${address.slice(0, 10)}…`)

  // Step 1: Reverse resolve
  const ensName = await resolveEnsName(address)

  if (!ensName) {
    console.log(`   No ENS name found — using defaults`)
    policyCache.set(key, { policy: DEFAULT_POLICY, ensName: null, ts: Date.now() })
    return { ...DEFAULT_POLICY, _ensName: null, _policySource: "defaults" }
  }

  console.log(`   ENS name: ${ensName}`)

  // Step 2: Read text records
  const records = await readAllMevShieldRecords(ensName)
  const hasAnyRecord = Object.values(records).some((v) => v !== null)

  if (!hasAnyRecord) {
    console.log(`   No com.mevshield.* records found — using defaults`)
    policyCache.set(key, { policy: DEFAULT_POLICY, ensName, ts: Date.now() })
    return { ...DEFAULT_POLICY, _ensName: ensName, _policySource: "ens-no-records" }
  }

  // Step 3: Parse
  const policy = parsePolicy(records)

  // Log what we found
  const setRecords = Object.entries(records).filter(([_, v]) => v !== null)
  console.log(`   Found ${setRecords.length} MEV Shield records:`)
  setRecords.forEach(([k, v]) => console.log(`     ${k} = "${v}"`))
  console.log(`   Resolved: ${policy.riskProfile}, threshold=$${policy.privateThresholdUsd}, split=${policy.splitEnabled}, maxChunks=${policy.maxChunks}`)

  // Step 4: Cache
  policyCache.set(key, { policy, ensName, ts: Date.now() })

  return { ...policy, _ensName: ensName, _policySource: "ens" }
}

// ============================================================================
// UNIFIED RESOLVE — used by /resolve API endpoint
// ============================================================================

export interface ResolveResult {
  address: string | null
  ensName: string | null
  avatar: string | null
  error: string | null
}

/**
 * Resolve user input that can be either an address or an ENS name.
 * Frontend calls this via GET /resolve?input=...
 */
export async function resolveUserInput(input: string): Promise<ResolveResult> {
  const trimmed = input.trim()

  // Already a hex address
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    const ensName = await resolveEnsName(trimmed)
    const avatar = ensName ? await resolveEnsAvatar(ensName) : null
    return { address: trimmed, ensName, avatar, error: null }
  }

  // Looks like an ENS name (contains a dot)
  if (trimmed.includes(".")) {
    const address = await resolveEnsAddress(trimmed)
    if (address) {
      const avatar = await resolveEnsAvatar(trimmed)
      return { address, ensName: trimmed, avatar, error: null }
    }
    return { address: null, ensName: null, avatar: null, error: `Could not resolve "${trimmed}"` }
  }

  return { address: null, ensName: null, avatar: null, error: "Enter an address (0x…) or ENS name (name.eth)" }
}