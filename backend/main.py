from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import requests
import os
from dotenv import load_dotenv
from datetime import datetime
from collections import Counter
import json
import pathlib
import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
import warnings
warnings.filterwarnings("ignore")

load_dotenv()

LEADERBOARD_FILE = pathlib.Path("leaderboard.json")

def load_leaderboard():
    if LEADERBOARD_FILE.exists():
        try:
            return json.loads(LEADERBOARD_FILE.read_text())
        except:
            return []
    return []

def save_leaderboard(data):
    LEADERBOARD_FILE.write_text(json.dumps(data, indent=2))

leaderboard_store = load_leaderboard()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

HELIUS_API_KEY = os.getenv("HELIUS_API_KEY", "5d80f768-058a-490d-bc3f-701969baec2c")
HELIUS_URL = f"https://mainnet.helius-rpc.com/?api-key={HELIUS_API_KEY}"

def get_transactions(wallet: str):
    """
    Fetch transactions in pages until we get all of them or hit 100.
    Returns the ACTUAL number of transactions the wallet has made.
    """
    url = f"https://api.helius.xyz/v0/addresses/{wallet}/transactions"
    all_txs = []
    last_signature = None

    for _ in range(2):  # max 2 pages of 50 = 100 txs
        params = {"api-key": HELIUS_API_KEY, "limit": 50}
        if last_signature:
            params["before"] = last_signature
        try:
            r = requests.get(url, params=params, timeout=15)
            if r.status_code == 200:
                data = r.json()
                if not isinstance(data, list) or len(data) == 0:
                    break
                all_txs.extend(data)
                if len(data) < 50:
                    # Got fewer than requested = no more transactions
                    break
                last_signature = data[-1].get("signature")
            else:
                break
        except Exception as e:
            print(f"Fetch error: {e}")
            break

    print(f"Actual transactions fetched: {len(all_txs)} for {wallet[:8]}")
    return all_txs

def get_sol_balance(wallet: str) -> float:
    payload = {"jsonrpc": "2.0", "id": 1, "method": "getBalance", "params": [wallet]}
    try:
        r = requests.post(HELIUS_URL, json=payload, timeout=10)
        lamports = r.json().get("result", {}).get("value", 0)
        return round(lamports / 1e9, 4)
    except:
        return 0.0

