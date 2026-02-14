const marketsEl = document.getElementById("markets");
const metaEl = document.getElementById("meta");
const warningsEl = document.getElementById("warnings");
const tabsEl = document.getElementById("market-tabs");
const marketCardTemplate = document.getElementById("market-card-template");

const EXEC_CHART_MAX_POINTS = 500;
const CANDLE_BUCKET_MS = 60_000;
const PRICE_CHART_HEIGHT = 300;
const POLL_INTERVAL_MS = 5000;

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

const buildTickSeries = (trades) => {
  const bySecond = new Map();
  for (const trade of trades) {
    if (!Number.isFinite(trade.price) || trade.price <= 0) continue;
    bySecond.set(toUnixSec(trade.ts), trade.price);
  }
  return [...bySecond.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time, value }));
};

const buildCandles = (trades, bucketMs) => {
  const buckets = new Map();
  for (const trade of trades) {
    if (!Number.isFinite(trade.price) || trade.price <= 0) continue;
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

  return [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-200);
};

const renderTabs = (markets) => {
  tabsEl.innerHTML = "";
  for (const market of markets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tab-btn ${market.index === activeMarketIndex ? "active" : ""}`;
    button.textContent = `Market #${market.index}`;
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

const renderDepthTable = (tbody, levels, side, onPick) => {
  tbody.innerHTML = "";
  if (!levels?.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="3" class="muted">No levels</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const level of levels) {
    const tr = document.createElement("tr");
    tr.className = "orderbook-row";
    tr.dataset.price = level.priceQuotePerBase;
    tr.dataset.size = level.sizeBase;
    tr.dataset.side = side;
    tr.innerHTML = `
      <td>${level.priceQuotePerBase}</td>
      <td>${level.sizeBase}</td>
      <td>${level.totalBase}</td>
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
    ? `Candles ${CANDLE_BUCKET_MS / 1000}s`
    : "Ticks";

  setCellText(
    cardState.execRange,
    `${modeLabel} | last ${lastTrade.price.toFixed(6)} @ ${new Date(lastTrade.ts).toLocaleTimeString()} | range ${minPx.toFixed(6)}-${maxPx.toFixed(6)}`,
  );
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

const takeOrder = async (marketIndex, orderId, amountBase, statusEl, triggerBtn) => {
  triggerBtn.disabled = true;
  statusEl.className = "trade-status muted";
  statusEl.textContent = `Taking #${orderId}...`;
  try {
    const result = await callJson("/api/execute-order", {
      market: marketIndex,
      orderId,
      amountBase,
    });
    const touched = Boolean(result.selectedAffected);
    statusEl.className = touched ? "trade-status ok" : "trade-status muted";
    statusEl.textContent = touched
      ? `Selected #${result.selectedOrderId} touched (${result.selectedRemainingBefore} -> ${result.selectedRemainingAfter})`
      : `Taker #${result.takerOrderId} executed, selected #${result.selectedOrderId} not reached`;
  } catch (error) {
    statusEl.className = "trade-status err";
    statusEl.textContent = `Take failed: ${error?.message ?? String(error)}`;
  } finally {
    triggerBtn.disabled = false;
  }
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
    limitForm: card.querySelector(".limit-form"),
    tradeForm: card.querySelector(".trade-form"),
    tradeStatus: card.querySelector(".trade-status"),
    priceChart: card.querySelector("[data-price-chart]"),
    execRange: card.querySelector("[data-exec-chart-range]"),
    execModeButtons: [...card.querySelectorAll("button[data-chart-mode]")],
    ordersBody: card.querySelector(".orders-table tbody"),
    actionsBody: card.querySelector(".actions-table tbody"),
  };

  refs.title.textContent = `Market #${market.index}`;

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
    await takeOrder(market.index, orderId, amountBase, refs.tradeStatus, button);
  });

  const cardState = {
    ...refs,
    statBid: statBestBid.querySelector(".stat-v"),
    statAsk: statBestAsk.querySelector(".stat-v"),
    statSpread: statSpread.querySelector(".stat-v"),
    prefillFromLevel,
    execTrades: [],
    execTradeKeys: new Set(),
    execChartMode: "tick",
    priceChartApi: null,
    priceChartResizeObserver: null,
    tickSeries: null,
    candleSeries: null,
    chartDidInitialFit: false,
  };

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

  marketCards.set(market.index, cardState);

  marketsEl.appendChild(fragment);
  return marketCards.get(market.index);
};

const updateMarketCard = (market) => {
  const cardState = marketCards.get(market.index) ?? createMarketCard(market);
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
    <div><b>Base Token ID:</b> <code>${market.baseTokenId}</code></div>
  `;

  setCellText(cardState.statBid, market.bestBid);
  setCellText(cardState.statAsk, market.bestAsk);
  setCellText(cardState.statSpread, market.spreadBps === null ? "-" : `${market.spreadBps} bps`);

  renderDepthTable(cardState.asksBody, market.depth?.asks ?? [], "ask", cardState.prefillFromLevel);
  renderDepthTable(cardState.bidsBody, market.depth?.bids ?? [], "bid", cardState.prefillFromLevel);
  renderRecentOrders(cardState.ordersBody, market.orders ?? []);
  const actions = market.recentActions ?? [];
  renderTradeTape(cardState.actionsBody, actions);

  for (const action of [...actions].reverse()) {
    const price = Number.parseFloat(action.executionPriceApprox ?? "NaN");
    if (!Number.isFinite(price) || price <= 0) continue;
    const ts = Date.parse(action.ts);
    const key = `${action.ts}-${action.orderId ?? "na"}-${action.kind}-${action.status}`;
    if (cardState.execTradeKeys.has(key)) continue;
    cardState.execTradeKeys.add(key);
    cardState.execTrades.push({
      key,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      price,
      side: action.side,
    });
  }

  while (cardState.execTrades.length > 3000) {
    const removed = cardState.execTrades.shift();
    if (removed?.key) {
      cardState.execTradeKeys.delete(removed.key);
    }
  }

  if (cardState.root.style.display !== "none") {
    resizePriceChart(cardState);
    renderPriceChart(cardState);
  }
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
    pollMs = POLL_INTERVAL_MS;
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
});

poll();
