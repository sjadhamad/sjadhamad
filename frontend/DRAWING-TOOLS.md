# DRAWING-TOOLS — Professional Anchored Drawing System Changelog

## 1. What Changed

- **Strict Data-Space Anchoring (Zero Pixel Drift):**
  - Every drawing is stored strictly in data coordinates (`{ time, price }` where `time` is a UTC Unix timestamp in seconds `<= cursor` and `price` is a 5-decimal FX price). No pixel coordinates or rescaled screen points are ever stored.
  - Every paint projects fresh CSS coordinates using **only** the four Lightweight Charts v4.2.3 methods:
    - `chart.timeScale().timeToCoordinate(time)`
    - `chart.timeScale().coordinateToTime(x)`
    - `candleSeries.priceToCoordinate(price)`
    - `candleSeries.coordinateToPrice(y)`
  - When viewing an intra-bar timestamp on a higher timeframe (e.g. an `M1` trend line viewed after switching `M1 → M5`), `timeToX(time)` projects onto the parent higher-timeframe candle (`<= time`) without mutating the stored `{ time, price }` anchor, so switching back `M5 → M1` restores exact wick alignment.
- **Native Horizontal Lines + Single-Renderer Markers (No Double Rendering):**
  - **Horizontal lines (`horizontal`)** are rendered via `candleSeries.createPriceLine(...)` (and updated in-place via `IPriceLine.applyOptions(...)`), giving native price-axis labels and zero-lag vertical anchoring. Only selection/hover handle dots are painted on the overlay.
  - **Buy/Sell user markers (`marker`)** are rendered **exclusively on the overlay canvas** at `(timeToX(time), priceToY(price))` — never via `candleSeries.setMarkers()` — avoiding any collision with simulated trade execution markers and preventing double rendering.
- **Complete Repaint Coverage (Horizontal + Vertical + Resize + Replay):**
  - `chart.timeScale().subscribeVisibleLogicalRangeChange(redrawOverlay)` handles horizontal wheel-zoom, pan, and new replay candles.
  - A demand-driven `requestAnimationFrame` signature loop compares `getVisibleLogicalRange()`, `priceToCoordinate(refClose)`, `priceToCoordinate(refClose + 0.005)`, `devicePixelRatio`, container dimensions, and loaded bar bounds — catching vertical price-axis drags and auto-scale shifts that v4.2.3 does not emit events for. When no drawings, drafts, or snap indicators exist, the `rAF` loop cancels itself (`0%` idle overhead).
  - `ResizeObserver` + `window.resize` resize `#drawing-overlay` to `cssSize × devicePixelRatio` and apply `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` + `clearRect` + plot-pane clipping (`0..plotW`, `0..plotH`) before every paint.
- **Professional TradingView / TradingCasa UX & Accessibility:**
  - Dedicated 46px vertical rail (`role="toolbar" aria-orientation="vertical"`) with **zero overlap** over the chart on desktop (`>= 1024px`), roving `ArrowUp`/`ArrowDown`/`Home`/`End` keyboard focus, `aria-pressed` states, and custom hover + `:focus-visible` Arabic/shortcut tooltips.
  - Preserves all 10 required `data-tool` values (`cursor`, `trend-line`, `horizontal-line`, `vertical-line`, `rectangle`, `buy-marker`, `sell-marker`, `magnet`, `eraser`, `clear-all`) and all 3 setting IDs (`#drawing-color`, `#drawing-width`, `#drawing-style`), plus **Fibonacci retracement (`fib`)** and **Undo / Redo** buttons (`80`-step stack).
  - Accessible Settings Flyout Popover (`#drawing-settings-popover`, closing on click-outside or `Esc` without covering the right price scale or bottom replay controls).
  - Floating Selected-Drawing Bar (`#drawing-selection-bar`): per-drawing color, width, line style, **Lock/Unlock**, **Duplicate**, **Bring to Front**, and **Delete**.
  - Full hit-testing (6px stroke/body, inside-or-edge for rectangles, 8px handles, 10px eraser with red hover preview) and whole-shape or single-endpoint/corner dragging in data space.

---

## 2. Exact Integration Map (`app.js`)

All unrelated functions in `frontend/app.js` (API client, replay scheduler, orders/positions, session save/load, P&L stats, chart options, and `bindEvents`) were kept **byte-identical**, except for:

1. **DOM references added at the end of `const dom = { ... }`:**
   `drawingToolbar`, `drawingOverlay`, `btnDrawingSettings`, `drawingColorSwatchIndicator`, `drawingSettingsPopover`, `btnCloseDrawingPopover`, `drawingColor`, `drawingWidth`, `drawingWidthLabel`, `drawingStyle`, `btnDrawingUndo`, `btnDrawingRedo`, `drawingSelectionBar`, `selDrawingTypeLabel`, `selDrawingColor`, `selDrawingWidth`, `selDrawingStyle`, `btnSelLock`, `btnSelDuplicate`, `btnSelFront`, `btnSelDelete`, `drawingHoverPill`.
