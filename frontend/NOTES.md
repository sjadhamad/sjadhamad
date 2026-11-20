# NOTES — EUR/USD Bar-Replay Trainer (`frontend/`)

## 1. What Was Implemented

- **Pure static ES-module frontend (`index.html`, `app.js`, `styles.css`, `vendor/lightweight-charts.standalone.production.js`)**:
  - Runs directly from `http://127.0.0.1:5001/` with zero build step, zero bundler, zero framework, and zero runtime CDN/external requests.
  - Vendored **TradingView Lightweight Charts v4.2.3** (`dist/lightweight-charts.standalone.production.js` from npm `lightweight-charts@4.2.3`), using **only the v4 API**:
    - `LightweightCharts.createChart(el, opts)`
    - `chart.addCandlestickSeries(opts)`
    - `candleSeries.setData(...)` & `candleSeries.update(...)`
    - `candleSeries.setMarkers(...)`
    - `candleSeries.createPriceLine(...)` & `candleSeries.removePriceLine(...)`
- **Arabic RTL UI with strict Latin numerals (`dir="rtl"` + `<bdi dir="ltr">`)**:
  - Full Arabic labels across all regions, modals, overlays, and toasts.
  - Every price (`5` decimals), lot size, dollar balance/equity/P&L, timeframe code, session ID, multiplier (`1×`–`50×`), and UTC timestamp is formatted in Latin digits (`en-US` / `.toFixed()`) inside LTR-isolated `<bdi class="num" dir="ltr">` elements with `tabular-nums` to eliminate RTL bidi glitches.
  - The Lightweight Charts mount element uses `dir="ltr"` internally so HTML table/canvas mouse-drag coordinates and price-axis geometry remain crisp inside the RTL page.
- **Three-region layout + bottom-left RTL-aware replay controls**:
  1. **Top bar**: Symbol (`EURUSD`), live Bid/Ask chips from the server cursor candle (`bid_c` / `ask_c`), dynamic timeframe pills (`M1`…`D1` via `POST /api/session/<id>/tf`), UTC cursor exchange clock, explicit state pill, session ID, balance, equity, and session save button.
  2. **Chart area**: Candlesticks ending strictly at `cursor` with a fixed 8-bar right gutter (`rightOffset: 8`), live OHLCV crosshair HUD, open-position entry/SL/TP price lines, entry/exit trade markers (snapped onto loaded candles so markers survive timeframe switches and never render past `cursor`), loading indicator, `at_end` banner, and `error` veil/card.
  3. **Side panel tabs**:
     - `الأوامر`: Market Buy/Sell ticket (`POST /api/orders` with lot presets + optional `sl`/`tp`) and Open Position card with `25%`, `50%`, `75%`, custom partial-lot close, and full close (`DELETE /api/orders/<order_id>`).
     - `الصفقات`: Running P&L, Win Rate, Expectancy, trade count, and scrollable closed-trades table (clicking a row pans the chart within loaded history to that trade).
     - `الجلسة`: Active session info, UTC Seek (`POST /api/replay/seek` + `-1d` / `-7d` / `-30d` shortcuts), New Session form (`POST /api/session`), and Saved Sessions browser (`GET /api/sessions`, `POST /api/session/<id>/load`, `POST /api/session/<id>/save`).
- **Explicit state machine**:
  - `idle`, `loading`, `replaying`, `paused`, `at_end`, and `error` (reflected on `document.body.dataset.appState`, top-bar status badge, transport controls, and stage overlays).
  - Disconnecting the server or receiving any non-2xx HTTP status transitions immediately into `error`, dimming/blurring stale chart candles underneath an Arabic diagnostic overlay with **Retry (`إعادة المحاولة`)** and **Session Resync (`مزامنة الجلسة`)**.
- **Strict data & storage rules**:
  - Zero mocked/synthetic candles anywhere in code.
  - Defensive client-side guard drops any bar or marker with `t > cursor`.
  - `localStorage` stores **only** `eurusd_replay_session_id`, `eurusd_replay_tf`, and `eurusd_replay_speed`. Bars, cursor state, positions, and trades are always re-fetched from the API on reload.
- **High-frame-rate replay (`10×` / `50×`)**:
  - Sequential single-bar (`bars: 1`) step scheduler using incremental `candleSeries.update(...)` and dirty-checked signatures for price lines, markers, and trade tables so 1,500+ candles replay and scroll without frame drops or overlapping requests.
- **Keyboard shortcuts**:
  - `Space` (play/pause), `→` (step 1 bar forward), `←` (step 1 bar back in client view only), `B` (market buy), `S` (market sell), `C` (close open position), `Ctrl+S` / `Cmd+S` (save session).

---

## 2. What Was Left Out

- **Backend / replay server / trade accounting**: Excluded per rules. No candle aggregation and no price/pip/lot P&L calculation exist in the frontend.
- **Mocked, fallback, or demo candles**: Excluded per Rule 2.
- **Pending limit/stop entry orders & modifying SL/TP on an already-open position**: Not part of the REST contract (which defines market entry via `POST /api/orders` and full/partial close via `DELETE /api/orders/<order_id>`).
- **Technical indicators, drawing tools, and multi-symbol switching**: Omitted to keep the single-symbol (`EURUSD`) trainer focused and dependency-free.

