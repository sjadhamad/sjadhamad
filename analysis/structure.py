# -*- coding: utf-8 -*-
"""
structure.py — هيكل السوق: سوينغات + BOS + CHoCH (بدون Look-ahead)
"""
import pandas as pd

def detect_swings(df: pd.DataFrame, n=2):
    highs, lows = [], []
    h, l, idx = df["high"].values, df["low"].values, df.index
    for i in range(n, len(df) - n):
        if h[i] == max(h[i - n:i + n + 1]) and h[i] > h[i - 1]:
            highs.append({"time": idx[i], "price": float(h[i]), "i": i})
        if l[i] == min(l[i - n:i + n + 1]) and l[i] < l[i - 1]:
            lows.append({"time": idx[i], "price": float(l[i]), "i": i})
    return highs, lows

def market_structure(df: pd.DataFrame, n=2, keep_events=8) -> dict:
    highs, lows = detect_swings(df, n)
    closes = df["close"].values
    idx = df.index

    hi_confirmed = sorted([(s["i"] + n, s) for s in highs], key=lambda x: x[0])
    lo_confirmed = sorted([(s["i"] + n, s) for s in lows], key=lambda x: x[0])

    trend, events = "range", []
    last_h = last_l = None
    hp = lp = 0

    for i in range(len(df)):
        while hp < len(hi_confirmed) and hi_confirmed[hp][0] <= i:
            last_h = hi_confirmed[hp][1]; hp += 1
        while lp < len(lo_confirmed) and lo_confirmed[lp][0] <= i:
            last_l = lo_confirmed[lp][1]; lp += 1

        if last_h and closes[i] > last_h["price"]:
            kind = "BOS↑" if trend == "bullish" else "CHoCH↑"
            trend = "bullish"
            events.append({"time": idx[i], "type": kind, "price": last_h["price"]})
            last_h = None
        elif last_l and closes[i] < last_l["price"]:
            kind = "BOS↓" if trend == "bearish" else "CHoCH↓"
            trend = "bearish"
            events.append({"time": idx[i], "type": kind, "price": last_l["price"]})
            last_l = None

    last_events = events[-keep_events:]
    last_choch = next((e for e in reversed(events) if "CHoCH" in e["type"]), None)

    return {"trend": trend,
            "trend_ar": {"bullish": "صاعد", "bearish": "هابط", "range": "عرضي"}[trend],
            "events": last_events,
            "last_choch": last_choch,
            "swing_highs": highs[-6:], "swing_lows": lows[-6:]}