def get_wallet_age(txs: list) -> dict:
    if not txs:
        return {"first_seen": "Unknown", "last_active": "Unknown", "age_days": 0}
    timestamps = [int(tx["timestamp"]) for tx in txs
                  if isinstance(tx, dict) and tx.get("timestamp") and int(tx.get("timestamp", 0)) > 0]
    if not timestamps:
        return {"first_seen": "Unknown", "last_active": "Unknown", "age_days": 0}
    oldest = min(timestamps)
    newest = max(timestamps)
    age_days = max(0, (newest - oldest) // 86400)
    return {
        "first_seen": datetime.fromtimestamp(oldest).strftime("%b %d, %Y"),
        "last_active": datetime.fromtimestamp(newest).strftime("%b %d, %Y"),
        "age_days": age_days
    }

def extract_features(txs: list, wallet: str) -> dict:
    n = len(txs)
    if n == 0:
        return {"n_transactions": 0}

    # Temporal features
    timestamps = sorted([int(tx["timestamp"]) for tx in txs
                         if isinstance(tx, dict) and tx.get("timestamp")
                         and int(tx.get("timestamp", 0)) > 0], reverse=True)

    inter_arrival_times = []
    if len(timestamps) > 1:
        inter_arrival_times = [abs(timestamps[i] - timestamps[i+1])
                               for i in range(len(timestamps)-1)]

    avg_iat = float(np.mean(inter_arrival_times)) if inter_arrival_times else 0
    std_iat = float(np.std(inter_arrival_times)) if inter_arrival_times else 0
    cv_iat = std_iat / avg_iat if avg_iat > 0 else 0

    if len(inter_arrival_times) > 1:
        r_val = std_iat / avg_iat if avg_iat > 0 else 0
        burstiness = (r_val - 1) / (r_val + 1) if (r_val + 1) != 0 else 0
    else:
        burstiness = 0

    # Volume features — only count meaningful transfers (> 0.01 SOL)
    amounts, outflow_amounts, inflow_amounts = [], [], []
    for tx in txs:
        if not isinstance(tx, dict): continue
        for transfer in tx.get("nativeTransfers", []):
            amt = transfer.get("amount", 0) / 1e9
            if amt > 0.01:  # ignore dust/fees
                amounts.append(amt)
                if transfer.get("fromUserAccount") == wallet:
                    outflow_amounts.append(amt)
                elif transfer.get("toUserAccount") == wallet:
                    inflow_amounts.append(amt)

    total_outflow = sum(outflow_amounts)
    total_inflow = sum(inflow_amounts)
    flow_ratio = total_outflow / total_inflow if total_inflow > 0 else float(total_outflow > 0)
    avg_tx_size = float(np.mean(amounts)) if amounts else 0
    std_tx_size = float(np.std(amounts)) if amounts else 0
    max_tx_size = float(np.max(amounts)) if amounts else 0

    # Counterparty features — use token transfers too
    all_counterparties = []
    for tx in txs:
        if not isinstance(tx, dict): continue
        for transfer in tx.get("nativeTransfers", []):
            amt = transfer.get("amount", 0) / 1e9
            if amt > 0.01:
                for key in ["fromUserAccount", "toUserAccount"]:
                    addr = transfer.get(key, "")
                    if addr and addr != wallet:
                        all_counterparties.append(addr)
        for transfer in tx.get("tokenTransfers", []):
            for key in ["fromUserAccount", "toUserAccount"]:
                addr = transfer.get(key, "")
                if addr and addr != wallet:
                    all_counterparties.append(addr)

    unique_counterparties = len(set(all_counterparties))
    total_interactions = len(all_counterparties)
    counterparty_diversity = unique_counterparties / total_interactions if total_interactions > 0 else 1.0

    cp_counts = Counter(all_counterparties)
    cp_probs = np.array(list(cp_counts.values())) / max(total_interactions, 1)
    counterparty_entropy = float(-np.sum(cp_probs * np.log2(cp_probs + 1e-10)))
    most_frequent_ratio = max(cp_counts.values()) / max(total_interactions, 1) if cp_counts else 0

    # TX type features
    tx_types = Counter(tx.get("type", "UNKNOWN") for tx in txs if isinstance(tx, dict))
    swap_ratio = tx_types.get("SWAP", 0) / max(n, 1)
    failed_count = sum(1 for tx in txs if isinstance(tx, dict) and tx.get("transactionError"))
    failed_ratio = failed_count / max(n, 1)

    # Program features
    program_ids = []
    pumpfun = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
    pumpfun_count = 0
    for tx in txs:
        if not isinstance(tx, dict): continue
        for ix in tx.get("instructions", []):
            pid = ix.get("programId", "")
            if pid:
                program_ids.append(pid)
                if pid == pumpfun:
                    pumpfun_count += 1

    program_counts = Counter(program_ids)
    top_program_ratio = max(program_counts.values()) / max(len(program_ids), 1) if program_counts else 0
    pumpfun_ratio = pumpfun_count / max(n, 1)

    return {
        "n_transactions": n,
        "avg_inter_arrival": avg_iat,
        "std_inter_arrival": std_iat,
        "cv_inter_arrival": cv_iat,
        "burstiness": burstiness,
        "total_outflow": total_outflow,
        "total_inflow": total_inflow,
        "flow_ratio": flow_ratio,
        "avg_tx_size": avg_tx_size,
        "std_tx_size": std_tx_size,
        "max_tx_size": max_tx_size,
        "unique_counterparties": unique_counterparties,
        "counterparty_diversity": counterparty_diversity,
        "counterparty_entropy": counterparty_entropy,
        "most_frequent_ratio": most_frequent_ratio,
        "swap_ratio": swap_ratio,
        "failed_ratio": failed_ratio,
        "top_program_ratio": top_program_ratio,
        "pumpfun_ratio": pumpfun_ratio,
    }

def score_bot_behavior_ml(features: dict, txs: list) -> dict:
    score = 0
    flags = []
    evidence = {}
    n = features.get("n_transactions", 0)

    if n == 0:
        return {"score": 0, "flags": ["✅ No transaction data"], "evidence": {}}
    if n < 5:
        return {"score": 0, "flags": [f"✅ Only {n} transaction(s) — not enough for bot analysis"], "evidence": {}}

    avg_iat = features["avg_inter_arrival"]
    cv_iat = features["cv_inter_arrival"]
    burstiness = features["burstiness"]
    top_prog_ratio = features["top_program_ratio"]
    pumpfun_ratio = features["pumpfun_ratio"]

    # Only flag if VERY strong signals
    if avg_iat > 0 and avg_iat < 3 and cv_iat < 0.3:
        score += 50
        flags.append(f"⚠️ Extremely regular timing (avg {avg_iat:.1f}s, CV={cv_iat:.2f}) — strong bot signal")
        evidence["timing"] = "HIGH"
    elif avg_iat > 0 and avg_iat < 10 and cv_iat < 0.5:
        score += 25
        flags.append(f"⚠️ Fast regular timing (avg {avg_iat:.1f}s) — possible automation")
        evidence["timing"] = "MEDIUM"

    if n >= 20 and burstiness < -0.5:
        score += 20
        flags.append(f"⚠️ Non-bursty pattern (score={burstiness:.2f}) — automated behavior")

    if n >= 20 and top_prog_ratio > 0.8:
        score += 20
        flags.append(f"⚠️ {top_prog_ratio*100:.0f}% calls to one program — automated pattern")

    if pumpfun_ratio > 0.4:
        score += 25
        flags.append(f"⚠️ {pumpfun_ratio*100:.0f}% Pump.fun activity — memecoin bot")

    # Isolation Forest only with 15+ transactions
    timestamps = [tx.get("timestamp", 0) for tx in txs
                  if isinstance(tx, dict) and tx.get("timestamp")]
    if len(timestamps) >= 15:
        iats = np.array([abs(timestamps[i] - timestamps[i+1])
                         for i in range(len(timestamps)-1)])
        if len(iats) >= 10:
            try:
                iso = IsolationForest(contamination=0.1, random_state=42)
                preds = iso.fit_predict(iats.reshape(-1, 1))
                anomaly_ratio = float(np.mean(preds == -1))
                evidence["isolation_forest"] = anomaly_ratio
                if anomaly_ratio < 0.03:
                    score += 15
                    flags.append("⚠️ Isolation Forest: highly regular intervals detected")
            except:
                pass

    if not flags:
        flags.append("✅ No bot behavior detected — normal activity patterns")

    return {"score": min(score, 100), "flags": flags, "evidence": evidence}

def score_wash_trading_ml(features: dict, txs: list) -> dict:
    score = 0
    flags = []
    evidence = {}
    n = features.get("n_transactions", 0)

    if n == 0:
        return {"score": 0, "flags": ["✅ No transaction data"], "evidence": {}}
    if n < 5:
        return {"score": 0, "flags": [f"✅ Only {n} transaction(s) — not enough for wash trading analysis"], "evidence": {}}

    diversity = features["counterparty_diversity"]
    entropy = features["counterparty_entropy"]
    most_freq = features["most_frequent_ratio"]
    flow_ratio = features["flow_ratio"]
    std_tx = features["std_tx_size"]
    avg_tx = features["avg_tx_size"]
    unique_cp = features["unique_counterparties"]

    # Only flag strong signals
    max_entropy = np.log2(max(unique_cp, 2))
    normalized_entropy = entropy / max_entropy if max_entropy > 0 else 1.0
    evidence["entropy"] = normalized_entropy

    # Need at least 10 txs for meaningful entropy analysis
    if n >= 10 and normalized_entropy < 0.2:
        score += 40
        flags.append(f"⚠️ Extremely low counterparty entropy ({normalized_entropy:.2f}) — circular trading")
    elif n >= 10 and normalized_entropy < 0.35:
        score += 20
        flags.append(f"⚠️ Low counterparty entropy ({normalized_entropy:.2f}) — limited partners")

    if most_freq > 0.7 and n >= 10:
        score += 30
        flags.append(f"⚠️ Single counterparty = {most_freq*100:.0f}% of interactions")

    if 0.85 < flow_ratio < 1.15 and n >= 15 and avg_tx > 0.1:
        score += 15
        flags.append(f"⚠️ Balanced flow ratio ({flow_ratio:.2f}) — funds cycling")

    if avg_tx > 0.1 and n >= 10 and std_tx / avg_tx < 0.05:
        score += 15
        flags.append("⚠️ Nearly identical transaction sizes — artificial pattern")

    if not flags:
        flags.append("✅ No wash trading signals — organic trading patterns")

    return {"score": min(score, 100), "flags": flags, "evidence": evidence}

def score_rug_pull_ml(features: dict, txs: list, wallet: str) -> dict:
    score = 0
    flags = []
    evidence = {}
    n = features.get("n_transactions", 0)

    if n == 0:
        return {"score": 0, "flags": ["✅ No transaction data"], "evidence": {}}
    if n < 2:
        return {"score": 0, "flags": [f"✅ Only {n} transaction(s) — not enough for analysis"], "evidence": {}}

    total_outflow = features["total_outflow"]
    total_inflow = features["total_inflow"]
    max_tx = features["max_tx_size"]
    avg_tx = features["avg_tx_size"]
    failed_ratio = features["failed_ratio"]

    # Significant outflow detection
    outflow_amounts = []
    for tx in txs:
        if not isinstance(tx, dict): continue
        for transfer in tx.get("nativeTransfers", []):
            if transfer.get("fromUserAccount") == wallet:
                amt = transfer.get("amount", 0) / 1e9
                if amt > 0.01:
                    outflow_amounts.append(amt)

    if len(outflow_amounts) >= 3:
        arr = np.array(outflow_amounts)
        mean_out = np.mean(arr)
        std_out = np.std(arr)
        if std_out > 0:
            z_scores = (arr - mean_out) / std_out
            extreme = int(np.sum(z_scores > 2.5))
            if extreme > 0:
                score += 30
                flags.append(f"⚠️ {extreme} statistically extreme outflow(s) detected")
                evidence["extreme_outflows"] = extreme

    # Pure outflow with meaningful amounts
    if total_outflow > 1.0 and total_inflow == 0:
        score += 25
        flags.append(f"⚠️ Pure outflow wallet — {total_outflow:.2f} SOL out, nothing in")
    elif total_outflow > 0 and total_inflow > 0 and flow_ratio > 8:
        score += 20
        flags.append(f"⚠️ Heavy outflow dominance ({features['flow_ratio']:.1f}x ratio)")

    # Spike detection
    if avg_tx > 0.1 and max_tx / avg_tx > 15:
        score += 20
        flags.append(f"⚠️ Sudden spike: max tx {max_tx:.2f} SOL = {max_tx/avg_tx:.0f}x average")

    # Failed txs
    if failed_ratio > 0.3 and n >= 10:
        score += 15
        flags.append(f"⚠️ {failed_ratio*100:.0f}% failed transactions")

    # New wallet with outflows
    timestamps = [tx.get("timestamp", 0) for tx in txs
                  if isinstance(tx, dict) and tx.get("timestamp", 0) > 0]
    if timestamps:
        age_days = (max(timestamps) - min(timestamps)) / 86400
        if age_days < 3 and total_outflow > 5:
            score += 25
            flags.append(f"⚠️ New wallet ({age_days:.1f} days) draining {total_outflow:.1f} SOL")

    if not flags:
        flags.append("✅ No rug pull signals — normal outflow patterns")

    return {"score": min(score, 100), "flags": flags, "evidence": evidence}

def classify_wallet(features: dict, rug: dict, wash: dict, bot: dict) -> dict:
    n = features.get("n_transactions", 0)

    if n == 0:
        return {"type": "Empty Wallet", "emoji": "🈳", "description": "No transactions found for this address", "confidence": 0}
    if n < 3:
        return {"type": "New / Inactive", "emoji": "🆕", "description": f"Only {n} transaction(s) found — very new or rarely used wallet", "confidence": 20}

    rug_s = rug["score"]
    wash_s = wash["score"]
    bot_s = bot["score"]
    final = round(rug_s * 0.4 + wash_s * 0.35 + bot_s * 0.25)
    swap_r = features.get("swap_ratio", 0)
    pumpfun_r = features.get("pumpfun_ratio", 0)

    # Confidence based on data quality
    confidence = min(int(20 + (n / 100) * 60 + (final / 100) * 20), 95)

    if bot_s >= 65:
        return {"type": "Bot / Automated", "emoji": "🤖", "description": "High-frequency automated trading with regular timing patterns", "confidence": confidence}
    elif wash_s >= 55:
        return {"type": "Wash Trader", "emoji": "🔄", "description": "Suspicious circular trading with low counterparty diversity", "confidence": confidence}
    elif rug_s >= 65:
        return {"type": "High Risk Actor", "emoji": "🚨", "description": "Multiple high-risk signals including extreme outflows", "confidence": confidence}
    elif pumpfun_r > 0.4:
        return {"type": "Memecoin Trader", "emoji": "🎰", "description": "Heavy Pump.fun and memecoin trading activity", "confidence": confidence}
    elif swap_r > 0.4:
        return {"type": "DeFi Trader", "emoji": "💱", "description": "Active DeFi participant with frequent token swaps", "confidence": confidence}
    elif final >= 40:
        return {"type": "Moderate Risk", "emoji": "⚠️", "description": "Some suspicious patterns detected — use caution", "confidence": confidence}
    elif n >= 30:
        return {"type": "Active User", "emoji": "👤", "description": "Regular wallet with healthy diverse activity", "confidence": confidence}
    else:
        return {"type": "Casual User", "emoji": "🟢", "description": "Low-frequency wallet with typical retail behavior", "confidence": confidence}

def get_activity_timeline(txs: list) -> list:
    if not txs: return []
    daily = {}
    for tx in txs:
        if isinstance(tx, dict) and tx.get("timestamp") and int(tx.get("timestamp", 0)) > 0:
            day = datetime.fromtimestamp(int(tx["timestamp"])).strftime("%Y-%m-%d")
            daily[day] = daily.get(day, 0) + 1
    return [{"date": d, "count": c} for d, c in sorted(daily.items())[-14:]]

def get_top_counterparties(txs: list, wallet: str) -> list:
    counts = {}
    for tx in txs:
        if not isinstance(tx, dict): continue
        # Native transfers (only meaningful amounts)
        for transfer in tx.get("nativeTransfers", []):
            amt = transfer.get("amount", 0) / 1e9
            if amt > 0.01:
                for key in ["toUserAccount", "fromUserAccount"]:
                    addr = transfer.get(key, "")
                    if addr and addr != wallet:
                        counts[addr] = counts.get(addr, 0) + 1
        # Token transfers
        for transfer in tx.get("tokenTransfers", []):
            for key in ["toUserAccount", "fromUserAccount"]:
                addr = transfer.get(key, "")
                if addr and addr != wallet:
                    counts[addr] = counts.get(addr, 0) + 1
    top = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:5]
    return [{"address": a[:8] + "..." + a[-4:], "full": a, "interactions": c} for a, c in top]

