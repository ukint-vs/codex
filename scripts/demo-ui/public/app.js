import { DexBrowserAgent } from "./agent.js";

const marketsEl = document.getElementById("markets");
const metaEl = document.getElementById("meta");
const warningsEl = document.getElementById("warnings");
const tabsEl = document.getElementById("market-tabs");
const marketCardTemplate = document.getElementById("market-card-template");
const llmProviderEl = document.getElementById("llm-provider");
const llmModelEl = document.getElementById("llm-model");
const llmApiKeyEl = document.getElementById("llm-api-key");
const llmWalletEl = document.getElementById("llm-wallet");
const llmChatEl = document.getElementById("llm-chat");
const llmLoaderEl = document.getElementById("llm-loader");
const llmFormEl = document.getElementById("llm-form");
const llmInputEl = document.getElementById("llm-input");
const llmCancelEl = document.getElementById("llm-cancel");
const llmChartEl = document.getElementById("llm-market-chart");
const llmChartMetaEl = document.getElementById("llm-chart-meta");

const EXEC_CHART_MAX_POINTS = 500;
const EXEC_CHART_HISTORY_MAX_POINTS = 3000;
const EXEC_CHART_LOOKBACK_MS = 75 * 60_000;
const EXEC_CHART_RETAIN_MS = 4 * 60 * 60_000;
const EXEC_CANDLE_MAX_POINTS = 240;
const CANDLE_BUCKET_MS = 15_000;
const CANDLE_BUCKET_LABEL = "15s";
const PRICE_DISPLAY_STEP = 0.000001;
const AUTO_PRICE_STEP = 0.000001;
const AUTO_MIN_EXEC_MOVE_TICKS = 4;
const PRICE_CHART_HEIGHT = 300;
const POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;
const CHART_POLL_INTERVAL_MS = 1000;
const AUTO_TRADE_INTERVAL_MS = 1700;
const AUTO_TRADE_STEP_DELAY_MS = 40;
const AUTO_MAKER_BASE_OFFSET_BPS = 5;
const AUTO_MAKER_LEVEL_SPACING_BPS = 20;
const AUTO_MAKER_LEVELS = 8;
const AUTO_MAKER_ORDERS_PER_LEVEL = 4;
const AUTO_MIN_RESTING_PER_SIDE = 28;
const AUTO_REPLENISH_MAX_PASSES = 3;
const AUTO_TRADE_ATTEMPT_FACTOR = 6;
const AUTO_PICK_WINDOW = 40;
const AUTO_ROLE_SLOTS = 4;
const AUTO_TRADES_PER_TICK_MIN = 10;
const AUTO_TRADES_PER_TICK_MAX = 50;
const AUTO_SWEEP_PER_TICK_MIN = 2;
const AUTO_SWEEP_PER_TICK_MAX = 5;
const AUTO_DRIFT_STEP_BPS = 70;
const AUTO_DRIFT_JUMP_BPS = 460;
const AUTO_DRIFT_JUMP_PROB = 0.28;
const AUTO_DRIFT_MEAN_REVERT = 0.13;
const AUTO_DRIFT_MAX_BPS = 2800;
const AUTO_EXEC_TARGET_JITTER_BPS = 240;
const LLM_MARKET_HISTORY_MAX = 360;

const chartLib = window.LightweightCharts;
const marketCards = new Map();
let activeMarketIndex = null;
let latestSnapshot = null;
let chartLibMissingWarned = false;
let llmBusy = false;
let llmAbortController = null;
const llmMessages = [];
const llmAgent = new DexBrowserAgent({ debug: false });
const llmMarketHistory = new Map();
let llmChartApi = null;
let llmBidSeries = null;
let llmAskSeries = null;

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

const formatPriceForInput = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1) return n.toFixed(10).replace(/\.?0+$/, "");
  return n.toFixed(14).replace(/\.?0+$/, "");
};

const parsePositiveNumber = (value) => {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const formatPriceDisplay = (value) => {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) && n > 0 ? formatPriceAdaptive(n) : String(value ?? "-");
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");

const formatInline = (value) => {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return html;
};

const formatLlmMessageHtml = (content) => {
  const lines = String(content ?? "").split(/\r?\n/);
  let html = "";
  let inList = false;

  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    const bullet = raw.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        html += '<ul class="chat-list">';
        inList = true;
      }
      html += `<li>${formatInline(bullet[1])}</li>`;
      continue;
    }

    closeList();
    if (!line) {
      html += '<div class="chat-gap"></div>';
      continue;
    }
    html += `<p>${formatInline(line)}</p>`;
  }

  closeList();
  return html || `<p>${formatInline(content)}</p>`;
};

