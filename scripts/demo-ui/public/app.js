const marketsEl = document.getElementById("markets");
const metaEl = document.getElementById("meta");
const warningsEl = document.getElementById("warnings");
const tabsEl = document.getElementById("market-tabs");
const marketCardTemplate = document.getElementById("market-card-template");

const EXEC_CHART_MAX_POINTS = 500;
const EXEC_CHART_HISTORY_MAX_POINTS = 3000;
const CANDLE_BUCKET_MS = 60_000;
const CANDLE_BUCKET_LABEL = "1m";
const PRICE_CHART_HEIGHT = 300;
const POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;
const AUTO_TRADE_INTERVAL_MS = 2200;
const AUTO_TRADE_STEP_DELAY_MS = 120;
const AUTO_MAKER_OFFSET_BPS = 8;
const AUTO_MAKER_LEVELS = 2;
const AUTO_MAKER_ORDERS_PER_LEVEL = 1;
const AUTO_MIN_RESTING_PER_SIDE = 4;
const AUTO_REPLENISH_MAX_PASSES = 3;
const AUTO_TRADE_ATTEMPT_FACTOR = 10;
const AUTO_PICK_WINDOW = 16;
const AUTO_ROLE_SLOTS = 4;
const AUTO_TRADES_PER_TICK_MIN = 3;
const AUTO_TRADES_PER_TICK_MAX = 5;

const chartLib = window.LightweightCharts;
const marketCards = new Map();
let activeMarketIndex = null;
let latestSnapshot = null;
let chartLibMissingWarned = false;

const shortAddress = (address) => `${address.slice(0, 8)}...${address.slice(-6)}`;
const toUnixSec = (ms) => Math.max(1, Math.floor(ms / 1000));

const setWarning = (warning) => {
  warningsEl.innerHTML = warning
    ? `<p class="warning">Warning: ${warning}</p>`
    : "";
};

const setCellText = (el, text) => {
  if (el.textContent !== text) {
    el.textContent = text;
  }
};

const formatPriceAdaptive = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(6).replace(/\.?0+$/, "");
  if (n >= 0.01) return n.toFixed(8).replace(/\.?0+$/, "");
  if (n >= 0.0001) return n.toFixed(10).replace(/\.?0+$/, "");
  return n.toPrecision(10).replace(/\.?0+$/, "");
};

const parsePositiveNumber = (value) => {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const normalizeTradesForChart = (trades) =>
  trades
    .filter((trade) => Number.isFinite(trade.price) && trade.price > 0)
    .map((trade, index) => ({ ...trade, _index: index }))
    .sort((a, b) => (a.ts - b.ts) || (a._index - b._index));

const buildTickSeries = (trades) => {
  const normalized = normalizeTradesForChart(trades);
  const points = [];
  let lastTime = 0;
  for (const trade of normalized) {
    let time = toUnixSec(trade.ts);
    if (time <= lastTime) {
      time = lastTime + 1;
    }
    points.push({ time, value: trade.price });
    lastTime = time;
  }
  return points.slice(-EXEC_CHART_MAX_POINTS);
};

const buildCandles = (trades, bucketMs) => {
  const normalized = normalizeTradesForChart(trades);
  if (!normalized.length) return [];

  const bucketSecSize = Math.max(1, Math.floor(bucketMs / 1000));
  const buckets = new Map();
  for (const trade of normalized) {
    const bucketMsStart = Math.floor(trade.ts / bucketMs) * bucketMs;
    const bucketSec = toUnixSec(bucketMsStart);
    const existing = buckets.get(bucketSec);
    if (!existing) {
      buckets.set(bucketSec, {
        time: bucketSec,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
      });
      continue;
    }
    existing.high = Math.max(existing.high, trade.price);
    existing.low = Math.min(existing.low, trade.price);
    existing.close = trade.price;
  }

  const sortedBuckets = [...buckets.values()].sort((a, b) => a.time - b.time);
  const filled = [];
  let previous = null;
  for (const candle of sortedBuckets) {
    if (previous) {
      for (
        let gap = previous.time + bucketSecSize;
        gap < candle.time;
        gap += bucketSecSize
      ) {
        filled.push({
          time: gap,
          open: previous.close,
          high: previous.close,
          low: previous.close,
          close: previous.close,
        });
      }
    }
    filled.push(candle);
    previous = candle;
  }

  return filled.slice(-200);
};

const renderTabs = (markets) => {
  tabsEl.innerHTML = "";
  for (const market of markets) {
    const pairLabel = `${market.baseSymbol ?? "BASE"}/${market.quoteSymbol ?? "QUOTE"}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tab-btn ${market.index === activeMarketIndex ? "active" : ""}`;
    button.textContent = `#${market.index} ${pairLabel}`;
    button.addEventListener("click", () => {
      activeMarketIndex = market.index;
      renderTabs(markets);
      if (latestSnapshot) {
        for (const row of latestSnapshot.markets) {
          updateMarketCard(row);
        }
        resizeVisibleCharts();
      }
    });
    tabsEl.appendChild(button);
  }
};

const renderDepthTable = (tbody, levels, side, onPick, maxTotalBase) => {
  tbody.innerHTML = "";
  if (!levels?.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="3" class="muted">No levels</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const level of levels) {
    const tr = document.createElement("tr");
    tr.className = `orderbook-row ${side}`;
    tr.dataset.price = level.priceQuotePerBase;
    tr.dataset.size = level.sizeBase;
    tr.dataset.side = side;
    tr.title = `${level.orders ?? 0} orders at this level`;
    const totalBase = parsePositiveNumber(level.totalBase);
    const depthPct =
      maxTotalBase > 0 ? Math.max(0, Math.min(100, (totalBase / maxTotalBase) * 100)) : 0;
    tr.style.setProperty("--depth-pct", `${depthPct.toFixed(2)}%`);
    tr.innerHTML = `
      <td class="ob-total">${level.totalBase}</td>
      <td class="ob-size">${level.sizeBase}</td>
      <td class="ob-price ${side === "ask" ? "ask-price" : "bid-price"}">${level.priceQuotePerBase}</td>
    `;
    tr.addEventListener("click", () => onPick(level, side));
    tbody.appendChild(tr);
  }
};

const renderRecentOrders = (tbody, orders) => {
  tbody.innerHTML = "";
  if (!orders.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="muted">No resting orders in scan range.</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const order of orders) {
    const tr = document.createElement("tr");
    const sideClass = order.side === "Buy" ? "ok" : "warn";
    tr.innerHTML = `
      <td>#${order.id}</td>
      <td><span class="pill ${sideClass}">${order.side}</span></td>
      <td>${order.priceQuotePerBase}</td>
      <td>${order.remainingBase}</td>
      <td title="${order.owner}">${shortAddress(order.owner)}</td>
      <td><button class="mini-btn" data-order-id="${order.id}" data-order-amount="${order.remainingBase}">Take</button></td>
    `;
    tbody.appendChild(tr);
  }
};

const renderTradeTape = (tbody, actions) => {
  tbody.innerHTML = "";
  const rows = (actions ?? []).slice(0, 20);
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" class="muted">No actions yet. Use market/limit/take.</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const action of rows) {
    const tr = document.createElement("tr");
    const sideClass = action.side === "buy" ? "ok" : "warn";
    const statusText = action.status;
    const time = new Date(action.ts).toLocaleTimeString();
    tr.innerHTML = `
      <td>${time}</td>
      <td><span class="pill ${sideClass}">${action.side}</span></td>
      <td>${action.kind}/${statusText}</td>
      <td>
        id:${action.orderId ?? "-"} |
        amt:${action.amountBase} |
        px:${action.executionPriceApprox ?? "-"} |
        db:${action.baseDelta ?? "-"} dq:${action.quoteDelta ?? "-"}
      </td>
    `;
    tbody.appendChild(tr);
  }
};

