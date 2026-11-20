/**
 * EUR/USD Bar-Replay Trainer — Frontend Only (ES Module)
 *
 * Strict contract adherence:
 * - Zero candle aggregation, zero price-to-P&L math on the client.
 * - Zero synthetic/mocked candles; never requests or stores bars past `cursor`.
 * - `localStorage` stores ONLY session id + UI preferences (timeframe, speed).
 * - Uses vendored TradingView Lightweight Charts v4.2.3 standalone API only.
 */

const STORAGE_KEYS = Object.freeze({
  SESSION_ID: 'eurusd_replay_session_id',
  TIMEFRAME: 'eurusd_replay_tf',
  SPEED: 'eurusd_replay_speed',
});

const VALID_SPEEDS = [1, 2, 5, 10, 50];
const DEFAULT_TF = 'M5';
const DEFAULT_SPEED = 1;
const BARS_FETCH_LIMIT = 1500;
const GUTTER_BARS = 8;

const STATE_LABELS = Object.freeze({
  idle: 'في الانتظار',
  loading: 'جارٍ التحميل…',
  replaying: 'قيد التشغيل',
  paused: 'متوقف مؤقتاً',
  at_end: 'نهاية البيانات',
  error: 'خطأ في الاتصال',
});

const REASON_LABELS = Object.freeze({
  manual: 'يدوي',
  sl: 'وقف خسارة SL',
  tp: 'جني أرباح TP',
});

/* -------------------------------------------------------------------------- */
/* Application State (in-memory only; never persisted except id/tf/speed)     */
/* -------------------------------------------------------------------------- */

const state = {
  status: 'idle', // 'idle' | 'loading' | 'replaying' | 'paused' | 'at_end' | 'error'
  meta: null,
  session: null,
  bars: [], // raw server bars <= cursor, oldest first
  barsByTime: new Map(), // unixSec -> raw server bar
  hasMoreBefore: false,
  savedSessions: [],
  sessionStartById: new Map(), // sessionId -> initial cursor ISO observed in memory
  speed: loadPreferredSpeed(),
  preferredTf: loadPreferredTf(),
  inspectedTimeSec: null,
  errorInfo: null, // { title, message, detail, retryFn, canResync }
  replayTimerId: null,
  replayAbortCtrl: null,
  opLock: false,
};

/* -------------------------------------------------------------------------- */
/* Safe LocalStorage Helpers (strictly session_id, tf, speed)                 */
/* -------------------------------------------------------------------------- */

function safeGetStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetStorage(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

function safeRemoveStorage(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore
  }
}

function loadPreferredSpeed() {
  const raw = Number(safeGetStorage(STORAGE_KEYS.SPEED));
  return VALID_SPEEDS.includes(raw) ? raw : DEFAULT_SPEED;
}

function loadPreferredTf() {
  const raw = safeGetStorage(STORAGE_KEYS.TIMEFRAME);
  return raw && /^[A-Z0-9]{2,4}$/.test(raw) ? raw : DEFAULT_TF;
}

/* -------------------------------------------------------------------------- */
/* Latin Formatting & UTC Date Helpers                                        */
/* -------------------------------------------------------------------------- */

const moneyFmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const intFmt = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

function formatPrice(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '—';
  return num.toFixed(5);
}

function formatMoney(val, showPlus = false) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '—';
  const absStr = moneyFmt.format(Math.abs(num));
  if (num < 0) return `-$${absStr}`;
  if (num > 0 && showPlus) return `+$${absStr}`;
  return `$${absStr}`;
}

function formatSignedNumber(val, decimals = 2) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '—';
  const fixed = Math.abs(num).toFixed(decimals);
  if (num < 0) return `-${fixed}`;
  if (num > 0) return `+${fixed}`;
  return fixed;
}