def get_tx_type_breakdown(txs: list) -> dict:
    types = Counter()
    for tx in txs:
        if not isinstance(tx, dict): continue
        tx_type = tx.get("type", "UNKNOWN")
        readable = {
            "TRANSFER": "💸 SOL Transfer",
            "SWAP": "🔄 Token Swap",
            "NFT_SALE": "🎨 NFT Sale",
            "NFT_MINT": "🖼️ NFT Mint",
            "NFT_BID": "🏷️ NFT Bid",
            "BURN": "🔥 Token Burn",
            "STAKE_SOL": "📈 SOL Staking",
            "UNSTAKE_SOL": "📉 SOL Unstaking",
            "UNKNOWN": "⚙️ Complex DeFi",
        }.get(tx_type, f"📋 {tx_type}")
        types[readable] += 1
    return dict(types.most_common(6))

def get_risk_label(score: int) -> str:
    if score >= 70: return "HIGH RISK 🔴"
    if score >= 40: return "MEDIUM RISK 🟡"
    return "LOW RISK 🟢"

def calculate_final_score(rug: dict, wash: dict, bot: dict) -> int:
    return min(round(rug["score"] * 0.4 + wash["score"] * 0.35 + bot["score"] * 0.25), 100)

@app.get("/")
def root():
    return {"message": "SolSight ML API v4.0", "status": "running"}