---

## 3. Contract Ambiguities & How They Were Resolved

1. **`الصفقات` summary stats (`running P&L`, `win rate`, `expectancy`) vs. "do not implement P&L math"**:
   - *Ambiguity*: The screen specification requires showing `running P&L`, `win rate`, and `expectancy` in `الصفقات`, whereas `GET /api/session/<id>` returns `{ id, tf, cursor, balance, equity, position, orders, trades }` without top-level `win_rate` or `expectancy` fields.
   - *Resolution*: The client never calculates trade P&L from entry/exit prices, pips, spreads, or lot sizes. If the server provides `session.stats` (`running_pnl`, `win_rate`, `expectancy`), those values are rendered directly; otherwise, the summary cards aggregate strictly over the server-computed `trades[].pnl` numbers (`sum(pnl)`, percentage of trades with `pnl > 0`, and `sum(pnl) / trades.length`).
2. **`POST /api/orders` response payload**:
   - *Ambiguity*: `POST /api/orders` returns `{ order_id, fill_price, ts }` rather than the full session state returned by `DELETE /api/orders/<order_id>` and `POST /api/session/<id>/tf`.
   - *Resolution*: Right after `POST /api/orders` succeeds, the frontend calls `GET /api/session/<id>` so `position`, `balance`, `equity`, price lines, and markers reflect authoritative server state.
3. **`closed` vs. `trades` in `POST /api/replay/step` and `POST /api/replay/seek`**:
   - *Ambiguity*: Example responses for `step` and `seek` show `"closed": []` without explicitly showing `"trades": [...]`.
   - *Resolution*: When `trades` is included in a response, it replaces `session.trades`; otherwise `closed` entries are appended, and `GET /api/session/<id>` is fetched after `seek` (or if a `closed` item omits full trade fields) so the trade ledger stays authoritative.
4. **Default `start` when creating the initial session on first load**:
   - *Ambiguity*: `POST /api/session` states *"Omit `start` to begin at the last available bar."* Starting at `data.to` on a brand-new session would hit `at_end` on the very first forward step/play (Acceptance Tests #2 and #3).
   - *Resolution*: Automatic first-visit session creation passes `start` at the midpoint of `[meta.data.from, meta.data.to]`, ensuring both rich history behind the cursor and ample bars ahead for immediate replay. In the `الجلسة` tab's New Session form, clicking «آخر شمعة» clears the input and omits `start` so starting at the final bar remains supported.
5. **`⟲` Rewind to session start**:
   - *Ambiguity*: No `/api/replay/rewind` endpoint or `session.start` field is defined in `GET /api/session/<id>`.
   - *Resolution*: The UI records each session's initial `cursor` in memory when created or loaded (preferring `session.start` / `session.initial_cursor` if supplied by the server) and calls `POST /api/replay/seek` to that timestamp when `⟲` is pressed.
6. **Base replay cadence for `1× 2× 5× 10× 50×`**:
   - *Ambiguity*: Multiplier labels are specified without a base millisecond interval, while Acceptance Test #2 requires bars at `10×` to arrive one at a time (`bars: 1`).
   - *Resolution*: `1×` = `1000 ms/bar`, `2×` = `500 ms`, `5×` = `200 ms`, `10×` = `100 ms`, `50×` = `20 ms`. Each tick awaits completion of the in-flight `POST /api/replay/step` (`bars: 1`) before scheduling the next timer so requests never stack.
7. **`←` Keyboard action ("step one bar back (client-side view only, must not reveal new bars)")**:
   - *Ambiguity*: Server-side `seek` closes open positions, while Rule 1 forbids caching bars past `cursor` in memory.
   - *Resolution*: `←` pans the chart's visible logical scroll position and HUD bar readout one bar back within already-fetched `<= cursor` bars without calling the server, closing positions, or holding hidden future bars.
8. **Rule 3 phrasing ("other than `GET`/`POST` to the same origin") vs. `DELETE /api/orders/<order_id>`**:
   - *Ambiguity*: Rule 3 mentions `GET`/`POST` while the REST contract requires `DELETE /api/orders/<order_id>`.
   - *Resolution*: Treated Rule 3 as forbidding all external/cross-origin requests; same-origin `/api/*` requests use `GET`, `POST`, and `DELETE` per the REST contract.
9. **`limit=1500` in `GET /api/bars` vs. "last 500 bars" in Acceptance Test #1**:
   - *Ambiguity*: The endpoint specification and Acceptance Test #9 use `1,500` bars, whereas Acceptance Test #1 mentions `500` bars ending at the cursor.
   - *Resolution*: The frontend calls `GET /api/bars?session=<id>&limit=1500` as specified in the REST contract; whether the server returns 500 or 1,500 bars, the candle series ends strictly at `cursor` with nothing to its right.