function formatLots(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '—';
  return num.toFixed(2);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoToUnixSeconds(iso) {
  if (typeof iso !== 'string') return NaN;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return NaN;
  return Math.floor(ms / 1000);
}

function formatIsoUtcDisplay(iso, includeSeconds = false) {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const d = new Date(ms);
  const datePart = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const timePart = includeSeconds
    ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
    : `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return `${datePart} ${timePart} UTC`;
}

function formatChartUtcSeconds(unixSec) {
  const sec = Number(unixSec);
  if (!Number.isFinite(sec)) return '';
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

function isoToDatetimeLocalValue(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function datetimeLocalValueToIsoUtc(val) {
  if (!val || typeof val !== 'string') return null;
  const trimmed = val.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss = '00'] = match;
  const utcMs = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  if (!Number.isFinite(utcMs)) return null;
  return new Date(utcMs).toISOString().replace('.000Z', 'Z');
}

/* -------------------------------------------------------------------------- */
/* DOM References                                                             */
/* -------------------------------------------------------------------------- */

const dom = {
  symbolLabel: document.getElementById('symbol-label'),
  topBid: document.getElementById('top-bid'),
  topAsk: document.getElementById('top-ask'),
  tfPills: document.getElementById('tf-pills'),
  exchangeClock: document.getElementById('exchange-clock'),
  appStatePill: document.getElementById('app-state-pill'),
  appStateText: document.getElementById('app-state-text'),
  sessionName: document.getElementById('session-name'),
  accountBalance: document.getElementById('account-balance'),
  accountEquity: document.getElementById('account-equity'),
  btnTopSave: document.getElementById('btn-top-save'),

  tabButtons: Array.from(document.querySelectorAll('.panel-tab')),
  tabPanels: {
    orders: document.getElementById('tab-panel-orders'),
    trades: document.getElementById('tab-panel-trades'),
    session: document.getElementById('tab-panel-session'),
  },
  positionIndicatorDot: document.getElementById('position-indicator-dot'),
  tradesCountBadge: document.getElementById('trades-count-badge'),

  orderLots: document.getElementById('order-lots'),
  lotChipButtons: Array.from(document.querySelectorAll('[data-lot]')),
  orderSl: document.getElementById('order-sl'),
  orderTp: document.getElementById('order-tp'),
  btnFillSl: document.getElementById('btn-fill-sl'),
  btnFillTp: document.getElementById('btn-fill-tp'),
  btnBuy: document.getElementById('btn-buy'),
  btnSell: document.getElementById('btn-sell'),
  btnBuyPrice: document.getElementById('btn-buy-price'),
  btnSellPrice: document.getElementById('btn-sell-price'),

  openPosBadge: document.getElementById('open-pos-badge'),
  openPosEmpty: document.getElementById('open-pos-empty'),
  openPosDetails: document.getElementById('open-pos-details'),
  posOrderId: document.getElementById('pos-order-id'),
  posLots: document.getElementById('pos-lots'),
  posEntry: document.getElementById('pos-entry'),
  posTs: document.getElementById('pos-ts'),
  posSl: document.getElementById('pos-sl'),
  posTp: document.getElementById('pos-tp'),
  posBalance: document.getElementById('pos-balance'),
  posEquity: document.getElementById('pos-equity'),
  closePctButtons: Array.from(document.querySelectorAll('[data-close-pct]')),
  closeLotsInput: document.getElementById('close-lots-input'),
  btnClosePartial: document.getElementById('btn-close-partial'),
  btnCloseFull: document.getElementById('btn-close-full'),

  statRunningPnl: document.getElementById('stat-running-pnl'),
  statWinRate: document.getElementById('stat-win-rate'),
  statExpectancy: document.getElementById('stat-expectancy'),
  statTradeCount: document.getElementById('stat-trade-count'),
  tradesEmpty: document.getElementById('trades-empty'),
  tradesTableWrap: document.getElementById('trades-table-wrap'),
  tradesTbody: document.getElementById('trades-tbody'),

  btnPanelSave: document.getElementById('btn-panel-save'),
  infoSessionId: document.getElementById('info-session-id'),
  infoSessionTf: document.getElementById('info-session-tf'),
  infoDataRange: document.getElementById('info-data-range'),
  infoBarsLoaded: document.getElementById('info-bars-loaded'),
  panelSeekInput: document.getElementById('panel-seek-input'),
  btnPanelSeek: document.getElementById('btn-panel-seek'),
  seekOffsetButtons: Array.from(document.querySelectorAll('[data-seek-offset-days]')),
  newSessionTf: document.getElementById('new-session-tf'),
  newSessionStart: document.getElementById('new-session-start'),
  btnNewSession: document.getElementById('btn-new-session'),
  btnRefreshSessions: document.getElementById('btn-refresh-sessions'),
  savedSessionsEmpty: document.getElementById('saved-sessions-empty'),
  savedSessionsList: document.getElementById('saved-sessions-list'),

  chartMount: document.getElementById('chart-mount'),
  hudSymbol: document.getElementById('hud-symbol'),
  hudTf: document.getElementById('hud-tf'),
  hudTime: document.getElementById('hud-time'),
  hudO: document.getElementById('hud-o'),
  hudH: document.getElementById('hud-h'),
  hudL: document.getElementById('hud-l'),
  hudC: document.getElementById('hud-c'),
  hudV: document.getElementById('hud-v'),

  loadingOverlay: document.getElementById('loading-overlay'),
  loadingText: document.getElementById('loading-text'),
  atEndBanner: document.getElementById('at-end-banner'),
  btnAtEndRewind: document.getElementById('btn-at-end-rewind'),
  errorOverlay: document.getElementById('error-overlay'),
  errorTitle: document.getElementById('error-title'),
  errorMessage: document.getElementById('error-message'),
  errorDetail: document.getElementById('error-detail'),
  btnErrorRetry: document.getElementById('btn-error-retry'),
  btnErrorResync: document.getElementById('btn-error-resync'),
  toastArea: document.getElementById('toast-area'),

  replaySeekInput: document.getElementById('replay-seek-input'),
  btnReplaySeek: document.getElementById('btn-replay-seek'),
  speedPills: document.getElementById('speed-pills'),
  btnSnapCursor: document.getElementById('btn-snap-cursor'),
  btnRewind: document.getElementById('btn-rewind'),
  btnViewBack: document.getElementById('btn-view-back'),
  btnStepForward: document.getElementById('btn-step-forward'),
  btnPlayPause: document.getElementById('btn-play-pause'),
  playPauseIcon: document.getElementById('play-pause-icon'),
};

/* -------------------------------------------------------------------------- */
/* REST API Client (same-origin only; zero external network calls)            */
/* -------------------------------------------------------------------------- */

class ApiError extends Error {
  constructor(message, { status = 0, path = '', detail = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.detail = detail;
  }
}

async function apiRequest(path, { method = 'GET', body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  const fetchOpts = { method, headers, signal, cache: 'no-store' };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, fetchOpts);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw err;
    }
    throw new ApiError('انقطع الاتصال بالخادم المحلي أو تعذّر الوصول إليه.', {
      status: 0,
      path,
      detail: `${method} ${path} — ${err?.message || 'NetworkError'}`,
    });
  }

  const contentType = response.headers.get('content-type') || '';
  let payload = null;
  let rawText = '';

  try {
    if (contentType.includes('application/json')) {
      payload = await response.json();
    } else {
      rawText = await response.text();
      if (rawText.trim().startsWith('{')) {
        payload = JSON.parse(rawText);
      }
    }
  } catch {
    // Non-JSON error body
  }

  if (!response.ok) {
    const serverMsg =
      (payload && (payload.error || payload.message || payload.detail)) ||
      (rawText ? rawText.slice(0, 140).trim() : '') ||
      `HTTP ${response.status}`;
    throw new ApiError(
      response.status >= 500 || response.status === 404
        ? 'فشل الطلب من خادم الإعادة.'
        : 'رفض الخادم تنفيذ العملية المطلوبة.',
      {
        status: response.status,
        path,
        detail: `${method} ${path} → HTTP ${response.status}: ${serverMsg}`,
      }
    );
  }

  if (payload === null) {
    throw new ApiError('أعاد الخادم استجابة غير صالحة (ليست JSON).', {
      status: response.status,
      path,
      detail: `${method} ${path} → Invalid JSON response`,
    });
  }

  return payload;
}

/* -------------------------------------------------------------------------- */
/* Lightweight Charts v4.2.3 Setup                                            */
/* -------------------------------------------------------------------------- */

let chart = null;
let candleSeries = null;
let resizeObserver = null;
let clampingScroll = false;

const activePriceLines = {
  entry: null,
  sl: null,
  tp: null,
};

const renderMemo = {
  priceLinesSig: '',
  markersSig: '',
  tradesSig: '',
  savedSessionsSig: '',
};

function initChart() {
  if (chart) return true;
  const LWC = window.LightweightCharts;
  if (!LWC || typeof LWC.createChart !== 'function') {
    enterErrorState({
      title: 'تعذّر تحميل مكتبة الرسم البياني',
      message: 'لم يتم العثور على الملف المحلي vendor/lightweight-charts.standalone.production.js.',
      detail: 'window.LightweightCharts is undefined',
      retryFn: () => window.location.reload(),
      canResync: false,
    });
    return false;
  }

  const rect = dom.chartMount.getBoundingClientRect();
  chart = LWC.createChart(dom.chartMount, {
    width: Math.max(280, Math.floor(rect.width || 800)),
    height: Math.max(260, Math.floor(rect.height || 520)),
    layout: {
      background: { type: LWC.ColorType.Solid, color: '#0a0e17' },
      textColor: '#98a8c3',
      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace',
      fontSize: 11,
    },
    localization: {
      locale: 'en-US',
      priceFormatter: (price) => formatPrice(price),
      timeFormatter: (time) => formatChartUtcSeconds(time),
    },
    grid: {
      vertLines: { color: 'rgba(30, 43, 69, 0.55)' },
      horzLines: { color: 'rgba(30, 43, 69, 0.55)' },
    },
    crosshair: {
      mode: LWC.CrosshairMode.Normal,
      vertLine: {
        color: 'rgba(56, 189, 248, 0.45)',
        width: 1,
        style: LWC.LineStyle.Dashed,
        labelBackgroundColor: '#162033',
      },
      horzLine: {
        color: 'rgba(56, 189, 248, 0.45)',
        width: 1,
        style: LWC.LineStyle.Dashed,
        labelBackgroundColor: '#162033',
      },
    },
    rightPriceScale: {
      borderColor: '#1e2b45',
      scaleMargins: { top: 0.1, bottom: 0.12 },
    },
    timeScale: {
      borderColor: '#1e2b45',
      rightOffset: GUTTER_BARS,
      barSpacing: 8,
      minBarSpacing: 1.5,
      fixLeftEdge: true,
      fixRightEdge: false,
      lockVisibleTimeRangeOnResize: true,
      shiftVisibleRangeOnNewBar: true,
      timeVisible: true,
      secondsVisible: false,
    },
  });

  // Strictly Lightweight Charts v4 API: chart.addCandlestickSeries(...)
  candleSeries = chart.addCandlestickSeries({
    upColor: '#10b981',
    downColor: '#ef4444',
    borderUpColor: '#10b981',
    borderDownColor: '#ef4444',
    wickUpColor: '#10b981',
    wickDownColor: '#ef4444',
    priceFormat: {
      type: 'price',
      precision: 5,
      minMove: 0.00001,
    },
  });

  chart.subscribeCrosshairMove((param) => {
    if (!param || !param.time) {
      state.inspectedTimeSec = null;
      renderHudBar(getCursorBar());
      return;
    }
    const bar = state.barsByTime.get(Number(param.time));
    if (bar) {
      renderHudBar(bar);
    }
  });

  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    if (!chart || state.bars.length === 0 || clampingScroll) return;
    const pos = chart.timeScale().scrollPosition();
    // Prevent dragging far past the fixed right-edge cursor gutter
    if (pos > GUTTER_BARS + 0.25) {
      clampingScroll = true;
      chart.timeScale().scrollToPosition(GUTTER_BARS, false);
      clampingScroll = false;
    }
    updateSnapCursorButton();
  });

  if (typeof window.ResizeObserver === 'function') {
    resizeObserver = new window.ResizeObserver((entries) => {
      if (!chart || !entries.length) return;
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        chart.applyOptions({
          width: Math.floor(width),
          height: Math.floor(height),
        });
      }
    });
    resizeObserver.observe(dom.chartMount);
  } else {
    window.addEventListener('resize', () => {
      if (!chart) return;
      const r = dom.chartMount.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        chart.applyOptions({ width: Math.floor(r.width), height: Math.floor(r.height) });
      }
    });
  }

  return true;
}

function updateSnapCursorButton() {
  if (!chart || state.bars.length === 0) {
    dom.btnSnapCursor.hidden = true;
    return;
  }
  const dist = Math.abs(chart.timeScale().scrollPosition() - GUTTER_BARS);
  dom.btnSnapCursor.hidden = dist <= 1.25;
}

function snapChartToCursor() {
  if (!chart || state.bars.length === 0) return;
  state.inspectedTimeSec = null;
  chart.timeScale().scrollToPosition(GUTTER_BARS, false);
  renderHudBar(getCursorBar());
  updateSnapCursorButton();
}

/* -------------------------------------------------------------------------- */
/* Candle Series, Price Lines & Trade Markers Sync                            */
/* -------------------------------------------------------------------------- */

function toChartCandle(rawBar) {
  return {
    time: isoToUnixSeconds(rawBar.t),
    open: Number(rawBar.o),
    high: Number(rawBar.h),
    low: Number(rawBar.l),
    close: Number(rawBar.c),
  };
}

/**
 * Replaces the entire loaded bar window up to `cursorIso`.
 * Enforces Rule 1: drops any bar with t > cursor, deduplicates & sorts ascending.
 */
function replaceBarsWindow(rawBars, cursorIso, { snapToRight = true } = {}) {
  const cursorSec = isoToUnixSeconds(cursorIso);
  const bySec = new Map();

  if (Array.isArray(rawBars)) {
    for (const bar of rawBars) {
      if (!bar || !bar.t) continue;
      const tSec = isoToUnixSeconds(bar.t);
      if (!Number.isFinite(tSec)) continue;
      if (Number.isFinite(cursorSec) && tSec > cursorSec) {
        continue; // Never accept or cache any bar past the cursor
      }
      bySec.set(tSec, bar);
    }
  }

  const sortedSecs = Array.from(bySec.keys()).sort((a, b) => a - b);
  state.bars = sortedSecs.map((sec) => bySec.get(sec));
  state.barsByTime = bySec;
  state.inspectedTimeSec = null;

  if (candleSeries) {
    const chartData = state.bars.map(toChartCandle);
    candleSeries.setData(chartData);
    if (snapToRight && chartData.length > 0) {
      chart.timeScale().scrollToPosition(GUTTER_BARS, false);
    }
  }

  renderMemo.priceLinesSig = '';
  renderMemo.markersSig = '';
  syncPriceLines();
  syncTradeMarkers();
  renderQuotesAndHud();
  updateSnapCursorButton();
}

/**
 * Incrementally appends new bars returned by POST /api/replay/step.
 * Uses series.update(...) for zero-frame-drop performance at 10x / 50x.
 */
function appendStepBars(newBars, cursorIso) {
  if (!Array.isArray(newBars) || newBars.length === 0) return;
  const cursorSec = isoToUnixSeconds(cursorIso);
  let needsFullReset = false;

  for (const bar of newBars) {
    if (!bar || !bar.t) continue;
    const tSec = isoToUnixSeconds(bar.t);
    if (!Number.isFinite(tSec)) continue;
    if (Number.isFinite(cursorSec) && tSec > cursorSec) {
      continue; // Strict Rule 1 guard
    }

    const lastBar = state.bars[state.bars.length - 1];
    const lastSec = lastBar ? isoToUnixSeconds(lastBar.t) : -Infinity;

    if (tSec > lastSec) {
      state.bars.push(bar);
      state.barsByTime.set(tSec, bar);
      if (candleSeries && !needsFullReset) {
        candleSeries.update(toChartCandle(bar));
      }
    } else if (tSec === lastSec) {
      state.bars[state.bars.length - 1] = bar;
      state.barsByTime.set(tSec, bar);
      if (candleSeries && !needsFullReset) {
        candleSeries.update(toChartCandle(bar));
      }
    } else {
      state.barsByTime.set(tSec, bar);
      needsFullReset = true;
    }
  }

  if (needsFullReset) {
    const sortedSecs = Array.from(state.barsByTime.keys()).sort((a, b) => a - b);
    state.bars = sortedSecs.map((sec) => state.barsByTime.get(sec));
    if (candleSeries) {
      candleSeries.setData(state.bars.map(toChartCandle));
    }
  }

  syncPriceLines();
  syncTradeMarkers();
  renderQuotesAndHud();
  updateSnapCursorButton();
}

function clearPriceLines() {
  if (!candleSeries) return;
  for (const key of ['entry', 'sl', 'tp']) {
    if (activePriceLines[key]) {
      candleSeries.removePriceLine(activePriceLines[key]);
      activePriceLines[key] = null;
    }
  }
}

function syncPriceLines() {
  if (!candleSeries) return;
  const pos = state.session?.position || null;
  const nextSig = pos
    ? `${pos.order_id}|${pos.side}|${pos.dir}|${pos.lots}|${pos.entry}|${pos.sl ?? ''}|${pos.tp ?? ''}`
    : 'flat';
  if (nextSig === renderMemo.priceLinesSig) return;
  renderMemo.priceLinesSig = nextSig;

  clearPriceLines();
  if (!pos) return;

  const LWC = window.LightweightCharts;
  const isBuy = pos.side === 'buy' || pos.dir === 1;

  if (Number.isFinite(Number(pos.entry))) {
    activePriceLines.entry = candleSeries.createPriceLine({
      price: Number(pos.entry),
      color: isBuy ? '#38bdf8' : '#f59e0b',
      lineWidth: 2,
      lineStyle: LWC.LineStyle.Solid,
      axisLabelVisible: true,
      title: `${isBuy ? 'شراء' : 'بيع'} ${formatLots(pos.lots)}`,
    });
  }

  if (pos.sl !== null && pos.sl !== undefined && Number.isFinite(Number(pos.sl))) {
    activePriceLines.sl = candleSeries.createPriceLine({
      price: Number(pos.sl),
      color: '#ef4444',
      lineWidth: 1,
      lineStyle: LWC.LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'SL وقف',
    });
  }

  if (pos.tp !== null && pos.tp !== undefined && Number.isFinite(Number(pos.tp))) {
    activePriceLines.tp = candleSeries.createPriceLine({
      price: Number(pos.tp),
      color: '#10b981',
      lineWidth: 1,
      lineStyle: LWC.LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'TP هدف',
    });
  }
}

/**
 * Snaps an order/trade timestamp onto the nearest loaded candle <= timestamp,
 * ensuring markers survive timeframe switches (e.g. M5 -> H1) and never plot
 * to the right of the current cursor.
 */
function snapIsoToLoadedBarSec(iso, cursorSec) {
  if (!iso || state.bars.length === 0) return null;
  const targetSec = isoToUnixSeconds(iso);
  if (!Number.isFinite(targetSec)) return null;
  if (Number.isFinite(cursorSec) && targetSec > cursorSec) {
    return null; // Never place markers past the cursor
  }

  const firstSec = isoToUnixSeconds(state.bars[0].t);
  if (targetSec < firstSec) {
    return null; // Outside currently loaded 1500-bar window
  }

  if (state.barsByTime.has(targetSec)) {
    return targetSec;
  }

  // Binary search for largest bar time <= targetSec
  let lo = 0;
  let hi = state.bars.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const midSec = isoToUnixSeconds(state.bars[mid].t);
    if (midSec <= targetSec) {
      best = midSec;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function syncTradeMarkers() {
  if (!candleSeries) return;
  if (!state.session || state.bars.length === 0) {
    if (renderMemo.markersSig !== 'empty') {
      renderMemo.markersSig = 'empty';
      candleSeries.setMarkers([]);
    }
    return;
  }

  const trades = Array.isArray(state.session.trades) ? state.session.trades : [];
  const pos = state.session.position;
  const lastTrade = trades[trades.length - 1];
  const nextSig = [
    state.bars[0].t,
    pos ? `${pos.order_id}:${pos.ts}:${pos.lots}:${pos.entry}` : 'flat',
    trades.length,
    lastTrade ? `${lastTrade.order_id}:${lastTrade.exit_ts}:${lastTrade.lots}:${lastTrade.pnl}` : '',
  ].join('|');

  if (nextSig === renderMemo.markersSig) return;
  renderMemo.markersSig = nextSig;

  const cursorSec = isoToUnixSeconds(state.session.cursor);
  const markers = [];
  const seenEntries = new Set();

  // Closed trades markers (entry + exit)
  trades.forEach((tr, idx) => {
    const entryKey = `${tr.order_id || idx}:${tr.entry_ts || ''}`;
    const isBuy = tr.side === 'buy';

    if (!seenEntries.has(entryKey) && tr.entry_ts) {
      const entryBarSec = snapIsoToLoadedBarSec(tr.entry_ts, cursorSec);
      if (entryBarSec !== null) {
        seenEntries.add(entryKey);
        markers.push({
          time: entryBarSec,
          position: isBuy ? 'belowBar' : 'aboveBar',
          color: isBuy ? '#10b981' : '#ef4444',
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          text: `${isBuy ? 'B' : 'S'} ${formatPrice(tr.entry)}`,
          id: `ent_${idx}`,
        });
      }
    }

    if (tr.exit_ts) {
      const exitBarSec = snapIsoToLoadedBarSec(tr.exit_ts, cursorSec);
      if (exitBarSec !== null) {
        const pnlNum = Number(tr.pnl);
        const win = Number.isFinite(pnlNum) && pnlNum >= 0;
        const tag = (tr.reason || 'manual').toUpperCase();
        markers.push({
          time: exitBarSec,
          position: isBuy ? 'aboveBar' : 'belowBar',
          color: win ? '#34d399' : '#f87171',
          shape: 'circle',
          text: `${tag} ${formatSignedNumber(pnlNum, 2)}`,
          id: `ext_${idx}`,
        });
      }
    }
  });

  // Open position entry marker
  if (pos && pos.ts) {
    const openKey = `${pos.order_id || 'open'}:${pos.ts}`;
    if (!seenEntries.has(openKey)) {
      const posBarSec = snapIsoToLoadedBarSec(pos.ts, cursorSec);
      if (posBarSec !== null) {
        const isBuy = pos.side === 'buy' || pos.dir === 1;
        markers.push({
          time: posBarSec,
          position: isBuy ? 'belowBar' : 'aboveBar',
          color: isBuy ? '#38bdf8' : '#f59e0b',
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          text: `${isBuy ? 'BUY' : 'SELL'} ${formatLots(pos.lots)} @ ${formatPrice(pos.entry)}`,
          id: `open_${pos.order_id || 'pos'}`,
        });
      }
    }
  }

  // Lightweight Charts v4 requires markers sorted ascending by time
  markers.sort((a, b) => a.time - b.time);
  candleSeries.setMarkers(markers);
}

/* -------------------------------------------------------------------------- */
/* State Machine & Rendering                                                  */
/* -------------------------------------------------------------------------- */

function setAppState(nextStatus, loadingLabel) {
  state.status = nextStatus;
  document.body.dataset.appState = nextStatus;

  dom.appStatePill.className = `state-pill state-pill--${nextStatus}`;
  dom.appStateText.textContent = STATE_LABELS[nextStatus] || nextStatus;

  if (nextStatus === 'loading') {
    dom.loadingText.textContent = loadingLabel || 'جارٍ تحميل بيانات الجلسة…';
    dom.loadingOverlay.hidden = false;
  } else {
    dom.loadingOverlay.hidden = true;
  }

  dom.atEndBanner.hidden = nextStatus !== 'at_end';
  dom.errorOverlay.hidden = nextStatus !== 'error';

  dom.playPauseIcon.textContent = nextStatus === 'replaying' ? '⏸' : '▶';
  updateInteractiveDisabledStates();
}

function enterErrorState({ title, message, detail, retryFn, canResync = false }) {
  stopReplayLoop();
  state.errorInfo = { title, message, detail, retryFn, canResync };
  dom.errorTitle.textContent = title || 'تعذّر الاتصال بخادم الإعادة';
  dom.errorMessage.textContent =
    message || 'حدث خطأ في الشبكة أو الخادم. تم إيقاف العرض لمنع ظهور شموع متجمدة.';
  dom.errorDetail.textContent = detail || '';
  dom.errorDetail.hidden = !detail;
  dom.btnErrorResync.hidden = !canResync || !state.session?.id;
  setAppState('error');
}

function updateInteractiveDisabledStates() {
  const busyOrErr = state.status === 'loading' || state.status === 'error' || state.status === 'idle';
  const hasSession = Boolean(state.session?.id);
  const atEnd = state.status === 'at_end';
  const hasPos = Boolean(state.session?.position);

  dom.btnPlayPause.disabled = busyOrErr || !hasSession || atEnd;
  dom.btnStepForward.disabled = busyOrErr || !hasSession || atEnd;
  dom.btnViewBack.disabled = busyOrErr || state.bars.length <= 1;
  dom.btnRewind.disabled = busyOrErr || !hasSession;
  dom.btnReplaySeek.disabled = busyOrErr || !hasSession;
  dom.btnPanelSeek.disabled = busyOrErr || !hasSession;
  dom.btnTopSave.disabled = busyOrErr || !hasSession;
  dom.btnPanelSave.disabled = busyOrErr || !hasSession;
  dom.btnNewSession.disabled = state.status === 'loading' || state.status === 'error';

  dom.btnBuy.disabled = busyOrErr || !hasSession;
  dom.btnSell.disabled = busyOrErr || !hasSession;
  dom.btnCloseFull.disabled = busyOrErr || !hasSession || !hasPos;
  dom.btnClosePartial.disabled = busyOrErr || !hasSession || !hasPos;

  for (const btn of dom.closePctButtons) {
    const posLots = Number(state.session?.position?.lots || 0);
    const pct = Number(btn.dataset.closePct);
    const computedLots = Math.round(posLots * pct * 100) / 100;
    btn.disabled = busyOrErr || !hasPos || computedLots < 0.01 || computedLots >= posLots;
  }

  const tfButtons = dom.tfPills.querySelectorAll('.tf-pill');
  tfButtons.forEach((btn) => {
    btn.disabled = busyOrErr || !hasSession;
  });
}

function getCursorBar() {
  return state.bars.length > 0 ? state.bars[state.bars.length - 1] : null;
}

function renderHudBar(bar) {
  const sym = state.meta?.symbol || 'EURUSD';
  const tf = state.session?.tf || state.preferredTf;
  dom.hudSymbol.textContent = sym;
  dom.hudTf.textContent = tf;

  if (!bar) {
    dom.hudTime.textContent = '—';
    dom.hudO.textContent = '—';
    dom.hudH.textContent = '—';
    dom.hudL.textContent = '—';
    dom.hudC.textContent = '—';
    dom.hudV.textContent = '—';
    return;
  }

  dom.hudTime.textContent = formatIsoUtcDisplay(bar.t, false);
  dom.hudO.textContent = formatPrice(bar.o);
  dom.hudH.textContent = formatPrice(bar.h);
  dom.hudL.textContent = formatPrice(bar.l);
  dom.hudC.textContent = formatPrice(bar.c);
  dom.hudV.textContent = Number.isFinite(Number(bar.v)) ? intFmt.format(Number(bar.v)) : '—';
}

function renderQuotesAndHud() {
  const latest = getCursorBar();
  const bid = latest ? (latest.bid_c ?? latest.c) : null;
  const ask = latest ? (latest.ask_c ?? latest.c) : null;

  dom.topBid.textContent = bid !== null ? formatPrice(bid) : '—';
  dom.topAsk.textContent = ask !== null ? formatPrice(ask) : '—';
  dom.btnSellPrice.textContent = bid !== null ? formatPrice(bid) : '—';
  dom.btnBuyPrice.textContent = ask !== null ? formatPrice(ask) : '—';

  const inspectedBar =
    state.inspectedTimeSec !== null ? state.barsByTime.get(state.inspectedTimeSec) : null;
  renderHudBar(inspectedBar || latest);

  dom.infoBarsLoaded.textContent = `${intFmt.format(state.bars.length)}${
    state.hasMoreBefore ? ' (يتوفر تاريخ أقدم)' : ''
  }`;
}

function renderMetaUI() {
  if (!state.meta) return;
  const symbol = state.meta.symbol || 'EURUSD';
  dom.symbolLabel.textContent = symbol;
  dom.hudSymbol.textContent = symbol;

  const tfs = Array.isArray(state.meta.timeframes) && state.meta.timeframes.length > 0
    ? state.meta.timeframes
    : ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

  // Rebuild timeframe pills from /api/meta
  dom.tfPills.innerHTML = '';
  const activeTf = state.session?.tf || state.preferredTf;
  for (const tf of tfs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tf-pill${tf === activeTf ? ' is-active' : ''}`;
    btn.dataset.tf = tf;
    const bdi = document.createElement('bdi');
    bdi.className = 'num';
    bdi.dir = 'ltr';
    bdi.textContent = tf;
    btn.appendChild(bdi);
    dom.tfPills.appendChild(btn);
  }

  // Rebuild new-session timeframe select
  dom.newSessionTf.innerHTML = '';
  for (const tf of tfs) {
    const opt = document.createElement('option');
    opt.value = tf;
    opt.textContent = tf;
    if (tf === activeTf) opt.selected = true;
    dom.newSessionTf.appendChild(opt);
  }

  // Configure dataset min/max bounds on datetime-local inputs
  const fromIso = state.meta.data?.from;
  const toIso = state.meta.data?.to;
  const minLocal = isoToDatetimeLocalValue(fromIso);
  const maxLocal = isoToDatetimeLocalValue(toIso);

  for (const input of [dom.replaySeekInput, dom.panelSeekInput, dom.newSessionStart]) {
    if (minLocal) input.min = minLocal;
    if (maxLocal) input.max = maxLocal;
  }

  dom.infoDataRange.textContent =
    fromIso && toIso
      ? `${formatIsoUtcDisplay(fromIso, false)} → ${formatIsoUtcDisplay(toIso, false)}`
      : '—';
}