const renderBalancesTable = (tbody, balances, selectedRole, onPickRole) => {
  tbody.innerHTML = "";
  const rows = [...(balances ?? [])].sort((a, b) => a.role.localeCompare(b.role));
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" class="muted">No balances yet.</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const row of rows) {
    const tr = document.createElement("tr");
    if (row.role === selectedRole) {
      tr.classList.add("selected-balance");
    }
    tr.innerHTML = `
      <td title="${row.address}">
        <div>${row.role}</div>
        <div class="muted">${shortAddress(row.address)}</div>
      </td>
      <td>${row.base}</td>
      <td>${row.quote}</td>
      <td><button class="mini-btn" data-balance-role="${row.role}">Use</button></td>
    `;
    tr.querySelector("button[data-balance-role]")?.addEventListener("click", () => {
      onPickRole(row.role);
    });
    tbody.appendChild(tr);
  }
};

const deriveSeriesPriceFormat = (referencePrice) => {
  const price = parsePositiveNumber(referencePrice);
  if (price >= 1000) return { precision: 2, minMove: 0.01 };
  if (price >= 1) return { precision: 6, minMove: 0.000001 };
  if (price >= 0.01) return { precision: 8, minMove: 0.00000001 };
  if (price >= 0.0001) return { precision: 10, minMove: 0.0000000001 };
  return { precision: 12, minMove: 0.000000000001 };
};

const syncSeriesPriceFormat = (cardState, referencePrice) => {
  if (!cardState.tickSeries || !cardState.candleSeries) return;
  const next = deriveSeriesPriceFormat(referencePrice);
  if (
    cardState.chartPricePrecision === next.precision
    && cardState.chartPriceMinMove === next.minMove
  ) {
    return;
  }
  cardState.chartPricePrecision = next.precision;
  cardState.chartPriceMinMove = next.minMove;
  const priceFormat = {
    type: "price",
    precision: next.precision,
    minMove: next.minMove,
  };
  cardState.tickSeries.applyOptions({ priceFormat });
  cardState.candleSeries.applyOptions({ priceFormat });
};

const ensurePriceChart = (cardState) => {
  if (cardState.priceChartApi) return;
  if (!chartLib) {
    if (!chartLibMissingWarned) {
      chartLibMissingWarned = true;
      setWarning("Chart library failed to load. Reload page to retry.");
    }
    return;
  }

  const width = Math.max(380, cardState.priceChart.clientWidth || 0);
  const chart = chartLib.createChart(cardState.priceChart, {
    width,
    height: PRICE_CHART_HEIGHT,
    layout: {
      background: { color: "#041321" },
      textColor: "#d3e8fa",
    },
    localization: {
      priceFormatter: (price) => formatPriceAdaptive(price),
    },
    grid: {
      vertLines: { color: "#27435b55" },
      horzLines: { color: "#27435b55" },
    },
    rightPriceScale: {
      borderColor: "#3a607e",
      autoScale: true,
    },
    timeScale: {
      borderColor: "#3a607e",
      timeVisible: true,
      secondsVisible: true,
    },
    crosshair: {
      mode: chartLib.CrosshairMode.Normal,
    },
  });

  cardState.priceChartApi = chart;
  cardState.tickSeries = chart.addLineSeries({
    color: "#f86f5e",
    lineWidth: 2,
    title: "Trades",
    crosshairMarkerVisible: true,
    priceFormat: {
      type: "price",
      precision: 12,
      minMove: 0.000000000001,
    },
  });
  cardState.candleSeries = chart.addCandlestickSeries({
    upColor: "#1d6f60",
    downColor: "#6f4731",
    wickUpColor: "#48e0b6",
    wickDownColor: "#ffbf70",
    borderVisible: true,
    borderUpColor: "#48e0b6",
    borderDownColor: "#ffbf70",
    title: "Trades (candles)",
    priceFormat: {
      type: "price",
      precision: 12,
      minMove: 0.000000000001,
    },
  });

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => {
      resizePriceChart(cardState);
    });
    resizeObserver.observe(cardState.priceChart);
    cardState.priceChartResizeObserver = resizeObserver;
  }
};