@app.get("/analyze/{wallet}")
def analyze_wallet(wallet: str):
    txs = get_transactions(wallet)
    actual_count = len(txs)
    balance = get_sol_balance(wallet)
    age = get_wallet_age(txs)
    features = extract_features(txs, wallet)

    rug = score_rug_pull_ml(features, txs, wallet)
    wash = score_wash_trading_ml(features, txs)
    bot = score_bot_behavior_ml(features, txs)

    final_score = calculate_final_score(rug, wash, bot)
    label = get_risk_label(final_score)
    profile = classify_wallet(features, rug, wash, bot)
    timeline = get_activity_timeline(txs)
    counterparties = get_top_counterparties(txs, wallet)
    tx_types = get_tx_type_breakdown(txs)
    all_flags = rug["flags"] + wash["flags"] + bot["flags"]

    return {
        "wallet": wallet,
        "risk_score": final_score,
        "risk_label": label,
        "sol_balance": balance,
        "transaction_count": actual_count,
        "wallet_age": age,
        "profile": profile,
        "features": {
            "burstiness": round(features.get("burstiness", 0), 3),
            "counterparty_entropy": round(features.get("counterparty_entropy", 0), 3),
            "counterparty_diversity": round(features.get("counterparty_diversity", 0), 3),
            "avg_inter_arrival_sec": round(features.get("avg_inter_arrival", 0), 1),
            "flow_ratio": round(features.get("flow_ratio", 0), 3),
            "cv_inter_arrival": round(features.get("cv_inter_arrival", 0), 3),
        },
        "breakdown": {
            "rug_pull_risk": {"score": rug["score"], "flags": rug["flags"], "evidence": rug["evidence"]},
            "wash_trading_risk": {"score": wash["score"], "flags": wash["flags"], "evidence": wash["evidence"]},
            "bot_behavior_risk": {"score": bot["score"], "flags": bot["flags"], "evidence": bot["evidence"]},
        },
        "tx_type_breakdown": tx_types,
        "activity_timeline": timeline,
        "top_counterparties": counterparties,
        "all_flags": all_flags,
        "solscan_url": f"https://solscan.io/account/{wallet}",
        "summary": f"Analyzed {actual_count} actual transactions. '{profile['type']}' wallet. Risk: {final_score}/100."
    }