function renderSessionUI({ syncSeekInputs = false } = {}) {
  const sess = state.session;
  if (!sess) {
    dom.sessionName.textContent = '—';
    dom.exchangeClock.textContent = '—';
    dom.accountBalance.textContent = '—';
    dom.accountEquity.textContent = '—';
    return;
  }

  dom.sessionName.textContent = sess.id;
  dom.infoSessionId.textContent = sess.id;
  dom.infoSessionTf.textContent = sess.tf;
  dom.exchangeClock.textContent = formatIsoUtcDisplay(sess.cursor, true);
  dom.accountBalance.textContent = formatMoney(sess.balance);
  dom.accountEquity.textContent = formatMoney(sess.equity);

  // Highlight active timeframe pill
  dom.tfPills.querySelectorAll('.tf-pill').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tf === sess.tf);
  });

  if (syncSeekInputs) {
    const cursorLocal = isoToDatetimeLocalValue(sess.cursor);
    if (cursorLocal) {
      if (document.activeElement !== dom.replaySeekInput) {
        dom.replaySeekInput.value = cursorLocal;
      }
      if (document.activeElement !== dom.panelSeekInput) {
        dom.panelSeekInput.value = cursorLocal;
      }
    }
  }

  renderOpenPositionUI(sess);
  renderTradesUI(sess);
  renderSavedSessionsUI();
  updateInteractiveDisabledStates();
}

