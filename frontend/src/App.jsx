import { useState, useEffect, useRef } from "react";
import axios from "axios";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Transaction, SystemProgram, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line } from "recharts";

const API = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
const RECEIVER = "FiE25u7kzF2uLoRtAdmJ49MGvWjMB7R8WNjiNLEJu2x3";
const PREMIUM_COST = 0.01;

const getRiskColor = (score) => {
  if (score >= 70) return "#ff4444";
  if (score >= 40) return "#ffaa00";
  return "#14F195";
};
const getRiskBg = (score) => {
  if (score >= 70) return "rgba(255,68,68,0.06)";
  if (score >= 40) return "rgba(255,170,0,0.06)";
  return "rgba(20,241,149,0.06)";
};

const GaugeMeter = ({ score }) => {
  const color = getRiskColor(score);
  const dash = (score / 100) * 251;
  return (
    <svg viewBox="0 0 200 120" style={{ width: "180px", height: "110px" }}>
      <path d="M 20 110 A 80 80 0 0 1 180 110" fill="none" stroke="#1a1a2e" strokeWidth="16" strokeLinecap="round" />
      <path d="M 20 110 A 80 80 0 0 1 180 110" fill="none" stroke={color} strokeWidth="16"
        strokeLinecap="round" strokeDasharray={`${dash} 251`} style={{ transition: "stroke-dasharray 1s ease" }} />
      <text x="100" y="92" textAnchor="middle" fill={color} fontSize="30" fontWeight="900">{score}</text>
      <text x="100" y="110" textAnchor="middle" fill="#555" fontSize="11">/ 100</text>
    </svg>
  );
};