const resizePriceChart = (cardState) => {
  if (!cardState.priceChartApi) return;
  const width = cardState.priceChart.clientWidth;
  if (width > 0) {
    cardState.priceChartApi.applyOptions({ width, height: PRICE_CHART_HEIGHT });
  }
};

const renderPriceChart = (cardState) => {
  ensurePriceChart(cardState);
  if (!cardState.priceChartApi) {
    return;
  }

  const trades = cardState.execTrades.slice(-EXEC_CHART_MAX_POINTS);
  const tickData = buildTickSeries(trades);
  const candleData = buildCandles(trades, CANDLE_BUCKET_MS);
  const latestPrice = trades.length > 0
    ? trades[trades.length - 1].price
    : parsePositiveNumber(cardState?.latestMarket?.bestAsk)
      || parsePositiveNumber(cardState?.latestMarket?.bestBid)
      || estimateMidPrice(cardState?.latestMarket);
  syncSeriesPriceFormat(cardState, latestPrice);
  cardState.priceChartApi.applyOptions({
    timeScale: {
      timeVisible: true,
      secondsVisible: cardState.execChartMode !== "candle",
    },
  });

  if (cardState.execChartMode === "candle") {
    cardState.candleSeries.setData(candleData);
    cardState.tickSeries.setData([]);
  } else {
    cardState.tickSeries.setData(tickData);
    cardState.candleSeries.setData([]);
  }

  if (!cardState.chartDidInitialFit) {
    cardState.priceChartApi.timeScale().fitContent();
    cardState.chartDidInitialFit = true;
  } else {
    cardState.priceChartApi.timeScale().scrollToRealTime();
  }

  const tradeCount = trades.length;
  if (!tradeCount) {
    setCellText(cardState.execRange, "No executions yet");
    return;
  }

  const lastTrade = trades[tradeCount - 1];
  const minPx = Math.min(...trades.map((x) => x.price));
  const maxPx = Math.max(...trades.map((x) => x.price));
  const modeLabel = cardState.execChartMode === "candle"
    ? `Candles ${CANDLE_BUCKET_LABEL} / 5s update`
    : "Ticks";

  setCellText(
    cardState.execRange,
    `${modeLabel} | last ${formatPriceAdaptive(lastTrade.price)} @ ${new Date(lastTrade.ts).toLocaleTimeString()} | range ${formatPriceAdaptive(minPx)}-${formatPriceAdaptive(maxPx)}`,
  );
};

const isExecutionPricePlausible = (price, market) => {
  const mid = estimateMidPrice(market);
  if (!Number.isFinite(mid) || mid <= 0) return true;
  return price >= mid * 0.2 && price <= mid * 5;
};

const appendExecutionTrades = (cardState, actions, market) => {
  if (!Array.isArray(actions) || actions.length === 0) return;

  for (const action of [...actions].reverse()) {
    if (String(action.status ?? "") !== "executed") continue;
    const price = Number.parseFloat(action.executionPriceApprox ?? "NaN");
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!isExecutionPricePlausible(price, market ?? cardState.latestMarket)) continue;
    const ts = Date.parse(action.ts);
    const key = [
      action.ts,
      action.orderId ?? "na",
      action.selectedOrderId ?? "na",
      action.kind,
      action.status,
      action.actorRole ?? "na",
      action.amountBase ?? "na",
    ].join("|");
    if (cardState.execTradeKeys.has(key)) continue;
    cardState.execTradeKeys.add(key);
    cardState.execTrades.push({
      key,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      price,
      side: action.side,
    });
  }

  while (cardState.execTrades.length > EXEC_CHART_HISTORY_MAX_POINTS) {
    const removed = cardState.execTrades.shift();
    if (removed?.key) {
      cardState.execTradeKeys.delete(removed.key);
    }
  }
};

const resizeVisibleCharts = () => {
  for (const cardState of marketCards.values()) {
    if (cardState.root.style.display === "none") continue;
    resizePriceChart(cardState);
    renderPriceChart(cardState);
  }
};

const callJson = async (url, payload) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.error ?? `HTTP ${response.status}`);
  }
  return result;
};

const sendMarket = async (marketIndex, payload, statusEl, submitBtn) => {
  submitBtn.disabled = true;
  statusEl.className = "trade-status muted";
  statusEl.textContent = "Submitting market...";
  try {
    const result = await callJson("/api/trigger-order", { market: marketIndex, ...payload });
    statusEl.className = result.executed ? "trade-status ok" : "trade-status muted";
    statusEl.textContent = result.executed
      ? `Market executed #${result.orderId}`
      : `Market submitted #${result.orderId}`;
  } catch (error) {
    statusEl.className = "trade-status err";
    statusEl.textContent = `Market failed: ${error?.message ?? String(error)}`;
  } finally {
    submitBtn.disabled = false;
  }
};