function renderOpenPositionUI(sess) {
  const pos = sess?.position || null;
  dom.positionIndicatorDot.hidden = !pos;

  if (!pos) {
    dom.openPosBadge.className = 'pos-badge pos-badge--flat';
    dom.openPosBadge.textContent = 'بدون مركز';
    dom.openPosEmpty.hidden = false;
    dom.openPosDetails.hidden = true;
    return;
  }

  const isBuy = pos.side === 'buy' || pos.dir === 1;
  dom.openPosBadge.className = `pos-badge ${isBuy ? 'pos-badge--buy' : 'pos-badge--sell'}`;
  dom.openPosBadge.textContent = isBuy ? 'شراء BUY' : 'بيع SELL';
  dom.openPosEmpty.hidden = true;
  dom.openPosDetails.hidden = false;

  dom.posOrderId.textContent = pos.order_id || '—';
  dom.posLots.textContent = formatLots(pos.lots);
  dom.posEntry.textContent = formatPrice(pos.entry);
  dom.posTs.textContent = formatIsoUtcDisplay(pos.ts, false);
  dom.posSl.textContent = pos.sl !== null && pos.sl !== undefined ? formatPrice(pos.sl) : '—';
  dom.posTp.textContent = pos.tp !== null && pos.tp !== undefined ? formatPrice(pos.tp) : '—';
  dom.posBalance.textContent = formatMoney(sess.balance);
  dom.posEquity.textContent = formatMoney(sess.equity);

  if (document.activeElement !== dom.closeLotsInput) {
    const half = Math.max(0.01, Math.round(Number(pos.lots) * 50) / 100);
    dom.closeLotsInput.max = String(pos.lots);
    if (!dom.closeLotsInput.value || Number(dom.closeLotsInput.value) > Number(pos.lots)) {
      dom.closeLotsInput.value = Math.min(half, Number(pos.lots)).toFixed(2);
    }
  }
}

