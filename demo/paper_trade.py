#!/usr/bin/env python3
"""
x402-svm paper trading: Laya classifier vs Polymarket prices.
Pulls enriched market data, classifies with Laya, logs paper trades,
tracks calibration (Brier score) over time.
"""
import requests, json, time, os, math
from datetime import datetime, timezone

STATE_FILE = os.path.join(os.path.dirname(__file__), "paper_trades.json")
GAMMA = "https://gamma-api.polymarket.com"

def get_markets(limit=50, min_vol=100000, min_price=0.05, max_price=0.95):
    r = requests.get(f"{GAMMA}/events?limit={limit}&active=true&closed=false&order=volume&ascending=false", timeout=20)
    markets = []
    for ev in r.json():
        for m in ev.get("markets", []):
            try:
                outcomes = json.loads(m.get("outcomes", "[]"))
                prices = json.loads(m.get("outcomePrices", "[]"))
                vol = float(m.get("volume", 0) or 0)
                if len(outcomes) == 2 and len(prices) == 2 and vol >= min_vol:
                    yp = float(prices[0])
                    if min_price < yp < max_price:
                        markets.append({
                            "question": m.get("question", ""),
                            "slug": m.get("slug", ""),
                            "yes_price": yp,
                            "volume": vol,
                            "description": (m.get("description", "") or "")[:800],
                            "end_date": m.get("endDate", ""),
                        })
            except Exception:
                pass
    markets.sort(key=lambda x: -x["volume"])
    return markets

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"trades": [], "runs": []}

def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=1)

def brier_score(predictions):
    """Brier score for resolved markets (lower = better calibration)"""
    resolved = [t for t in predictions if t.get("resolved_yes") is not None]
    if not resolved:
        return None
    return sum((t["p_laya"] - (1 if t["resolved_yes"] else 0)) ** 2 for t in resolved) / len(resolved)

def run_once():
    from laya import Router
    router = Router(preload=True)
    markets = get_markets()
    state = load_state()
    now = datetime.now(timezone.utc).isoformat()
    
    run_trades = []
    for m in markets[:15]:  # top 15 by volume
        state_data = {
            "question": m["question"],
            "market_price": f"{m['yes_price']:.0%}",
            "context": m["description"][:600],
        }
        questions = {
            "p_yes": {
                "type": "score",
                "instructions": "What is the true probability that the answer is YES?",
                "criteria": ["0%", "25%", "50%", "75%", "100%"]
            }
        }
        try:
            res = router.predict(state_data, questions)
            a = res["answers"]["p_yes"]
            probs = a["probabilities"]
            p_yes = sum(float(k) * v for k, v in probs.items()) / 4.0
            trade = {
                "at": now,
                "question": m["question"][:80],
                "slug": m["slug"],
                "market_price": m["yes_price"],
                "laya_p": round(p_yes, 4),
                "edge": round(p_yes - m["yes_price"], 4),
                "action": "BUY_YES" if p_yes > m["yes_price"] + 0.05 else ("BUY_NO" if p_yes < m["yes_price"] - 0.05 else "HOLD"),
                "volume": m["volume"],
            }
            run_trades.append(trade)
            print(f"  {trade['action']:8} | mkt={m['yes_price']:.2f} laya={p_yes:.3f} | {m['question'][:55]}")
        except Exception as e:
            print(f"  ERROR {m['question'][:40]}: {e}")
    
    state["runs"].append({"at": now, "trades": run_trades, "count": len(run_trades)})
    state["trades"].extend(run_trades)
    save_state(state)
    bs = brier_score(state["trades"])
    print(f"  {len(run_trades)} paper trades logged | total: {len(state['trades'])} | Brier: {bs}")
    return run_trades

if __name__ == "__main__":
    run_once()
