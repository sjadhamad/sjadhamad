# -*- coding: utf-8 -*-
"""
cot_analyzer.py — التحليل الاحترافي لتقرير COT والفائدة المفتوحة
"""
import numpy as np
import pandas as pd

def analyze_cot(cot: pd.DataFrame) -> dict:
    c = cot.dropna(subset=["spec_net_pct"]).copy()
    last = c.iloc[-1]
    pct = float(last["spec_net_pct"])
    score, reasons = 0.0, []

    if pct >= 85:
        score -= 45; reasons.append(f"تشبع شرائي حاد ({pct:.0f}%) — خطر انعكاس هابط")
    elif pct >= 70:
        score -= 20; reasons.append(f"مراكز شرائية مرتفعة ({pct:.0f}%) — حذر شراء")
    elif pct <= 15:
        score += 45; reasons.append(f"تشبع بيعي حاد ({pct:.0f}%) — خطر انعكاس صاعد")
    elif pct <= 30:
        score += 20; reasons.append(f"مراكز بيعية مرتفعة ({pct:.0f}%) — حذر بيع")

    if len(c) >= 6:
        chg4 = float(c["spec_net"].iloc[-1] - c["spec_net"].iloc[-5])
        std = float(c["spec_net_chg"].std()) or 1.0
        z = np.clip(chg4 / (std * 2), -1, 1)
        weight = 35 if 30 < pct < 70 else 20
        score += z * weight
        if z > 0.3:
            reasons.append("الكبار يزيدون الشراء منذ 4 أسابيع")
        elif z < -0.3:
            reasons.append("الكبار يزيدون البيع منذ 4 أسابيع")

    oi_trend = c["oi_chg"].tail(4).mean()
    if pd.isna(oi_trend):
        oi_label = "غير متاحة"
    elif oi_trend > 0:
        score *= 1.10
        oi_label = "صاعدة"
        reasons.append("OI صاعدة — أموال جديدة تؤكد الاتجاه")
    else:
        score *= 0.85
        oi_label = "هابطة"
        reasons.append("OI هابطة — تصفية مراكز، ثقة أقل بالحركة")

    comm_pct = float(last["comm_net_pct"])
    if pct >= 85 and comm_pct <= 20:
        score -= 10; reasons.append("التجاريون على الطرف المعاكس — تأكيد انعكاسي")
    elif pct <= 15 and comm_pct >= 80:
        score += 10; reasons.append("التجاريون على الطرف المعاكس — تأكيد انعكاسي")

    score = float(np.clip(score, -100, 100))
    state = ("شرائي قوي" if score >= 50 else "شرائي" if score >= 15 else
             "بيعي قوي" if score <= -50 else "بيعي" if score <= -15 else "محايد")

    return {"score": round(score, 1), "state": state,
            "spec_net_pct": round(pct, 1),
            "spec_net": int(last["spec_net"]),
            "oi": int(last["oi"]),
            "oi_trend": oi_label,
            "report_date": str(last["date"].date()),
            "reasons": reasons}