const sendLimit = async (marketIndex, payload, statusEl, submitBtn) => {
  submitBtn.disabled = true;
  statusEl.className = "trade-status muted";
  statusEl.textContent = "Submitting limit...";
  try {
    const result = await callJson("/api/submit-limit-order", {
      market: marketIndex,
      ...payload,
    });
    statusEl.className = result.executed ? "trade-status ok" : "trade-status muted";
    statusEl.textContent = result.executed
      ? `Limit matched instantly #${result.orderId}`
      : `Limit placed on book #${result.orderId}`;
  } catch (error) {
    statusEl.className = "trade-status err";
    statusEl.textContent = `Limit failed: ${error?.message ?? String(error)}`;
  } finally {
    submitBtn.disabled = false;
  }
};

const takeOrder = async (marketIndex, orderId, amountBase, statusEl, triggerBtn, cardState) => {
  triggerBtn.disabled = true;
  statusEl.className = "trade-status muted";
  statusEl.textContent = `Taking #${orderId}...`;
  try {
    const request = {
      market: marketIndex,
      orderId,
      amountBase,
    };
    if (cardState?.actorRole) {
      request.actorRole = cardState.actorRole;
    }
    const result = await callJson("/api/execute-order", request);
    const touched = Boolean(result.selectedAffected);
    statusEl.className = touched ? "trade-status ok" : "trade-status muted";
    statusEl.textContent = touched
      ? `Selected #${result.selectedOrderId} touched by ${result.actorRole} (${result.selectedRemainingBefore} -> ${result.selectedRemainingAfter})`
      : `Taker #${result.takerOrderId} (${result.actorRole}) executed, selected #${result.selectedOrderId} not reached`;
  } catch (error) {
    statusEl.className = "trade-status err";
    statusEl.textContent = `Take failed: ${error?.message ?? String(error)}`;
  } finally {
    triggerBtn.disabled = false;
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fallbackMidByPair = new Map([
  ["VARA/USDC", 0.001165],
  ["ETH/USDC", 2055],
  ["USDC/VARA", 858.3690987124464],
  ["USDC/USDC", 1],
]);

const estimateMidPrice = (market) => {
  const bestBid = parsePositiveNumber(market?.bestBid);
  const bestAsk = parsePositiveNumber(market?.bestAsk);
  if (bestBid > 0 && bestAsk > 0 && bestAsk >= bestBid) {
    return (bestBid + bestAsk) / 2;
  }
  const pair = `${(market?.baseSymbol ?? "BASE").toUpperCase()}/${(market?.quoteSymbol ?? "QUOTE").toUpperCase()}`;
  return fallbackMidByPair.get(pair) ?? 1;
};

const pickAutoAmountBase = (mid) => {
  if (mid >= 1000) return 1;
  if (mid >= 100) return 2;
  if (mid >= 1) return 10;
  if (mid >= 0.01) return 50;
  return 250;
};

const estimateAutoMaxQuote = (mid, amountBase) =>
  Math.max(1, Math.ceil(mid * amountBase * 1.8));

const randInt = (min, max) => {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
};

const estimateQuoteForAmount = (priceQuotePerBase, amountBase) =>
  Math.max(1, Math.ceil(parsePositiveNumber(priceQuotePerBase) * Math.max(1, amountBase) * 1.25));

const countRestingOrdersBySide = (orders) => {
  let buy = 0;
  let sell = 0;
  for (const row of orders ?? []) {
    if (parsePositiveNumber(row.remainingBase) < 1) continue;
    if (String(row.side).toLowerCase() === "buy") {
      buy += 1;
    } else {
      sell += 1;
    }
  }
  return { buy, sell };
};

const fallbackRoleForSide = (side, cursor) => {
  const slot = Math.abs(Number(cursor ?? 0)) % AUTO_ROLE_SLOTS;
  return side === "buy" ? `quote-maker-${slot}` : `base-maker-${slot}`;
};

const pickActorRoleForSide = (
  balances,
  side,
  amountBase,
  priceQuotePerBase,
  cursor = 0,
) => {
  const rows = Array.isArray(balances) ? balances : [];
  if (rows.length === 0) {
    return fallbackRoleForSide(side, cursor);
  }

  const requiredBase = side === "sell" ? Math.max(1, amountBase) : 0;
  const requiredQuote = side === "buy"
    ? estimateQuoteForAmount(priceQuotePerBase, amountBase)
    : 0;
  const preferredPrefix = side === "buy" ? "quote-maker-" : "base-maker-";

  const poolRaw = rows
    .map((row) => ({
      role: String(row.role ?? ""),
      base: parsePositiveNumber(row.base),
      quote: parsePositiveNumber(row.quote),
    }))
    .filter((row) => row.role.length > 0);
  const preferred = poolRaw.filter((row) => row.role.startsWith(preferredPrefix));
  const pool = preferred.length > 0 ? preferred : poolRaw;
  if (pool.length === 0) {
    return fallbackRoleForSide(side, cursor);
  }

  const sufficient = pool.filter((row) =>
    side === "buy" ? row.quote >= requiredQuote : row.base >= requiredBase,
  );
  const ranked = (sufficient.length > 0 ? sufficient : pool)
    .sort((a, b) => (side === "buy" ? (b.quote - a.quote) : (b.base - a.base)));
  const topCount = Math.max(1, Math.min(3, ranked.length));
  const pick = ranked[Math.abs(Number(cursor ?? 0)) % topCount];
  return pick.role || fallbackRoleForSide(side, cursor);
};

const applyLiveMarketRow = (marketRow) => {
  if (!marketRow) return;
  if (latestSnapshot?.markets) {
    const idx = latestSnapshot.markets.findIndex((m) => m.index === marketRow.index);
    if (idx >= 0) {
      latestSnapshot.markets[idx] = marketRow;
    }
  }
  if (marketCards.has(marketRow.index)) {
    updateMarketCard(marketRow);
  }
};

const fetchMarketSnapshot = async (marketIndex, { render = false } = {}) => {
  const response = await fetch("/api/snapshot", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Snapshot HTTP ${response.status}`);
  }
  const snapshot = await response.json();
  latestSnapshot = snapshot;
  const marketRow = snapshot.markets?.find((m) => m.index === marketIndex) ?? null;
  if (render && marketRow) {
    applyLiveMarketRow(marketRow);
  }
  return marketRow;
};

const updateAutoTradeUi = (cardState) => {
  if (!cardState.autoToggleBtn || !cardState.autoState) return;
  const running = Boolean(cardState.autoRunning);
  cardState.autoToggleBtn.textContent = running ? "Stop Auto" : "Start Auto";
  cardState.autoToggleBtn.disabled = Boolean(cardState.autoInFlight);
  cardState.autoToggleBtn.classList.toggle("running", running);
  cardState.autoState.textContent = cardState.autoStatusText
    ?? (running
      ? "auto: running"
      : "auto: stopped");
};

const stopAutoTrade = (cardState, reason = "auto: stopped") => {
  cardState.autoRunning = false;
  cardState.autoInFlight = false;
  cardState.autoStatusText = reason;
  if (cardState.autoTimer) {
    clearInterval(cardState.autoTimer);
    cardState.autoTimer = null;
  }
  updateAutoTradeUi(cardState);
};

const stopAllAutoTradesExcept = (marketIndex) => {
  for (const [index, cardState] of marketCards.entries()) {
    if (index === marketIndex) continue;
    if (cardState.autoRunning || cardState.autoTimer) {
      stopAutoTrade(cardState, "auto: stopped");
    }
  }
};

const runAutoTradeStep = async (cardState, marketIndex) => {
  if (!cardState.autoRunning || cardState.autoInFlight) return;
  cardState.autoInFlight = true;
  updateAutoTradeUi(cardState);

  try {
    const market =
      await fetchMarketSnapshot(marketIndex, { render: true })
      ?? latestSnapshot?.markets?.find((m) => m.index === marketIndex)
      ?? cardState.latestMarket;
    if (!market) {
      throw new Error("market snapshot unavailable");
    }

    let liveMarket = market;
    const mid = estimateMidPrice(liveMarket);
    const makerOffsetBps = AUTO_MAKER_OFFSET_BPS / 10_000;
    const takerAmountBase = pickAutoAmountBase(mid);
    const makerBaseAmount = Math.max(1, Math.floor(takerAmountBase * 0.4));
    let makerPlaced = 0;
    let makerFailed = 0;
    let liquidityMisses = 0;
    let lastMakerLabel = "-";

    const makerPriceAtLevel = (snapshot, side, level = 1) => {
      const bestBid = parsePositiveNumber(snapshot?.bestBid);
      const bestAsk = parsePositiveNumber(snapshot?.bestAsk);
      const levelOffset = makerOffsetBps * level;
      const anchor = side === "buy"
        ? (bestBid > 0 ? bestBid : mid)
        : (bestAsk > 0 ? bestAsk : mid);
      return side === "buy"
        ? Math.max(0.000000000001, anchor * (1 - levelOffset))
        : Math.max(0.000000000001, anchor * (1 + levelOffset));
    };

    const placeMakerOrder = async (snapshot, side, level = 1) => {
      const price = makerPriceAtLevel(snapshot, side, level);
      const jitter = 0.8 + Math.random() * 0.6;
      const amountBase = Math.max(1, Math.floor(makerBaseAmount * jitter));
      const cursor = cardState.autoActorCursor;
      cardState.autoActorCursor += 1;
      const actorRole = pickActorRoleForSide(
        snapshot?.balances ?? [],
        side,
        amountBase,
        price,
        cursor,
      );

      try {
        await callJson("/api/submit-limit-order", {
          market: marketIndex,
          side,
          amountBase,
          priceQuotePerBase: price,
          actorRole,
        });
        makerPlaced += 1;
        lastMakerLabel = `${side} L @${formatPriceAdaptive(price)}`;
        return true;
      } catch (error) {
        const message = String(error?.message ?? error ?? "");
        if (message.includes("InsufficientLiquidity")) {
          liquidityMisses += 1;
        }
        makerFailed += 1;
        return false;
      }
    };

    const seedMakerBands = async (snapshot) => {
      for (let level = 1; level <= AUTO_MAKER_LEVELS; level += 1) {
        for (const makerSide of ["buy", "sell"]) {
          for (let i = 0; i < AUTO_MAKER_ORDERS_PER_LEVEL; i += 1) {
            await placeMakerOrder(snapshot, makerSide, level);
          }
        }
      }
    };

    const replenishBookIfThin = async () => {
      let refreshed = false;
      for (let pass = 0; pass < AUTO_REPLENISH_MAX_PASSES; pass += 1) {
        const counts = countRestingOrdersBySide(liveMarket.orders ?? []);
        const buyMissing = Math.max(0, AUTO_MIN_RESTING_PER_SIDE - counts.buy);
        const sellMissing = Math.max(0, AUTO_MIN_RESTING_PER_SIDE - counts.sell);
        if (buyMissing === 0 && sellMissing === 0) break;

        for (let i = 0; i < buyMissing; i += 1) {
          await placeMakerOrder(liveMarket, "buy", 1 + Math.floor(i / 2));
        }
        for (let i = 0; i < sellMissing; i += 1) {
          await placeMakerOrder(liveMarket, "sell", 1 + Math.floor(i / 2));
        }
        await wait(AUTO_TRADE_STEP_DELAY_MS);
        liveMarket =
          await fetchMarketSnapshot(marketIndex, { render: true })
          ?? latestSnapshot?.markets?.find((m) => m.index === marketIndex)
          ?? liveMarket;
        refreshed = true;
      }
      return refreshed;
    };

    await seedMakerBands(liveMarket);

    await wait(AUTO_TRADE_STEP_DELAY_MS);
    liveMarket =
      await fetchMarketSnapshot(marketIndex, { render: true })
      ?? latestSnapshot?.markets?.find((m) => m.index === marketIndex)
      ?? liveMarket;
    await replenishBookIfThin();

    const tradesTarget = randInt(AUTO_TRADES_PER_TICK_MIN, AUTO_TRADES_PER_TICK_MAX);
    let tradesDone = 0;
    let attempts = 0;
    const maxAttempts = Math.max(8, tradesTarget * AUTO_TRADE_ATTEMPT_FACTOR);

    while (tradesDone < tradesTarget && attempts < maxAttempts) {
      attempts += 1;
      liveMarket =
        await fetchMarketSnapshot(marketIndex, { render: true })
        ?? latestSnapshot?.markets?.find((m) => m.index === marketIndex)
        ?? liveMarket;
      if (!liveMarket) break;

      const counts = countRestingOrdersBySide(liveMarket.orders ?? []);
      if (
        counts.buy < Math.ceil(AUTO_MIN_RESTING_PER_SIDE / 2)
        || counts.sell < Math.ceil(AUTO_MIN_RESTING_PER_SIDE / 2)
      ) {
        await replenishBookIfThin();
      }

      const candidates = (liveMarket.orders ?? [])
        .filter((row) => parsePositiveNumber(row.remainingBase) >= 1);
      if (candidates.length === 0) {
        await wait(Math.max(80, AUTO_TRADE_STEP_DELAY_MS));
        continue;
      }

      const pickWindow = Math.max(1, Math.min(candidates.length, AUTO_PICK_WINDOW));
      const picked = candidates[randInt(0, pickWindow - 1)];
      if (!picked) continue;

      const orderId = Number(picked.id);
      if (!Number.isFinite(orderId) || orderId <= 0) continue;

      const remainingUnits = Math.floor(parsePositiveNumber(picked.remainingBase));
      if (!Number.isFinite(remainingUnits) || remainingUnits < 1) continue;

      const suggested = Math.max(
        1,
        Math.floor(takerAmountBase * (0.45 + Math.random() * 0.75)),
      );
      const amountBase = Math.min(remainingUnits, suggested);
      const makerIsBuy = String(picked.side).toLowerCase() === "buy";
      const takerSide = makerIsBuy ? "sell" : "buy";
      const pickPrice = parsePositiveNumber(picked.priceQuotePerBase) || mid;
      const cursor = cardState.autoActorCursor;
      cardState.autoActorCursor += 1;
      const takerActorRole = pickActorRoleForSide(
        liveMarket.balances ?? [],
        takerSide,
        amountBase,
        pickPrice,
        cursor,
      );

      try {
        const result = await callJson("/api/execute-order", {
          market: marketIndex,
          orderId,
          amountBase,
          actorRole: takerActorRole,
        });

        if (result.selectedAffected || result.executed) {
          tradesDone += 1;
        }
      } catch (error) {
        const message = String(error?.message ?? error ?? "");
        if (
          message.includes("InsufficientLiquidity")
          || message.includes("insufficient")
        ) {
          liquidityMisses += 1;
        }
        // likely stale/competed order; retry another candidate
      }

      await wait(Math.max(50, AUTO_TRADE_STEP_DELAY_MS - 40));
    }

    cardState.autoStatusText = [
      "auto: running",
      `makers=${makerPlaced}/${makerPlaced + makerFailed}`,
      `trades=${tradesDone}/${tradesTarget}`,
      `attempts=${attempts}`,
      `liqErr=${liquidityMisses}`,
      `| ${lastMakerLabel}`,
    ].join(" ");
    updateAutoTradeUi(cardState);
  } catch (error) {
    cardState.autoStatusText = `auto: error ${error?.message ?? String(error)}`;
    updateAutoTradeUi(cardState);
  } finally {
    cardState.autoInFlight = false;
    updateAutoTradeUi(cardState);
  }
};

const startAutoTrade = (cardState, marketIndex) => {
  stopAllAutoTradesExcept(marketIndex);
  if (cardState.autoRunning) return;
  cardState.autoRunning = true;
  cardState.autoStatusText = `auto: running every ${(AUTO_TRADE_INTERVAL_MS / 1000).toFixed(1)}s`;
  cardState.autoActorCursor = 0;
  updateAutoTradeUi(cardState);
  void runAutoTradeStep(cardState, marketIndex);
  cardState.autoTimer = setInterval(() => {
    void runAutoTradeStep(cardState, marketIndex);
  }, AUTO_TRADE_INTERVAL_MS);
};

const createMarketCard = (market) => {
  const fragment = marketCardTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".card");
  const refs = {
    root: card,
    title: card.querySelector(".card-head h2"),
    chip: card.querySelector(".chip"),
    addresses: card.querySelector(".market-addresses"),
    stats: card.querySelector(".stats"),
    asksBody: card.querySelector(".asks-table tbody"),
    bidsBody: card.querySelector(".bids-table tbody"),
    depthSpread: card.querySelector("[data-depth-spread]"),
    depthMid: card.querySelector("[data-depth-mid]"),
    limitForm: card.querySelector(".limit-form"),
    tradeForm: card.querySelector(".trade-form"),
    tradeStatus: card.querySelector(".trade-status"),
    actorRoleSelect: card.querySelector(".actor-role-select"),
    balancesBody: card.querySelector(".balances-table tbody"),
    priceChart: card.querySelector("[data-price-chart]"),
    execRange: card.querySelector("[data-exec-chart-range]"),
    execModeButtons: [...card.querySelectorAll("button[data-chart-mode]")],
    autoToggleBtn: card.querySelector("[data-auto-toggle]"),
    autoState: card.querySelector("[data-auto-state]"),
    ordersBody: card.querySelector(".orders-table tbody"),
    actionsBody: card.querySelector(".actions-table tbody"),
  };

  refs.title.textContent = `Market #${market.index} ${market.baseSymbol ?? "BASE"}/${market.quoteSymbol ?? "QUOTE"}`;

  const statBestBid = document.createElement("div");
  statBestBid.className = "stat";
  statBestBid.innerHTML = `<span class="stat-k">Best Bid</span><span class="stat-v ok"></span>`;
  const statBestAsk = document.createElement("div");
  statBestAsk.className = "stat";
  statBestAsk.innerHTML = `<span class="stat-k">Best Ask</span><span class="stat-v warn"></span>`;
  const statSpread = document.createElement("div");
  statSpread.className = "stat";
  statSpread.innerHTML = `<span class="stat-k">Spread</span><span class="stat-v"></span>`;
  refs.stats.append(statBestBid, statBestAsk, statSpread);

  const prefillFromLevel = (level, side) => {
    const sideSelect = refs.limitForm.querySelector("select[name='side']");
    const priceInput = refs.limitForm.querySelector("input[name='priceQuotePerBase']");
    const amountInput = refs.limitForm.querySelector("input[name='amountBase']");
    priceInput.value = level.priceQuotePerBase;
    amountInput.value = Math.max(1, Math.floor(Number.parseFloat(level.sizeBase) || 1));
    sideSelect.value = side === "ask" ? "buy" : "sell";
    refs.tradeStatus.className = "trade-status muted";
    refs.tradeStatus.textContent = `Prefilled ${side} level ${level.priceQuotePerBase}`;
  };

  refs.limitForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(refs.limitForm);
    const payload = {
      side: String(formData.get("side") ?? "buy").toLowerCase(),
      amountBase: Number(formData.get("amountBase") ?? 0),
      priceQuotePerBase: Number(formData.get("priceQuotePerBase") ?? 0),
      actorRole: cardState.actorRole || undefined,
    };
    const submitBtn = refs.limitForm.querySelector("button[type='submit']");
    await sendLimit(market.index, payload, refs.tradeStatus, submitBtn);
  });

  refs.tradeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(refs.tradeForm);
    const payload = {
      side: String(formData.get("side") ?? "buy").toLowerCase(),
      amountBase: Number(formData.get("amountBase") ?? 0),
      maxQuote: Number(formData.get("maxQuote") ?? 0),
      actorRole: cardState.actorRole || undefined,
    };
    const submitBtn = refs.tradeForm.querySelector("button[type='submit']");
    await sendMarket(market.index, payload, refs.tradeStatus, submitBtn);
  });

  refs.ordersBody.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest("button[data-order-id]");
    if (!(button instanceof HTMLButtonElement)) return;
    const orderId = Number(button.dataset.orderId ?? 0);
    const rawAmount = Number.parseFloat(button.dataset.orderAmount ?? "0");
    const amountBase = Math.max(1, Math.floor(Number.isFinite(rawAmount) ? rawAmount : 1));
    await takeOrder(market.index, orderId, amountBase, refs.tradeStatus, button, cardState);
  });

  const cardState = {
    ...refs,
    statBid: statBestBid.querySelector(".stat-v"),
    statAsk: statBestAsk.querySelector(".stat-v"),
    statSpread: statSpread.querySelector(".stat-v"),
    prefillFromLevel,
    execTrades: [],
    execTradeKeys: new Set(),
    latestBalances: [],
    actorRole: "",
    execChartMode: "tick",
    priceChartApi: null,
    priceChartResizeObserver: null,
    tickSeries: null,
    candleSeries: null,
    chartPricePrecision: null,
    chartPriceMinMove: null,
    chartDidInitialFit: false,
    autoRunning: false,
    autoInFlight: false,
    autoMakerSide: "sell",
    autoStatusText: "auto: stopped",
    autoTimer: null,
    latestMarket: market,
  };

  refs.actorRoleSelect.addEventListener("change", () => {
    cardState.actorRole = refs.actorRoleSelect.value;
    renderBalancesTable(refs.balancesBody, cardState.latestBalances, cardState.actorRole, (role) => {
      cardState.actorRole = role;
      refs.actorRoleSelect.value = role;
    });
  });

  if (refs.autoToggleBtn) {
    refs.autoToggleBtn.addEventListener("click", () => {
      if (cardState.autoRunning) {
        stopAutoTrade(cardState, "auto: stopped");
        return;
      }
      startAutoTrade(cardState, market.index);
    });
  }

  const updateModeButtons = () => {
    cardState.execModeButtons.forEach((button) => {
      const active = button.dataset.chartMode === cardState.execChartMode;
      button.classList.toggle("active", active);
    });
  };

  cardState.execModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      cardState.execChartMode = button.dataset.chartMode === "candle"
        ? "candle"
        : "tick";
      updateModeButtons();
      renderPriceChart(cardState);
    });
  });
  updateModeButtons();
  updateAutoTradeUi(cardState);

  marketCards.set(market.index, cardState);

  marketsEl.appendChild(fragment);
  return marketCards.get(market.index);
};