@app.get("/leaderboard")
def get_leaderboard():
    return {"leaderboard": sorted(leaderboard_store, key=lambda x: x["risk_score"], reverse=True)[:20]}

@app.post("/leaderboard/add")
def add_to_leaderboard(entry: dict):
    global leaderboard_store
    for item in leaderboard_store:
        if item["wallet"] == entry.get("wallet"):
            item.update(entry)
            save_leaderboard(leaderboard_store)
            return {"status": "updated"}
    leaderboard_store.append(entry)
    save_leaderboard(leaderboard_store)
    return {"status": "added"}

@app.get("/monitor/{wallet}")
def monitor_wallet(wallet: str):
    txs = get_transactions(wallet)
    features = extract_features(txs, wallet)
    rug = score_rug_pull_ml(features, txs, wallet)
    wash = score_wash_trading_ml(features, txs)
    bot = score_bot_behavior_ml(features, txs)
    return {
        "wallet": wallet,
        "risk_score": calculate_final_score(rug, wash, bot),
        "risk_label": get_risk_label(calculate_final_score(rug, wash, bot)),
        "timestamp": datetime.now().isoformat(),
        "transaction_count": len(txs)
    }

@app.get("/network/{wallet}")
def get_network(wallet: str):
    txs = get_transactions(wallet)
    nodes = [{"id": wallet, "type": "main", "label": wallet[:8] + "..."}]
    edges = []
    seen = set()

    for tx in txs[:50]:
        if not isinstance(tx, dict): continue
        all_transfers = []

        for t in tx.get("nativeTransfers", []):
            src = t.get("fromUserAccount", "")
            dst = t.get("toUserAccount", "")
            amt = t.get("amount", 0) / 1e9
            if amt > 0.01 and src and dst:
                all_transfers.append((src, dst, round(amt, 4), "SOL"))

        for t in tx.get("tokenTransfers", []):
            src = t.get("fromUserAccount", "")
            dst = t.get("toUserAccount", "")
            amt = t.get("tokenAmount", 0)
            if src and dst:
                all_transfers.append((src, dst, round(float(amt or 0), 2), "TOKEN"))

        for src, dst, amt, type_ in all_transfers:
            if src != dst:
                for addr in [src, dst]:
                    if addr != wallet and addr not in seen:
                        seen.add(addr)
                        nodes.append({
                            "id": addr,
                            "type": "counterparty",
                            "label": addr[:6] + "..." + addr[-4:]
                        })
                edge_id = f"{src}-{dst}"
                if edge_id not in seen:
                    seen.add(edge_id)
                    edges.append({"source": src, "target": dst, "amount": amt, "type": type_})

    return {"nodes": nodes[:20], "edges": edges[:30]}

@app.get("/debug/{wallet}")
def debug_wallet(wallet: str):
    txs = get_transactions(wallet)
    if not txs:
        return {"count": 0, "sample": None}
    sample = txs[0]
    return {
        "actual_count": len(txs),
        "first_tx_type": sample.get("type", "N/A"),
        "native_transfers": sample.get("nativeTransfers", [])[:2],
        "token_transfers": sample.get("tokenTransfers", [])[:2],
        "timestamp": sample.get("timestamp", "N/A"),
    }