const ScoreBar = ({ label, score, icon }) => (
  <div style={{ marginBottom: "20px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
      <span style={{ color: "#aaa", fontSize: "14px" }}>{icon} {label}</span>
      <span style={{ color: getRiskColor(score), fontWeight: "700", fontSize: "14px" }}>{score}/100</span>
    </div>
    <div style={{ background: "#1a1a2e", borderRadius: "999px", height: "10px", overflow: "hidden" }}>
      <div style={{ width: `${score}%`, height: "100%", background: `linear-gradient(90deg,${getRiskColor(score)}88,${getRiskColor(score)})`, borderRadius: "999px", transition: "width 1.2s ease" }} />
    </div>
  </div>
);

const NetworkGraph = ({ data }) => {
  const W = 700, H = 380;
  if (!data?.nodes?.length) return <div style={{ color: "#444", textAlign: "center", padding: "40px" }}>No network data available</div>;
  const main = data.nodes.find(n => n.type === "main");
  const others = data.nodes.filter(n => n.type !== "main");
  const pos = {};
  pos[main.id] = { x: W / 2, y: H / 2 };
  others.forEach((n, i) => {
    const a = (i / others.length) * 2 * Math.PI;
    pos[n.id] = { x: W / 2 + 150 * Math.cos(a), y: H / 2 + 130 * Math.sin(a) };
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }}>
      <defs>
        <radialGradient id="mg"><stop offset="0%" stopColor="#9945FF" /><stop offset="100%" stopColor="#7733CC" /></radialGradient>
      </defs>
      {data.edges.map((e, i) => {
        const s = pos[e.source], t = pos[e.target];
        if (!s || !t) return null;
        return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="#9945FF44" strokeWidth="1.5" />;
      })}
      {data.nodes.map(n => {
        const p = pos[n.id]; if (!p) return null;
        const isMain = n.type === "main";
        return (
          <g key={n.id} style={{ cursor: "pointer" }}
            onClick={() => window.open(`https://solscan.io/account/${n.id}`, "_blank")}>
            <title>Click to view {n.id} on Solscan</title>
            <circle cx={p.x} cy={p.y} r={isMain ? 26 : 16}
              fill={isMain ? "url(#mg)" : "#14F19515"}
              stroke={isMain ? "#9945FF" : "#14F195"}
              strokeWidth={isMain ? 2.5 : 1.5} />
            <text x={p.x} y={p.y + (isMain ? 40 : 30)}
              textAnchor="middle"
              fill={isMain ? "#9945FF" : "#14F195"}
              fontSize={isMain ? 11 : 9}
              style={{ userSelect: "none" }}>
              {n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

export default function App() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const [page, setPage] = useState("landing");
  const [tab, setTab] = useState("analyze");
  const [wallet, setWallet] = useState("");
  const [result, setResult] = useState(null);
  const [network, setNetwork] = useState(null);
  const [loading, setLoading] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [monitoring, setMonitoring] = useState(false);
  const [monitorData, setMonitorData] = useState([]);
  const [monitorWallet, setMonitorWallet] = useState("");
  const monitorRef = useRef(null);

  useEffect(() => { if (tab === "leaderboard") fetchLeaderboard(); }, [tab]);

  const fetchLeaderboard = async () => {
    try { const r = await axios.get(`${API}/leaderboard`); setLeaderboard(r.data.leaderboard); } catch {}
  };

  const handlePayment = async () => {
    if (!connected || !publicKey) return;
    setPaying(true);
    try {
      const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: new PublicKey(RECEIVER),
        lamports: PREMIUM_COST * LAMPORTS_PER_SOL,
      }));
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash; tx.feePayer = publicKey;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      setPaid(true);
      alert(`✅ Payment confirmed!\nTx: ${sig.slice(0, 30)}...`);
    } catch (e) { alert("Payment failed: " + e.message); }
    setPaying(false);
  };

  const analyze = async (addr) => {
    const target = addr || wallet.trim();
    if (!target) return;
    setLoading(true); setError(""); setResult(null); setNetwork(null);
    try {
      const [res, net] = await Promise.all([
        axios.get(`${API}/analyze/${target}`),
        axios.get(`${API}/network/${target}`)
      ]);
      setResult(res.data); setNetwork(net.data);
      setHistory(p => [{ wallet: target, score: res.data.risk_score }, ...p.filter(h => h.wallet !== target)].slice(0, 5));
      if (res.data.risk_score >= 40) {
        await axios.post(`${API}/leaderboard/add`, {
          wallet: target, risk_score: res.data.risk_score,
          risk_label: res.data.risk_label, profile: res.data.profile.type,
          transaction_count: res.data.transaction_count
        });
      }
    } catch { setError("Failed to analyze. Please check the wallet address and try again."); }
    setLoading(false);
  };

  const startMonitor = async () => {
    if (!monitorWallet.trim()) return;
    setMonitoring(true); setMonitorData([]);
    const scan = async () => {
      try {
        const r = await axios.get(`${API}/monitor/${monitorWallet.trim()}`);
        setMonitorData(p => [...p.slice(-19), { time: new Date().toLocaleTimeString(), score: r.data.risk_score }]);
      } catch {}
    };
    await scan();
    monitorRef.current = setInterval(scan, 30000);
  };
  const stopMonitor = () => { setMonitoring(false); clearInterval(monitorRef.current); };

  const exportHTML = (r) => {
    const c = r.risk_score >= 70 ? "#ff4444" : r.risk_score >= 40 ? "#ffaa00" : "#14F195";
    const html = `<!DOCTYPE html><html><head><title>SolSight Report</title>
<style>body{font-family:'Segoe UI',sans-serif;background:#060610;color:#e6e6e6;padding:48px;max-width:860px;margin:0 auto}
h1{background:linear-gradient(90deg,#9945FF,#14F195);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-size:38px}
.card{background:#0d1117;border:1px solid #1a1a2e;border-radius:18px;padding:28px;margin-bottom:20px}
.score{font-size:80px;font-weight:900;color:${c}}.label{font-size:22px;font-weight:700;color:${c};margin-top:6px}
.st{font-size:11px;color:#555;text-transform:uppercase;letter-spacing:2px;margin-bottom:18px}
.row{display:flex;justify-content:space-between;font-size:14px;padding:8px 0;border-bottom:1px solid #1a1a2e}
.val{color:#aaa;font-weight:600}.flag{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:8px}
.fw{background:rgba(255,170,0,0.08);color:#ffaa00;border-left:3px solid #ffaa00}
.fo{background:rgba(20,241,149,0.08);color:#14F195;border-left:3px solid #14F195}
.bar-bg{background:#1a1a2e;border-radius:999px;height:10px;margin:6px 0 16px}
.bar-fill{height:10px;border-radius:999px}
.footer{text-align:center;color:#333;font-size:12px;margin-top:40px;padding-top:20px;border-top:1px solid #111}
a{color:#9945FF}</style></head>
<body><h1>⬡ SolSight Risk Report</h1>
<p style="color:#555;margin-bottom:28px">Generated ${new Date().toLocaleString()} • ML-Powered Analysis</p>
<div class="card" style="text-align:center;border-color:${c}44">
<div class="st">Risk Score</div><div class="score">${r.risk_score}</div>
<div style="color:#555;font-size:14px">out of 100</div><div class="label">${r.risk_label}</div>
<div style="font-size:13px;color:#444;margin-top:14px;word-break:break-all">${r.wallet}</div></div>
<div class="card"><div class="st">Wallet Profile</div>
<div style="font-size:32px;margin-bottom:10px">${r.profile.emoji}</div>
<div style="font-size:20px;font-weight:700;margin-bottom:4px">${r.profile.type}</div>
<div style="font-size:13px;color:#9945FF;margin-bottom:12px">Confidence: ${r.profile.confidence}%</div>
<div style="font-size:13px;color:#555;margin-bottom:18px">${r.profile.description}</div>
<div class="row"><span>💰 SOL Balance</span><span class="val">${r.sol_balance} SOL</span></div>
<div class="row"><span>📅 First Seen</span><span class="val">${r.wallet_age.first_seen}</span></div>
<div class="row"><span>⚡ Last Active</span><span class="val">${r.wallet_age.last_active}</span></div>
<div class="row" style="border:none"><span>📊 Txns Analyzed</span><span class="val">${r.transaction_count}</span></div></div>
<div class="card"><div class="st">Risk Breakdown</div>
${[["🪤 Rug Pull",r.breakdown.rug_pull_risk.score],["🔄 Wash Trading",r.breakdown.wash_trading_risk.score],["🤖 Bot Behavior",r.breakdown.bot_behavior_risk.score]].map(([l,s])=>{const col=s>=70?"#ff4444":s>=40?"#ffaa00":"#14F195";return`<div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px"><span style="color:#aaa">${l}</span><span style="color:${col};font-weight:700">${s}/100</span></div><div class="bar-bg"><div class="bar-fill" style="width:${s}%;background:${col}"></div></div>`;}).join("")}</div>
<div class="card"><div class="st">🚩 Risk Signals</div>
${r.all_flags.map(f=>`<div class="flag ${f.startsWith("✅")?"fo":"fw"}">${f}</div>`).join("")}</div>
<div class="card"><div class="st">Transaction Types</div>
${Object.entries(r.tx_type_breakdown).map(([t,c])=>`<div class="row"><span>${t}</span><span class="val">${c} txns</span></div>`).join("")}</div>
<div class="footer">SolSight v4.0 • Solana Frontier Hackathon 2026 • <a href="${r.solscan_url}">View on Solscan →</a></div>
</body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `solsight-${r.wallet.slice(0,8)}.html`; a.click();
  };

  const S = {
    page: { minHeight: "100vh", background: "#060610", color: "#e6e6e6", fontFamily: "'Segoe UI',system-ui,sans-serif" },
    card: { background: "#0d1117", border: "1px solid #1e2035", borderRadius: "20px", padding: "28px", marginBottom: "20px" },
    sl: { fontSize: "11px", color: "#555", textTransform: "uppercase", letterSpacing: "2px", marginBottom: "18px" },
    input: { width: "100%", padding: "16px 20px", borderRadius: "14px", border: "1px solid #1e2035", background: "#080810", color: "#fff", fontSize: "15px", outline: "none", boxSizing: "border-box" },
    btn: (grad) => ({ padding: "14px 28px", borderRadius: "12px", border: "none", background: grad || "linear-gradient(90deg,#9945FF,#14F195)", color: "#000", fontSize: "14px", fontWeight: "800", cursor: "pointer" }),
  };

  // ── LANDING ───────────────────────────────────────────────────────────────
  if (page === "landing") return (
    <div style={S.page}>
      <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 60px", height: "72px", borderBottom: "1px solid #1e2035", background: "#06061099", backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ fontSize: "22px", fontWeight: "900", background: "linear-gradient(90deg,#9945FF,#14F195)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>⬡ SolSight</div>
        <div style={{ display: "flex", gap: "32px", alignItems: "center" }}>
          {["Features", "Pricing"].map(l => (
            <button key={l} onClick={() => document.getElementById(l.toLowerCase())?.scrollIntoView({ behavior: "smooth" })}
              style={{ background: "none", border: "none", color: "#666", fontSize: "14px", cursor: "pointer" }}>{l}</button>
          ))}
          <button onClick={() => { setPage("app"); setTab("leaderboard"); }} style={{ background: "none", border: "none", color: "#666", fontSize: "14px", cursor: "pointer" }}>Leaderboard</button>
          <WalletMultiButton style={{ background: "linear-gradient(90deg,#9945FF,#14F195)", border: "none", borderRadius: "10px", fontSize: "13px", height: "40px" }} />
        </div>
      </nav>

      {/* Hero */}
      <section style={{ maxWidth: "1200px", margin: "0 auto", padding: "100px 60px 80px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "80px", alignItems: "center" }}>
        <div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", background: "#9945FF18", border: "1px solid #9945FF44", borderRadius: "999px", padding: "6px 16px", fontSize: "12px", color: "#9945FF", marginBottom: "28px" }}>
            🏆 Solana Frontier Hackathon 2026
          </div>
          <h1 style={{ fontSize: "56px", fontWeight: "900", lineHeight: 1.1, margin: "0 0 24px 0", color: "#fff" }}>
            Know Who You're<br />
            <span style={{ background: "linear-gradient(90deg,#9945FF,#14F195)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Transacting With</span>
          </h1>
          <p style={{ fontSize: "18px", color: "#666", lineHeight: 1.7, marginBottom: "36px" }}>
            SolSight uses advanced machine learning to analyze any Solana wallet and give it a <strong style={{ color: "#14F195" }}>0-100 risk score</strong> — detecting scams, bots, and wash trading before they hurt you.
          </p>
          <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
            <button onClick={() => setPage("app")} style={{ ...S.btn(), padding: "16px 36px", fontSize: "16px" }}>🔍 Analyze a Wallet</button>
            <button onClick={() => document.getElementById("features")?.scrollIntoView({ behavior: "smooth" })}
              style={{ padding: "16px 36px", borderRadius: "12px", border: "1px solid #333", background: "transparent", color: "#aaa", fontSize: "16px", cursor: "pointer" }}>
              Learn More ↓
            </button>
          </div>
          <div style={{ display: "flex", gap: "40px", marginTop: "48px" }}>
            {[["3", "Risk Vectors"], ["< 5s", "Analysis Time"], ["100%", "On-Chain Data"]].map(([v, l]) => (
              <div key={l}>
                <div style={{ fontSize: "28px", fontWeight: "900", background: "linear-gradient(90deg,#9945FF,#14F195)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>{v}</div>
                <div style={{ color: "#444", fontSize: "13px", marginTop: "2px" }}>{l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Hero Demo Card */}
        <div style={{ background: "#0d1117", border: "1px solid #1e2035", borderRadius: "24px", padding: "32px", boxShadow: "0 0 80px #9945FF22" }}>
          <div style={{ fontSize: "12px", color: "#555", textTransform: "uppercase", letterSpacing: "2px", marginBottom: "20px" }}>Sample Risk Analysis</div>
          <div style={{ textAlign: "center", marginBottom: "24px" }}>
            <GaugeMeter score={73} />
            <div style={{ fontSize: "22px", fontWeight: "800", color: "#ff4444", marginTop: "8px" }}>HIGH RISK 🔴</div>
            <div style={{ fontSize: "12px", color: "#444", marginTop: "4px" }}>47 transactions analyzed</div>
          </div>
          {[["🪤 Rug Pull Risk", 80, "#ff4444"], ["🔄 Wash Trading", 60, "#ffaa00"], ["🤖 Bot Behavior", 75, "#ff4444"]].map(([l, s, c]) => (
            <div key={l} style={{ marginBottom: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "6px" }}>
                <span style={{ color: "#aaa" }}>{l}</span><span style={{ color: c, fontWeight: "700" }}>{s}/100</span>
              </div>
              <div style={{ background: "#1a1a2e", borderRadius: "999px", height: "8px" }}>
                <div style={{ width: `${s}%`, height: "8px", background: c, borderRadius: "999px" }} />
              </div>
            </div>
          ))}
          <div style={{ marginTop: "20px", padding: "12px 16px", background: "rgba(255,68,68,0.06)", borderRadius: "10px", fontSize: "12px", color: "#ff8888", border: "1px solid #ff444422", lineHeight: 1.6 }}>
            ⚠️ 4 extreme outflows · Pure outflow wallet · Bot timing pattern
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" style={{ background: "#080812", borderTop: "1px solid #1e2035", borderBottom: "1px solid #1e2035", padding: "80px 60px" }}>
        <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: "60px" }}>
            <h2 style={{ fontSize: "40px", fontWeight: "800", color: "#fff", margin: "0 0 16px 0" }}>Everything You Need to Stay Safe</h2>
            <p style={{ color: "#555", fontSize: "17px", maxWidth: "600px", margin: "0 auto" }}>Three independent risk engines analyze behavior across different threat vectors</p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "24px" }}>
            {[
              ["🪤", "Rug Pull Detection", "Identifies wallets with sudden large outflows, statistical anomalies, and new wallet draining patterns", "#ff4444"],
              ["🔄", "Wash Trading Analysis", "Detects circular trading using counterparty diversity analysis, flow ratio patterns, and transaction uniformity", "#ffaa00"],
              ["🤖", "Bot Behavior Scoring", "Flags automated trading using timing regularity, program concentration patterns, and anomaly detection", "#14F195"],
              ["🌐", "Network Graph", "Interactive clickable map of wallet connections — click any node to view on Solscan", "#9945FF"],
              ["⚡", "Live Monitor", "Real-time risk tracking that rescans every 30 seconds and charts score changes over time", "#14F195"],
              ["🏆", "Risk Leaderboard", "Community-powered database of the highest-risk wallets detected across Solana", "#ffaa00"],
            ].map(([icon, title, desc, accent]) => (
              <div key={title} style={{ background: "#0d1117", border: "1px solid #1e2035", borderRadius: "18px", padding: "28px", transition: "border-color 0.2s", cursor: "default" }}
                onMouseEnter={e => e.currentTarget.style.borderColor = accent + "55"}
                onMouseLeave={e => e.currentTarget.style.borderColor = "#1e2035"}>
                <div style={{ fontSize: "32px", marginBottom: "16px" }}>{icon}</div>
                <div style={{ fontSize: "17px", fontWeight: "700", color: "#fff", marginBottom: "10px" }}>{title}</div>
                <div style={{ fontSize: "13px", color: "#555", lineHeight: 1.7 }}>{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section style={{ maxWidth: "1200px", margin: "0 auto", padding: "80px 60px" }}>
        <h2 style={{ fontSize: "40px", fontWeight: "800", color: "#fff", textAlign: "center", marginBottom: "60px" }}>How It Works</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "32px" }}>
          {[
            ["01", "Enter Wallet", "Paste any Solana wallet address"],
            ["02", "ML Analysis", "Engine fetches transactions and runs risk models"],
            ["03", "Risk Score", "Get 0-100 score across 3 threat vectors"],
            ["04", "Take Action", "View graph, monitor live, or export report"],
          ].map(([num, title, desc]) => (
            <div key={num} style={{ textAlign: "center" }}>
              <div style={{ width: "56px", height: "56px", borderRadius: "50%", background: "linear-gradient(135deg,#9945FF,#14F195)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: "18px", fontWeight: "900", color: "#000" }}>{num}</div>
              <div style={{ fontSize: "17px", fontWeight: "700", color: "#fff", marginBottom: "10px" }}>{title}</div>
              <div style={{ fontSize: "13px", color: "#555", lineHeight: 1.7 }}>{desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" style={{ background: "#080812", borderTop: "1px solid #1e2035", borderBottom: "1px solid #1e2035", padding: "80px 60px" }}>
        <div style={{ maxWidth: "800px", margin: "0 auto" }}>
          <h2 style={{ fontSize: "40px", fontWeight: "800", color: "#fff", textAlign: "center", marginBottom: "16px" }}>Simple Pricing</h2>
          <p style={{ color: "#555", textAlign: "center", marginBottom: "48px", fontSize: "16px" }}>Connect your Phantom wallet to unlock premium features</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
            <div style={{ background: "#0d1117", border: "1px solid #1e2035", borderRadius: "20px", padding: "36px" }}>
              <div style={{ fontSize: "13px", color: "#555", marginBottom: "12px", textTransform: "uppercase", letterSpacing: "1px" }}>Free</div>
              <div style={{ fontSize: "48px", fontWeight: "900", color: "#fff", marginBottom: "8px" }}>0 <span style={{ fontSize: "20px", color: "#555" }}>SOL</span></div>
              <div style={{ color: "#555", fontSize: "14px", marginBottom: "28px" }}>Basic risk analysis</div>
              <div style={{ borderTop: "1px solid #1e2035", paddingTop: "24px" }}>
                {["Risk score 0-100", "Wallet classification", "Risk signals & flags", "Unlimited scans"].map(f => (
                  <div key={f} style={{ display: "flex", gap: "10px", padding: "8px 0", fontSize: "14px", color: "#aaa" }}>
                    <span style={{ color: "#14F195" }}>✓</span> {f}
                  </div>
                ))}
              </div>
              <button onClick={() => setPage("app")} style={{ width: "100%", marginTop: "24px", padding: "14px", borderRadius: "12px", border: "1px solid #333", background: "transparent", color: "#888", cursor: "pointer", fontSize: "14px" }}>Get Started Free</button>
            </div>
            <div style={{ background: "linear-gradient(135deg,#0d1117,#110d1f)", border: "1px solid #9945FF55", borderRadius: "20px", padding: "36px", position: "relative" }}>
              <div style={{ position: "absolute", top: "16px", right: "16px", background: "linear-gradient(90deg,#9945FF,#14F195)", borderRadius: "999px", padding: "4px 12px", fontSize: "11px", color: "#000", fontWeight: "700" }}>POPULAR</div>
              <div style={{ fontSize: "13px", color: "#9945FF", marginBottom: "12px", textTransform: "uppercase", letterSpacing: "1px" }}>Premium</div>
              <div style={{ fontSize: "48px", fontWeight: "900", color: "#fff", marginBottom: "8px" }}>0.01 <span style={{ fontSize: "20px", color: "#9945FF" }}>SOL</span></div>
              <div style={{ color: "#555", fontSize: "14px", marginBottom: "28px" }}>Full intelligence report</div>
              <div style={{ borderTop: "1px solid #9945FF33", paddingTop: "24px" }}>
                {["Everything in Free", "Network graph (clickable)", "14-day activity timeline", "Counterparty analysis", "TX type breakdown", "Downloadable HTML report"].map(f => (
                  <div key={f} style={{ display: "flex", gap: "10px", padding: "8px 0", fontSize: "14px", color: "#aaa" }}>
                    <span style={{ color: "#9945FF" }}>⭐</span> {f}
                  </div>
                ))}
              </div>
              <button onClick={() => setPage("app")} style={{ ...S.btn(), width: "100%", marginTop: "24px", padding: "14px", fontSize: "14px" }}>Get Premium Report</button>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section style={{ textAlign: "center", padding: "100px 60px" }}>
        <h2 style={{ fontSize: "48px", fontWeight: "900", marginBottom: "20px", color: "#fff" }}>
          Ready to Stay Safe<br />
          <span style={{ background: "linear-gradient(90deg,#9945FF,#14F195)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>on Solana?</span>
        </h2>
        <p style={{ color: "#555", fontSize: "18px", marginBottom: "40px" }}>Analyze any wallet in seconds. No registration required.</p>
        <button onClick={() => setPage("app")} style={{ ...S.btn(), padding: "20px 56px", fontSize: "18px", boxShadow: "0 0 40px #9945FF44" }}>Launch App →</button>
      </section>

      <footer style={{ borderTop: "1px solid #1e2035", padding: "32px 60px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: "16px", fontWeight: "900", background: "linear-gradient(90deg,#9945FF,#14F195)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>⬡ SolSight</div>
        <div style={{ color: "#333", fontSize: "13px" }}>SolSight v4.0 • Solana Frontier Hackathon 2026</div>
        <div style={{ color: "#333", fontSize: "13px" }}>Powered by Helius API</div>
      </footer>
    </div>
  );

  // ── APP PAGE ──────────────────────────────────────────────────────────────
  return (
    <div style={{ ...S.page, padding: "0" }}>
      <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 40px", height: "64px", borderBottom: "1px solid #1e2035", background: "#06061099", backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 100 }}>
        <button onClick={() => setPage("landing")} style={{ background: "none", border: "none", fontSize: "18px", fontWeight: "900", cursor: "pointer", background: "linear-gradient(90deg,#9945FF,#14F195)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          ⬡ SolSight
        </button>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          {connected && !paid && (
            <button onClick={handlePayment} disabled={paying} style={{ padding: "8px 16px", borderRadius: "10px", border: "none", background: paying ? "#1a1a2e" : "linear-gradient(90deg,#9945FF,#14F195)", color: paying ? "#555" : "#000", fontSize: "13px", fontWeight: "700", cursor: "pointer" }}>
              {paying ? "⏳ Processing..." : "⭐ Unlock Premium (0.01 SOL)"}
            </button>
          )}
          {paid && <span style={{ color: "#14F195", fontSize: "13px", fontWeight: "700", background: "rgba(20,241,149,0.1)", padding: "6px 14px", borderRadius: "999px", border: "1px solid #14F19533" }}>⭐ Premium Active</span>}
          <WalletMultiButton style={{ background: "linear-gradient(90deg,#9945FF,#14F195)", border: "none", borderRadius: "10px", fontSize: "13px", height: "40px" }} />
        </div>
      </nav>

      <div style={{ maxWidth: "1100px", margin: "0 auto", padding: "40px" }}>

        {/* Tabs */}
        <div style={{ display: "flex", gap: "8px", background: "#0d1117", padding: "6px", borderRadius: "16px", border: "1px solid #1e2035", marginBottom: "32px" }}>
          {[{ id: "analyze", label: "🔍 Analyze Wallet" }, { id: "monitor", label: "⚡ Live Monitor" }, { id: "leaderboard", label: "🏆 Leaderboard" }].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ flex: 1, padding: "12px", borderRadius: "12px", border: "none", background: tab === t.id ? "linear-gradient(90deg,#9945FF22,#14F19522)" : "transparent", color: tab === t.id ? "#fff" : "#555", fontWeight: tab === t.id ? "700" : "400", fontSize: "14px", cursor: "pointer", borderBottom: tab === t.id ? "2px solid #9945FF" : "2px solid transparent", transition: "all 0.2s" }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ANALYZE TAB */}
        {tab === "analyze" && (
          <>
            <div style={{ background: "#0d1117", border: "1px solid #1e2035", borderRadius: "20px", padding: "28px", marginBottom: "24px" }}>
              <div style={{ fontSize: "13px", color: "#555", marginBottom: "16px", textTransform: "uppercase", letterSpacing: "2px" }}>Wallet Analysis</div>
              <div style={{ display: "flex", gap: "12px" }}>
                <input value={wallet} onChange={e => setWallet(e.target.value)} onKeyDown={e => e.key === "Enter" && analyze()}
                  placeholder="Enter any Solana wallet address..."
                  style={{ ...S.input }} />
                <button onClick={() => analyze()} disabled={loading} style={{ ...S.btn(loading ? "#1a1a2e" : null), color: loading ? "#555" : "#000", minWidth: "150px", cursor: loading ? "not-allowed" : "pointer" }}>
                  {loading ? "⏳ Scanning..." : "Analyze →"}
                </button>
              </div>
              {history.length > 0 && (
                <div style={{ marginTop: "14px", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ color: "#333", fontSize: "12px" }}>Recent:</span>
                  {history.map(h => (
                    <button key={h.wallet} onClick={() => { setWallet(h.wallet); analyze(h.wallet); }} style={{ background: "#111827", border: "1px solid #1e2035", borderRadius: "8px", padding: "4px 12px", color: getRiskColor(h.score), fontSize: "12px", cursor: "pointer" }}>
                      {h.wallet.slice(0, 6)}...{h.wallet.slice(-4)} ({h.score})
                    </button>
                  ))}
                </div>
              )}
            </div>

            {false && (
              <div style={{ padding: "16px 24px", background: "rgba(153,69,255,0.06)", border: "1px solid #9945FF33", borderRadius: "14px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
                <div>
                  <div style={{ fontSize: "14px", color: "#9945FF", fontWeight: "600", marginBottom: "4px" }}>🔒 Connect Phantom Wallet for Premium</div>
                  <div style={{ fontSize: "12px", color: "#555" }}>Unlock Network Graph, Timeline, Counterparty Analysis and HTML Export for 0.01 SOL</div>
                </div>
                <WalletMultiButton style={{ background: "linear-gradient(90deg,#9945FF,#14F195)", border: "none", borderRadius: "10px", fontSize: "13px", height: "40px", flexShrink: 0 }} />
              </div>
            )}

            {error && <div style={{ padding: "16px 20px", background: "rgba(255,68,68,0.06)", border: "1px solid #ff444444", borderRadius: "12px", color: "#ff6666", marginBottom: "24px" }}>{error}</div>}

            {loading && (
              <div style={{ textAlign: "center", padding: "80px 0", background: "#0d1117", border: "1px solid #1e2035", borderRadius: "20px" }}>
                <div style={{ fontSize: "40px", marginBottom: "16px" }}>🔍</div>
                <div style={{ color: "#9945FF", fontSize: "20px", fontWeight: "700", marginBottom: "8px" }}>Running ML Analysis...</div>
                <div style={{ color: "#444", fontSize: "14px" }}>Fetching transactions · Scoring behavior · Building network</div>
              </div>
            )}

            {result && !loading && (
              <>
                {/* Score + Profile */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", marginBottom: "20px" }}>
                  <div style={{ ...S.card, background: getRiskBg(result.risk_score), border: `1px solid ${getRiskColor(result.risk_score)}44`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "36px", marginBottom: 0 }}>
                    <div style={S.sl}>Risk Score</div>
                    <GaugeMeter score={result.risk_score} />
                    <div style={{ fontSize: "22px", fontWeight: "800", color: getRiskColor(result.risk_score), marginTop: "12px" }}>{result.risk_label}</div>
                    <div style={{ fontSize: "12px", color: "#555", marginTop: "6px" }}>
                      {result.transaction_count} transaction{result.transaction_count !== 1 ? "s" : ""} analyzed
                    </div>
                    <div style={{ fontSize: "10px", color: "#2a2a3e", marginTop: "4px", wordBreak: "break-all", textAlign: "center", maxWidth: "200px" }}>{result.wallet}</div>
                  </div>

                  <div style={{ ...S.card, marginBottom: 0 }}>
                    <div style={S.sl}>Wallet Profile</div>
                    <div style={{ fontSize: "40px", marginBottom: "8px" }}>{result.profile.emoji}</div>
                    <div style={{ fontSize: "20px", fontWeight: "700", color: "#fff", marginBottom: "4px" }}>{result.profile.type}</div>
                    {result.profile.confidence > 0 && (
                      <div style={{ display: "inline-block", background: "#9945FF18", border: "1px solid #9945FF33", borderRadius: "999px", padding: "3px 10px", fontSize: "11px", color: "#9945FF", marginBottom: "12px" }}>
                        Confidence: {result.profile.confidence}%
                      </div>
                    )}
                    <div style={{ fontSize: "13px", color: "#555", marginBottom: "20px", lineHeight: 1.6 }}>{result.profile.description}</div>
                    <div style={{ borderTop: "1px solid #1e2035", paddingTop: "16px" }}>
                      {[
                        ["💰", "SOL Balance", `${result.sol_balance} SOL`],
                        ["📅", "First Seen", result.wallet_age.first_seen],
                        ["⚡", "Last Active", result.wallet_age.last_active],
                        ["📊", "Txns Analyzed", `${result.transaction_count} transaction${result.transaction_count !== 1 ? "s" : ""}`],
                        ["📅", "Wallet Age", result.wallet_age.age_days > 0 ? `${result.wallet_age.age_days} days` : "< 1 day"],
                      ].map(([icon, label, val]) => (
                        <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", padding: "6px 0", borderBottom: "1px solid #111827" }}>
                          <span style={{ color: "#555" }}>{icon} {label}</span>
                          <span style={{ color: "#aaa", fontWeight: "600" }}>{val}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Risk Breakdown */}
                <div style={S.card}>
                  <div style={S.sl}>Risk Breakdown</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px", marginBottom: "24px" }}>
                    {[
                      ["🪤", "Rug Pull", result.breakdown.rug_pull_risk.score],
                      ["🔄", "Wash Trading", result.breakdown.wash_trading_risk.score],
                      ["🤖", "Bot Behavior", result.breakdown.bot_behavior_risk.score]
                    ].map(([icon, label, score]) => (
                      <div key={label} style={{ background: "#080810", borderRadius: "14px", padding: "20px", textAlign: "center", border: `1px solid ${getRiskColor(score)}33` }}>
                        <div style={{ fontSize: "24px", marginBottom: "8px" }}>{icon}</div>
                        <div style={{ fontSize: "32px", fontWeight: "900", color: getRiskColor(score) }}>{score}</div>
                        <div style={{ fontSize: "12px", color: "#555", marginTop: "4px" }}>{label}</div>
                      </div>
                    ))}
                  </div>
                  <ScoreBar label="Rug Pull Risk" score={result.breakdown.rug_pull_risk.score} icon="🪤" />
                  <ScoreBar label="Wash Trading Risk" score={result.breakdown.wash_trading_risk.score} icon="🔄" />
                  <ScoreBar label="Bot Behavior Risk" score={result.breakdown.bot_behavior_risk.score} icon="🤖" />
                </div>

                {/* Risk Signals */}
                <div style={S.card}>
                  <div style={S.sl}>🚩 Risk Signals</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                    {result.all_flags.map((flag, i) => (
                      <div key={i} style={{ padding: "12px 16px", borderRadius: "10px", fontSize: "13px", lineHeight: 1.5, background: flag.startsWith("✅") ? "rgba(20,241,149,0.05)" : "rgba(255,170,0,0.05)", color: flag.startsWith("✅") ? "#14F195" : "#ffaa00", borderLeft: `3px solid ${flag.startsWith("✅") ? "#14F195" : "#ffaa00"}`, border: `1px solid ${flag.startsWith("✅") ? "#14F19522" : "#ffaa0022"}` }}>
                        {flag}
                      </div>
                    ))}
                  </div>
                </div>

                {/* PREMIUM GATE */}
                {!connected ? (
                  <div style={{ ...S.card, textAlign: "center", border: "1px solid #9945FF33", background: "linear-gradient(135deg,rgba(153,69,255,0.05),rgba(20,241,149,0.02))", padding: "48px" }}>
                    <div style={{ fontSize: "48px", marginBottom: "16px" }}>🔒</div>
                    <div style={{ fontSize: "22px", fontWeight: "700", color: "#fff", marginBottom: "12px" }}>Unlock Premium Intelligence</div>
                    <div style={{ fontSize: "14px", color: "#555", marginBottom: "28px", maxWidth: "500px", margin: "0 auto 28px", lineHeight: 1.7 }}>
                      Connect your Phantom wallet and pay 0.01 SOL to unlock Network Graph, Activity Timeline, Counterparty Analysis, and HTML Report.
                    </div>
                    <WalletMultiButton style={{ background: "linear-gradient(90deg,#9945FF,#14F195)", border: "none", borderRadius: "12px", fontSize: "15px", height: "48px", padding: "0 32px" }} />
                  </div>
                ) : !paid ? (
                  <div style={{ ...S.card, textAlign: "center", border: "1px solid #9945FF44", background: "linear-gradient(135deg,rgba(153,69,255,0.06),rgba(20,241,149,0.02))", padding: "48px" }}>
                    <div style={{ fontSize: "48px", marginBottom: "16px" }}>⭐</div>
                    <div style={{ fontSize: "22px", fontWeight: "700", color: "#fff", marginBottom: "12px" }}>Get Full Premium Report</div>
                    <div style={{ fontSize: "14px", color: "#555", marginBottom: "28px", lineHeight: 1.7 }}>
                      Pay 0.01 SOL to unlock Network Graph, Activity Timeline, Counterparty Analysis and HTML Export.
                    </div>
                    <button onClick={handlePayment} disabled={paying} style={{ ...S.btn(), padding: "16px 48px", fontSize: "16px", boxShadow: "0 0 30px #9945FF44" }}>
                      {paying ? "⏳ Confirming on Solana..." : "⭐ Pay 0.01 SOL → Unlock"}
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Network Graph */}
                    {network && (
                      <div style={S.card}>
                        <div style={S.sl}>🌐 Wallet Network Graph</div>
                        <NetworkGraph data={network} />
                        <div style={{ display: "flex", gap: "24px", marginTop: "16px", padding: "14px 20px", background: "#080810", borderRadius: "12px", border: "1px solid #1e2035", flexWrap: "wrap" }}>
                          <div style={{ fontSize: "12px", color: "#555" }}><span style={{ color: "#9945FF", fontWeight: "700" }}>●</span> Analyzed wallet</div>
                          <div style={{ fontSize: "12px", color: "#555" }}><span style={{ color: "#14F195", fontWeight: "700" }}>●</span> Counterparties</div>
                          <div style={{ fontSize: "12px", color: "#555" }}>Lines = SOL transfers</div>
                          <div style={{ fontSize: "12px", color: "#9945FF", marginLeft: "auto" }}>💡 Click any node → view on Solscan</div>
                          <div style={{ fontSize: "12px", color: "#444", width: "100%" }}>{network?.nodes?.length - 1} counterparties · {network?.edges?.length} transfers mapped</div>
                        </div>
                      </div>
                    )}

                    {/* Timeline */}
                    {result.activity_timeline?.length > 0 && (
                      <div style={S.card}>
                        <div style={S.sl}>📈 14-Day Activity Timeline</div>
                        <div style={{ fontSize: "13px", color: "#444", marginBottom: "16px" }}>
                          Each bar = number of transactions on that day. Tall single bar = burst activity (suspicious signal).
                        </div>
                        <ResponsiveContainer width="100%" height={180}>
                          <BarChart data={result.activity_timeline}>
                            <XAxis dataKey="date" tick={{ fill: "#444", fontSize: 10 }} tickFormatter={d => d.slice(5)} />
                            <YAxis tick={{ fill: "#444", fontSize: 10 }} />
                            <Tooltip contentStyle={{ background: "#111827", border: "1px solid #222", borderRadius: "10px", fontSize: "13px" }}
                              formatter={(value) => [`${value} transactions`, "Count"]} />
                            <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                              {result.activity_timeline.map((entry, i) => (
                                <Cell key={i} fill={entry.count > 50 ? "#ff444488" : "#9945FF88"} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                        <div style={{ fontSize: "11px", color: "#333", marginTop: "8px" }}>
                          🔴 Red bars = high activity days (50+ transactions) · 🟣 Purple = normal activity
                        </div>
                      </div>
                    )}

                    {/* Counterparties + TX Types */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", marginBottom: "20px" }}>
                      <div style={{ ...S.card, marginBottom: 0 }}>
                        <div style={S.sl}>🔗 Top Interactions</div>
                        {result.top_counterparties?.length > 0 ? result.top_counterparties.map((cp, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: i < result.top_counterparties.length - 1 ? "1px solid #1e2035" : "none" }}>
                            <a href={`https://solscan.io/account/${cp.full}`} target="_blank" rel="noreferrer"
                              style={{ color: "#9945FF", fontSize: "13px", textDecoration: "none", fontFamily: "monospace" }}>
                              {cp.address}
                            </a>
                            <span style={{ background: "#1a1a2e", padding: "3px 10px", borderRadius: "999px", fontSize: "12px", color: "#aaa" }}>{cp.interactions}x</span>
                          </div>
                        )) : <div style={{ color: "#444", fontSize: "13px" }}>No counterparty data found</div>}
                      </div>
                      <div style={{ ...S.card, marginBottom: 0 }}>
                        <div style={S.sl}>📊 TX Type Breakdown</div>
                        <div style={{ fontSize: "12px", color: "#444", marginBottom: "14px" }}>
                          What kinds of transactions this wallet performs
                        </div>
                        {result.tx_type_breakdown && Object.entries(result.tx_type_breakdown).map(([type, count], i, arr) => (
                          <div key={type} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: i < arr.length - 1 ? "1px solid #1e2035" : "none" }}>
                            <span style={{ fontSize: "13px", color: "#aaa" }}>
                              {type === "TRANSFER" ? "💸 Transfer" :
                               type === "SWAP" ? "🔄 Swap" :
                               type === "NFT_SALE" ? "🎨 NFT Sale" :
                               type === "NFT_MINT" ? "🖼️ NFT Mint" :
                               type === "UNKNOWN" ? "❓ Unknown" : `📋 ${type}`}
                            </span>
                            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                              <div style={{ width: "80px", background: "#1a1a2e", borderRadius: "999px", height: "6px" }}>
                                <div style={{ width: `${(count / result.transaction_count) * 100}%`, height: "6px", background: "#9945FF88", borderRadius: "999px" }} />
                              </div>
                              <span style={{ fontSize: "13px", color: "#666", width: "30px", textAlign: "right" }}>{count}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "40px" }}>
                      <a href={result.solscan_url} target="_blank" rel="noreferrer"
                        style={{ padding: "16px", borderRadius: "14px", textAlign: "center", background: "#0d1117", border: "1px solid #1e2035", color: "#9945FF", textDecoration: "none", fontSize: "14px", fontWeight: "600", display: "block" }}>
                        🔗 View on Solscan
                      </a>
                      <button onClick={() => { setMonitorWallet(result.wallet); setTab("monitor"); }}
                        style={{ padding: "16px", borderRadius: "14px", background: "#0d1117", border: "1px solid #1e2035", color: "#ffaa00", fontSize: "14px", fontWeight: "600", cursor: "pointer" }}>
                        ⚡ Monitor This Wallet
                      </button>
                      <button onClick={() => exportHTML(result)}
                        style={{ padding: "16px", borderRadius: "14px", background: "#0d1117", border: "1px solid #1e2035", color: "#14F195", fontSize: "14px", fontWeight: "600", cursor: "pointer" }}>
                        📤 Export HTML Report
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {/* MONITOR TAB */}
        {tab === "monitor" && (
          <div style={S.card}>
            <div style={S.sl}>⚡ Real-Time Wallet Monitor</div>
            <p style={{ color: "#555", fontSize: "14px", marginBottom: "20px", lineHeight: 1.7 }}>
              Track any wallet's risk score live. Auto-rescans every 30 seconds and charts changes over time.
            </p>
            <div style={{ display: "flex", gap: "12px", marginBottom: "20px" }}>
              <input value={monitorWallet} onChange={e => setMonitorWallet(e.target.value)}
                placeholder="Enter Solana wallet address to monitor..."
                style={{ ...S.input }} />
              {!monitoring
                ? <button onClick={startMonitor} style={{ ...S.btn(), minWidth: "120px" }}>▶ Start</button>
                : <button onClick={stopMonitor} style={{ padding: "14px 24px", borderRadius: "12px", border: "none", background: "#ff444422", color: "#ff4444", fontWeight: "800", fontSize: "14px", cursor: "pointer", minWidth: "120px" }}>⏹ Stop</button>}
            </div>
            {monitoring && (
              <div style={{ padding: "12px 18px", background: "rgba(20,241,149,0.06)", borderRadius: "12px", fontSize: "13px", color: "#14F195", marginBottom: "20px", border: "1px solid #14F19522" }}>
                🟢 Monitoring active — rescanning every 30 seconds
              </div>
            )}
            {monitorData.length > 0 && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px", marginBottom: "24px" }}>
                  {[
                    ["CURRENT RISK", monitorData[monitorData.length-1].score, getRiskColor(monitorData[monitorData.length-1].score)],
                    ["TOTAL SCANS", monitorData.length, "#9945FF"],
                    ["LAST SCAN", monitorData[monitorData.length-1].time, "#aaa"],
                  ].map(([label, val, color]) => (
                    <div key={label} style={{ background: "#080810", borderRadius: "14px", padding: "20px", textAlign: "center", border: "1px solid #1e2035" }}>
                      <div style={{ fontSize: "11px", color: "#555", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "1px" }}>{label}</div>
                      <div style={{ fontSize: label === "LAST SCAN" ? "16px" : "36px", fontWeight: "900", color, marginTop: label === "LAST SCAN" ? "8px" : 0 }}>{val}</div>
                    </div>
                  ))}
                </div>
                <div style={{ ...S.sl, marginBottom: "12px" }}>Risk Score Over Time</div>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={monitorData}>
                    <XAxis dataKey="time" tick={{ fill: "#444", fontSize: 10 }} />
                    <YAxis domain={[0, 100]} tick={{ fill: "#444", fontSize: 10 }} />
                    <Tooltip contentStyle={{ background: "#111827", border: "1px solid #222", borderRadius: "10px", fontSize: "13px" }} />
                    <Line type="monotone" dataKey="score" stroke="#9945FF" strokeWidth={2.5} dot={{ fill: "#9945FF", r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </>
            )}
          </div>
        )}

        {/* LEADERBOARD TAB */}
        {tab === "leaderboard" && (
          <div style={S.card}>
            <div style={S.sl}>🏆 Riskiest Wallets Detected</div>
            <p style={{ color: "#555", fontSize: "14px", marginBottom: "24px", lineHeight: 1.7 }}>
              Community-powered database of wallets flagged with medium or high risk by SolSight.
            </p>
            {leaderboard.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: "#333" }}>
                <div style={{ fontSize: "40px", marginBottom: "16px" }}>🔍</div>
                <div style={{ fontSize: "16px", marginBottom: "8px" }}>No high-risk wallets detected yet.</div>
                <div style={{ fontSize: "13px", color: "#222" }}>Analyze wallets to populate this leaderboard!</div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {leaderboard.map((entry, i) => (
                  <div key={entry.wallet} style={{ display: "flex", alignItems: "center", gap: "16px", padding: "16px 20px", borderRadius: "14px", background: i === 0 ? "rgba(255,68,68,0.05)" : "#080810", border: `1px solid ${i === 0 ? "#ff444433" : "#1e2035"}` }}>
                    <div style={{ fontSize: "20px", width: "32px", textAlign: "center", flexShrink: 0 }}>
                      {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i+1}`}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "14px", color: "#9945FF", fontFamily: "monospace", marginBottom: "4px" }}>
                        {entry.wallet.slice(0, 16)}...{entry.wallet.slice(-8)}
                      </div>
                      <div style={{ fontSize: "12px", color: "#444" }}>
                        {entry.profile} · {entry.transaction_count} transactions
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: "28px", fontWeight: "900", color: getRiskColor(entry.risk_score) }}>{entry.risk_score}</div>
                      <div style={{ fontSize: "11px", color: getRiskColor(entry.risk_score) }}>{entry.risk_label?.split(" ")[0]}</div>
                    </div>
                    <button onClick={() => { setWallet(entry.wallet); setTab("analyze"); analyze(entry.wallet); }}
                      style={{ padding: "8px 16px", borderRadius: "8px", border: "none", background: "#1a1a2e", color: "#aaa", fontSize: "12px", cursor: "pointer", flexShrink: 0 }}>
                      Re-analyze →
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <footer style={{ borderTop: "1px solid #1e2035", padding: "24px 40px", display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "20px" }}>
        <div style={{ fontSize: "14px", fontWeight: "900", background: "linear-gradient(90deg,#9945FF,#14F195)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>⬡ SolSight</div>
        <div style={{ color: "#333", fontSize: "12px" }}>SolSight v4.0 • Solana Frontier Hackathon 2026</div>
        <div style={{ color: "#333", fontSize: "12px" }}>Powered by Helius API</div>
      </footer>
    </div>
  );
}