const updateMarketCard = (market) => {
  const cardState = marketCards.get(market.index) ?? createMarketCard(market);
  cardState.latestMarket = market;
  cardState.root.style.display =
    activeMarketIndex === null || market.index === activeMarketIndex
      ? ""
      : "none";

  setCellText(
    cardState.chip,
    market.spreadBps === null ? "No Spread" : `${market.spreadBps} bps`,
  );
  cardState.addresses.innerHTML = `
    <div><b>Orderbook:</b> <code>${market.orderbook}</code></div>
    <div><b>Base Vault:</b> <code>${market.baseVault}</code></div>
    <div><b>Quote Vault:</b> <code>${market.quoteVault}</code></div>
    <div><b>Pair:</b> <code>${market.baseSymbol ?? "BASE"}/${market.quoteSymbol ?? "QUOTE"}</code></div>
    <div><b>Base Token ID:</b> <code>${market.baseTokenId}</code></div>
    <div><b>Quote Token ID:</b> <code>${market.quoteTokenId ?? "-"}</code></div>
  `;

  setCellText(cardState.statBid, market.bestBid);
  setCellText(cardState.statAsk, market.bestAsk);
  setCellText(cardState.statSpread, market.spreadBps === null ? "-" : `${market.spreadBps} bps`);

  const asks = market.depth?.asks ?? [];
  const bids = market.depth?.bids ?? [];
  const maxDepthTotalBase = Math.max(
    0,
    ...asks.map((level) => parsePositiveNumber(level.totalBase)),
    ...bids.map((level) => parsePositiveNumber(level.totalBase)),
  );
  renderDepthTable(
    cardState.asksBody,
    [...asks].reverse(),
    "ask",
    cardState.prefillFromLevel,
    maxDepthTotalBase,
  );
  renderDepthTable(cardState.bidsBody, bids, "bid", cardState.prefillFromLevel, maxDepthTotalBase);
  const bestBid = parsePositiveNumber(market.bestBid);
  const bestAsk = parsePositiveNumber(market.bestAsk);
  const hasTopOfBook = bestBid > 0 && bestAsk > 0 && bestAsk >= bestBid;
  setCellText(
    cardState.depthSpread,
    hasTopOfBook
      ? `${formatPriceAdaptive(bestAsk - bestBid)} (${market.spreadBps ?? "0"} bps)`
      : "-",
  );
  setCellText(
    cardState.depthMid,
    hasTopOfBook ? formatPriceAdaptive((bestAsk + bestBid) / 2) : "-",
  );
  renderRecentOrders(cardState.ordersBody, market.orders ?? []);
  const actions = market.recentActions ?? [];
  renderTradeTape(cardState.actionsBody, actions);
  appendExecutionTrades(cardState, actions, market);

  cardState.latestBalances = market.balances ?? [];
  const roles = cardState.latestBalances.map((row) => row.role);
  const nextRole = roles.includes(cardState.actorRole) ? cardState.actorRole : (roles[0] ?? "");
  cardState.actorRoleSelect.innerHTML = "";
  for (const role of roles) {
    const option = document.createElement("option");
    option.value = role;
    option.textContent = role;
    cardState.actorRoleSelect.appendChild(option);
  }
  cardState.actorRole = nextRole;
  if (nextRole) {
    cardState.actorRoleSelect.value = nextRole;
  }
  const refreshBalanceView = () => {
    renderBalancesTable(
      cardState.balancesBody,
      cardState.latestBalances,
      cardState.actorRole,
      (role) => {
        cardState.actorRole = role;
        cardState.actorRoleSelect.value = role;
        refreshBalanceView();
      },
    );
  };
  refreshBalanceView();

  if (cardState.root.style.display !== "none") {
    resizePriceChart(cardState);
    renderPriceChart(cardState);
  }
  updateAutoTradeUi(cardState);
};