const addLlmMessage = (role, content) => {
  if (!llmChatEl) return;
  const row = document.createElement("div");
  row.className = `chat-row ${role}`;
  const who = role === "assistant" ? "Assistant" : "You";
  row.innerHTML = `<div class="chat-role">${who}</div><div class="chat-bubble"></div>`;
  row.querySelector(".chat-bubble").innerHTML = formatLlmMessageHtml(content);
  llmChatEl.appendChild(row);
  llmChatEl.scrollTop = llmChatEl.scrollHeight;
};

const setLlmLoading = (loading) => {
  if (llmLoaderEl) {
    llmLoaderEl.hidden = !loading;
  }
  const submitBtn = llmFormEl?.querySelector("button[type='submit']");
  if (submitBtn) submitBtn.disabled = loading;
  if (llmCancelEl) {
    llmCancelEl.disabled = !loading;
    llmCancelEl.hidden = !loading;
  }
  if (llmInputEl) llmInputEl.disabled = loading;
};

const cancelLlmRequest = () => {
  if (!llmAbortController) return;
  llmAbortController.abort();
};

const ensureLlmChart = () => {
  if (!llmChartEl || llmChartApi || !chartLib) return;
  const width = Math.max(320, llmChartEl.clientWidth || 0);
  llmChartApi = chartLib.createChart(llmChartEl, {
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
  });

  llmBidSeries = llmChartApi.addLineSeries({
    color: "#48e0b6",
    lineWidth: 2,
    title: "Best Bid",
  });
  llmAskSeries = llmChartApi.addLineSeries({
    color: "#ffbf70",
    lineWidth: 2,
    title: "Best Ask",
  });
};

const renderLlmMarketChart = () => {
  if (!latestSnapshot?.markets?.length || activeMarketIndex === null) return;
  ensureLlmChart();
  if (!llmChartApi || !llmBidSeries || !llmAskSeries) return;

  const history = llmMarketHistory.get(activeMarketIndex) ?? [];
  const bidData = history
    .filter((x) => Number.isFinite(x.bid))
    .map((x) => ({ time: x.time, value: x.bid }));
  const askData = history
    .filter((x) => Number.isFinite(x.ask))
    .map((x) => ({ time: x.time, value: x.ask }));

  llmBidSeries.setData(bidData);
  llmAskSeries.setData(askData);
  llmChartApi.timeScale().fitContent();

  const market = latestSnapshot.markets.find((m) => m.index === activeMarketIndex);
  if (!market || !llmChartMetaEl) return;
  llmChartMetaEl.textContent = `Market #${market.index} | bid ${formatPriceDisplay(market.bestBid)} | ask ${formatPriceDisplay(market.bestAsk)} | spread ${market.spreadBps ?? "-"}`;
};

const sendLlmChat = async (question) => {
  if (llmBusy) return;
  const text = String(question ?? "").trim();
  if (!text) return;
  llmBusy = true;
  llmAbortController = new AbortController();
  addLlmMessage("user", text);
  llmMessages.push({ role: "user", content: text });
  if (llmInputEl) llmInputEl.value = "";
  setLlmLoading(true);

  try {
    llmAgent.activeMarketIndex = activeMarketIndex;
    const reply = await llmAgent.run({
      provider: llmProviderEl?.value || "openrouter",
      model: llmModelEl?.value?.trim() || undefined,
      apiKey: llmApiKeyEl?.value?.trim() || undefined,
      walletAddress: llmWalletEl?.value?.trim() || undefined,
      messages: llmMessages,
      signal: llmAbortController.signal,
    });
    const normalized = String(reply ?? "").trim() || "No response from assistant.";
    addLlmMessage("assistant", normalized);
    llmMessages.push({ role: "assistant", content: normalized });
  } catch (error) {
    const message = (error && error.name === "AbortError")
      ? "Request canceled."
      : `Assistant error: ${error?.message ?? String(error)}`;
    addLlmMessage("assistant", message);
    llmMessages.push({ role: "assistant", content: message });
  } finally {
    llmBusy = false;
    llmAbortController = null;
    setLlmLoading(false);
  }
};

const roundToStep = (value, step = PRICE_DISPLAY_STEP) => {
  const n = Number(value);
  if (!Number.isFinite(n) || step <= 0) return 0;
  return Math.round(n / step) * step;
};

