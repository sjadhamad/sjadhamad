# -*- coding: utf-8 -*-
"""
orderflow.py — تحليل تدفق الأوامر
- الذهب: حجم حقيقي من COMEX → Delta حقيقي
- الفوركس سبوت: نموذج ضغط من بنية الشمعة (السبوت لامركزي، لا حجم حقيقي)
"""
import numpy as np
import pandas as pd

def compute_delta(df: pd.DataFrame, window: int = 50) -> pd.DataFrame:
    out = df.copy()
    rng = (out["high"] - out["low"]).replace(0, np.nan)

    clv = ((out["close"] - out["low"]) - (out["high"] - out["close"])) / rng
    clv = clv.fillna(0.0)

    vol = out["volume"].astype(float)
    if (vol > 0).any():
        delta = vol * clv
        out["delta_mode"] = "REAL_VOLUME"
    else:
        delta = rng.fillna(0.0) * clv
        out["delta_mode"] = "PRICE_PRESSURE"

    out["delta"] = delta
    out["cvd"] = delta.rolling(window, min_periods=1).sum()
    return out

def _swing_idx(s: pd.Series, n=2):
    highs, lows = [], []
    v = s.values
    for i in range(n, len(s) - n):
        w = v[i - n:i + n + 1]
        if v[i] == w.max() and v[i] > v[i - 1]:
            highs.append(i)
        if v[i] == w.min() and v[i] < v[i - 1]:
            lows.append(i)
    return highs, lows

def detect_absorption(df: pd.DataFrame, lookback=120) -> dict:
    d = df.tail(lookback).reset_index(drop=True)
    ph, pl = _swing_idx(d["close"], 2)
    res = {"bull_abs": False, "bear_abs": False, "bull_i": -1, "bear_i": -1, "detail": ""}

    if len(pl) >= 2:
        i1, i2 = pl[-2], pl[-1]
        if d["close"].iloc[i2] < d["close"].iloc[i1] and d["cvd"].iloc[i2] > d["cvd"].iloc[i1]:
            res["bull_abs"], res["bull_i"] = True, i2
    if len(ph) >= 2:
        i1, i2 = ph[-2], ph[-1]
        if d["close"].iloc[i2] > d["close"].iloc[i1] and d["cvd"].iloc[i2] < d["cvd"].iloc[i1]:
            res["bear_abs"], res["bear_i"] = True, i2

    if res["bull_abs"] and (res["bull_i"] >= res["bear_i"]):
        res["detail"] = "امتصاص شرائي: قاع أدنى في السعر + قاع أعلى في CVD"
    elif res["bear_abs"]:
        res["detail"] = "امتصاص بيعي: قمة أعلى في السعر + قمة أدنى في CVD"
    return res

def orderflow_score(df: pd.DataFrame, window: int = 50) -> dict:
    d = compute_delta(df, window)
    ab = detect_absorption(d)

    std = d["delta"].rolling(window).std().iloc[-1]
    if not std or np.isnan(std) or std == 0:
        std = abs(d["delta"].mean()) or 1.0

    move = d["cvd"].iloc[-1] - (d["cvd"].iloc[-20] if len(d) > 20 else d["cvd"].iloc[0])
    score = float(np.clip(move / (std * 8), -1, 1) * 60)

    if ab["bull_abs"] and ab["bull_i"] >= ab["bear_i"]:
        score += 40
    elif ab["bear_abs"] and ab["bear_i"] > ab["bull_i"]:
        score -= 40

    score = float(np.clip(score, -100, 100))
    state = ("شرائي قوي" if score >= 50 else "شرائي" if score >= 15 else
             "بيعي قوي" if score <= -50 else "بيعي" if score <= -15 else "محايد")

    return {"score": round(score, 1), "state": state,
            "mode": d["delta_mode"].iloc[-1],
            "absorption": ab["detail"] or "لا يوجد امتصاص واضح",
            "cvd_last": float(d["cvd"].iloc[-1])}
