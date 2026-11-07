# -*- coding: utf-8 -*-
"""
cot_feed.py — تقرير COT + الفائدة المفتوحة (Open Interest) من CFTC الرسمي
"""
import requests
import pandas as pd
from config import COT_LEGACY_URL, COT_WEEKS, HTTP_HEADERS
from cache import load_cache, save_cache

MAP = {
    "report_date_as_yyyy_mm_dd": "date",
    "open_interest_all":          "oi",
    "noncomm_positions_long_all":  "spec_long",
    "noncomm_positions_short_all": "spec_short",
    "comm_positions_long_all":     "comm_long",
    "comm_positions_short_all":    "comm_short",
}
NUM = ["oi", "spec_long", "spec_short", "comm_long", "comm_short"]

def _request(market_name: str, weeks: int):
    params = {
        "market_and_exchange_names": market_name,
        "$order": "report_date_as_yyyy_mm_dd DESC",
        "$limit": weeks,
    }
    r = requests.get(COT_LEGACY_URL, params=params,
                     headers=HTTP_HEADERS, timeout=40)
    r.raise_for_status()
    return r.json()

def _resolve(market_name: str, weeks: int):
    data = _request(market_name, weeks)
    if data:
        return data
    keyword = market_name.split(" - ")[0]
    r = requests.get(COT_LEGACY_URL, params={
        "$select": "market_and_exchange_names",
        "$group": "market_and_exchange_names",
        "$q": keyword}, headers=HTTP_HEADERS, timeout=40)
    r.raise_for_status()
    candidates = [d["market_and_exchange_names"] for d in r.json()]
    for c in candidates:
        data = _request(c, weeks)
        if data:
            return data
    raise RuntimeError(f"سوق COT غير موجود: {market_name} | المرشحون: {candidates}")

def fetch_cot(symbol_cfg: dict, weeks: int = COT_WEEKS, use_cache=True) -> pd.DataFrame:
    cache_name = f"cot_{symbol_cfg['yf'].replace('=','').replace('^','')}"
    if use_cache:
        cached = load_cache(cache_name, 12 * 3600)
        if cached is not None and not cached.empty:
            return cached

    data = _resolve(symbol_cfg["cot_market"], weeks)
    df = pd.DataFrame(data)
    missing = [c for c in MAP if c not in df.columns]
    if missing:
        raise RuntimeError(f"أعمدة ناقصة من CFTC: {missing}")

    df = df[list(MAP)].rename(columns=MAP)
    df["date"] = pd.to_datetime(df["date"])
    for c in NUM:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.sort_values("date").reset_index(drop=True)

    df["spec_net"] = df["spec_long"] - df["spec_short"]
    df["comm_net"] = df["comm_long"] - df["comm_short"]

    if symbol_cfg.get("cot_side") == "inverse":
        df["spec_net"] = -df["spec_net"]
        df["comm_net"] = -df["comm_net"]

    df["oi_chg"]       = df["oi"].diff()
    df["spec_net_chg"] = df["spec_net"].diff()
    df["spec_net_pct"] = df["spec_net"].rank(pct=True) * 100
    df["comm_net_pct"] = df["comm_net"].rank(pct=True) * 100

    save_cache(cache_name, df)
    return df
