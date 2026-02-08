/**
 * SetEnsPolicy — Write MEV Shield preferences to ENS text records
 *
 * Uses wagmi 3.x useWriteContract + useWaitForTransactionReceipt.
 * Calls ENS Public Resolver's setText(bytes32 node, string key, string value).
 *
 * REQUIRES: App wrapped in <Web3Provider> and wallet connected.
 *
 * INTEGRATION:
 *   import SetEnsPolicy from "./components/SetEnsPolicy"
 *
 *   // In your JSX (inside the sidebar form, below the submit button):
 *   {ensName && <SetEnsPolicy ensName={ensName} />}
 */

import React, { useState, useMemo, useEffect } from "react"
import { useWriteContract, useWaitForTransactionReceipt, useAccount } from "wagmi"
import { namehash, normalize } from "viem/ens"

// ENS Public Resolver (latest mainnet)
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

const FIELDS = [
  { id: "riskProfile",       key: "com.mevshield.riskProfile",       label: "Risk Profile",              options: ["conservative", "balanced", "aggressive"], default: "balanced" },
  { id: "privateThreshold",  key: "com.mevshield.privateThreshold",  label: "Private Threshold ($)",      type: "number", default: "5000" },
  { id: "splitEnabled",      key: "com.mevshield.splitEnabled",      label: "Split Enabled",              options: ["true", "false"], default: "true" },
  { id: "maxChunks",         key: "com.mevshield.maxChunks",         label: "Max Chunks",                 type: "number", default: "10" },
  { id: "preferredChains",   key: "com.mevshield.preferredChains",   label: "Preferred Chains",           placeholder: "ethereum,arbitrum", default: "ethereum" },
  { id: "slippageTolerance", key: "com.mevshield.slippageTolerance", label: "Slippage (bps)",             type: "number", default: "50" },
]

// Styles matching your dark theme
const S = {
  bg: "#06060a",
  surface: "#0c0c12",
  surfaceAlt: "#101018",
  border: "#1a1a28",
  borderLight: "#252538",
  text: "#d4d4e0",
  textMuted: "#6b6b80",
  textDim: "#44445a",
  accent: "#6ee7b7",
  accentDim: "#2d6b54",
  danger: "#ef4444",
}

export default function SetEnsPolicy({ ensName, onPolicySet }) {
  const { address: connectedAddress, isConnected } = useAccount()

  // Form values
  const [values, setValues] = useState(() => {
    const init = {}
    FIELDS.forEach((f) => { init[f.id] = f.default })
    return init
  })

  // Track which field is being written
  const [activeField, setActiveField] = useState(null)
  const [fieldStatus, setFieldStatus] = useState({}) // { fieldId: "pending" | "confirmed" | "error" }

  // wagmi 3.x: useWriteContract returns { writeContract, data (hash), isPending, error }
  const {
    writeContract,
    data: txHash,
    isPending: isWriting,
    error: writeError,
    reset: resetWrite,
  } = useWriteContract()

  // Wait for confirmation
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
  })

  // When tx confirms, update status
  useEffect(() => {
    if (isConfirmed && activeField) {
      setFieldStatus((prev) => ({ ...prev, [activeField]: "confirmed" }))
      if (onPolicySet) onPolicySet(activeField, values[activeField])
    }
  }, [isConfirmed, activeField])

  // When write errors, update status
  useEffect(() => {
    if (writeError && activeField) {
      setFieldStatus((prev) => ({ ...prev, [activeField]: "error" }))
    }
  }, [writeError, activeField])

  if (!ensName) {
    return (
      <div style={{ padding: 12, color: S.textDim, fontSize: 11 }}>
        No ENS name detected. Connect a wallet with an ENS name to set your policy.
      </div>
    )
  }

  if (!isConnected) {
    return (
      <div style={{ padding: 12, color: S.textDim, fontSize: 11 }}>
        Connect your wallet to set ENS policy records.
        <br />
        <span style={{ fontSize: 9, marginTop: 4, display: "block" }}>
          Use the <code>&lt;appkit-button&gt;</code> or <code>useAppKit().open()</code>
        </span>
      </div>
    )
  }

  function handleSet(field) {
    const node = namehash(normalize(ensName))
    const value = values[field.id]

    setActiveField(field.id)
    setFieldStatus((prev) => ({ ...prev, [field.id]: "pending" }))
    resetWrite() // clear previous tx state

    writeContract({
      address: PUBLIC_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: "setText",
      args: [node, field.key, String(value)],
    })
  }

  const isBusy = isWriting || isConfirming

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 6,
      padding: 12, background: S.surface,
      border: `1px solid ${S.border}`, borderRadius: 6,
    }}>
      <div style={{ fontSize: 10, color: S.accent, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
        ✏️ Set MEV Shield Policy — {ensName}
      </div>

      {FIELDS.map((field) => {
        const status = fieldStatus[field.id]
        const isActive = activeField === field.id && isBusy

        return (
          <div key={field.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {/* Label */}
            <span style={{ fontSize: 10, color: S.textMuted, width: 110, flexShrink: 0 }}>
              {field.label}
            </span>

            {/* Input */}
            {field.options ? (
              <select
                value={values[field.id]}
                onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
                style={{
                  flex: 1, padding: "4px 6px", fontSize: 11,
                  background: S.surfaceAlt, border: `1px solid ${S.border}`,
                  color: S.text, borderRadius: 3, fontFamily: "inherit",
                }}
              >
                {field.options.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            ) : (
              <input
                type={field.type || "text"}
                value={values[field.id]}
                onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
                placeholder={field.placeholder || ""}
                style={{
                  flex: 1, padding: "4px 6px", fontSize: 11,
                  background: S.surfaceAlt, border: `1px solid ${S.border}`,
                  color: S.text, borderRadius: 3, fontFamily: "inherit",
                  outline: "none", boxSizing: "border-box",
                }}
              />
            )}

            {/* Set button */}
            <button
              onClick={() => handleSet(field)}
              disabled={isActive}
              style={{
                padding: "3px 8px", fontSize: 9, fontWeight: 600,
                background: status === "confirmed" ? S.accentDim :
                            status === "error" ? S.danger + "33" : S.surfaceAlt,
                border: `1px solid ${
                  status === "confirmed" ? S.accent :
                  status === "error" ? S.danger :
                  S.borderLight
                }`,
                color: status === "confirmed" ? S.accent :
                       status === "error" ? S.danger : S.text,
                borderRadius: 3, cursor: isActive ? "wait" : "pointer",
                opacity: isActive ? 0.5 : 1,
                minWidth: 32,
              }}
            >
              {status === "confirmed" ? "✓" :
               isActive ? "…" :
               status === "error" ? "✗" :
               "Set"}
            </button>
          </div>
        )
      })}

      {/* Status line */}
      {txHash && (
        <div style={{ fontSize: 9, color: S.textDim, marginTop: 2 }}>
          tx: {txHash.slice(0, 10)}…{txHash.slice(-8)}
          {isConfirming && " (confirming…)"}
          {isConfirmed && " ✓"}
        </div>
      )}

      {writeError && (
        <div style={{ fontSize: 9, color: S.danger, marginTop: 2 }}>
          {writeError.shortMessage || writeError.message?.slice(0, 80)}
        </div>
      )}

      <div style={{ fontSize: 8, color: S.textDim, marginTop: 4, lineHeight: 1.4 }}>
        Each record is a separate on-chain transaction on the ENS Public Resolver.
        Your wallet must own this ENS name or be an authorized operator.
      </div>
    </div>
  )
}