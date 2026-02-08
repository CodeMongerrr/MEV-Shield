import { useState, useEffect, useRef } from "react";
import { useEnsResolver } from "./hooks/useEnsResolver";

// ── API Config ──────────────────────────────────────────────────────────────
const API_BASE = "http://localhost:3001";

// ── Common tokens ───────────────────────────────────────────────────────────
const TOKENS = {
  WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
  USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
  USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
  DAI: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18 },
  WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8 },
};
const TOKEN_LIST = Object.values(TOKENS);
function findToken(addr) {
  return TOKEN_LIST.find((t) => t.address.toLowerCase() === addr?.toLowerCase());
}

// ── Formatters ──────────────────────────────────────────────────────────────
function truncAddr(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; }
function fmt(n, d = 2) {
  if (n == null || isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return "$" + n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  return "$" + Number(n).toFixed(d);
}
function fmtNum(n, d = 4) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toFixed(d);
}
function pct(n, d = 2) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toFixed(d) + "%";
}

// ── Colors ──────────────────────────────────────────────────────────────────
const C = {
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
  warn: "#f59e0b",
  danger: "#ef4444",
  dangerDim: "#7f1d1d",
  info: "#60a5fa",
};

const riskColors = { LOW: C.accent, MEDIUM: C.warn, HIGH: "#f97316", CRITICAL: C.danger, EXTREME: C.danger };

// ── Components ──────────────────────────────────────────────────────────────

function Badge({ level, small }) {
  const c = riskColors[level] || C.textMuted;
  return (
    <span style={{
      display: "inline-block", padding: small ? "1px 6px" : "2px 10px",
      borderRadius: 3, fontSize: small ? 9 : 10, fontWeight: 700,
      letterSpacing: "0.08em", color: "#000", background: c,
      textTransform: "uppercase",
    }}>{level}</span>
  );
}

function SectionCard({ title, icon, badge, children, accent }) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: 8, overflow: "hidden",
      borderLeft: accent ? `3px solid ${accent}` : undefined,
    }}>
      <div style={{
        padding: "10px 16px", fontSize: 11, fontWeight: 700,
        color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.08em",
        borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8,
      }}>
        {icon && <span style={{ fontSize: 13 }}>{icon}</span>}
        <span>{title}</span>
        {badge}
      </div>
      <div style={{ padding: "12px 16px" }}>{children}</div>
    </div>
  );
}

function KV({ label, value, accent, mono, sub }) {
  return (
    <div style={{ minWidth: 100, marginBottom: 8 }}>
      <div style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: accent || C.text, fontFamily: mono !== false ? "'JetBrains Mono', monospace" : "inherit" }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: C.textDim, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function Grid({ cols = 4, gap = 16, children }) {
  return <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap }}>{children}</div>;
}

