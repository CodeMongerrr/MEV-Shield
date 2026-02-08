/**
 * useEnsResolver — Custom hook that calls your backend /resolve + /policy endpoints.
 *
 * This is the STANDALONE version that works with your existing vanilla React
 * frontend (no wagmi/WagmiProvider needed). It uses your agent API to do the
 * ENS resolution server-side via viem.
 *
 * Use this in App.jsx directly.
 */

import { useState, useEffect, useCallback, useRef } from "react"

const API_BASE = "http://localhost:3001"

// ============================================================================
// useEnsResolver — Debounced ENS resolution via backend
// ============================================================================

export function useEnsResolver(input, debounceMs = 400) {
  const [resolvedAddress, setResolvedAddress] = useState(null)
  const [ensName, setEnsName] = useState(null)
  const [avatar, setAvatar] = useState(null)
  const [ensPolicy, setEnsPolicy] = useState(null)
  const [policySource, setPolicySource] = useState("defaults")
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState(null)
  const timerRef = useRef(null)

  useEffect(() => {
    // Clear previous timer
    if (timerRef.current) clearTimeout(timerRef.current)

    // Reset if input is empty
    if (!input || input.length < 3) {
      setResolvedAddress(null)
      setEnsName(null)
      setAvatar(null)
      setEnsPolicy(null)
      setPolicySource("defaults")
      setError(null)
      return
    }

    // Debounce
    timerRef.current = setTimeout(async () => {
      setResolving(true)
      setError(null)

      try {
        // Step 1: Resolve address ↔ ENS name
        const res = await fetch(`${API_BASE}/resolve?input=${encodeURIComponent(input)}`)
        const data = await res.json()

        if (data.error) {
          setError(data.error)
          setResolvedAddress(null)
          setEnsName(null)
          setAvatar(null)
          setEnsPolicy(null)
          setPolicySource("defaults")
          setResolving(false)
          return
        }

        setResolvedAddress(data.address)
        setEnsName(data.ensName)
        setAvatar(data.avatar)

        // Step 2: Fetch policy if we got an address
        if (data.address) {
          try {
            const pRes = await fetch(`${API_BASE}/policy?address=${data.address}`)
            const pData = await pRes.json()
            setEnsPolicy(pData)
            setPolicySource(pData._policySource || "defaults")
          } catch {
            setEnsPolicy(null)
            setPolicySource("defaults")
          }
        }
      } catch (err) {
        setError("Resolution failed")
        setResolvedAddress(null)
        setEnsName(null)
      }

      setResolving(false)
    }, debounceMs)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [input, debounceMs])

  return {
    resolvedAddress,
    ensName,
    avatar,
    ensPolicy,
    policySource,
    resolving,
    error,
    // The address to actually use in API calls
    effectiveAddress: resolvedAddress || ((/^0x[a-fA-F0-9]{40}$/.test(input)) ? input : null),
  }
}