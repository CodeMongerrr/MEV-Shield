/**
 * SetEnsPolicy — Write MEV Shield preferences to ENS text records
 *
 * Uses wagmi v2 useWriteContract hook to call the ENS Public Resolver's
 * setText(bytes32 node, string key, string value) function.
 *
 * This component lets users set their protection preferences on-chain,
 * which the MEV Shield agent reads automatically on every swap.
 *
 * REQUIRES: <WagmiProvider> + connected wallet that owns the ENS name.
 */

import React, { useState, useMemo } from "react"
import { useWriteContract, useWaitForTransactionReceipt, useAccount } from "wagmi"
import { namehash } from "viem/ens"
import { normalize } from "viem/ens"

// ENS Public Resolver (latest mainnet deployment)
const PUBLIC_RESOLVER = "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63"

const RESOLVER_ABI = [
  {
    name: "setText",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
      { name: "value", type: "string" },
    ],
    outputs: [],
  },
]

const MEVSHIELD_KEYS = {
  riskProfile: { key: "com.mevshield.riskProfile", label: "Risk Profile", options: ["conservative", "balanced", "aggressive"] },
  privateThreshold: { key: "com.mevshield.privateThreshold", label: "Private Relay Threshold ($)", type: "number" },
  splitEnabled: { key: "com.mevshield.splitEnabled", label: "Split Enabled", options: ["true", "false"] },
  maxChunks: { key: "com.mevshield.maxChunks", label: "Max Chunks", type: "number" },
  preferredChains: { key: "com.mevshield.preferredChains", label: "Preferred Chains", placeholder: "ethereum,arbitrum,base" },
  slippageTolerance: { key: "com.mevshield.slippageTolerance", label: "Slippage Tolerance (bps)", type: "number" },
}

// ============================================================================
// Single record writer hook
// ============================================================================

export function useSetEnsText(ensName, recordKey, value) {
  const node = useMemo(
    () => ensName ? namehash(normalize(ensName)) : undefined,
    [ensName]
  )

  const { writeContract, data: hash, isPending, error } = useWriteContract()

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
  })

  const write = () => {
    if (!node || !recordKey || value === undefined) return
    writeContract({
      address: PUBLIC_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: "setText",
      args: [node, recordKey, String(value)],
    })
  }

  return {
    write,
    isPending,
    isConfirming,
    isSuccess,
    error,
    hash,
  }
}

// ============================================================================
// Full policy editor component
// ============================================================================

export default function SetEnsPolicy({ ensName, onPolicySet }) {
  const { address: connectedAddress } = useAccount()
  const [values, setValues] = useState({
    riskProfile: "balanced",
    privateThreshold: "5000",
    splitEnabled: "true",
    maxChunks: "10",
    preferredChains: "ethereum",
    slippageTolerance: "50",
  })
  const [activeKey, setActiveKey] = useState(null)
  const [txStatus, setTxStatus] = useState({})

  const { writeContract, data: hash, isPending } = useWriteContract()
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash })

  if (!ensName) {
    return (
      <div style={{ padding: 16, color: "#6b6b80", fontSize: 12 }}>
        Connect a wallet with an ENS name to set your MEV Shield policy.
      </div>
    )
  }

  const handleSet = async (keyName) => {
    const config = MEVSHIELD_KEYS[keyName]
    const value = values[keyName]
    if (!config || !value) return

    const node = namehash(normalize(ensName))
    setActiveKey(keyName)

    try {
      writeContract({
        address: PUBLIC_RESOLVER,
        abi: RESOLVER_ABI,
        functionName: "setText",
        args: [node, config.key, String(value)],
      })
      setTxStatus((prev) => ({ ...prev, [keyName]: "pending" }))
    } catch (err) {
      setTxStatus((prev) => ({ ...prev, [keyName]: "error" }))
    }
  }

  // Track tx confirmation
  if (isSuccess && activeKey && txStatus[activeKey] === "pending") {
    setTxStatus((prev) => ({ ...prev, [activeKey]: "confirmed" }))
    if (onPolicySet) onPolicySet(activeKey, values[activeKey])
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 11, color: "#6ee7b7", fontWeight: 600, marginBottom: 4 }}>
        ✏️ Set MEV Shield Policy for {ensName}
      </div>

      {Object.entries(MEVSHIELD_KEYS).map(([keyName, config]) => (
        <div key={keyName} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 10, color: "#6b6b80", width: 140, flexShrink: 0 }}>
            {config.label}
          </label>

          {config.options ? (
            <select
              value={values[keyName]}
              onChange={(e) => setValues((v) => ({ ...v, [keyName]: e.target.value }))}
              style={{
                flex: 1, padding: "4px 6px", fontSize: 11,
                background: "#101018", border: "1px solid #1a1a28",
                color: "#d4d4e0", borderRadius: 3,
              }}
            >
              {config.options.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          ) : (
            <input
              type={config.type || "text"}
              value={values[keyName]}
              onChange={(e) => setValues((v) => ({ ...v, [keyName]: e.target.value }))}
              placeholder={config.placeholder || ""}
              style={{
                flex: 1, padding: "4px 6px", fontSize: 11,
                background: "#101018", border: "1px solid #1a1a28",
                color: "#d4d4e0", borderRadius: 3, fontFamily: "inherit",
              }}
            />
          )}

          <button
            onClick={() => handleSet(keyName)}
            disabled={isPending && activeKey === keyName}
            style={{
              padding: "4px 10px", fontSize: 10, fontWeight: 600,
              background: txStatus[keyName] === "confirmed" ? "#2d6b54" : "#1a1a28",
              border: `1px solid ${txStatus[keyName] === "confirmed" ? "#6ee7b7" : "#252538"}`,
              color: txStatus[keyName] === "confirmed" ? "#6ee7b7" : "#d4d4e0",
              borderRadius: 3, cursor: "pointer",
              opacity: (isPending && activeKey === keyName) ? 0.5 : 1,
            }}
          >
            {txStatus[keyName] === "confirmed" ? "✓" :
             txStatus[keyName] === "pending" ? "…" :
             "Set"}
          </button>
        </div>
      ))}

      <div style={{ fontSize: 9, color: "#44445a", marginTop: 4 }}>
        Each record requires a separate on-chain transaction. Records are stored on your ENS name and read automatically by MEV Shield.
      </div>
    </div>
  )
}