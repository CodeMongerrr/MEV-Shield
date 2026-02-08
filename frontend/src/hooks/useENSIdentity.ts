/**
 * useEnsIdentity — wagmi v2 hook for ENS resolution
 *
 * Resolves an address ↔ ENS name bidirectionally.
 * Compatible with wagmi v2 (TanStack Query based) — does NOT use the
 * deprecated `enabled` parameter. Instead, passes `undefined` to skip.
 *
 * REQUIREMENT: Your app must be wrapped in <WagmiProvider> + <QueryClientProvider>.
 * See frontend/src/components/Web3Provider.tsx for the setup.
 */

import { useEnsName, useEnsAddress, useEnsAvatar, useEnsText } from "wagmi"
import { normalize } from "viem/ens"
import { useMemo } from "react"

// ============================================================================
// useEnsIdentity — Bidirectional address ↔ ENS resolution
// ============================================================================

export function useEnsIdentity(addressOrName: string) {
  const isAddress = /^0x[a-fA-F0-9]{40}$/.test(addressOrName)
  const isName = !isAddress && addressOrName.length > 0 && addressOrName.includes(".")

  // Wagmi v2: pass undefined to skip the query (no `enabled` param)
  const { data: ensName, isLoading: nameLoading } = useEnsName({
    address: isAddress ? (addressOrName as `0x${string}`) : undefined,
  })

  const { data: ensAddress, isLoading: addrLoading } = useEnsAddress({
    name: isName ? normalize(addressOrName) : undefined,
  })

  const resolvedAddress = isAddress ? addressOrName : (ensAddress ?? null)
  const resolvedName = isAddress ? (ensName ?? null) : (isName ? addressOrName : null)

  // Avatar (only if we have a name)
  const { data: avatar } = useEnsAvatar({
    name: resolvedName ? normalize(resolvedName) : undefined,
  })

  return {
    address: resolvedAddress,
    ensName: resolvedName,
    avatar: avatar ?? null,
    isLoading: nameLoading || addrLoading,
    isEns: !!resolvedName,
  }
}

// ============================================================================
// useEnsPolicy — Read MEV Shield config from ENS text records
// ============================================================================

const MEVSHIELD_KEYS = {
  riskProfile: "com.mevshield.riskProfile",
  privateThreshold: "com.mevshield.privateThreshold",
  splitEnabled: "com.mevshield.splitEnabled",
  maxChunks: "com.mevshield.maxChunks",
  preferredChains: "com.mevshield.preferredChains",
  slippageTolerance: "com.mevshield.slippageTolerance",
} as const

export function useEnsPolicy(ensName: string | null | undefined) {
  // Wagmi v2: when name is undefined, the query is skipped automatically
  const normalizedName = ensName ? normalize(ensName) : undefined

  const { data: riskProfile } = useEnsText({
    name: normalizedName,
    key: MEVSHIELD_KEYS.riskProfile,
  })

  const { data: privateThreshold } = useEnsText({
    name: normalizedName,
    key: MEVSHIELD_KEYS.privateThreshold,
  })

  const { data: splitEnabled } = useEnsText({
    name: normalizedName,
    key: MEVSHIELD_KEYS.splitEnabled,
  })

  const { data: maxChunks } = useEnsText({
    name: normalizedName,
    key: MEVSHIELD_KEYS.maxChunks,
  })

  const { data: preferredChains } = useEnsText({
    name: normalizedName,
    key: MEVSHIELD_KEYS.preferredChains,
  })

  const { data: slippageTolerance } = useEnsText({
    name: normalizedName,
    key: MEVSHIELD_KEYS.slippageTolerance,
  })

  const policy = useMemo(() => {
    if (!ensName) return null

    const hasAny =
      riskProfile || privateThreshold || splitEnabled ||
      maxChunks || preferredChains || slippageTolerance

    if (!hasAny) return null

    // Validate risk profile
    const rp = riskProfile?.toLowerCase()
    const validRisk = rp === "conservative" || rp === "balanced" || rp === "aggressive"
      ? rp as "conservative" | "balanced" | "aggressive"
      : "balanced"

    // Parse numeric values with validation
    const ptVal = parseFloat(privateThreshold ?? "")
    const mcVal = parseInt(maxChunks ?? "")
    const stVal = parseInt(slippageTolerance ?? "")

    // Parse preferred chains
    const chains = preferredChains
      ? preferredChains.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean)
      : ["ethereum"]

    return {
      riskProfile: validRisk,
      privateThresholdUsd: !isNaN(ptVal) && ptVal > 0 ? ptVal : 5000,
      splitEnabled: splitEnabled?.toLowerCase() !== "false",
      maxChunks: !isNaN(mcVal) && mcVal >= 1 && mcVal <= 50 ? mcVal : 10,
      preferredChains: chains,
      slippageTolerance: !isNaN(stVal) && stVal >= 1 && stVal <= 1000 ? stVal : 50,
    }
  }, [ensName, riskProfile, privateThreshold, splitEnabled, maxChunks, preferredChains, slippageTolerance])

  // Raw records for display
  const rawRecords = useMemo(() => {
    if (!ensName) return {}
    const records: Record<string, string | null> = {}
    if (riskProfile) records[MEVSHIELD_KEYS.riskProfile] = riskProfile
    if (privateThreshold) records[MEVSHIELD_KEYS.privateThreshold] = privateThreshold
    if (splitEnabled) records[MEVSHIELD_KEYS.splitEnabled] = splitEnabled
    if (maxChunks) records[MEVSHIELD_KEYS.maxChunks] = maxChunks
    if (preferredChains) records[MEVSHIELD_KEYS.preferredChains] = preferredChains
    if (slippageTolerance) records[MEVSHIELD_KEYS.slippageTolerance] = slippageTolerance
    return records
  }, [ensName, riskProfile, privateThreshold, splitEnabled, maxChunks, preferredChains, slippageTolerance])

  return {
    policy,
    hasPolicy: policy !== null,
    rawRecords,
    recordCount: Object.keys(rawRecords).length,
  }
}