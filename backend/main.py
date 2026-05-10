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

# ── DATA FETCHING ─────────────────────────────────────────────────────────────

def get_transactions(wallet: str):
    """Fetch transactions - returns actual count, not always 100"""
    url = f"https://api.helius.xyz/v0/addresses/{wallet}/transactions"
    params = {"api-key": HELIUS_API_KEY, "limit": 100}
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, list):
                print(f"Fetched {len(data)} actual transactions for {wallet[:8]}")
                return data
        return []
    except Exception as e:
        print(f"Fetch error: {e}")
        return []

def get_sol_balance(wallet: str) -> float:
    payload = {"jsonrpc": "2.0", "id": 1, "method": "getBalance", "params": [wallet]}
    try:
        r = requests.post(HELIUS_URL, json=payload, timeout=10)
        lamports = r.json().get("result", {}).get("value", 0)
        return round(lamports / 1e9, 4)
    except:
        return 0.0

def get_wallet_age(txs: list) -> dict:
    """Get REAL first seen and last active from actual transaction timestamps"""
    if not txs:
        return {"first_seen": "Unknown", "last_active": "Unknown", "age_days": 0}

    # Filter only valid timestamps
    timestamps = []
    for tx in txs:
        if isinstance(tx, dict):
            ts = tx.get("timestamp")
            if ts and isinstance(ts, (int, float)) and ts > 0:
                timestamps.append(int(ts))

    if not timestamps:
        return {"first_seen": "Unknown", "last_active": "Unknown", "age_days": 0}

    oldest = min(timestamps)
    newest = max(timestamps)
    age_days = max(0, (newest - oldest) // 86400)

    print(f"Wallet timestamps: oldest={oldest} ({datetime.fromtimestamp(oldest)}), newest={newest} ({datetime.fromtimestamp(newest)})")

    return {
        "first_seen": datetime.fromtimestamp(oldest).strftime("%b %d, %Y"),
        "last_active": datetime.fromtimestamp(newest).strftime("%b %d, %Y"),
        "age_days": age_days
    }

# ── FEATURE EXTRACTION ────────────────────────────────────────────────────────

def extract_features(txs: list, wallet: str) -> dict:
    """Extract numerical features from raw transactions"""
    n = len(txs)  # ACTUAL count, not 100

    if n == 0:
        return {"n_transactions": 0}

    # 1. Temporal features
    timestamps = []
    for tx in txs:
        if isinstance(tx, dict):
            ts = tx.get("timestamp")
            if ts and isinstance(ts, (int, float)) and ts > 0:
                timestamps.append(int(ts))

    timestamps.sort(reverse=True)

    inter_arrival_times = []
    if len(timestamps) > 1:
        inter_arrival_times = [timestamps[i] - timestamps[i+1]
                               for i in range(len(timestamps)-1)
                               if timestamps[i] - timestamps[i+1] >= 0]

    avg_iat = float(np.mean(inter_arrival_times)) if inter_arrival_times else 0
    std_iat = float(np.std(inter_arrival_times)) if inter_arrival_times else 0
    min_iat = float(np.min(inter_arrival_times)) if inter_arrival_times else 0
    cv_iat = std_iat / avg_iat if avg_iat > 0 else 0

    # 2. Volume features
    amounts, outflow_amounts, inflow_amounts = [], [], []
    for tx in txs:
        if not isinstance(tx, dict): continue
        for transfer in tx.get("nativeTransfers", []):
            amt = transfer.get("amount", 0) / 1e9
            if amt > 0:
                amounts.append(amt)
                if transfer.get("fromUserAccount") == wallet:
                    outflow_amounts.append(amt)
                elif transfer.get("toUserAccount") == wallet:
                    inflow_amounts.append(amt)

    total_volume = sum(amounts)
    total_outflow = sum(outflow_amounts)
    total_inflow = sum(inflow_amounts)
    flow_ratio = total_outflow / total_inflow if total_inflow > 0 else float(total_outflow > 0)
    avg_tx_size = float(np.mean(amounts)) if amounts else 0
    std_tx_size = float(np.std(amounts)) if amounts else 0
    max_tx_size = float(np.max(amounts)) if amounts else 0

    # 3. Counterparty features
    all_counterparties = []
    for tx in txs:
        if not isinstance(tx, dict): continue
        for transfer in tx.get("nativeTransfers", []):
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

    # 4. Transaction type features
    tx_types = Counter(tx.get("type", "UNKNOWN") for tx in txs if isinstance(tx, dict))
    swap_ratio = tx_types.get("SWAP", 0) / max(n, 1)
    transfer_ratio = tx_types.get("TRANSFER", 0) / max(n, 1)
    failed_count = sum(1 for tx in txs if isinstance(tx, dict) and tx.get("transactionError"))
    failed_ratio = failed_count / max(n, 1)

    # 5. Program features
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
    unique_programs = len(program_counts)
    top_program_ratio = max(program_counts.values()) / max(len(program_ids), 1) if program_counts else 0
    pumpfun_ratio = pumpfun_count / max(n, 1)

    # 6. Burstiness
    if len(inter_arrival_times) > 1:
        r_val = std_iat / avg_iat if avg_iat > 0 else 0
        burstiness = (r_val - 1) / (r_val + 1) if (r_val + 1) != 0 else 0
    else:
        burstiness = 0

    return {
        "n_transactions": n,
        "avg_inter_arrival": avg_iat,
        "std_inter_arrival": std_iat,
        "min_inter_arrival": min_iat,
        "cv_inter_arrival": cv_iat,
        "burstiness": burstiness,
        "total_volume": total_volume,
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
        "transfer_ratio": transfer_ratio,
        "failed_ratio": failed_ratio,
        "unique_programs": unique_programs,
        "top_program_ratio": top_program_ratio,
        "pumpfun_ratio": pumpfun_ratio,
    }

# ── ML SCORING ENGINES ────────────────────────────────────────────────────────

def score_bot_behavior_ml(features: dict, txs: list) -> dict:
    score = 0
    flags = []
    evidence = {}
    n = features.get("n_transactions", 0)

    if n == 0:
        return {"score": 0, "flags": ["✅ No transaction data to analyze"], "evidence": {}}

    # Need minimum transactions for meaningful analysis
    if n < 3:
        return {"score": 0, "flags": [f"✅ Only {n} transaction(s) — insufficient for bot analysis"], "evidence": {}}

    avg_iat = features["avg_inter_arrival"]
    cv_iat = features["cv_inter_arrival"]
    burstiness = features["burstiness"]
    top_prog_ratio = features["top_program_ratio"]
    pumpfun_ratio = features["pumpfun_ratio"]

    # 1. Timing analysis
    if avg_iat > 0:
        if avg_iat < 5 and cv_iat < 0.5:
            score += 45
            flags.append(f"⚠️ Highly regular timing (avg {avg_iat:.1f}s, CV={cv_iat:.2f}) — strong bot signal")
            evidence["timing_regularity"] = "HIGH"
        elif avg_iat < 30:
            score += 25
            flags.append(f"⚠️ Fast transaction intervals (avg {avg_iat:.1f}s) — possible automation")
            evidence["timing_regularity"] = "MEDIUM"

    # 2. Burstiness (only meaningful with 5+ txs)
    if n >= 5 and burstiness < -0.3:
        score += 20
        flags.append(f"⚠️ Non-bursty pattern (burstiness={burstiness:.2f}) — consistent with bots")
        evidence["burstiness_score"] = burstiness

    # 3. Program concentration (only with 10+ txs)
    if n >= 10 and top_prog_ratio > 0.7:
        score += 20
        flags.append(f"⚠️ {top_prog_ratio*100:.0f}% calls to single program — automated pattern")
        evidence["program_concentration"] = top_prog_ratio

    # 4. Pump.fun ratio
    if pumpfun_ratio > 0.3:
        score += 20
        flags.append(f"⚠️ {pumpfun_ratio*100:.0f}% Pump.fun interactions — memecoin bot")
        evidence["pumpfun_activity"] = pumpfun_ratio

    # 5. Isolation Forest (only with 10+ txs)
    timestamps = [tx.get("timestamp", 0) for tx in txs
                  if isinstance(tx, dict) and tx.get("timestamp")]
    if len(timestamps) >= 10:
        iats = np.array([timestamps[i] - timestamps[i+1]
                         for i in range(len(timestamps)-1)])
        iats = iats[iats >= 0]
        if len(iats) >= 5:
            try:
                iso = IsolationForest(contamination=0.1, random_state=42)
                preds = iso.fit_predict(iats.reshape(-1, 1))
                anomaly_ratio = float(np.mean(preds == -1))
                evidence["isolation_forest_anomaly_ratio"] = anomaly_ratio
                if anomaly_ratio < 0.05:
                    score += 15
                    flags.append(f"⚠️ Isolation Forest: highly regular intervals detected")
            except Exception as e:
                print(f"IsolationForest error: {e}")

    if not flags:
        flags.append("✅ No bot behavior detected — human-like activity")

    return {"score": min(score, 100), "flags": flags, "evidence": evidence}


def score_wash_trading_ml(features: dict, txs: list) -> dict:
    score = 0
    flags = []
    evidence = {}
    n = features.get("n_transactions", 0)

    if n == 0:
        return {"score": 0, "flags": ["✅ No transaction data"], "evidence": {}}

    if n < 3:
        return {"score": 0, "flags": [f"✅ Only {n} transaction(s) — insufficient for wash trading analysis"], "evidence": {}}

    diversity = features["counterparty_diversity"]
    entropy = features["counterparty_entropy"]
    most_freq = features["most_frequent_ratio"]
    flow_ratio = features["flow_ratio"]
    swap_ratio = features["swap_ratio"]
    std_tx = features["std_tx_size"]
    avg_tx = features["avg_tx_size"]

    # 1. Counterparty entropy
    max_entropy = np.log2(max(features["unique_counterparties"], 2))
    normalized_entropy = entropy / max_entropy if max_entropy > 0 else 1.0
    evidence["normalized_counterparty_entropy"] = normalized_entropy

    if n >= 5:
        if normalized_entropy < 0.3:
            score += 35
            flags.append(f"⚠️ Very low counterparty entropy ({normalized_entropy:.2f}) — circular trading")
        elif normalized_entropy < 0.5:
            score += 20
            flags.append(f"⚠️ Low counterparty entropy ({normalized_entropy:.2f}) — limited partners")

    # 2. Single counterparty dominance
    if most_freq > 0.5 and n >= 5:
        score += 25
        flags.append(f"⚠️ Single counterparty = {most_freq*100:.0f}% of interactions — wash signal")
        evidence["counterparty_dominance"] = most_freq

    # 3. Flow ratio (balanced = circular)
    if 0.8 < flow_ratio < 1.2 and n >= 10:
        score += 15
        flags.append(f"⚠️ Balanced flow ratio ({flow_ratio:.2f}) — funds cycling pattern")
        evidence["flow_ratio"] = flow_ratio

    # 4. Uniform transaction sizes
    if avg_tx > 0 and n >= 5 and std_tx / avg_tx < 0.1:
        score += 15
        flags.append(f"⚠️ Highly uniform transaction sizes — artificial volume")
        evidence["size_uniformity"] = std_tx / avg_tx

    # 5. Z-score on amounts
    amounts = []
    for tx in txs:
        if not isinstance(tx, dict): continue
        for transfer in tx.get("nativeTransfers", []):
            amt = transfer.get("amount", 0) / 1e9
            if amt > 0:
                amounts.append(amt)

    if len(amounts) >= 5:
        X = np.array(amounts).reshape(-1, 1)
        try:
            scaler = StandardScaler()
            X_scaled = scaler.fit_transform(X)
            z_scores = np.abs(X_scaled.flatten())
            outlier_ratio = float(np.mean(z_scores > 2))
            evidence["amount_outlier_ratio"] = outlier_ratio
            if outlier_ratio < 0.05 and len(amounts) >= 10:
                score += 10
                flags.append("⚠️ Statistically uniform amounts — artificial pattern")
        except Exception as e:
            print(f"Wash scoring error: {e}")

    if not flags:
        flags.append("✅ No wash trading signals — organic patterns")

    return {"score": min(score, 100), "flags": flags, "evidence": evidence}


def score_rug_pull_ml(features: dict, txs: list, wallet: str) -> dict:
    score = 0
    flags = []
    evidence = {}
    n = features.get("n_transactions", 0)

    if n == 0:
        return {"score": 0, "flags": ["✅ No transaction data"], "evidence": {}}

    if n < 2:
        return {"score": 0, "flags": [f"✅ Only {n} transaction(s) — insufficient for rug pull analysis"], "evidence": {}}

    flow_ratio = features["flow_ratio"]
    max_tx = features["max_tx_size"]
    avg_tx = features["avg_tx_size"]
    failed_ratio = features["failed_ratio"]
    total_outflow = features["total_outflow"]
    total_inflow = features["total_inflow"]

    # 1. Extreme outflow detection via z-score
    outflow_amounts = []
    for tx in txs:
        if not isinstance(tx, dict): continue
        for transfer in tx.get("nativeTransfers", []):
            if transfer.get("fromUserAccount") == wallet:
                amt = transfer.get("amount", 0) / 1e9
                if amt > 0:
                    outflow_amounts.append(amt)

    if len(outflow_amounts) >= 3:
        arr = np.array(outflow_amounts)
        mean_out = np.mean(arr)
        std_out = np.std(arr)
        if std_out > 0:
            z_scores = (arr - mean_out) / std_out
            extreme_outflows = int(np.sum(z_scores > 2))
            evidence["extreme_outflow_count"] = extreme_outflows
            if extreme_outflows > 0:
                score += 30
                flags.append(f"⚠️ {extreme_outflows} statistically extreme outflow(s) detected (z>2σ)")

    # 2. Pure outflow
    if total_outflow > 0 and total_inflow == 0:
        score += 25
        flags.append("⚠️ Pure outflow wallet — no incoming funds")
        evidence["pure_outflow"] = True
    elif flow_ratio > 5 and n >= 5:
        score += 20
        flags.append(f"⚠️ Outflow/inflow = {flow_ratio:.1f}x — heavily negative")
        evidence["flow_ratio"] = flow_ratio

    # 3. Sudden large spike
    if avg_tx > 0 and max_tx / avg_tx > 10:
        score += 20
        flags.append(f"⚠️ Max tx {max_tx:.2f} SOL = {max_tx/avg_tx:.0f}x average — sudden spike")
        evidence["spike_ratio"] = max_tx / avg_tx

    # 4. Failed transactions
    if failed_ratio > 0.2 and n >= 5:
        score += 15
        flags.append(f"⚠️ {failed_ratio*100:.0f}% failed transactions — possible exploit attempts")
        evidence["failed_ratio"] = failed_ratio

    # 5. New wallet with large outflows
    timestamps = [tx.get("timestamp", 0) for tx in txs
                  if isinstance(tx, dict) and tx.get("timestamp") and tx.get("timestamp") > 0]
    if timestamps:
        age_days = (max(timestamps) - min(timestamps)) / 86400
        evidence["wallet_age_days"] = age_days
        if age_days < 7 and total_outflow > 10:
            score += 20
            flags.append(f"⚠️ New wallet ({age_days:.1f} days) with {total_outflow:.1f} SOL outflow")

    if not flags:
        flags.append("✅ No rug pull signals detected")

    return {"score": min(score, 100), "flags": flags, "evidence": evidence}


# ── PROFILE CLASSIFIER ────────────────────────────────────────────────────────

def classify_wallet(features: dict, rug: dict, wash: dict, bot: dict) -> dict:
    if not features or features.get("n_transactions", 0) == 0:
        return {"type": "Unknown", "emoji": "❓", "description": "No transaction data found", "confidence": 0}

    n = features.get("n_transactions", 0)

    # With very few transactions, default to unknown
    if n < 3:
        return {
            "type": "New / Inactive",
            "emoji": "🆕",
            "description": f"Only {n} transaction(s) found — insufficient data for classification",
            "confidence": 0
        }

    rug_s = rug["score"]
    wash_s = wash["score"]
    bot_s = bot["score"]
    swap_r = features.get("swap_ratio", 0)
    pumpfun_r = features.get("pumpfun_ratio", 0)
    diversity = features.get("counterparty_diversity", 1)

    # Use ACTUAL scores not hardcoded thresholds
    final_score = round(rug_s * 0.4 + wash_s * 0.35 + bot_s * 0.25)

    if bot_s >= 60:
        return {"type": "Bot / Automated", "emoji": "🤖", "description": "Automated trading patterns with regular timing", "confidence": min(bot_s, 95)}
    elif wash_s >= 50:
        return {"type": "Wash Trader", "emoji": "🔄", "description": "Suspicious circular trading with low diversity", "confidence": min(wash_s, 95)}
    elif rug_s >= 60:
        return {"type": "High Risk Actor", "emoji": "🚨", "description": "Multiple high-risk signals detected", "confidence": min(rug_s, 95)}
    elif pumpfun_r > 0.3:
        return {"type": "Memecoin Trader", "emoji": "🎰", "description": "Heavy Pump.fun trading activity", "confidence": 70}
    elif swap_r > 0.3:
        return {"type": "DeFi Trader", "emoji": "💱", "description": "Active DeFi participant with frequent swaps", "confidence": 75}
    elif final_score >= 40:
        return {"type": "Medium Risk", "emoji": "⚠️", "description": "Some suspicious patterns detected", "confidence": 60}
    elif n >= 20:
        return {"type": "Active User", "emoji": "👤", "description": "Regular wallet with consistent activity", "confidence": 70}
    else:
        return {"type": "Casual User", "emoji": "🟢", "description": "Low activity, typical retail behavior", "confidence": 65}


# ── HELPERS ───────────────────────────────────────────────────────────────────

def get_activity_timeline(txs: list) -> list:
    if not txs: return []
    daily = {}
    for tx in txs:
        if isinstance(tx, dict) and tx.get("timestamp") and tx.get("timestamp") > 0:
            day = datetime.fromtimestamp(int(tx["timestamp"])).strftime("%Y-%m-%d")
            daily[day] = daily.get(day, 0) + 1
    return [{"date": d, "count": c} for d, c in sorted(daily.items())[-14:]]

def get_top_counterparties(txs: list, wallet: str) -> list:
    counts = {}
    for tx in txs:
        if not isinstance(tx, dict): continue
        for transfer in tx.get("nativeTransfers", []):
            for key in ["toUserAccount", "fromUserAccount"]:
                addr = transfer.get(key, "")
                if addr and addr != wallet:
                    counts[addr] = counts.get(addr, 0) + 1
        for transfer in tx.get("tokenTransfers", []):
            for key in ["toUserAccount", "fromUserAccount"]:
                addr = transfer.get(key, "")
                if addr and addr != wallet:
                    counts[addr] = counts.get(addr, 0) + 1
        for acc in tx.get("accountData", []):
            addr = acc.get("account", "")
            if addr and addr != wallet and acc.get("nativeBalanceChange", 0) != 0:
                counts[addr] = counts.get(addr, 0) + 1
    top = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:5]
    return [{"address": a[:8] + "..." + a[-4:], "full": a, "interactions": c} for a, c in top]