function MiniTable({ headers, rows, highlightLast }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr>{headers.map((h, i) => (
          <th key={i} style={{ padding: "6px 8px", fontSize: 9, color: C.textDim, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", textAlign: i === 0 ? "left" : "right", borderBottom: `1px solid ${C.border}` }}>{h}</th>
        ))}</tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri} style={{ borderBottom: `1px solid ${C.border}`, background: highlightLast && ri === rows.length - 1 ? "rgba(110,231,183,0.04)" : "transparent" }}>
            {row.map((cell, ci) => (
              <td key={ci} style={{ padding: "7px 8px", textAlign: ci === 0 ? "left" : "right", color: cell?.color || C.text, fontWeight: cell?.bold ? 700 : 400, fontFamily: ci > 0 ? "'JetBrains Mono', monospace" : "inherit", fontSize: 12 }}>
                {typeof cell === "object" && cell?.text != null ? cell.text : cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProgressBar({ value, max, color, height = 4 }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ width: "100%", height, background: C.border, borderRadius: 2, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color || C.accent, borderRadius: 2, transition: "width 0.4s ease" }} />
    </div>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────
export default function App() {
  // Form
  const [tokenIn, setTokenIn] = useState(TOKENS.WETH.address);
  const [tokenOut, setTokenOut] = useState(TOKENS.USDT.address);
  const [amountRaw, setAmountRaw] = useState("30");
  const [chainId, setChainId] = useState(1);

  // State
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [elapsed, setElapsed] = useState(null);
  const [logs, setLogs] = useState([]);
  const [poolThreat, setPoolThreat] = useState(null);
  const [poolThreatLoading, setPoolThreatLoading] = useState(false);
  const logRef = useRef(null);
  // State
  const [userInput, setUserInput] = useState("vitalik.eth");
  const [resolvedUser, setResolvedUser] = useState(null);
  const [ensName, setEnsName] = useState(null);
  const [ensPolicy, setEnsPolicy] = useState(null);
  const [resolving, setResolving] = useState(false);

  // Resolve ENS when user types
  useEffect(() => {
    if (!userInput || userInput.length < 3) {
      setResolvedUser(null);
      setEnsName(null);
      setEnsPolicy(null);
      return;
    }

    const timeout = setTimeout(async () => {
      setResolving(true);
      try {
        const res = await fetch(`${API_BASE}/resolve?input=${encodeURIComponent(userInput)}`);
        const data = await res.json();
        setResolvedUser(data.address);
        setEnsName(data.ensName);

        // Fetch policy if we have an address
        if (data.address) {
          const pRes = await fetch(`${API_BASE}/policy?address=${data.address}`);
          const pData = await pRes.json();
          setEnsPolicy(pData);
        }
      } catch {
        setResolvedUser(null);
      }
      setResolving(false);
    }, 500); // debounce

    return () => clearTimeout(timeout);
  }, [userInput]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  function getAmountIn() {
    const tkn = findToken(tokenIn);
    const dec = tkn?.decimals ?? 18;
    try {
      const parts = amountRaw.split(".");
      const whole = parts[0] || "0";
      const frac = (parts[1] || "").padEnd(dec, "0").slice(0, dec);
      return BigInt(whole) * BigInt(10 ** dec) + BigInt(frac);
    } catch { return BigInt(0); }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true); setError(null); setResult(null); setLogs([]); setPoolThreat(null);
    const t0 = Date.now();
    const amount = getAmountIn();
    const effectiveUser = resolvedUser || userInput ;

    const payload = {
      user: effectiveUser,
      tokenIn,
      tokenOut,
      amountIn: amount.toString(),
      chainId,
      ensName,
    };
    setLogs((l) => [...l, `POST /swap`, JSON.stringify(payload, null, 2)]);
    try {
      const res = await fetch(`${API_BASE}/swap`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const data = await res.json();
      setResult(data);
      setElapsed(((Date.now() - t0) / 1000).toFixed(1));
      setLogs((l) => [...l, `✓ ${((Date.now() - t0) / 1000).toFixed(1)}s`]);

      // Fetch pool threat from separate endpoint
      const poolAddr = data?.simulation?.poolAddress;
      if (poolAddr) {
        setPoolThreatLoading(true);
        setLogs((l) => [...l, `GET /pool-threat?pool=${poolAddr}`]);
        fetch(`${API_BASE}/pool-threat?pool=${poolAddr}`)
          .then((r) => r.ok ? r.json() : null)
          .then((pt) => { if (pt) { setPoolThreat(pt); setLogs((l) => [...l, `✓ Pool threat loaded (${pt.analyzedSwaps} swaps)`]); } })
          .catch(() => setLogs((l) => [...l, `✗ Pool threat fetch failed`]))
          .finally(() => setPoolThreatLoading(false));
      }
    } catch (err) { setError(err.message); setLogs((l) => [...l, `✗ ${err.message}`]); }
    finally { setLoading(false); }
  }

  const sim = result?.simulation;
  const exec = result?.execution;
  const comp = exec?.comparison;
  const costs = exec?.costs;
  const chunks = exec?.split?.chunks ?? [];
  const privateTx = exec?.privateTx;
  const tokenInInfo = findToken(tokenIn);
  const tokenOutInfo = findToken(tokenOut);

  // Determine winner label
  const winnerLabel = comp?.winner === "OPTIMIZED_PATH"
    ? (comp?.optimizedPath?.description || "Optimized")
    : comp?.winner === "PRIVATE_RELAY" ? "Private Relay"
      : comp?.winner === "DIRECT_SWAP" ? "Direct Swap" : exec?.strategyType || "—";

  return (
    <div style={{ height: "100vh", background: C.bg, color: C.text, display: "flex", flexDirection: "column", fontFamily: "'JetBrains Mono', 'SF Mono', monospace", fontSize: 12 }}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet" />

      {/* ── Header ──────────────────────── */}
      <header style={{ borderBottom: `1px solid ${C.border}`, padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>🛡️</span>
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.02em" }}>MEV Shield</span>
          <span style={{ fontSize: 10, color: C.textDim, marginLeft: 2 }}>v4 · Hybrid Optimizer</span>
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: 10, color: C.textDim }}>
          {elapsed && <span>⏱ {elapsed}s</span>}
          {sim?.ethPriceUsd && <span>Ξ {fmt(sim.ethPriceUsd)}</span>}
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* ── Left Panel: Swap Form ──────── */}
        <aside style={{ width: 300, borderRight: `1px solid ${C.border}`, padding: 16, flexShrink: 0, display: "flex", flexDirection: "column" }}>
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
            <div style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.1em" }}>Swap Parameters</div>
            {/* User input with ENS resolution */}

            <Field label="User Address">
              <Input value={userInput} onChange={(e) => setUserInput(e.target.value)} placeholder="0x... or name.eth" />
              {resolving && <span style={{ position: "absolute", right: 10, top: 8, fontSize: 11, color: C.textDim }}>Resolving...</span>}
              {ensName && resolvedUser && (
                <div style={{ fontSize: 11, color: C.accent, marginTop: 4 }}>
                  ✓ {ensName} → {resolvedUser.slice(0, 6)}...{resolvedUser.slice(-4)}
                  {ensPolicy?.riskProfile && (
                    <span style={{ marginLeft: 8, color: C.textDim }}>
                      Policy: {ensPolicy.riskProfile} | threshold: ${ensPolicy.privateThresholdUsd}
                    </span>
                  )}
                </div>
              )}
            </Field>
            <Field label="Token In">
              <Select value={tokenIn} onChange={(e) => setTokenIn(e.target.value)}>
                {TOKEN_LIST.map((t) => <option key={t.address} value={t.address}>{t.symbol}</option>)}
              </Select>
            </Field>
            <Field label="Token Out">
              <Select value={tokenOut} onChange={(e) => setTokenOut(e.target.value)}>
                {TOKEN_LIST.map((t) => <option key={t.address} value={t.address}>{t.symbol}</option>)}
              </Select>
            </Field>
            <Field label={`Amount (${tokenInInfo?.symbol ?? "tokens"})`}>
              <Input value={amountRaw} onChange={(e) => setAmountRaw(e.target.value)} placeholder="e.g. 30" />
              <div style={{ fontSize: 9, color: C.textDim, marginTop: 2 }}>Raw: {getAmountIn().toString()}</div>
            </Field>
            <Field label="Chain">
              <Select value={chainId} onChange={(e) => setChainId(Number(e.target.value))}>
                <option value={1}>Ethereum Mainnet</option>
                <option value={42161}>Arbitrum</option>
                <option value={8453}>Base</option>
                <option value={10}>Optimism</option>
              </Select>
            </Field>

            <button
              type="submit"
              disabled={loading || resolving || (userInput && !resolvedUser)}
              style={{
                marginTop: 6,
                padding: "10px 0",
                background: (loading || resolving) ? C.border : C.accent,
                color: C.bg,
                border: "none",
                borderRadius: 4,
                fontFamily: "inherit",
                fontSize: 12,
                fontWeight: 700,
                cursor: (loading || resolving) ? "wait" : "pointer",
              }}
            >
              {resolving ? "Resolving ENS…" : loading ? "Analyzing…" : "Analyze Swap"}
            </button>

            {error && <div style={{ padding: 8, background: C.dangerDim, border: `1px solid ${C.danger}33`, borderRadius: 4, fontSize: 11, color: C.danger, wordBreak: "break-all" }}>{error}</div>}
          </form>

          {/* Log */}
          <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
            <div style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Request Log</div>
            <div ref={logRef} style={{ height: 100, overflow: "auto", background: C.bg, borderRadius: 4, padding: 6, fontSize: 9, lineHeight: 1.5, color: C.textDim, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {logs.length === 0 ? "Waiting…" : logs.join("\n")}
            </div>
          </div>
        </aside>

        {/* ── Main Panel: Dashboard ──────── */}
        <main style={{ flex: 1, padding: 20, overflow: "auto", minWidth: 0, minHeight: 0 }}>
          {!result && !loading && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: C.textDim }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>🛡️</div>
                <div style={{ fontSize: 13 }}>Configure swap and click Analyze</div>
              </div>
            </div>
          )}

          {loading && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: C.textDim }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 13, animation: "pulse 1.5s ease-in-out infinite" }}>Running MEV analysis pipeline…</div>
                <div style={{ fontSize: 10, marginTop: 6, color: C.textDim }}>Pool data → Sandwich sim → MEV temperature → Optimizer → Strategy</div>
                <style>{`@keyframes pulse { 0%,100% { opacity: 0.4 } 50% { opacity: 1 } }`}</style>
              </div>
            </div>
          )}

          {result && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

              {/* ══ 1. WINNER BANNER ══════════════════════════════════════════ */}
              <div style={{
                background: `linear-gradient(135deg, ${C.accentDim}22, ${C.surface})`,
                border: `1px solid ${C.accent}33`, borderRadius: 8, padding: "14px 18px",
                display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12,
              }}>
                <div>
                  <div style={{ fontSize: 9, color: C.accent, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>🏆 Recommended Strategy</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: C.accent }}>{winnerLabel}</div>
                  {comp?.recommendation && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, maxWidth: 600, lineHeight: 1.5 }}>{comp.recommendation}</div>}
                </div>
                <div style={{ display: "flex", gap: 20, alignItems: "flex-end" }}>
                  <KV label="Trade Size" value={fmt(result.tradeSizeUsd)} />
                  <KV label="MEV Exposure" value={fmt(sim?.estimatedLossUsd)} accent={sim?.estimatedLossUsd > 100 ? C.danger : C.accent} />
                  {costs && <KV label="Savings" value={`${pct(costs.savingsPercent, 1)}`} accent={C.accent} sub={`${fmt(costs.savings)}`} />}
                </div>
              </div>
              {/* ══ ENS IDENTITY & POLICY SOURCE ════════════════════════════ */}
{result?.identity?.ensName && (
  <div style={{
    display: "flex", alignItems: "center", gap: 10,
    padding: "8px 14px", background: C.surface,
    border: `1px solid ${C.border}`, borderRadius: 6,
  }}>
    {result.identity.avatar && (
      <img src={result.identity.avatar} alt="" style={{ width: 24, height: 24, borderRadius: "50%" }} />
    )}
    <div>
      <span style={{ fontSize: 12, color: C.accent, fontWeight: 600 }}>{result.identity.ensName}</span>
      <span style={{ fontSize: 9, color: C.textDim, marginLeft: 8 }}>
        Policy: {result.identity.policySource === "ens" ? "📡 loaded from ENS" : "⚙️ defaults"}
      </span>
    </div>
    <div style={{ marginLeft: "auto", fontSize: 9, color: C.textDim, fontFamily: "'JetBrains Mono'" }}>
      {result.identity.address?.slice(0, 8)}…{result.identity.address?.slice(-6)}
    </div>
  </div>
)}
              {/* ══ 2. RISK OVERVIEW ══════════════════════════════════════════ */}
              <SectionCard title="Risk Overview" icon="⚠️" badge={<Badge level={sim?.adjustedRisk || sim?.risk} />}>
                <Grid cols={5}>
                  <KV label="Base Risk" value={<Badge level={sim?.risk} small />} />
                  <KV label="Adjusted Risk" value={<Badge level={sim?.adjustedRisk} small />} />
                  <KV label="Attack Viable" value={sim?.attackViable ? "YES" : "NO"} accent={sim?.attackViable ? C.danger : C.accent} />
                  <KV label="Loss %" value={pct(sim?.estimatedLossPercent)} accent={sim?.estimatedLossPercent > 1 ? C.danger : C.warn} />
                  <KV label="ETH Price" value={fmt(sim?.ethPriceUsd)} />
                </Grid>
              </SectionCard>

              {/* ══ USER POLICY (from ENS) ════════════════════════════════ */}
{result?.policy && (
  <SectionCard title="User Policy" icon="🔑" badge={
    <span style={{ fontSize: 10, color: result.identity?.policySource === "ens" ? C.accent : C.textDim, fontWeight: 400, marginLeft: 6 }}>
      {result.identity?.policySource === "ens" ? "📡 ENS" : "⚙️ Defaults"}
    </span>
  }>
    <Grid cols={5}>
      <KV label="Risk Profile" value={result.policy.riskProfile} accent={
        result.policy.riskProfile === "conservative" ? C.accent :
        result.policy.riskProfile === "aggressive" ? C.warn : C.text
      } />
      <KV label="Private Threshold" value={fmt(result.policy.privateThresholdUsd)} />
      <KV label="Split Enabled" value={result.policy.splitEnabled ? "YES" : "NO"} accent={result.policy.splitEnabled ? C.accent : C.textDim} />
      <KV label="Max Chunks" value={result.policy.maxChunks ?? "—"} />
      <KV label="Slippage Tolerance" value={`${result.policy.slippageTolerance ?? 50} bps`} />
    </Grid>
  </SectionCard>
)}

              {/* ══ 3. SANDWICH SIMULATION ════════════════════════════════════ */}
              <SectionCard title="Sandwich Simulation" icon="🥪" accent={sim?.attackViable ? C.danger : C.accent}>
                <Grid cols={4}>
                  <KV label="Clean Output" value={fmt(sim?.cleanOutputUsd)} accent={C.accent} />
                  <KV label="Attacked Output" value={fmt(sim?.attackedOutputUsd)} accent={C.danger} />
                  <KV label="User Loss" value={fmt(sim?.estimatedLossUsd)} accent={C.danger} />
                  <KV label="Attacker Profit" value={fmt(sim?.attackerProfitUsd)} accent={C.warn} />
                </Grid>
                <div style={{ marginTop: 4 }}>
                  <Grid cols={4}>
                    <KV label="Optimal Frontrun" value={`${fmtNum(sim?.optimalFrontrunEth, 6)} ETH`} mono />
                    <KV label="Sandwich Gas" value={fmt(sim?.sandwichGasCostUsd, 4)} />
                    <KV label="Safe Chunk Threshold" value={fmt(sim?.safeChunkThresholdUsd)} accent={C.info} />
                    <KV label="Gas Price" value={`${fmtNum(sim?.gasData?.gasPriceGwei, 2)} gwei`} />
                  </Grid>
                </div>
                {/* Loss bar */}
                {sim?.cleanOutputUsd > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 9, color: C.textDim, marginBottom: 3 }}>MEV Extraction ({pct(sim?.estimatedLossPercent)} of output)</div>
                    <ProgressBar value={sim?.estimatedLossUsd} max={sim?.cleanOutputUsd} color={C.danger} height={5} />
                  </div>
                )}
              </SectionCard>

              {/* ══ 4. POOL DETAILS ══════════════════════════════════════════ */}
              <SectionCard title="Pool Information" icon="🏊">
                <Grid cols={4}>
                  <KV label="Pool Address" value={truncAddr(sim?.poolAddress)} sub={sim?.poolAddress} />
                  <KV label="Pool Depth" value={fmt(sim?.poolDepthUsd)} />
                  <KV label="Trade / Pool" value={pct(sim?.tradeToPoolRatio)} accent={sim?.tradeToPoolRatio > 5 ? C.warn : C.text} />
                  <KV label="Shallow Pool" value={sim?.isShallowPool ? "YES ⚠️" : "NO"} accent={sim?.isShallowPool ? C.warn : C.accent} />
                </Grid>
              </SectionCard>

              {/* ══ 5. POOL THREAT HISTORY ════════════════════════════════════ */}
              <SectionCard title="Pool Threat History" icon="🔍" badge={
                poolThreatLoading
                  ? <span style={{ fontSize: 10, color: C.textDim, fontWeight: 400, marginLeft: 6, animation: "pulse 1.5s ease-in-out infinite" }}>Loading…</span>
                  : <Badge level={poolThreat?.threatLevel ?? sim?.poolThreat?.threatLevel ?? "LOW"} small />
              }>
                {(() => {
                  const pt = poolThreat || sim?.poolThreat;
                  if (!pt) return <div style={{ fontSize: 11, color: C.textDim }}>No pool threat data available</div>;
                  return (
                    <>
                      <Grid cols={5}>
                        <KV label="Analyzed Swaps" value={pt.analyzedSwaps ?? "—"} />
                        <KV label="Sandwiches" value={pt.sandwichCount ?? 0} accent={pt.sandwichCount > 0 ? C.danger : C.accent} />
                        <KV label="Sandwich Rate" value={pct((pt.sandwichRate ?? 0) * 100)} />
                        <KV label="Avg Excess Slippage" value={pct(pt.avgExcessSlippage)} />
                        <KV label="Total Extracted" value={fmt(pt.totalMevExtracted)} />
                      </Grid>
                      <Grid cols={3} gap={12}>
                        <KV label="Min Attack Size" value={pt.minAttackedSizeUsd > 0 ? fmt(pt.minAttackedSizeUsd) : "N/A"} />
                        <KV label="Max Attack Size" value={pt.maxAttackedSizeUsd > 0 ? fmt(pt.maxAttackedSizeUsd) : "N/A"} />
                        <KV label="Threat Level" value={<Badge level={pt.threatLevel ?? "LOW"} small />} />
                      </Grid>
                    </>
                  );
                })()}
              </SectionCard>

              {/* ══ 6. MEV TEMPERATURE ════════════════════════════════════════ */}
              {sim?.mevTemperature && (
                <SectionCard title="MEV Temperature" icon="🔥" badge={<Badge level={sim.mevTemperature.riskLevel} small />}>
                  <Grid cols={5}>
                    <KV label="Score" value={`${sim.mevTemperature.score}/100`} accent={sim.mevTemperature.score >= 50 ? C.danger : sim.mevTemperature.score >= 25 ? C.warn : C.accent} />
                    <KV label="Victim Rate" value={pct(sim.mevTemperature.victimRate)} />
                    <KV label="Sandwiches" value={sim.mevTemperature.sandwichCount} />
                    <KV label="Total Losses" value={fmt(sim.mevTemperature.totalLossUsd)} />
                    <KV label="Cost Multiplier" value={`${sim.mevTemperature.costMultiplier?.toFixed(2) ?? "—"}×`} />
                  </Grid>
                </SectionCard>
              )}

              {/* ══ 7. STRATEGY COMPARISON TABLE ═════════════════════════════ */}
              {comp && (
                <SectionCard title="Strategy Comparison" icon="📊" badge={<span style={{ fontSize: 10, color: C.accent, fontWeight: 400, marginLeft: 6 }}>Winner: {comp.winner?.replace(/_/g, " ")}</span>}>
                  <MiniTable
                    headers={["Strategy", "MEV Loss", "Gas + Fees", "Total Cost", ""]}
                    rows={[
                      [
                        "Direct Swap (unprotected)",
                        fmt(comp.directSwap?.mevLoss),
                        fmt(comp.directSwap?.gasCost),
                        fmt(comp.directSwap?.totalCost),
                        comp.winner === "DIRECT_SWAP" ? { text: "★", color: C.accent, bold: true } : "",
                      ],
                      comp.privateRelay ? [
                        "Private Relay (Flashbots)",
                        fmt(comp.privateRelay?.mevLoss ?? 0),
                        fmt((comp.privateRelay?.gasCost ?? 0) + (comp.privateRelay?.privateTip ?? 0)),
                        fmt(comp.privateRelay?.totalCost),
                        comp.winner === "PRIVATE_RELAY" ? { text: "★", color: C.accent, bold: true } : "",
                      ] : null,
                      comp.optimizedPath ? [
                        { text: `Optimized (${comp.optimizedPath?.description ?? "—"})`, color: comp.winner === "OPTIMIZED_PATH" ? C.accent : C.text },
                        fmt(comp.optimizedPath?.mevLoss ?? 0),
                        fmt((comp.optimizedPath?.gasCost ?? 0) + (comp.optimizedPath?.bridgeCost ?? 0) + (comp.optimizedPath?.privateRelayCost ?? 0) + (comp.optimizedPath?.timingRisk ?? 0)),
                        { text: fmt(comp.optimizedPath?.totalCost), color: comp.winner === "OPTIMIZED_PATH" ? C.accent : C.text, bold: comp.winner === "OPTIMIZED_PATH" },
                        comp.winner === "OPTIMIZED_PATH" ? { text: "★", color: C.accent, bold: true } : "",
                      ] : null,
                    ].filter(Boolean)}
                  />
                </SectionCard>
              )}

              {/* ══ 8. COST BREAKDOWN ════════════════════════════════════════ */}
              {costs && (
                <SectionCard title="Cost Breakdown" icon="💰" accent={C.accent}>
                  <Grid cols={3}>
                    <div>
                      <div style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", marginBottom: 6 }}>Unprotected</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: C.danger }}>{fmt(costs.unprotectedCost)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", marginBottom: 6 }}>Optimized Total</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: C.accent }}>{fmt(costs.totalCost)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", marginBottom: 6 }}>Savings</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: C.accent }}>{fmt(costs.savings)} <span style={{ fontSize: 12, color: C.textMuted }}>({pct(costs.savingsPercent, 1)})</span></div>
                    </div>
                  </Grid>

                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <CostRow label="MEV Exposure" value={costs.mevExposure} total={costs.totalCost} color={C.danger} />
                    <CostRow label="Gas Fees" value={costs.gasFees} total={costs.totalCost} color={C.info} />
                    <CostRow label="Bridge Fees" value={costs.bridgeFees} total={costs.totalCost} color={C.warn} />
                    <CostRow label="Private Relay Fees" value={costs.privateRelayFees} total={costs.totalCost} color="#a78bfa" />
                    <CostRow label="Timing Risk" value={costs.timingRisk} total={costs.totalCost} color="#f472b6" />
                  </div>
                </SectionCard>
              )}

              {/* ══ 9. OPTIMIZED PATH DETAILS ════════════════════════════════ */}
              {comp?.optimizedPath && comp.winner === "OPTIMIZED_PATH" && (
                <SectionCard title="Optimized Path Details" icon="⚡">
                  <Grid cols={4}>
                    <KV label="Private Amount" value={fmt(comp.optimizedPath.privateAmount)} sub={comp.optimizedPath.privateAmount > 0 ? `${pct(comp.optimizedPath.privateAmount / result.tradeSizeUsd * 100, 0)} of trade` : "—"} />
                    <KV label="Public Chunks" value={comp.optimizedPath.publicChunks} />
                    <KV label="Public Amount" value={fmt(comp.optimizedPath.publicAmount)} />
                    <KV label="Timing Risk" value={fmt(comp.optimizedPath.timingRisk, 4)} />
                  </Grid>
                </SectionCard>
              )}

              {/* ══ 10. CHUNK BREAKDOWN TABLE ═════════════════════════════════ */}
              {chunks.length > 0 && (
                <SectionCard title="Chunk Breakdown" icon="📦" badge={<span style={{ fontSize: 10, color: C.textMuted, fontWeight: 400, marginLeft: 6 }}>{chunks.length} chunks · {chunks.filter(c => c.safeTx).length} safe</span>}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead>
                        <tr>
                          {["#", "Size", "Amount", "Chain", "Route", "MEV", "Gas", "Safe", "Block Delay"].map((h, i) => (
                            <th key={h} style={{ padding: "6px 8px", fontSize: 9, color: C.textDim, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", textAlign: i < 2 ? "left" : "right", borderBottom: `1px solid ${C.border}` }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {chunks.map((c, i) => {
                          const amtUsd = c.amountIn && sim?.ethPriceUsd ? Number(c.amountIn) / 1e18 * sim.ethPriceUsd : 0;
                          return (
                            <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                              <td style={{ padding: "6px 8px", color: C.textMuted }}>{c.index + 1}</td>
                              <td style={{ padding: "6px 8px" }}>{c.sizePercent?.toFixed(1)}%</td>
                              <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "'JetBrains Mono'" }}>{fmt(amtUsd)}</td>
                              <td style={{ padding: "6px 8px", textAlign: "right" }}>{c.route?.chain ?? "ethereum"}</td>
                              <td style={{ padding: "6px 8px", textAlign: "right", fontSize: 10 }}>{c.route?.type === "CROSS_CHAIN" ? "🌉 Cross" : "↔ Same"}</td>
                              <td style={{ padding: "6px 8px", textAlign: "right", color: c.mevExposureUsd > 0 ? C.warn : C.textDim }}>{fmt(c.mevExposureUsd, 4)}</td>
                              <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmt(c.userGasCostUsd ?? 0, 4)}</td>
                              <td style={{ padding: "6px 8px", textAlign: "right", color: c.safeTx ? C.accent : C.danger }}>{c.safeTx ? "✓ Safe" : "✗ Unsafe"}</td>
                              <td style={{ padding: "6px 8px", textAlign: "right" }}>{c.blockDelay ?? 0}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {exec?.split && (
                    <div style={{ marginTop: 8, display: "flex", gap: 16, fontSize: 10, color: C.textMuted }}>
                      <span>Total MEV: <span style={{ color: C.warn }}>{fmt(exec.split.totalMevExposureUsd)}</span></span>
                      <span>All Safe: <span style={{ color: exec.split.allChunksSafe ? C.accent : C.danger }}>{exec.split.allChunksSafe ? "Yes" : "No"}</span></span>
                      <span>Execution Span: {exec.split.executionBlocks} blocks</span>
                    </div>
                  )}
                </SectionCard>
              )}

              {/* ══ 11. PRIVATE RELAY ════════════════════════════════════════ */}
              {privateTx && (
                <SectionCard title="Private Relay Details" icon="🔒" accent="#a78bfa">
                  <Grid cols={3}>
                    <KV label="Relay" value={privateTx.relay?.name ?? "Flashbots"} />
                    <KV label="Max Block Wait" value={privateTx.relay?.maxBlockWait ?? "—"} />
                    <KV label="Worth It" value={privateTx.economics?.worthIt ? "YES" : "NO"} accent={privateTx.economics?.worthIt ? C.accent : C.danger} />
                  </Grid>
                  <Grid cols={3}>
                    <KV label="MEV Saved" value={fmt(privateTx.economics?.mevSavedUsd)} accent={C.accent} />
                    <KV label="Gas Cost" value={fmt(privateTx.economics?.gasCostUsd)} />
                    <KV label="Priority Fee" value={fmt(privateTx.economics?.priorityFeeUsd)} />
                  </Grid>
                  <Grid cols={2}>
                    <KV label="Net Savings" value={fmt(privateTx.economics?.netSavingsUsd)} accent={privateTx.economics?.netSavingsUsd > 0 ? C.accent : C.danger} />
                    <KV label="Gas Limit" value={privateTx.tx?.gasLimit ?? "—"} />
                  </Grid>
                  {privateTx.economics?.reasoning && (
                    <div style={{ marginTop: 6, padding: 8, background: C.bg, borderRadius: 4, fontSize: 10, color: C.textMuted, lineHeight: 1.5 }}>
                      {privateTx.economics.reasoning}
                    </div>
                  )}
                </SectionCard>
              )}

              {/* ══ 12. OPTIMIZATION STATS ════════════════════════════════════ */}
              {exec?.optimizationStats && (
                <SectionCard title="Optimization Stats" icon="🧮">
                  <Grid cols={3}>
                    <KV label="Theoretical Optimum n*" value={fmtNum(exec.optimizationStats.theoreticalOptimum, 1)} />
                    <KV label="Actual Chunks" value={exec.optimizationStats.actualChunks} />
                    <KV label="Savings %" value={pct(exec.optimizationStats.savingsPercent)} accent={C.accent} />
                  </Grid>
                </SectionCard>
              )}

              {/* ══ 13. EXECUTION STRATEGY ════════════════════════════════════ */}
              <SectionCard title="Execution Details" icon="⚙️">
                <Grid cols={2}>
                  <KV label="Strategy Type" value={exec?.strategyType ?? "—"} />
                  <KV label="Policy" value={`${result.policy?.riskProfile} · threshold ${fmt(result.policy?.privateThresholdUsd)}`} />
                </Grid>
                <div style={{ marginTop: 6, padding: 8, background: C.bg, borderRadius: 4, fontSize: 10, color: C.textMuted, lineHeight: 1.6 }}>
                  {exec?.reasoning ?? "—"}
                </div>
              </SectionCard>

              {/* ══ 14. RAW JSON ══════════════════════════════════════════════ */}
              <details style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden", cursor: "pointer" }}>
                <summary style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer", userSelect: "none" }}>
                  Raw API Response
                </summary>
                <pre style={{ padding: "10px 16px", margin: 0, fontSize: 9, lineHeight: 1.5, color: C.textDim, overflow: "auto", maxHeight: 400, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  {JSON.stringify(result, null, 2)}
                </pre>
              </details>

            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function CostRow({ label, value, total, color }) {
  if (value == null || value === 0) return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
      <div style={{ width: 8, height: 8, borderRadius: 2, background: color, opacity: 0.3 }} />
      <span style={{ flex: 1, fontSize: 11, color: C.textDim }}>{label}</span>
      <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono'", color: C.textDim }}>$0.00</span>
    </div>
  );
  return (
    <div style={{ padding: "4px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
        <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
        <span style={{ flex: 1, fontSize: 11, color: C.text }}>{label}</span>
        <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono'", color }}>{fmt(value, 4)}</span>
      </div>
      <ProgressBar value={value} max={total} color={color} height={3} />
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 9, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
      {children}
    </label>
  );
}

function Input({ ...props }) {
  return <input {...props} spellCheck={false} style={{
    background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 4,
    padding: "8px 10px", color: C.text, fontFamily: "inherit", fontSize: 12,
    outline: "none", width: "100%", boxSizing: "border-box",
  }} />;
}

function Select({ children, ...props }) {
  return <select {...props} style={{
    background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 4,
    padding: "8px 10px", color: C.text, fontFamily: "inherit", fontSize: 12,
    outline: "none", width: "100%", boxSizing: "border-box",
  }}>{children}</select>;
}