function renderTradesUI(sess) {
  const trades = Array.isArray(sess?.trades) ? sess.trades : [];
  const lastTr = trades[trades.length - 1];
  const nextSig = `${sess?.id || ''}|${trades.length}|${
    lastTr ? `${lastTr.order_id}:${lastTr.exit_ts}:${lastTr.lots}:${lastTr.pnl}` : ''
  }`;
  if (nextSig === renderMemo.tradesSig) return;
  renderMemo.tradesSig = nextSig;

  dom.tradesCountBadge.textContent = String(trades.length);
  dom.statTradeCount.textContent = intFmt.format(trades.length);

  if (trades.length === 0) {
    dom.statRunningPnl.textContent = '$0.00';
    dom.statRunningPnl.className = 'num stat-card__value';
    dom.statWinRate.textContent = '—';
    dom.statExpectancy.textContent = '—';
    dom.statExpectancy.className = 'num stat-card__value';
    dom.tradesEmpty.hidden = false;
    dom.tradesTableWrap.hidden = true;
    dom.tradesTbody.innerHTML = '';
    return;
  }

  dom.tradesEmpty.hidden = true;
  dom.tradesTableWrap.hidden = false;

  // Prefer server-supplied summary fields if present; otherwise summarize strictly
  // over server-reported `trade.pnl` rows (zero price/pip/contract P&L calculation).
  let cumulative = 0;
  let wins = 0;
  const rowsFragment = document.createDocumentFragment();

  trades.forEach((tr, idx) => {
    const serverPnl = Number(tr.pnl) || 0;
    cumulative += serverPnl;
    if (serverPnl > 0) wins += 1;

    const row = document.createElement('tr');
    row.dataset.entryTs = tr.entry_ts || '';
    row.dataset.exitTs = tr.exit_ts || '';
    row.title = 'انقر للانتقال في العرض إلى توقيت الصفقة';

    const isBuy = tr.side === 'buy';
    const pnlCls = serverPnl > 0 ? 'pnl-pos' : serverPnl < 0 ? 'pnl-neg' : '';
    const cumCls = cumulative > 0 ? 'pnl-pos' : cumulative < 0 ? 'pnl-neg' : '';
    const reasonText = REASON_LABELS[tr.reason] || tr.reason || '—';

    // Cell 1: Order ID + Side
    const tdOrder = document.createElement('td');
    const sideSpan = document.createElement('span');
    sideSpan.className = `trade-side-tag ${isBuy ? 'trade-side-tag--buy' : 'trade-side-tag--sell'}`;
    sideSpan.textContent = isBuy ? 'شراء' : 'بيع';
    const orderBdi = document.createElement('bdi');
    orderBdi.className = 'num';
    orderBdi.dir = 'ltr';
    orderBdi.style.display = 'block';
    orderBdi.style.color = '#98a8c3';
    orderBdi.textContent = tr.order_id || `#${idx + 1}`;
    tdOrder.append(sideSpan, orderBdi);

    // Cell 2: Lots
    const tdLots = document.createElement('td');
    const lotsBdi = document.createElement('bdi');
    lotsBdi.className = 'num';
    lotsBdi.dir = 'ltr';
    lotsBdi.textContent = formatLots(tr.lots);
    tdLots.appendChild(lotsBdi);

    // Cell 3: Entry -> Exit
    const tdPrices = document.createElement('td');
    const pricesBdi = document.createElement('bdi');
    pricesBdi.className = 'num';
    pricesBdi.dir = 'ltr';
    pricesBdi.style.display = 'block';
    pricesBdi.textContent = `${formatPrice(tr.entry)} → ${formatPrice(tr.exit)}`;
    const timesBdi = document.createElement('bdi');
    timesBdi.className = 'num';
    timesBdi.dir = 'ltr';
    timesBdi.style.display = 'block';
    timesBdi.style.fontSize = '10px';
    timesBdi.style.color = '#667897';
    timesBdi.textContent = formatIsoUtcDisplay(tr.exit_ts || tr.entry_ts, false);
    tdPrices.append(pricesBdi, timesBdi);

    // Cell 4: Reason
    const tdReason = document.createElement('td');
    const reasonSpan = document.createElement('span');
    reasonSpan.className = 'reason-tag';
    reasonSpan.textContent = reasonText;
    tdReason.appendChild(reasonSpan);

    // Cell 5: Server Trade P&L
    const tdPnl = document.createElement('td');
    const pnlBdi = document.createElement('bdi');
    pnlBdi.className = `num ${pnlCls}`;
    pnlBdi.dir = 'ltr';
    pnlBdi.textContent = formatMoney(serverPnl, true);
    tdPnl.appendChild(pnlBdi);

    // Cell 6: Running P&L
    const tdCum = document.createElement('td');
    const cumBdi = document.createElement('bdi');
    cumBdi.className = `num ${cumCls}`;
    cumBdi.dir = 'ltr';
    cumBdi.textContent = formatMoney(cumulative, true);
    tdCum.appendChild(cumBdi);

    row.append(tdOrder, tdLots, tdPrices, tdReason, tdPnl, tdCum);
    rowsFragment.appendChild(row);
  });

  dom.tradesTbody.innerHTML = '';
  dom.tradesTbody.appendChild(rowsFragment);

  const runningPnl = sess.stats?.running_pnl ?? cumulative;
  const winRatePct =
    sess.stats?.win_rate !== undefined
      ? Number(sess.stats.win_rate)
      : (wins / trades.length) * 100;
  const expectancyVal =
    sess.stats?.expectancy !== undefined
      ? Number(sess.stats.expectancy)
      : cumulative / trades.length;

  dom.statRunningPnl.textContent = formatMoney(runningPnl, true);
  dom.statRunningPnl.className = `num stat-card__value ${
    runningPnl > 0 ? 'pnl-pos' : runningPnl < 0 ? 'pnl-neg' : ''
  }`;

  dom.statWinRate.textContent = `${winRatePct.toFixed(1)}%`;

  dom.statExpectancy.textContent = formatMoney(expectancyVal, true);
  dom.statExpectancy.className = `num stat-card__value ${
    expectancyVal > 0 ? 'pnl-pos' : expectancyVal < 0 ? 'pnl-neg' : ''
  }`;
}

function renderSavedSessionsUI() {
  const list = Array.isArray(state.savedSessions) ? state.savedSessions : [];
  const currentId = state.session?.id || '';
  const nextSig = `${currentId}|${list.map((s) => `${s.id}:${s.tf}:${s.cursor}`).join(',')}`;
  if (nextSig === renderMemo.savedSessionsSig) return;
  renderMemo.savedSessionsSig = nextSig;

  if (list.length === 0) {
    dom.savedSessionsEmpty.hidden = false;
    dom.savedSessionsList.hidden = true;
    dom.savedSessionsList.innerHTML = '';
    return;
  }

  dom.savedSessionsEmpty.hidden = true;
  dom.savedSessionsList.hidden = false;
  dom.savedSessionsList.innerHTML = '';

  for (const item of list) {
    const li = document.createElement('li');
    li.className = `session-item${item.id === currentId ? ' is-current' : ''}`;

    const metaDiv = document.createElement('div');
    metaDiv.className = 'session-item__meta';

    const idBdi = document.createElement('bdi');
    idBdi.className = 'num session-item__id';
    idBdi.dir = 'ltr';
    idBdi.textContent = `${item.id} · ${item.tf || ''}`;

    const subBdi = document.createElement('bdi');
    subBdi.className = 'num session-item__sub';
    subBdi.dir = 'ltr';
    subBdi.textContent = formatIsoUtcDisplay(item.cursor, false);

    metaDiv.append(idBdi, subBdi);

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'btn btn--secondary btn--xs';
    loadBtn.dataset.loadSessionId = item.id;
    loadBtn.textContent = item.id === currentId ? 'إعادة تحميل' : 'تحميل';

    li.append(metaDiv, loadBtn);
    dom.savedSessionsList.appendChild(li);
  }
}

function renderSpeedPills() {
  dom.speedPills.querySelectorAll('.speed-pill').forEach((btn) => {
    btn.classList.toggle('is-active', Number(btn.dataset.speed) === state.speed);
  });
}

function showToast(text, variant = 'ok') {
  const el = document.createElement('div');
  el.className = `toast toast--${variant}`;
  el.textContent = text;
  dom.toastArea.appendChild(el);
  window.setTimeout(() => {
    el.remove();
  }, 2800);
}

/* -------------------------------------------------------------------------- */
/* Session Boot, Sync & Replay Actions                                        */
/* -------------------------------------------------------------------------- */

function applySessionPayload(payload, { recordAsStart = false } = {}) {
  const prevTrades = state.session?.trades || [];
  let nextTrades = prevTrades;

  if (Array.isArray(payload.trades)) {
    nextTrades = payload.trades;
  } else if (Array.isArray(payload.closed) && payload.closed.length > 0) {
    nextTrades = [...prevTrades, ...payload.closed];
  }

  state.session = {
    ...(state.session || {}),
    id: payload.id ?? state.session?.id,
    tf: payload.tf ?? state.session?.tf ?? state.preferredTf,
    cursor: payload.cursor ?? state.session?.cursor,
    balance: payload.balance ?? state.session?.balance ?? 0,
    equity: payload.equity ?? state.session?.equity ?? 0,
    position: payload.position !== undefined ? payload.position : (state.session?.position ?? null),
    orders: Array.isArray(payload.orders) ? payload.orders : (state.session?.orders ?? []),
    trades: nextTrades,
    stats: payload.stats ?? state.session?.stats,
  };

  if (state.session.id) {
    safeSetStorage(STORAGE_KEYS.SESSION_ID, state.session.id);
    if (recordAsStart || !state.sessionStartById.has(state.session.id)) {
      const startCursor = payload.start || payload.initial_cursor || state.session.cursor;
      if (startCursor) {
        state.sessionStartById.set(state.session.id, startCursor);
      }
    }
  }

  if (state.session.tf) {
    state.preferredTf = state.session.tf;
    safeSetStorage(STORAGE_KEYS.TIMEFRAME, state.session.tf);
  }
}