const formatDepthPrice = (value) => {
  const n = roundToStep(parsePositiveNumber(value), PRICE_DISPLAY_STEP);
  if (!Number.isFinite(n) || n <= 0) return "0.000000";
  return n.toFixed(6);
};

const normalizeTradesForChart = (trades) =>
  trades
    .filter((trade) => Number.isFinite(trade.price) && trade.price > 0)
    .sort((a, b) => (a.ts - b.ts) || ((a.seq ?? 0) - (b.seq ?? 0)));

const selectChartTrades = (trades) => {
  const list = Array.isArray(trades) ? trades : [];
  if (list.length === 0) return [];
  const cutoff = Date.now() - EXEC_CHART_LOOKBACK_MS;
  const recent = list.filter((trade) => Number(trade.ts) >= cutoff);
  const picked = recent.length > 0 ? recent : list.slice(-EXEC_CHART_MAX_POINTS);
  return picked.slice(-EXEC_CHART_HISTORY_MAX_POINTS);
};

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
  return sortedBuckets.slice(-EXEC_CANDLE_MAX_POINTS);
};

const renderTabs = (markets) => {
  tabsEl.innerHTML = "";
  for (const market of markets) {
    const pairLabel = `${market.baseSymbol ?? "BASE"}/${market.quoteSymbol ?? "QUOTE"}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tab-btn ${market.index === activeMarketIndex ? "active" : ""}`;
    button.textContent = `M${market.index} ${pairLabel}`;
    button.addEventListener("click", () => {
      activeMarketIndex = market.index;
      renderTabs(markets);
      if (latestSnapshot) {
        for (const row of latestSnapshot.markets) {
          updateMarketCard(row);
        }
        resizeVisibleCharts();
        renderLlmMarketChart();
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
    const displayPrice = formatDepthPrice(level.priceQuotePerBase);
    const normalizedPrice = roundToStep(parsePositiveNumber(level.priceQuotePerBase), PRICE_DISPLAY_STEP);
    tr.className = `orderbook-row ${side}`;
    tr.dataset.price = normalizedPrice > 0 ? String(normalizedPrice) : level.priceQuotePerBase;
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
      <td class="ob-price ${side === "ask" ? "ask-price" : "bid-price"}">${displayPrice}</td>
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

const renderTradeTape = (tbody, trades) => {
  tbody.innerHTML = "";
  const rows = (trades ?? []).slice(0, 30);
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="muted">No on-chain executed trades yet.</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const trade of rows) {
    const tr = document.createElement("tr");
    const time = new Date(trade.ts).toLocaleTimeString();
    const price = formatPriceAdaptive(parsePositiveNumber(trade.priceQuotePerBase));
    const amountBase = parsePositiveNumber(trade.amountBase) > 0
      ? trade.amountBase
      : "0";
    const amountQuote = parsePositiveNumber(trade.amountQuote) > 0
      ? trade.amountQuote
      : "0";
    tr.innerHTML = `
      <td>${time}</td>
      <td>#${trade.seq}</td>
      <td>${price}</td>
      <td>${amountBase} / ${amountQuote}</td>
      <td>
        m#${trade.makerOrderId} ${shortAddress(trade.maker)}
        -> t#${trade.takerOrderId} ${shortAddress(trade.taker)}
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
      background: { color: "#081224" },
      textColor: "#b8d9fa",
    },
    localization: {
      priceFormatter: (price) => formatPriceAdaptive(price),
    },
    grid: {
      vertLines: { color: "#35537955" },
      horzLines: { color: "#35537955" },
    },
    rightPriceScale: {
      borderColor: "#456c94",
      autoScale: true,
    },
    timeScale: {
      borderColor: "#456c94",
      timeVisible: true,
      secondsVisible: true,
    },
    crosshair: {
      mode: chartLib.CrosshairMode.Normal,
    },
  });

  cardState.priceChartApi = chart;
  cardState.tickSeries = chart.addLineSeries({
    color: "#69d8ff",
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
    upColor: "#1f7f86",
    downColor: "#2f6292",
    wickUpColor: "#48e0b6",
    wickDownColor: "#75cfff",
    borderVisible: true,
    borderUpColor: "#48e0b6",
    borderDownColor: "#75cfff",
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

  const modeChanged = cardState.lastRenderedChartMode !== cardState.execChartMode;
  const trades = selectChartTrades(cardState.execTrades);
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

  if (!cardState.chartDidInitialFit || modeChanged) {
    cardState.priceChartApi.timeScale().fitContent();
    cardState.chartDidInitialFit = true;
    cardState.lastRenderedChartMode = cardState.execChartMode;
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
  const mid = referenceMidForMarket(market);
  if (!Number.isFinite(mid) || mid <= 0) return true;
  return price >= mid * 0.05 && price <= mid * 20;
};

const trimExecutionTrades = (cardState) => {
  while (cardState.execTrades.length > EXEC_CHART_HISTORY_MAX_POINTS) {
    const removed = cardState.execTrades.shift();
    if (removed?.key) {
      cardState.execTradeKeys.delete(removed.key);
    }
  }
  const minTs = Date.now() - EXEC_CHART_RETAIN_MS;
  while (cardState.execTrades.length > 0 && Number(cardState.execTrades[0]?.ts) < minTs) {
    const removed = cardState.execTrades.shift();
    if (removed?.key) {
      cardState.execTradeKeys.delete(removed.key);
    }
  }
};

const appendExecutionTradePoint = (cardState, trade) => {
  const price = parsePositiveNumber(trade?.price);
  if (!Number.isFinite(price) || price <= 0) return false;
  if (!isExecutionPricePlausible(price, cardState.latestMarket)) return false;
  const key = String(
    trade?.key
      ?? `local|${Date.now()}|${cardState.nextExecSeq}|${trade?.side ?? "na"}`,
  );
  if (cardState.execTradeKeys.has(key)) return false;
  cardState.execTradeKeys.add(key);
  const parsedSeq = Number.parseInt(String(trade?.seq ?? ""), 10);
  const seq = Number.isFinite(parsedSeq) ? parsedSeq : cardState.nextExecSeq;
  cardState.execTrades.push({
    key,
    ts: Number.isFinite(Number(trade?.ts)) ? Number(trade.ts) : Date.now(),
    price,
    side: trade?.side === "sell" ? "sell" : "buy",
    seq,
  });
  cardState.nextExecSeq = Math.max(cardState.nextExecSeq + 1, seq + 1);
  trimExecutionTrades(cardState);
  return true;
};

const appendExecutionTrades = (cardState, trades, market) => {
  if (!Array.isArray(trades) || trades.length === 0) return;

  const ordered = [...trades].sort((a, b) => {
    const aSeq = Number.parseInt(String(a?.seq ?? ""), 10);
    const bSeq = Number.parseInt(String(b?.seq ?? ""), 10);
    if (Number.isFinite(aSeq) && Number.isFinite(bSeq) && aSeq !== bSeq) {
      return aSeq - bSeq;
    }
    const aTs = Date.parse(String(a?.ts ?? ""));
    const bTs = Date.parse(String(b?.ts ?? ""));
    if (!Number.isFinite(aTs) || !Number.isFinite(bTs)) return 0;
    return aTs - bTs;
  });

  for (const trade of ordered) {
    const price = parsePositiveNumber(trade.priceQuotePerBase);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!isExecutionPricePlausible(price, market ?? cardState.latestMarket)) continue;
    const ts = Date.parse(String(trade.ts ?? ""));
    const key = `chain|${trade.seq ?? `${trade.makerOrderId}|${trade.takerOrderId}|${trade.ts}`}`;
    appendExecutionTradePoint(cardState, {
      key,
      seq: trade.seq,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      price,
      side: "buy",
    });
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

const marketPairKey = (market) =>
  `${(market?.baseSymbol ?? "BASE").toUpperCase()}/${(market?.quoteSymbol ?? "QUOTE").toUpperCase()}`;

const fallbackMidForMarket = (market) => fallbackMidByPair.get(marketPairKey(market)) ?? 0;

const estimateMidPrice = (market) => {
  const bestBid = parsePositiveNumber(market?.bestBid);
  const bestAsk = parsePositiveNumber(market?.bestAsk);
  if (bestBid > 0 && bestAsk > 0 && bestAsk >= bestBid) {
    return (bestBid + bestAsk) / 2;
  }
  return fallbackMidForMarket(market) || 1;
};

const referenceMidForMarket = (market) => {
  const observed = estimateMidPrice(market);
  const fallback = fallbackMidForMarket(market);
  if (fallback > 0 && observed > 0) {
    if (observed < fallback / 20 || observed > fallback * 20) {
      return fallback;
    }
  }
  return observed > 0 ? observed : (fallback > 0 ? fallback : 1);
};

const pickAutoAmountBase = (mid) => {
  if (mid >= 1000) return 1;
  if (mid >= 100) return 2;
  if (mid >= 1) return 10;
  if (mid >= 0.01) return 50;
  return 250;
};

const estimateAutoMaxQuote = (mid, amountBase) =>
  Math.max(1, Math.ceil(mid * amountBase * 2.6));

const randInt = (min, max) => {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
};

const randFloat = (min, max) =>
  Math.random() * (Math.max(min, max) - Math.min(min, max)) + Math.min(min, max);

const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));

const priceBoundsForReference = (referenceMid) => ({
  low: Math.max(0.000000000001, referenceMid * 0.35),
  high: Math.max(0.000000000002, referenceMid * 2.6),
});

const clampPriceAroundReference = (price, referenceMid) => {
  const bounds = priceBoundsForReference(referenceMid);
  return clampNumber(price, bounds.low, bounds.high);
};

const alignAutoPrice = (price, referenceMid) => {
  const stepped = roundToStep(price, AUTO_PRICE_STEP);
  const normalized = stepped > 0 ? stepped : AUTO_PRICE_STEP;
  return clampPriceAroundReference(normalized, referenceMid);
};

const minJitterBpsForStep = (referenceMid, ticks = 1) => {
  const mid = Math.max(parsePositiveNumber(referenceMid), AUTO_PRICE_STEP);
  const desiredMove = AUTO_PRICE_STEP * Math.max(1, ticks);
  return Math.ceil((desiredMove * 10_000) / mid);
};

const normalizeObservedMid = (observedMid, referenceMid) => {
  if (!Number.isFinite(observedMid) || observedMid <= 0) return referenceMid;
  const bounds = priceBoundsForReference(referenceMid);
  if (observedMid < bounds.low || observedMid > bounds.high) {
    return referenceMid;
  }
  return observedMid;
};

const selectByWeightedWindow = (rows, targetPrice, window) => {
  if (!rows.length) return null;
  const ranked = [...rows].sort((a, b) => {
    const aPx = parsePositiveNumber(a.priceQuotePerBase);
    const bPx = parsePositiveNumber(b.priceQuotePerBase);
    return Math.abs(aPx - targetPrice) - Math.abs(bPx - targetPrice);
  });
  const pickWindow = Math.max(1, Math.min(ranked.length, window));
  let totalWeight = 0;
  for (let i = 0; i < pickWindow; i += 1) {
    totalWeight += pickWindow - i;
  }
  let roll = Math.random() * totalWeight;
  for (let i = 0; i < pickWindow; i += 1) {
    roll -= pickWindow - i;
    if (roll <= 0) return ranked[i];
  }
  return ranked[pickWindow - 1];
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

const countRestingOrdersBySideFromMarket = (market) => {
  const fromOrders = countRestingOrdersBySide(market?.orders ?? []);
  let depthBuy = 0;
  let depthSell = 0;
  for (const level of market?.depth?.bids ?? []) {
    depthBuy += Math.max(0, Number(level?.orders ?? 0));
  }
  for (const level of market?.depth?.asks ?? []) {
    depthSell += Math.max(0, Number(level?.orders ?? 0));
  }
  return {
    buy: Math.max(fromOrders.buy, depthBuy),
    sell: Math.max(fromOrders.sell, depthSell),
  };
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
  const topCount = Math.max(1, Math.min(AUTO_ROLE_SLOTS, ranked.length));
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
  cardState.autoMidDriftBps = 0;
  cardState.autoFairMid = 0;
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
    const referenceMid = referenceMidForMarket(liveMarket);
    const observedMid = normalizeObservedMid(estimateMidPrice(liveMarket), referenceMid);
    const previousDrift = Number(cardState.autoMidDriftBps ?? 0);
    const noiseBps =
      randInt(-AUTO_DRIFT_STEP_BPS, AUTO_DRIFT_STEP_BPS)
      + randInt(-AUTO_DRIFT_STEP_BPS, AUTO_DRIFT_STEP_BPS) * 0.5;
    const jumpBps = Math.random() < AUTO_DRIFT_JUMP_PROB
      ? randInt(-AUTO_DRIFT_JUMP_BPS, AUTO_DRIFT_JUMP_BPS)
      : 0;
    const observedPullBps = clampNumber(
      ((observedMid / referenceMid) - 1) * 10_000 * 0.35,
      -260,
      260,
    );
    let nextDrift = clampNumber(
      previousDrift
      - previousDrift * AUTO_DRIFT_MEAN_REVERT
      + noiseBps
      + jumpBps
      + observedPullBps,
      -AUTO_DRIFT_MAX_BPS,
      AUTO_DRIFT_MAX_BPS,
    );
    cardState.autoMidDriftBps = Math.round(nextDrift);
    let fairMid = alignAutoPrice(
      referenceMid * (1 + nextDrift / 10_000),
      referenceMid,
    );
    cardState.autoFairMid = fairMid;
    const takerAmountBase = pickAutoAmountBase(fairMid);
    const makerBaseAmount = Math.max(
      1,
      Math.floor(takerAmountBase * randFloat(0.35, 0.75)),
    );
    let makerPlaced = 0;
    let makerFailed = 0;
    let liquidityMisses = 0;
    let lastMakerLabel = "-";

    const makerPriceAtLevel = (side, level = 1) => {
      const driftSkewBps = clampNumber(nextDrift * 0.07, -18, 18);
      const sideSkew = side === "buy" ? -driftSkewBps : driftSkewBps;
      const baseOffset = AUTO_MAKER_BASE_OFFSET_BPS + AUTO_MAKER_LEVEL_SPACING_BPS * (level - 1);
      const jitter = randFloat(-2.5, 4.5);
      const offsetBps = Math.max(1, baseOffset + sideSkew + jitter);
      const rawPrice = side === "buy"
        ? fairMid * (1 - offsetBps / 10_000)
        : fairMid * (1 + offsetBps / 10_000);
      return alignAutoPrice(rawPrice, referenceMid);
    };

    const placeMakerOrder = async (snapshot, side, level = 1) => {
      const price = makerPriceAtLevel(side, level);
      const amountBase = Math.max(1, Math.floor(makerBaseAmount * randFloat(0.7, 1.4)));
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
        if (level >= 4 && Math.random() < 0.45) continue;
        for (const makerSide of ["buy", "sell"]) {
          const ordersAtLevel = level <= 2 ? AUTO_MAKER_ORDERS_PER_LEVEL : 1;
          for (let i = 0; i < ordersAtLevel; i += 1) {
            await placeMakerOrder(snapshot, makerSide, level);
          }
        }
      }
    };

    const replenishBookIfThin = async () => {
      let refreshed = false;
      for (let pass = 0; pass < AUTO_REPLENISH_MAX_PASSES; pass += 1) {
        const counts = countRestingOrdersBySideFromMarket(liveMarket);
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
    const sweepsTarget = randInt(AUTO_SWEEP_PER_TICK_MIN, AUTO_SWEEP_PER_TICK_MAX);
    let tradesDone = 0;
    let sweepsDone = 0;
    let attempts = 0;
    const maxAttempts = Math.max(14, tradesTarget * AUTO_TRADE_ATTEMPT_FACTOR);

    while (tradesDone < tradesTarget && attempts < maxAttempts) {
      attempts += 1;
      liveMarket =
        await fetchMarketSnapshot(marketIndex, { render: true })
        ?? latestSnapshot?.markets?.find((m) => m.index === marketIndex)
        ?? liveMarket;
      if (!liveMarket) break;

      const counts = countRestingOrdersBySideFromMarket(liveMarket);
      if (
        counts.buy < Math.ceil(AUTO_MIN_RESTING_PER_SIDE / 2)
        || counts.sell < Math.ceil(AUTO_MIN_RESTING_PER_SIDE / 2)
      ) {
        await replenishBookIfThin();
      }

      const candidates = (liveMarket.orders ?? [])
        .filter((row) => parsePositiveNumber(row.remainingBase) >= 1)
        .filter((row) => {
          const px = parsePositiveNumber(row.priceQuotePerBase);
          if (px <= 0) return false;
          const bounds = priceBoundsForReference(referenceMid);
          return px >= bounds.low && px <= bounds.high;
        });
      if (candidates.length === 0) {
        await wait(Math.max(80, AUTO_TRADE_STEP_DELAY_MS));
        continue;
      }

      fairMid = alignAutoPrice(referenceMid * (1 + nextDrift / 10_000), referenceMid);
      const jitterBps = Math.max(
        AUTO_EXEC_TARGET_JITTER_BPS,
        minJitterBpsForStep(referenceMid, AUTO_MIN_EXEC_MOVE_TICKS),
      );
      const targetPrice = clampPriceAroundReference(
        fairMid * (1 + randInt(-jitterBps, jitterBps) / 10_000),
        referenceMid,
      );
      const picked = selectByWeightedWindow(candidates, targetPrice, AUTO_PICK_WINDOW);
      if (!picked) continue;

      const orderId = Number(picked.id);
      if (!Number.isFinite(orderId) || orderId <= 0) continue;

      const remainingUnits = Math.floor(parsePositiveNumber(picked.remainingBase));
      if (!Number.isFinite(remainingUnits) || remainingUnits < 1) continue;

      const suggested = Math.max(
        1,
        Math.floor(takerAmountBase * randFloat(0.4, 1.45)),
      );
      const amountBase = Math.min(remainingUnits, suggested);
      const makerIsBuy = String(picked.side).toLowerCase() === "buy";
      const takerSide = makerIsBuy ? "sell" : "buy";
      const pickPrice = alignAutoPrice(
        parsePositiveNumber(picked.priceQuotePerBase) || fairMid,
        referenceMid,
      );
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
          const impulse = takerSide === "buy"
            ? randInt(7, 34)
            : -randInt(7, 34);
          nextDrift = clampNumber(
            nextDrift + impulse,
            -AUTO_DRIFT_MAX_BPS,
            AUTO_DRIFT_MAX_BPS,
          );
          cardState.autoMidDriftBps = Math.round(nextDrift);
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

    const observedMidForSweep = estimateMidPrice(liveMarket);
    const canSweepMarketOrders =
      observedMidForSweep >= referenceMid * 0.2
      && observedMidForSweep <= referenceMid * 5;

    while (canSweepMarketOrders && sweepsDone < sweepsTarget) {
      fairMid = alignAutoPrice(referenceMid * (1 + nextDrift / 10_000), referenceMid);
      const buyBias = nextDrift >= 0 ? 0.62 : 0.38;
      const sweepSide = Math.random() < buyBias ? "buy" : "sell";
      const amountBase = Math.max(
        1,
        Math.floor(takerAmountBase * randFloat(0.8, 2.2)),
      );
      const cursor = cardState.autoActorCursor;
      cardState.autoActorCursor += 1;
      const actorRole = pickActorRoleForSide(
        liveMarket?.balances ?? [],
        sweepSide,
        amountBase,
        fairMid,
        cursor,
      );

      try {
        const bestAskNow = parsePositiveNumber(liveMarket?.bestAsk);
        const maxQuoteRef = Math.max(fairMid, referenceMid, bestAskNow);
        const result = await callJson("/api/trigger-order", {
          market: marketIndex,
          side: sweepSide,
          amountBase,
          maxQuote: sweepSide === "buy"
            ? estimateAutoMaxQuote(maxQuoteRef, amountBase)
            : undefined,
          actorRole,
        });
        if (result.executed) {
          sweepsDone += 1;
          const impulse = sweepSide === "buy"
            ? randInt(10, 42)
            : -randInt(10, 42);
          nextDrift = clampNumber(
            nextDrift + impulse,
            -AUTO_DRIFT_MAX_BPS,
            AUTO_DRIFT_MAX_BPS,
          );
          cardState.autoMidDriftBps = Math.round(nextDrift);
        }
      } catch (error) {
        const message = String(error?.message ?? error ?? "");
        if (
          message.includes("InsufficientLiquidity")
          || message.includes("insufficient")
        ) {
          liquidityMisses += 1;
        }
        break;
      }
      await wait(Math.max(50, AUTO_TRADE_STEP_DELAY_MS - 30));
    }

    fairMid = alignAutoPrice(referenceMid * (1 + nextDrift / 10_000), referenceMid);
    cardState.autoFairMid = fairMid;
    cardState.autoStatusText = [
      "auto: running",
      `ref=${formatPriceAdaptive(referenceMid)} fair=${formatPriceAdaptive(fairMid)} drift=${Math.round(nextDrift)}bps`,
      `makers=${makerPlaced}/${makerPlaced + makerFailed}`,
      `trades=${tradesDone}/${tradesTarget}`,
      `sweeps=${sweepsDone}/${sweepsTarget}`,
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
  cardState.autoMidDriftBps = 0;
  cardState.autoFairMid = 0;
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

  refs.title.textContent =
    `codex market #${market.index} ${market.baseSymbol ?? "BASE"}/${market.quoteSymbol ?? "QUOTE"}`;

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
    const parsedPrice = roundToStep(parsePositiveNumber(level.priceQuotePerBase), PRICE_DISPLAY_STEP);
    priceInput.value = parsedPrice > 0
      ? formatPriceForInput(parsedPrice)
      : "";
    priceInput.setCustomValidity("");
    amountInput.value = Math.max(1, Math.floor(Number.parseFloat(level.sizeBase) || 1));
    sideSelect.value = side === "ask" ? "buy" : "sell";
    refs.tradeStatus.className = "trade-status muted";
    refs.tradeStatus.textContent = `Prefilled ${side} level ${priceInput.value || level.priceQuotePerBase}`;
  };
  const limitPriceInput = refs.limitForm.querySelector("input[name='priceQuotePerBase']");
  limitPriceInput?.addEventListener("input", () => {
    limitPriceInput.setCustomValidity("");
  });

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
    nextExecSeq: 0,
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
    lastRenderedChartMode: null,
    autoRunning: false,
    autoInFlight: false,
    autoMakerSide: "sell",
    autoActorCursor: 0,
    autoMidDriftBps: 0,
    autoFairMid: 0,
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
    market.spreadBps === null ? "spread n/a" : `${market.spreadBps} bps`,
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
  const trades = market.trades ?? [];
  renderTradeTape(cardState.actionsBody, trades);
  appendExecutionTrades(cardState, trades, market);

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
    CHART_POLL_INTERVAL_MS / 1000
  ).toFixed(1)}s`;

  const indexes = new Set(snapshot.markets.map((m) => m.index));
  if (activeMarketIndex === null || !indexes.has(activeMarketIndex)) {
    activeMarketIndex = snapshot.markets[0]?.index ?? null;
  }
  renderTabs(snapshot.markets);

  const nowSec = Math.max(1, Math.floor(Date.now() / 1000));
  for (const market of snapshot.markets) {
    const bid = Number.parseFloat(String(market.bestBid ?? "NaN"));
    const ask = Number.parseFloat(String(market.bestAsk ?? "NaN"));
    if (!Number.isFinite(bid) && !Number.isFinite(ask)) continue;
    const rows = llmMarketHistory.get(market.index) ?? [];
    rows.push({ time: nowSec, bid, ask });
    if (rows.length > LLM_MARKET_HISTORY_MAX) rows.splice(0, rows.length - LLM_MARKET_HISTORY_MAX);
    llmMarketHistory.set(market.index, rows);
  }

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

  renderLlmMarketChart();
};

const renderError = (message) => {
  metaEl.textContent = "codex snapshot error";
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
    pollMs = CHART_POLL_INTERVAL_MS;
    renderSnapshot(snapshot);
  } catch (error) {
    renderError(error?.message ?? String(error));
    pollMs = Math.max(MIN_POLL_INTERVAL_MS, CHART_POLL_INTERVAL_MS);
  } finally {
    polling = false;
    if (!stopped) setTimeout(poll, pollMs);
  }
};

window.addEventListener("resize", () => {
  resizeVisibleCharts();
  if (llmChartApi && llmChartEl) {
    const width = llmChartEl.clientWidth;
    if (width > 0) llmChartApi.applyOptions({ width, height: PRICE_CHART_HEIGHT });
  }
});

window.addEventListener("beforeunload", () => {
  stopped = true;
  cancelLlmRequest();
  for (const cardState of marketCards.values()) {
    stopAutoTrade(cardState, "auto: stopped");
  }
});

if (llmWalletEl) {
  const savedWallet = localStorage.getItem("dex_llm_wallet");
  if (savedWallet) llmWalletEl.value = savedWallet;
  llmWalletEl.addEventListener("change", () => {
    localStorage.setItem("dex_llm_wallet", llmWalletEl.value.trim());
  });
}

if (llmProviderEl) {
  const savedProvider = localStorage.getItem("dex_llm_provider");
  if (savedProvider) llmProviderEl.value = savedProvider;
  llmProviderEl.addEventListener("change", () => {
    localStorage.setItem("dex_llm_provider", llmProviderEl.value);
  });
}

if (llmApiKeyEl) {
  const savedApiKey = localStorage.getItem("dex_llm_api_key");
  if (savedApiKey) llmApiKeyEl.value = savedApiKey;
  llmApiKeyEl.addEventListener("change", () => {
    localStorage.setItem("dex_llm_api_key", llmApiKeyEl.value.trim());
  });
}

if (llmFormEl) {
  llmFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendLlmChat(llmInputEl?.value ?? "");
  });
}

if (llmCancelEl) {
  llmCancelEl.addEventListener("click", () => {
    cancelLlmRequest();
  });
}

document.querySelectorAll("[data-q]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const text = btn.getAttribute("data-q") ?? "";
    if (!text) return;
    if (llmInputEl) llmInputEl.value = text;
    await sendLlmChat(text);
  });
});

if (llmChatEl && llmMessages.length === 0) {
  const welcome = "Ask me about balances, spread, depth, orders, or place/cancel actions.";
  addLlmMessage("assistant", welcome);
  llmMessages.push({ role: "assistant", content: welcome });
}

poll();
