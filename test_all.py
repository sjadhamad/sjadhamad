# -*- coding: utf-8 -*-
"""test_all.py — فحص شامل للجزءين 1+2 على كل الأزواج مع تقرير نجاح/فشل"""
import sys, traceback
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from config import SYMBOLS, TIMEFRAMES
from data_feeds.price_feed import fetch_ohlcv, has_real_volume
from data_feeds.cot_feed import fetch_cot
from data_feeds.bonds_feed import fetch_bonds, fetch_dxy
from analysis.orderflow import orderflow_score
from analysis.cot_analyzer import analyze_cot
from analysis.bonds_analyzer import analyze_bonds
from analysis.structure import market_structure

passed, failed = [], []

def check(name, fn):
    try:
        fn()
        passed.append(name)
        print(f"  ✅ {name}")
    except Exception as e:
        failed.append((name, e))
        print(f"  ❌ {name} → {e}")
        traceback.print_exc(limit=1)

print("\n═══════ [1] مصادر البيانات العامة ═══════")
bonds = dxy = None

def _bonds():
    global bonds
    bonds = fetch_bonds()
    assert len(bonds) > 500, "بيانات سندات غير كافية"
    assert not bonds[["US10Y", "REAL10Y"]].iloc[-1].isna().any()
    print(f"      US10Y={bonds['US10Y'].iloc[-1]:.3f}% | REAL10Y={bonds['REAL10Y'].iloc[-1]:.3f}%")

def _dxy():
    global dxy
    dxy = fetch_dxy()
    assert len(dxy) > 100, "بيانات DXY غير كافية"
    print(f"      DXY={dxy['dxy'].iloc[-1]:.2f}")

check("السندات الأمريكية (FRED)", _bonds)
check("مؤشر الدولار DXY", _dxy)

print("\n═══════ [2] الأسعار + COT لكل الأزواج ═══════")
for name, cfg in SYMBOLS.items():
    def _px(name=name, cfg=cfg):
        px = fetch_ohlcv(cfg, "1H")
        assert len(px) > 300, "شموع غير كافية"
        assert not px[["open", "high", "low", "close"]].iloc[-1].isna().any()
        assert (px["high"] >= px["low"]).all(), "شموع غير منطقية"
        mode = "حجم حقيقي" if has_real_volume(px) else "بدون حجم (سبوت)"
        print(f"      شموع 1H: {len(px)} | {mode} | آخر إغلاق: {px['close'].iloc[-1]:.5g}")
    check(f"أسعار {name}", _px)

    def _cot(name=name, cfg=cfg):
        cot = fetch_cot(cfg)
        assert len(cot) >= 100, "أسابيع COT غير كافية"
        last = cot.iloc[-1]
        assert 0 <= last["spec_net_pct"] <= 100, "Percentile خارج النطاق"
        print(f"      أسابيع: {len(cot)} | آخر تقرير: {last['date'].date()} | "
              f"OI: {int(last['oi']):,} | موقع الكبار: {last['spec_net_pct']:.0f}%")
    check(f"COT {name}", _cot)

print("\n═══════ [3] سلامة بناء فريم 4H ═══════")
def _tf4():
    cfg = SYMBOLS["XAUUSD"]
    h1, h4 = fetch_ohlcv(cfg, "1H"), fetch_ohlcv(cfg, "4H")
    ratio = len(h1) / max(len(h4), 1)
    assert 3.2 < ratio < 5.5, f"نسبة شموع 1H/4H غير منطقية: {ratio:.1f}"
    print(f"      شموع 1H: {len(h1)} | شموع 4H: {len(h4)} | النسبة: {ratio:.2f}")
    m15 = fetch_ohlcv(cfg, "15m")
    assert len(m15) > 500, "شموع 15m غير كافية"
    print(f"      شموع 15m: {len(m15)} ✓")
check("فريمات 15m/1H/4H للذهب", _tf4)

print("\n═══════ [4] محرك التحليل الكامل ═══════")
for name in ["XAUUSD", "EURUSD"]:
    def _engine(name=name):
        cfg = SYMBOLS[name]
        px = fetch_ohlcv(cfg, "1H")

        of = orderflow_score(px)
        assert -100 <= of["score"] <= 100, "نقاط OrderFlow خارج النطاق"
        assert of["mode"] in ("REAL_VOLUME", "PRICE_PRESSURE")
        print(f"      OrderFlow: {of['score']} ({of['state']}) [{of['mode']}]")

        cot_a = analyze_cot(fetch_cot(cfg))
        assert -100 <= cot_a["score"] <= 100, "نقاط COT خارج النطاق"
        print(f"      COT: {cot_a['score']} ({cot_a['state']}) | أسباب: {len(cot_a['reasons'])}")

        bd = analyze_bonds(bonds, dxy, name)
        assert -100 <= bd["score"] <= 100, "نقاط السندات خارج النطاق"
        print(f"      السندات: {bd['score']} ({bd['state']})")

        ms = market_structure(px)
        assert ms["trend"] in ("bullish", "bearish", "range")
        print(f"      الهيكل: {ms['trend_ar']} | أحداث: {len(ms['events'])}")
        print(f"      ── {name}: كل المحركات تعمل ✓")
    check(f"محرك التحليل {name}", _engine)

print("\n" + "═" * 50)
print(f"  النتيجة النهائية: نجح {len(passed)} | فشل {len(failed)}")
if failed:
    for n, e in failed:
        print(f"  ❌ {n}: {e}")
else:
    print("  🎉 الجزءان 1+2 سليمان 100% — جاهزان للجزء الثالث")
print("═" * 50)