async function fetchBarsForCurrentSession({ snapToRight = true } = {}) {
  const sessionId = state.session?.id;
  if (!sessionId) return;
  const barsResp = await apiRequest(
    `/api/bars?session=${encodeURIComponent(sessionId)}&limit=${BARS_FETCH_LIMIT}`
  );
  if (barsResp.cursor) {
    state.session.cursor = barsResp.cursor;
  }
  state.hasMoreBefore = Boolean(barsResp.has_more_before);
  replaceBarsWindow(barsResp.bars || [], state.session.cursor, { snapToRight });
}

async function refreshSavedSessionsQuietly() {
  try {
    const resp = await apiRequest('/api/sessions');
    state.savedSessions = Array.isArray(resp.sessions) ? resp.sessions : [];
    renderSavedSessionsUI();
  } catch {
    // Non-fatal background list refresh
  }
}

function computeDefaultStartIso(meta) {
  const fromMs = Date.parse(meta?.data?.from || '');
  const toMs = Date.parse(meta?.data?.to || '');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return null;
  }
  // Start ~50% through the dataset so >=500 historical bars exist behind the cursor
  // AND ample forward bars exist for immediate play/step replay.
  const midMs = fromMs + Math.floor((toMs - fromMs) * 0.5);
  const roundedMinuteMs = Math.floor(midMs / 60000) * 60000;
  return new Date(roundedMinuteMs).toISOString().replace('.000Z', 'Z');
}

async function bootApplication() {
  if (!initChart()) return;
  renderSpeedPills();
  setAppState('loading', 'جارٍ الاتصال بخادم الإعادة…');

  try {
    state.meta = await apiRequest('/api/meta');
    renderMetaUI();

    const storedId = safeGetStorage(STORAGE_KEYS.SESSION_ID);
    let restored = false;

    if (storedId) {
      try {
        const existing = await apiRequest(`/api/session/${encodeURIComponent(storedId)}`);
        applySessionPayload(existing, { recordAsStart: true });
        restored = true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          // Try loading from persisted sessions on disk before creating a new one
          try {
            const loaded = await apiRequest(
              `/api/session/${encodeURIComponent(storedId)}/load`,
              { method: 'POST' }
            );
            applySessionPayload(loaded, { recordAsStart: true });
            restored = true;
          } catch (loadErr) {
            if (loadErr instanceof ApiError && loadErr.status === 404) {
              safeRemoveStorage(STORAGE_KEYS.SESSION_ID);
            } else {
              throw loadErr;
            }
          }
        } else {
          throw err;
        }
      }
    }

    if (!restored) {
      const supportedTfs = state.meta.timeframes || [];
      const tf = supportedTfs.includes(state.preferredTf)
        ? state.preferredTf
        : (supportedTfs.includes(DEFAULT_TF) ? DEFAULT_TF : (supportedTfs[0] || DEFAULT_TF));
      const defaultStart = computeDefaultStartIso(state.meta);
      const body = defaultStart ? { tf, start: defaultStart } : { tf };
      const created = await apiRequest('/api/session', { method: 'POST', body });
      applySessionPayload(created, { recordAsStart: true });
    }

    // Default the new-session start picker to midpoint for convenience
    const midDefault = computeDefaultStartIso(state.meta);
    if (midDefault && !dom.newSessionStart.value) {
      dom.newSessionStart.value = isoToDatetimeLocalValue(midDefault);
    }

    await fetchBarsForCurrentSession({ snapToRight: true });
    renderSessionUI({ syncSeekInputs: true });
    setAppState('paused');
    refreshSavedSessionsQuietly();
  } catch (err) {
    enterErrorState({
      title: 'تعذّر تهيئة جلسة الإعادة',
      message: err?.message || 'فشل الاتصال بالخادم المحلي على نفس النطاق.',
      detail: err?.detail || String(err),
      retryFn: () => bootApplication(),
      canResync: false,
    });
  }
}

