# -*- coding: utf-8 -*-
"""cache.py — تخزين مؤقت لتسريع الأداة وتجنب تكرار الطلبات"""
import os, time, pickle
from config import CACHE_DIR

os.makedirs(CACHE_DIR, exist_ok=True)

def load_cache(name, max_age_sec):
    path = os.path.join(CACHE_DIR, f"{name}.pkl")
    if os.path.exists(path) and (time.time() - os.path.getmtime(path)) < max_age_sec:
        try:
            with open(path, "rb") as f:
                return pickle.load(f)
        except Exception:
            return None
    return None

def save_cache(name, df):
    try:
        with open(os.path.join(CACHE_DIR, f"{name}.pkl"), "wb") as f:
            pickle.dump(df, f)
    except Exception:
        pass
