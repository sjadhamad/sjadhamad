# -*- coding: utf-8 -*-
"""
bonds_feed.py — عوائد السندات الأمريكية + العائد الحقيقي + مؤشر الدولار
المصدر: FRED (مجاني بدون API Key) + Yahoo للمؤشر
"""
import io
import requests
import pandas as pd
import yfinance as yf
from config import FRED_CSV, FRED_SERIES, DXY_TICKER, HTTP_HEADERS
from cache import load_cache, save_cache

def _fred_series(sid: str) -> pd.Series:
    r = requests.get(FRED_CSV.format(sid=sid),
                     headers=HTTP_HEADERS, timeout=40)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text))
    df.columns = ["date", "value"]
    df["date"] = pd.to_datetime(df["date"])
    v = pd.to_numeric(df["value"], errors="coerce")
    return pd.Series(v.values, index=df["date"].values, name=sid).dropna()

def fetch_bonds(years=5, use_cache=True) -> pd.DataFrame:
    if use_cache:
        cached = load_cache("bonds", 6 * 3600)
        if cached is not None and not cached.empty:
            return cached
    cols = {name: _fred_series(sid) for name, sid in FRED_SERIES.items()}
    df = pd.concat(cols.values(), axis=1).sort_index().ffill().dropna()
    df = df[df.index >= (df.index.max() - pd.Timedelta(days=365 * years))]
    df["curve_2_10"]   = df["US10Y"] - df["US02Y"]
    df["us10y_chg_5d"] = df["US10Y"].diff(5)
    df["real_chg_5d"]  = df["REAL10Y"].diff(5)
    save_cache("bonds", df)
    return df

def fetch_dxy(use_cache=True) -> pd.DataFrame:
    if use_cache:
        cached = load_cache("dxy", 3600)
        if cached is not None and not cached.empty:
            return cached
    raw = yf.download(DXY_TICKER, period="1y", interval="1d",
                      auto_adjust=False, progress=False, threads=False)
    if raw.empty:
        raise RuntimeError("فشل جلب مؤشر الدولار DXY")
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = raw.columns.get_level_values(0)
    df = raw.rename(columns={c: str(c).lower() for c in raw.columns})[["close"]]
    df = df.rename(columns={"close": "dxy"}).dropna()
    df["dxy_chg_5d"] = df["dxy"].diff(5)
    save_cache("dxy", df)
    return df
