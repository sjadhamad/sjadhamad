# -*- coding: utf-8 -*-
"""config.py — الإعدادات المركزية: الأزواج، الفريمات، مصادر البيانات"""

SYMBOLS = {
    "XAUUSD": {
        "yf": "GC=F",
        "cot_market": "GOLD - COMMODITY EXCHANGE INC.",
        "cot_side": "direct",
        "pip": 0.1,
    },
    "EURUSD": {
        "yf": "EURUSD=X",
        "cot_market": "EURO FX - CHICAGO MERCANTILE EXCHANGE",
        "cot_side": "direct",
        "pip": 0.0001,
    },
    "GBPUSD": {
        "yf": "GBPUSD=X",
        "cot_market": "BRITISH POUND - CHICAGO MERCANTILE EXCHANGE",
        "cot_side": "direct",
        "pip": 0.0001,
    },
    "USDJPY": {
        "yf": "JPY=X",
        "cot_market": "JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE",
        "cot_side": "inverse",
        "pip": 0.01,
    },
    "AUDUSD": {
        "yf": "AUDUSD=X",
        "cot_market": "AUSTRALIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE",
        "cot_side": "direct",
        "pip": 0.0001,
    },
    "NZDUSD": {
        "yf": "NZDUSD=X",
        "cot_market": "NEW ZEALAND DOLLAR - CHICAGO MERCANTILE EXCHANGE",
        "cot_side": "direct",
        "pip": 0.0001,
    },
    "USDCAD": {
        "yf": "CAD=X",
        "cot_market": "CANADIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE",
        "cot_side": "inverse",
        "pip": 0.0001,
    },
    "USDCHF": {
        "yf": "CHF=X",
        "cot_market": "SWISS FRANC - CHICAGO MERCANTILE EXCHANGE",
        "cot_side": "inverse",
        "pip": 0.0001,
    },
}

TIMEFRAMES = {
    "15m": {"interval": "15m", "period": "59d",  "resample": None},
    "1H":  {"interval": "60m", "period": "729d", "resample": None},
    "4H":  {"interval": "60m", "period": "729d", "resample": "4h"},
}

COT_LEGACY_URL = "https://publicreporting.cftc.gov/resource/6dca-aqww.json"
COT_WEEKS = 156

FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
FRED_SERIES = {
    "US10Y":   "DGS10",
    "US02Y":   "DGS2",
    "US30Y":   "DGS30",
    "REAL10Y": "DFII10",
}

DXY_TICKER = "DX-Y.NYB"
CACHE_DIR = "cache"

HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
