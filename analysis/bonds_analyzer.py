# -*- coding: utf-8 -*-
"""
bonds_analyzer.py — محرك السندات والدولار (تطبيع Z-Score)
"""
import numpy as np

def _z(change_series, window=60):
    std = float(change_series.rolling(window).std().iloc[-1])
    if not std or np.isnan(std) or std == 0:
        return 0.0
    return float(change_series.iloc[-1] / std)

def analyze_bonds(bonds, dxy, symbol: str) -> dict:
    b = bonds.dropna(subset=["real_chg_5d", "us10y_chg_5d"])
    d = dxy.dropna(subset=["dxy_chg_5d"])

    z_real = _z(b["real_chg_5d"])
    z_10y  = _z(b["us10y_chg_5d"])
    z_dxy  = _z(d["dxy_chg_5d"])

    if symbol == "XAUUSD":
        raw = -0.60 * z_real - 0.25 * z_dxy - 0.15 * z_10y
        logic = "العائد الحقيقي هو المحرك الأول للذهب (علاقة عكسية)"
    elif symbol.startswith("USD"):
        raw = 0.50 * z_10y + 0.40 * z_dxy + 0.10 * z_real
        if symbol == "USDJPY":
            raw *= 1.3
        logic = "الدولار عملة الأساس — ارتفاع العوائد يدعم الزوج"
    else:
        raw = -(0.50 * z_10y + 0.40 * z_dxy + 0.10 * z_real)
        logic = "الدولار عملة التسعير — ارتفاع العوائد يضغط على الزوج"

    score = float(np.clip(raw * 40, -100, 100))
    last = b.iloc[-1]

    state = ("شرائي قوي" if score >= 50 else "شرائي" if score >= 15 else
             "بيعي قوي" if score <= -50 else "بيعي" if score <= -15 else "محايد")

    return {"score": round(score, 1), "state": state, "logic": logic,
            "us10y": round(float(last["US10Y"]), 3),
            "real10y": round(float(last["REAL10Y"]), 3),
            "curve_2_10": round(float(last["curve_2_10"]), 3),
            "dxy": round(float(d["dxy"].iloc[-1]), 2),
            "z_real": round(z_real, 2), "z_10y": round(z_10y, 2), "z_dxy": round(z_dxy, 2)}