const renderSnapshot = (snapshot) => {
  latestSnapshot = snapshot;

  setWarning(snapshot.warning);
  const date = new Date(snapshot.updatedAt);
  metaEl.textContent = `Last tick: ${date.toLocaleTimeString()} | Refresh ${(
    snapshot.refreshMs / 1000
  ).toFixed(1)}s | CEX ladder + live tape`;

  const indexes = new Set(snapshot.markets.map((m) => m.index));
  if (activeMarketIndex === null || !indexes.has(activeMarketIndex)) {
    activeMarketIndex = snapshot.markets[0]?.index ?? null;
  }
  renderTabs(snapshot.markets);

  const activeIndexes = new Set(snapshot.markets.map((m) => m.index));
  for (const market of snapshot.markets) {
    updateMarketCard(market);
  }
  for (const [index, cardState] of marketCards.entries()) {
    if (activeIndexes.has(index)) continue;
    stopAutoTrade(cardState, "auto: stopped");
    if (cardState.priceChartResizeObserver) {
      cardState.priceChartResizeObserver.disconnect();
    }
    cardState.root.remove();
    marketCards.delete(index);
  }
};

const renderError = (message) => {
  metaEl.textContent = "Snapshot error";
  warningsEl.innerHTML = `<p class="warning">${message}</p>`;
};

let pollMs = POLL_INTERVAL_MS;
let polling = false;
let stopped = false;

const poll = async () => {
  if (polling || stopped) return;
  polling = true;
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    const nextPollMs = Number(snapshot.refreshMs);
    pollMs =
      Number.isFinite(nextPollMs) && nextPollMs >= MIN_POLL_INTERVAL_MS
        ? nextPollMs
        : POLL_INTERVAL_MS;
    renderSnapshot(snapshot);
  } catch (error) {
    renderError(error?.message ?? String(error));
  } finally {
    polling = false;
    if (!stopped) setTimeout(poll, pollMs);
  }
};

window.addEventListener("resize", () => {
  resizeVisibleCharts();
});

window.addEventListener("beforeunload", () => {
  stopped = true;
  for (const cardState of marketCards.values()) {
    stopAutoTrade(cardState, "auto: stopped");
  }
});

poll();
