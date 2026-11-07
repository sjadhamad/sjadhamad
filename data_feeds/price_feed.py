# -*- coding: utf-8 -*-
"""
price_feed.py — بيانات أسعار حقيقية OHLCV لفريمات 15m / 1H / 4H
المصدر: Yahoo Finance (سبوت للفوركس + عقود COMEX للذهب بحجم حقيقي)
"""
import pandas as pd
import yfinance as yf
from config import TIMEFRAMES
from cache import load_cache, save_cache

CACHE_AGE = {"15m": 300, "1H": 900, "4H": 900}

def _flatten(df: pd.DataFrame) -> pd.DataFrame:
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.rename(columns={c: str(c).lower() for c in df.columns})
    if "volume" not in df.columns:
        df["volume"] = 0.0
    df = df[["open", "high", "low", "close", "volume"]].copy()
    df.index = pd.to_datetime(df.index)
    try:
        df.index = df.index.tz_convert("UTC")
    except Exception:
        pass
    return df.dropna(subset=["open", "high", "low", "close"])

def fetch_ohlcv(symbol_cfg: dict, tf: str, use_cache=True) -> pd.DataFrame:
    if tf not in TIMEFRAMES:
        raise ValueError("الفريمات المسموحة: 15m / 1H / 4H فقط")

    cache_name = f"px_{symbol_cfg['yf'].replace('=','').replace('^','')}_{tf}"
    if use_cache:
        cached = load_cache(cache_name, CACHE_AGE[tf])
        if cached is not None and not cached.empty:
            return cached

    spec = TIMEFRAMES[tf]
    raw = yf.download(symbol_cfg["yf"], period=spec["period"],
                      interval=spec["interval"], auto_adjust=False,
                      progress=False, threads=False)
    if raw.empty:
        raise RuntimeError(f"لا توجد بيانات سعر لـ {symbol_cfg['yf']}")

    df = _flatten(raw)

    if spec["resample"]:
        df = df.resample(spec["resample"]).agg({
            "open": "first", "high": "max", "low": "min",
            "close": "last", "volume": "sum",
        }).dropna(subset=["open", "close"])

    save_cache(cache_name, df)
    return df

def has_real_volume(df: pd.DataFrame) -> bool:
    return bool((df["volume"] > 0).any())