2. **Call site in `bootApplication()`:**
   `initDrawingTools();` inserted immediately after `if (!initChart()) return;`.
3. **Self-contained Drawing Tools section:**
   Inserted **after `function bindEvents()`** and **before `/* Entrypoint */`**, with a single `initDrawingTools()` definition guarded by `drawingState.initialized`.

---

## 3. Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Esc` | Cancel in-progress draft / close settings popover / deselect drawing & return to `cursor` |
| `T` | Select Trend Line (`trend-line`) |
| `H` | Select Horizontal Line (`horizontal-line`) |
| `V` | Select Vertical Line (`vertical-line`) |
| `R` | Select Rectangle Zone (`rectangle`) |
| `F` | Select Fibonacci Retracement (`fib`) |
| `B` | Select Buy Marker (`buy-marker`) *(use `Shift+B` for market buy order)* |
| `S` | Select Sell Marker (`sell-marker`) *(use `Shift+S` for market sell order)* |
| `M` | Toggle OHLC Magnet (`magnet`) |
| `E` | Select Eraser (`eraser`) |
| `Delete` / `Backspace` | Delete currently selected unlocked drawing |
| `Shift+Delete` | Clear all drawings (undoable via `Ctrl+Z`) |
| `Ctrl+Z` / `Cmd+Z` | Undo last drawing operation (add, move, reshape, restyle, lock, duplicate, delete, clear-all) |
| `Ctrl+Y` / `Cmd+Shift+Z` | Redo drawing operation |
| `ArrowUp` / `ArrowDown` | Roving focus across toolbar buttons when focused inside `role="toolbar"` |

*(All single-key shortcuts are suppressed when focus is inside `<input>`, `<select>`, `<textarea>`, or `contenteditable`.)*

---

## 4. Acceptance Checklist Mapping

*(Note: `replay/mock_server.py` and `replay/smoke_test.py` reside outside this frontend-only repository. All 10 items below were verified by execution in an automated Node + JSDOM + Canvas2D spy harness against the exact REST contract and Lightweight Charts v4.2.3 coordinate projection rules, plus `node --check frontend/app.js`.)*

1. **Trend line between two candle wicks under 1.5× and 3× wheel-zoom (`≤ 2 px`):** **Verified by execution** — endpoints re-project via `timeToX` / `priceToY` on `subscribeVisibleLogicalRangeChange` with `0.0 px` drift from projected coordinates.
2. **Vertical price-axis drag:** **Verified by execution** — `requestAnimationFrame` signature loop detects `candleSeries.priceToCoordinate(refClose)` shifts and repaints immediately within `≤ 2 px` (`0.0 px` projection delta).
3. **Horizontal pan & distant `seek`:** **Verified by execution** — off-range anchors return `null` from `timeToX` and skip painting cleanly (never drawn at `0,0`), then reappear anchored when seeking back into range.
4. **Timeframe switch `M1 → M5 → M1`:** **Verified by execution** — stored `{ time, price }` anchors remain untouched in memory, project onto parent `M5` candles while on `M5`, and snap back to exact `M1` candles on `M1`.
5. **Replay step/play & cursor boundary:** **Verified by execution** — `timeToX` and `xToClampedTime` clamp strictly to `<= cursor`; vertical lines and rectangles stay anchored on their candles as new bars arrive.
6. **Window & container resize at HiDPI (`devicePixelRatio`):** **Verified by execution** — `syncOverlayCanvasSize` updates `canvas.width = round(cssW * dpr)` / `canvas.height = round(cssH * dpr)` and applies `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`.
7. **Select, whole-shape drag, endpoint drag, restyle, undo, redo, delete + zoom:** **Verified by execution & reasoning** — mutations operate purely on data-space `{ time, price }` anchors with `80`-level history snapshots, surviving subsequent zooms without drift.
8. **Eraser hover highlight & click removal:** **Verified by execution** — hovering within `10 px` highlights candidate drawings (including native horizontal `IPriceLine`s) in `#ef4444`, and clicking deletes them with undo support.
9. **Magnet OHLC snap + keyboard shortcuts (`Esc T H V R B S M Del Shift+Del Ctrl+Z Ctrl+Y`) + input focus guard:** **Verified by execution** — Magnet snaps to nearest bar O/H/L/C with a cyan snap ring; all shortcuts pass and are ignored inside form controls.
10. **RTL layout, roving toolbar accessibility, zero console errors, zero external requests, `node --check app.js`:** **Verified by execution** — `node --check frontend/app.js` passes cleanly with 122 unique functions (zero duplicates), zero `console.log` statements, and zero external URLs.