async function resyncCurrentSession() {
  if (!state.session?.id) {
    return bootApplication();
  }
  stopReplayLoop();
  setAppState('loading', 'جارٍ مزامنة حالة الجلسة…');
  try {
    const fresh = await apiRequest(`/api/session/${encodeURIComponent(state.session.id)}`);
    applySessionPayload(fresh);
    await fetchBarsForCurrentSession({ snapToRight: true });
    renderSessionUI({ syncSeekInputs: true });
    setAppState('paused');
  } catch (err) {
    enterErrorState({
      title: 'فشلت مزامنة الجلسة',
      message: err?.message || 'تعذّر جلب حالة الجلسة من الخادم.',
      detail: err?.detail || String(err),
      retryFn: () => resyncCurrentSession(),
      canResync: false,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Replay Loop & Stepping                                                     */
/* -------------------------------------------------------------------------- */

function stopReplayLoop() {
  if (state.replayTimerId !== null) {
    window.clearTimeout(state.replayTimerId);
    state.replayTimerId = null;
  }
  if (state.replayAbortCtrl) {
    state.replayAbortCtrl.abort();
    state.replayAbortCtrl = null;
  }
}

async function executeSingleStep({ fromLoop = false } = {}) {
  if (!state.session?.id) return { ended: true };

  const prevCursor = state.session.cursor;
  const abortCtrl = new AbortController();
  if (fromLoop) {
    state.replayAbortCtrl = abortCtrl;
  }

  const resp = await apiRequest('/api/replay/step', {
    method: 'POST',
    body: { session: state.session.id, bars: 1 },
    signal: abortCtrl.signal,
  });

  if (fromLoop && state.replayAbortCtrl === abortCtrl) {
    state.replayAbortCtrl = null;
  }

  const newBars = Array.isArray(resp.new_bars) ? resp.new_bars : [];
  const unchangedCursor = !resp.cursor || resp.cursor === prevCursor;

  // Contract: empty new_bars + unchanged cursor => at_end (never tight-poll)
  if (newBars.length === 0 && unchangedCursor) {
    applySessionPayload(resp);
    renderSessionUI({ syncSeekInputs: true });
    stopReplayLoop();
    setAppState('at_end');
    return { ended: true };
  }

  const closedNow = Array.isArray(resp.closed) ? resp.closed : [];
  applySessionPayload(resp);
  appendStepBars(newBars, state.session.cursor);

  // If a trade auto-closed (SL/TP) and the step payload omitted full trade details, sync once
  if (
    closedNow.length > 0 &&
    !Array.isArray(resp.trades) &&
    closedNow.some((c) => c.pnl === undefined || c.entry_ts === undefined)
  ) {
    const full = await apiRequest(`/api/session/${encodeURIComponent(state.session.id)}`);
    applySessionPayload(full);
    syncPriceLines();
    syncTradeMarkers();
  }

  if (closedNow.length > 0) {
    const r = closedNow[0]?.reason;
    const reasonAr = REASON_LABELS[r] || 'تلقائياً';
    showToast(`أُغلق المركز (${reasonAr})`, 'warn');
  }

  renderSessionUI({ syncSeekInputs: !fromLoop });
  return { ended: false };
}

function scheduleNextReplayTick(startedAtMs) {
  if (state.status !== 'replaying') return;
  const targetIntervalMs = Math.max(20, Math.round(1000 / state.speed));
  const elapsed = performance.now() - startedAtMs;
  const delay = Math.max(4, targetIntervalMs - elapsed);

  state.replayTimerId = window.setTimeout(async () => {
    state.replayTimerId = null;
    if (state.status !== 'replaying') return;
    const tickStart = performance.now();
    try {
      const { ended } = await executeSingleStep({ fromLoop: true });
      if (!ended && state.status === 'replaying') {
        scheduleNextReplayTick(tickStart);
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      enterErrorState({
        title: 'توقفت الإعادة بسبب خطأ في الاتصال',
        message: err?.message || 'انقطع الاتصال بالخادم أثناء تشغيل الشموع.',
        detail: err?.detail || String(err),
        retryFn: async () => {
          await resyncCurrentSession();
          if (state.status === 'paused') {
            startReplay();
          }
        },
        canResync: true,
      });
    }
  }, delay);
}

function startReplay() {
  if (!state.session?.id || state.status === 'loading' || state.status === 'at_end') return;
  stopReplayLoop();
  snapChartToCursor();
  setAppState('replaying');
  scheduleNextReplayTick(performance.now() - 1000);
}

function pauseReplay() {
  if (state.status !== 'replaying') return;
  stopReplayLoop();
  renderSessionUI({ syncSeekInputs: true });
  setAppState('paused');
}

function togglePlayPause() {
  if (state.status === 'replaying') {
    pauseReplay();
  } else if (state.status === 'paused') {
    startReplay();
  }
}

async function stepForwardOnce() {
  if (!state.session?.id || state.opLock || state.status === 'loading' || state.status === 'at_end') {
    return;
  }
  if (state.status === 'replaying') {
    pauseReplay();
  }
  state.opLock = true;
  snapChartToCursor();
  try {
    const { ended } = await executeSingleStep({ fromLoop: false });
    if (!ended && state.status !== 'at_end') {
      setAppState('paused');
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    enterErrorState({
      title: 'تعذّر التقدم للشمعة التالية',
      message: err?.message || 'فشل طلب خطوة الإعادة.',
      detail: err?.detail || String(err),
      retryFn: () => stepForwardOnce(),
      canResync: true,
    });
  } finally {
    state.opLock = false;
  }
}

/**
 * Client-side view step back (`←`):
 * Pans the viewport one bar earlier and moves HUD inspection back within
 * already-loaded bars without touching the server cursor or revealing new bars.
 */
function stepViewBackClientOnly() {
  if (!chart || state.bars.length <= 1) return;
  if (state.status === 'replaying') {
    pauseReplay();
  }

  const currentScroll = chart.timeScale().scrollPosition();
  const minScroll = -(state.bars.length - 5);
  const nextScroll = Math.max(minScroll, currentScroll - 1);
  chart.timeScale().scrollToPosition(nextScroll, false);

  // Also step the HUD bar readout one bar earlier
  let currentIdx = state.bars.length - 1;
  if (state.inspectedTimeSec !== null) {
    const found = state.bars.findIndex((b) => isoToUnixSeconds(b.t) === state.inspectedTimeSec);
    if (found >= 0) currentIdx = found;
  }
  const prevIdx = Math.max(0, currentIdx - 1);
  state.inspectedTimeSec = isoToUnixSeconds(state.bars[prevIdx].t);
  renderHudBar(state.bars[prevIdx]);
  updateSnapCursorButton();
}

function setReplaySpeed(nextSpeed) {
  const num = Number(nextSpeed);
  if (!VALID_SPEEDS.includes(num)) return;
  state.speed = num;
  safeSetStorage(STORAGE_KEYS.SPEED, num);
  renderSpeedPills();
}

/* -------------------------------------------------------------------------- */
/* Seek, Rewind, Timeframe Switch, Session Save/Load/Create                   */
/* -------------------------------------------------------------------------- */

async function seekToIso(targetIso) {
  if (!state.session?.id || !targetIso || state.opLock) return;
  stopReplayLoop();
  state.opLock = true;
  setAppState('loading', 'جارٍ الانتقال الزمني وإعادة بناء الشموع…');

  try {
    const resp = await apiRequest('/api/replay/seek', {
      method: 'POST',
      body: { session: state.session.id, to: targetIso },
    });

    applySessionPayload(resp);

    // Ensure full authoritative trade list if `/api/replay/seek` returned summary + closed only
    if (!Array.isArray(resp.trades)) {
      const full = await apiRequest(`/api/session/${encodeURIComponent(state.session.id)}`);
      applySessionPayload(full);
    }

    await fetchBarsForCurrentSession({ snapToRight: true });
    renderSessionUI({ syncSeekInputs: true });
    setAppState('paused');

    if (Array.isArray(resp.closed) && resp.closed.length > 0) {
      showToast('تم إغلاق المركز المفتوح بسعر السوق قبل الانتقال الزمني.', 'warn');
    } else {
      showToast('تم تحديث موقع المؤشر بنجاح.');
    }
  } catch (err) {
    enterErrorState({
      title: 'فشل الانتقال الزمني (Seek)',
      message: err?.message || 'تعذّر الانتقال إلى التوقيت المحدد.',
      detail: err?.detail || String(err),
      retryFn: () => seekToIso(targetIso),
      canResync: true,
    });
  } finally {
    state.opLock = false;
  }
}

function rewindToSessionStart() {
  if (!state.session?.id) return;
  const startIso =
    state.sessionStartById.get(state.session.id) ||
    (state.bars.length > 0 ? state.bars[0].t : state.meta?.data?.from);
  if (!startIso) return;
  seekToIso(startIso);
}

async function switchTimeframe(nextTf) {
  if (!state.session?.id || !nextTf || state.opLock) return;
  if (nextTf === state.session.tf && state.status !== 'error') return;

  stopReplayLoop();
  state.opLock = true;
  const sessionId = state.session.id;
  setAppState('loading', `جارٍ التبديل إلى الإطار الزمني ${nextTf}…`);

  try {
    const updated = await apiRequest(`/api/session/${encodeURIComponent(sessionId)}/tf`, {
      method: 'POST',
      body: { tf: nextTf },
    });
    applySessionPayload(updated);
    await fetchBarsForCurrentSession({ snapToRight: true });
    renderSessionUI({ syncSeekInputs: true });
    setAppState('paused');
  } catch (err) {
    enterErrorState({
      title: `تعذّر التبديل إلى الإطار ${nextTf}`,
      message: err?.message || 'فشل طلب تغيير الإطار الزمني.',
      detail: err?.detail || String(err),
      retryFn: () => switchTimeframe(nextTf),
      canResync: true,
    });
  } finally {
    state.opLock = false;
  }
}

async function saveCurrentSession() {
  if (!state.session?.id || state.opLock) return;
  const wasReplaying = state.status === 'replaying';
  if (wasReplaying) pauseReplay();
  state.opLock = true;

  try {
    await apiRequest(`/api/session/${encodeURIComponent(state.session.id)}/save`, {
      method: 'POST',
    });
    showToast(`تم حفظ الجلسة (${state.session.id}) بنجاح.`);
    await refreshSavedSessionsQuietly();
  } catch (err) {
    enterErrorState({
      title: 'تعذّر حفظ الجلسة',
      message: err?.message || 'فشل حفظ الجلسة على الخادم.',
      detail: err?.detail || String(err),
      retryFn: () => saveCurrentSession(),
      canResync: true,
    });
  } finally {
    state.opLock = false;
  }
}

async function loadSavedSession(targetId) {
  if (!targetId || state.opLock) return;
  stopReplayLoop();
  state.opLock = true;
  setAppState('loading', `جارٍ تحميل الجلسة ${targetId}…`);

  try {
    const loaded = await apiRequest(`/api/session/${encodeURIComponent(targetId)}/load`, {
      method: 'POST',
    });
    state.session = null;
    applySessionPayload(loaded, { recordAsStart: true });
    await fetchBarsForCurrentSession({ snapToRight: true });
    renderSessionUI({ syncSeekInputs: true });
    setAppState('paused');
    showToast(`تم تحميل الجلسة ${targetId}.`);
  } catch (err) {
    enterErrorState({
      title: `تعذّر تحميل الجلسة ${targetId}`,
      message: err?.message || 'فشل استرجاع الجلسة المحفوظة.',
      detail: err?.detail || String(err),
      retryFn: () => loadSavedSession(targetId),
      canResync: Boolean(state.session?.id),
    });
  } finally {
    state.opLock = false;
  }
}

async function createNewSession() {
  if (state.opLock) return;
  stopReplayLoop();
  state.opLock = true;

  const tf = dom.newSessionTf.value || state.preferredTf || DEFAULT_TF;
  const startRaw = dom.newSessionStart.value.trim();
  const startIso = startRaw ? datetimeLocalValueToIsoUtc(startRaw) : null;
  const body = startIso ? { tf, start: startIso } : { tf };

  setAppState('loading', 'جارٍ إنشاء جلسة تدريب جديدة…');

  try {
    const created = await apiRequest('/api/session', { method: 'POST', body });
    state.session = null;
    applySessionPayload(created, { recordAsStart: true });
    await fetchBarsForCurrentSession({ snapToRight: true });
    renderSessionUI({ syncSeekInputs: true });
    setAppState('paused');
    showToast(`بدأت جلسة جديدة (${created.id}).`);
    refreshSavedSessionsQuietly();
  } catch (err) {
    enterErrorState({
      title: 'تعذّر إنشاء جلسة جديدة',
      message: err?.message || 'فشل إنشاء الجلسة على الخادم.',
      detail: err?.detail || String(err),
      retryFn: () => createNewSession(),
      canResync: Boolean(state.session?.id),
    });
  } finally {
    state.opLock = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Trading Actions: Market Buy/Sell & Full/Partial Close                      */
/* -------------------------------------------------------------------------- */

function parseOptionalPriceInput(inputEl) {
  const raw = inputEl.value.trim();
  if (!raw) return null;
  const val = Number(raw);
  if (!Number.isFinite(val) || val <= 0) return NaN;
  return Number(val.toFixed(5));
}

async function submitMarketOrder(side) {
  if (!state.session?.id || state.opLock || state.status === 'loading' || state.status === 'error') {
    return;
  }
  const lotsRaw = Number(dom.orderLots.value);
  if (!Number.isFinite(lotsRaw) || lotsRaw <= 0) {
    showToast('يرجى إدخال حجم عقد (Lots) صالح أكبر من صفر.', 'warn');
    dom.orderLots.focus();
    return;
  }
  const lots = Math.round(lotsRaw * 100) / 100;

  const sl = parseOptionalPriceInput(dom.orderSl);
  if (Number.isNaN(sl)) {
    showToast('قيمة وقف الخسارة (SL) غير صالحة.', 'warn');
    dom.orderSl.focus();
    return;
  }

  const tp = parseOptionalPriceInput(dom.orderTp);
  if (Number.isNaN(tp)) {
    showToast('قيمة جني الأرباح (TP) غير صالحة.', 'warn');
    dom.orderTp.focus();
    return;
  }

  const wasReplaying = state.status === 'replaying';
  if (wasReplaying) pauseReplay();
  state.opLock = true;
  updateInteractiveDisabledStates();

  try {
    const orderResp = await apiRequest('/api/orders', {
      method: 'POST',
      body: {
        session: state.session.id,
        side,
        lots,
        sl,
        tp,
      },
    });

    // POST /api/orders returns { order_id, fill_price, ts } -> fetch authoritative session state
    const fullState = await apiRequest(`/api/session/${encodeURIComponent(state.session.id)}`);
    applySessionPayload(fullState);
    syncPriceLines();
    syncTradeMarkers();
    renderSessionUI({ syncSeekInputs: false });

    const sideLabel = side === 'buy' ? 'شراء' : 'بيع';
    showToast(`تم تنفيذ أمر ${sideLabel} (${formatLots(lots)}) بسعر ${formatPrice(orderResp.fill_price)}`);
  } catch (err) {
    enterErrorState({
      title: 'تعذّر تنفيذ أمر السوق',
      message: err?.message || 'رفض الخادم أمر التداول أو انقطع الاتصال.',
      detail: err?.detail || String(err),
      retryFn: () => submitMarketOrder(side),
      canResync: true,
    });
  } finally {
    state.opLock = false;
    updateInteractiveDisabledStates();
  }
}

async function closeOpenPosition(partialLots = null) {
  const pos = state.session?.position;
  if (!state.session?.id || !pos?.order_id || state.opLock) {
    if (!pos) showToast('لا يوجد مركز مفتوح لإغلاقه.', 'warn');
    return;
  }

  const body = { session: state.session.id };
  if (partialLots !== null && partialLots !== undefined) {
    const rounded = Math.round(Number(partialLots) * 100) / 100;
    if (!Number.isFinite(rounded) || rounded <= 0 || rounded > Number(pos.lots)) {
      showToast('حجم الإغلاق الجزئي يجب أن يكون بين 0.01 وحجم المركز المفتوح.', 'warn');
      return;
    }
    body.lots = rounded;
  }

  const wasReplaying = state.status === 'replaying';
  if (wasReplaying) pauseReplay();
  state.opLock = true;
  updateInteractiveDisabledStates();

  try {
    const closeResp = await apiRequest(
      `/api/orders/${encodeURIComponent(pos.order_id)}`,
      { method: 'DELETE', body }
    );

    if (closeResp.trades !== undefined && closeResp.position !== undefined) {
      applySessionPayload(closeResp);
    } else {
      const fullState = await apiRequest(`/api/session/${encodeURIComponent(state.session.id)}`);
      applySessionPayload(fullState);
    }

    syncPriceLines();
    syncTradeMarkers();
    renderSessionUI({ syncSeekInputs: false });

    const closedLotsText = closeResp.closed_lots !== undefined ? formatLots(closeResp.closed_lots) : '';
    const pnlText = closeResp.closed_pnl !== undefined ? ` (${formatMoney(closeResp.closed_pnl, true)})` : '';
    showToast(`تم إغلاق ${closedLotsText} عقد${pnlText}`);
  } catch (err) {
    enterErrorState({
      title: 'تعذّر إغلاق المركز',
      message: err?.message || 'فشل طلب إغلاق المركز المفتوح.',
      detail: err?.detail || String(err),
      retryFn: () => closeOpenPosition(partialLots),
      canResync: true,
    });
  } finally {
    state.opLock = false;
    updateInteractiveDisabledStates();
  }
}

/* -------------------------------------------------------------------------- */
/* UI Event Wiring & Keyboard Shortcuts                                       */
/* -------------------------------------------------------------------------- */

function switchSideTab(tabName) {
  dom.tabButtons.forEach((btn) => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });

  Object.entries(dom.tabPanels).forEach(([key, panel]) => {
    const active = key === tabName;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
  });

  if (tabName === 'session') {
    refreshSavedSessionsQuietly();
  }
}

function isEditableElement(target) {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

function bindEvents() {
  // Side panel tabs
  dom.tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchSideTab(btn.dataset.tab));
  });

  // Timeframe pills (delegated)
  dom.tfPills.addEventListener('click', (e) => {
    const pill = e.target.closest('.tf-pill');
    if (!pill || pill.disabled) return;
    switchTimeframe(pill.dataset.tf);
  });

  // Speed pills (delegated)
  dom.speedPills.addEventListener('click', (e) => {
    const pill = e.target.closest('.speed-pill');
    if (!pill) return;
    setReplaySpeed(Number(pill.dataset.speed));
  });

  // Transport controls
  dom.btnPlayPause.addEventListener('click', togglePlayPause);
  dom.btnStepForward.addEventListener('click', stepForwardOnce);
  dom.btnViewBack.addEventListener('click', stepViewBackClientOnly);
  dom.btnRewind.addEventListener('click', rewindToSessionStart);
  dom.btnAtEndRewind.addEventListener('click', rewindToSessionStart);
  dom.btnSnapCursor.addEventListener('click', snapChartToCursor);

  // Seek controls (Replay bar + Session panel + quick offset chips)
  dom.btnReplaySeek.addEventListener('click', () => {
    const iso = datetimeLocalValueToIsoUtc(dom.replaySeekInput.value);
    if (!iso) {
      showToast('يرجى اختيار تاريخ ووقت UTC صالحين للانتقال.', 'warn');
      return;
    }
    seekToIso(iso);
  });

  dom.btnPanelSeek.addEventListener('click', () => {
    const iso = datetimeLocalValueToIsoUtc(dom.panelSeekInput.value);
    if (!iso) {
      showToast('يرجى اختيار تاريخ ووقت UTC صالحين للانتقال.', 'warn');
      return;
    }
    seekToIso(iso);
  });

  dom.seekOffsetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.session?.cursor) return;
      const days = Number(btn.dataset.seekOffsetDays);
      const baseMs = Date.parse(state.session.cursor);
      if (!Number.isFinite(baseMs) || !Number.isFinite(days)) return;
      const targetMs = baseMs + days * 86400 * 1000;
      const targetIso = new Date(targetMs).toISOString().replace('.000Z', 'Z');
      seekToIso(targetIso);
    });
  });

  // Save / Load / New Session
  dom.btnTopSave.addEventListener('click', saveCurrentSession);
  dom.btnPanelSave.addEventListener('click', saveCurrentSession);
  dom.btnNewSession.addEventListener('click', createNewSession);
  dom.btnRefreshSessions.addEventListener('click', refreshSavedSessionsQuietly);

  dom.savedSessionsList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-load-session-id]');
    if (!btn) return;
    loadSavedSession(btn.dataset.loadSessionId);
  });

  // Order ticket controls
  dom.lotChipButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      dom.orderLots.value = btn.dataset.lot;
      dom.lotChipButtons.forEach((b) => b.classList.toggle('is-selected', b === btn));
    });
  });

  dom.orderLots.addEventListener('input', () => {
    const val = Number(dom.orderLots.value).toFixed(2);
    dom.lotChipButtons.forEach((b) => b.classList.toggle('is-selected', b.dataset.lot === val));
  });

  document.querySelectorAll('[data-clear-input]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.clearInput);
      if (target) target.value = '';
    });
  });

  dom.btnFillSl.addEventListener('click', () => {
    const latest = getCursorBar();
    if (latest) dom.orderSl.value = formatPrice(latest.c);
  });

  dom.btnFillTp.addEventListener('click', () => {
    const latest = getCursorBar();
    if (latest) dom.orderTp.value = formatPrice(latest.c);
  });

  dom.btnBuy.addEventListener('click', () => submitMarketOrder('buy'));
  dom.btnSell.addEventListener('click', () => submitMarketOrder('sell'));

  // Position close controls
  dom.btnCloseFull.addEventListener('click', () => closeOpenPosition(null));

  dom.btnClosePartial.addEventListener('click', () => {
    const lots = Number(dom.closeLotsInput.value);
    closeOpenPosition(lots);
  });

  dom.closePctButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const posLots = Number(state.session?.position?.lots || 0);
      const pct = Number(btn.dataset.closePct);
      if (!posLots || !pct) return;
      const closeLots = Math.round(posLots * pct * 100) / 100;
      if (closeLots >= 0.01 && closeLots < posLots) {
        closeOpenPosition(closeLots);
      }
    });
  });

  // Clicking a trade row centers the chart on that trade's candle (within loaded history <= cursor)
  dom.tradesTbody.addEventListener('click', (e) => {
    const row = e.target.closest('tr');
    if (!row || !chart || state.bars.length === 0) return;
    const targetIso = row.dataset.exitTs || row.dataset.entryTs;
    const cursorSec = isoToUnixSeconds(state.session?.cursor);
    const snappedSec = snapIsoToLoadedBarSec(targetIso, cursorSec);
    if (snappedSec === null) return;
    const barIdx = state.bars.findIndex((b) => isoToUnixSeconds(b.t) === snappedSec);
    if (barIdx < 0) return;
    const barsFromLatest = state.bars.length - 1 - barIdx;
    chart.timeScale().scrollToPosition(GUTTER_BARS - barsFromLatest + 15, true);
    updateSnapCursorButton();
  });

  // Error recovery buttons
  dom.btnErrorRetry.addEventListener('click', () => {
    const retry = state.errorInfo?.retryFn;
    if (typeof retry === 'function') {
      setAppState(state.session?.id ? 'paused' : 'idle');
      retry();
    } else {
      bootApplication();
    }
  });

  dom.btnErrorResync.addEventListener('click', () => {
    resyncCurrentSession();
  });

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    // Ctrl+S / Cmd+S always saves session (even if focused in an input)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveCurrentSession();
      return;
    }

    // Do not intercept typing or modifier combos
    if (e.ctrlKey || e.metaKey || e.altKey || isEditableElement(e.target)) {
      return;
    }

    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      togglePlayPause();
      return;
    }

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepForwardOnce();
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepViewBackClientOnly();
      return;
    }

    const lower = e.key.toLowerCase();
    if (lower === 'b') {
      e.preventDefault();
      submitMarketOrder('buy');
    } else if (lower === 's') {
      e.preventDefault();
      submitMarketOrder('sell');
    } else if (lower === 'c') {
      e.preventDefault();
      closeOpenPosition(null);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Entrypoint                                                                 */
/* -------------------------------------------------------------------------- */

bindEvents();
bootApplication();