def get_tx_type_breakdown(txs: list) -> dict:
    types = Counter()
    for tx in txs:
        if not isinstance(tx, dict): continue
        tx_type = tx.get("type", "UNKNOWN")
        readable = {
            "UNKNOWN": "Complex DeFi",
            "TRANSFER": "SOL Transfer",
            "SWAP": "Token Swap",
            "NFT_SALE": "NFT Sale",
            "NFT_MINT": "NFT Mint",
            "NFT_BID": "NFT Bid",
            "BURN": "Token Burn",
            "STAKE_SOL": "SOL Staking",
        }.get(tx_type, tx_type)
        types[readable] += 1
    return dict(types.most_common(6))

def get_risk_label(score: int) -> str:
    if score >= 70: return "HIGH RISK 🔴"
    if score >= 40: return "MEDIUM RISK 🟡"
    return "LOW RISK 🟢"

def calculate_final_score(rug: dict, wash: dict, bot: dict) -> int:
    return min(round(rug["score"] * 0.4 + wash["score"] * 0.35 + bot["score"] * 0.25), 100)


# ── API ENDPOINTS ─────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"message": "SolSight ML API v4.0", "models": ["IsolationForest", "ZScore", "Entropy", "Burstiness"]}

@app.get("/analyze/{wallet}")
def analyze_wallet(wallet: str):
    txs = get_transactions(wallet)
    actual_count = len(txs)  # REAL count
    balance = get_sol_balance(wallet)
    age = get_wallet_age(txs)  # REAL timestamps

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
        "transaction_count": actual_count,  # REAL count
        "wallet_age": age,  # REAL timestamps
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
        "summary": f"Analyzed {actual_count} actual transactions. Classified as '{profile['type']}'. Risk: {final_score}/100."
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
    final_score = calculate_final_score(rug, wash, bot)
    return {
        "wallet": wallet,
        "risk_score": final_score,
        "risk_label": get_risk_label(final_score),
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
            if src and dst:
                all_transfers.append((src, dst, round(amt, 4), "SOL"))

        for t in tx.get("tokenTransfers", []):
            src = t.get("fromUserAccount", "")
            dst = t.get("toUserAccount", "")
            amt = t.get("tokenAmount", 0)
            if src and dst:
                all_transfers.append((src, dst, round(float(amt), 2), "TOKEN"))

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
                    edges.append({
                        "source": src,
                        "target": dst,
                        "amount": amt,
                        "type": type_
                    })

    return {"nodes": nodes[:20], "edges": edges[:30]}