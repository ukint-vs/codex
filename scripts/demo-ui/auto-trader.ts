import { setTimeout as sleep } from "node:timers/promises";

type ActionRow = {
  ts: string;
  kind: "market" | "take" | "limit";
  status: "submitted" | "executed" | "failed";
  side: "buy" | "sell";
  amountBase: number;
  baseDelta?: string;
  quoteDelta?: string;
  executionPriceApprox?: string;
};

type OrderRow = {
  id: string;
  side: "Buy" | "Sell";
  owner: string;
  priceQuotePerBase: string;
  remainingBase: string;
  reservedQuote: string;
};

type DepthLevel = {
  priceQuotePerBase: string;
  sizeBase: string;
  totalBase: string;
  orders: number;
};

type BalanceRow = {
  role: string;
  address: string;
  base: string;
  quote: string;
};

type MarketSnapshot = {
  index: number;
  baseSymbol?: string;
  quoteSymbol?: string;
  bestBid: string;
  bestAsk: string;
  orders: OrderRow[];
  depth?: {
    asks: DepthLevel[];
    bids: DepthLevel[];
  };
  balances: BalanceRow[];
  recentActions: ActionRow[];
};

type Snapshot = {
  updatedAt: string;
  markets: MarketSnapshot[];
  warning?: string;
};

type TriggerResult = {
  ok: boolean;
  market?: number;
  side?: "buy" | "sell";
  actorRole?: string;
  orderId?: string;
  amountBase?: number;
  maxQuote?: number;
  executed?: boolean;
  baseDelta?: string;
  quoteDelta?: string;
  error?: string;
};

type ExecuteResult = {
  ok: boolean;
  market?: number;
  selectedOrderId?: number;
  selectedOrderSide?: "buy" | "sell";
  takerSide?: "buy" | "sell";
  actorRole?: string;
  amountBase?: number;
  takerOrderId?: string;
  executed?: boolean;
  selectedAffected?: boolean;
  baseDelta?: string;
  quoteDelta?: string;
  error?: string;
};

type LimitResult = {
  ok: boolean;
  market?: number;
  side?: "buy" | "sell";
  actorRole?: string;
  orderId?: string;
  amountBase?: number;
  priceQuotePerBase?: number;
  executed?: boolean;
  baseDelta?: string;
  quoteDelta?: string;
  error?: string;
};

const DEMO_UI_BASE_URL = (
  process.env.DEMO_UI_BASE_URL ?? "http://127.0.0.1:4180"
).replace(/\/+$/, "");
const INTERVAL_MS = Math.max(700, Number(process.env.ORDER_RUNNER_INTERVAL_MS ?? 2500));
const PER_MARKET_DELAY_MS = Math.max(
  50,
  Number(process.env.ORDER_RUNNER_PER_MARKET_DELAY_MS ?? 180),
);
const CHART_WIDTH = Math.max(16, Number(process.env.ORDER_RUNNER_CHART_WIDTH ?? 44));
const MAKER_OFFSET_BPS = Math.max(1, Number(process.env.ORDER_RUNNER_MAKER_OFFSET_BPS ?? 5));
const MAKER_LEVELS = Math.max(2, Number(process.env.ORDER_RUNNER_MAKER_LEVELS ?? 4));
const TRADES_PER_MARKET_MIN = Math.max(
  2,
  Number(process.env.ORDER_RUNNER_TRADES_MIN ?? 3),
);
const TRADES_PER_MARKET_MAX = Math.max(
  TRADES_PER_MARKET_MIN,
  Number(process.env.ORDER_RUNNER_TRADES_MAX ?? 6),
);
const DRIFT_STEP_BPS = Math.max(4, Number(process.env.ORDER_RUNNER_DRIFT_STEP_BPS ?? 64));
const DRIFT_MAX_BPS = Math.max(150, Number(process.env.ORDER_RUNNER_DRIFT_MAX_BPS ?? 2400));
const MIN_RESTING_PER_SIDE = Math.max(
  8,
  Number(process.env.ORDER_RUNNER_MIN_RESTING_PER_SIDE ?? 18),
);
const REPLENISH_MAX_PASSES = Math.max(
  1,
  Number(process.env.ORDER_RUNNER_REPLENISH_MAX_PASSES ?? 3),
);
const TAKE_PICK_WINDOW = Math.max(3, Number(process.env.ORDER_RUNNER_TAKE_PICK_WINDOW ?? 20));
const ROLE_SLOTS = Math.max(1, Number(process.env.ORDER_RUNNER_ROLE_SLOTS ?? 4));
const MARKETS_FILTER = new Set(
  (process.env.ORDER_RUNNER_MARKETS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x)),
);
const LOOP_LIMIT = Math.max(0, Number(process.env.ORDER_RUNNER_LOOPS ?? 0));

const fallbackMidByPair = new Map<string, number>([
  ["VARA/USDC", 0.001165],
  ["ETH/USDC", 2055],
  ["USDC/VARA", 858.3690987124464],
  ["USDC/USDC", 1],
]);

const toNum = (v: string | number | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const parsePositiveNumber = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const formatPriceAdaptive = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(6).replace(/\.?0+$/, "");
  if (value >= 0.01) return value.toFixed(8).replace(/\.?0+$/, "");
  if (value >= 0.0001) return value.toFixed(10).replace(/\.?0+$/, "");
  return value.toPrecision(10).replace(/\.?0+$/, "");
};

const estimateMid = (market: MarketSnapshot): number => {
  const bid = toNum(market.bestBid);
  const ask = toNum(market.bestAsk);
  if (bid > 0 && ask > 0 && ask >= bid) return (bid + ask) / 2;

  const base = (market.baseSymbol ?? "BASE").toUpperCase();
  const quote = (market.quoteSymbol ?? "QUOTE").toUpperCase();
  return fallbackMidByPair.get(`${base}/${quote}`) ?? 1;
};

const pickAmountBase = (mid: number): number => {
  if (mid >= 1_000) return 1;
  if (mid >= 100) return 2;
  if (mid >= 1) return 10;
  if (mid >= 0.01) return 50;
  return 250;
};

const estimateMaxQuote = (mid: number, amountBase: number): number =>
  Math.max(1, Math.ceil(mid * amountBase * 2.8));

const randInt = (min: number, max: number): number => {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
};

const randFloat = (min: number, max: number): number =>
  Math.random() * (Math.max(min, max) - Math.min(min, max)) + Math.min(min, max);

const clampNumber = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const priceBoundsForReference = (referenceMid: number): { low: number; high: number } => ({
  low: Math.max(0.000000000001, referenceMid * 0.35),
  high: Math.max(0.000000000002, referenceMid * 2.6),
});

const countRestingOrdersBySide = (
  orders: OrderRow[],
): { buy: number; sell: number } => {
  let buy = 0;
  let sell = 0;
  for (const row of orders ?? []) {
    if (parsePositiveNumber(row.remainingBase) < 1) continue;
    if (String(row.side).toLowerCase() === "buy") buy += 1;
    else sell += 1;
  }
  return { buy, sell };
};

const countRestingOrdersBySideFromMarket = (
  market: MarketSnapshot,
): { buy: number; sell: number } => {
  const fromOrders = countRestingOrdersBySide(market.orders ?? []);
  let depthBuy = 0;
  let depthSell = 0;
  for (const level of market.depth?.bids ?? []) {
    depthBuy += Math.max(0, Number(level.orders ?? 0));
  }
  for (const level of market.depth?.asks ?? []) {
    depthSell += Math.max(0, Number(level.orders ?? 0));
  }
  return {
    buy: Math.max(fromOrders.buy, depthBuy),
    sell: Math.max(fromOrders.sell, depthSell),
  };
};

const estimateQuoteForAmount = (priceQuotePerBase: number, amountBase: number): number =>
  Math.max(1, Math.ceil(parsePositiveNumber(priceQuotePerBase) * Math.max(1, amountBase) * 1.25));

const fallbackRoleForSide = (side: "buy" | "sell", cursor: number): string => {
  const slot = Math.abs(Number(cursor ?? 0)) % ROLE_SLOTS;
  return side === "buy" ? `quote-maker-${slot}` : `base-maker-${slot}`;
};

const pickActorRoleForSide = (
  balances: BalanceRow[],
  side: "buy" | "sell",
  amountBase: number,
  priceQuotePerBase: number,
  cursor: number,
): string => {
  const rows = Array.isArray(balances) ? balances : [];
  if (rows.length === 0) return fallbackRoleForSide(side, cursor);

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
  if (pool.length === 0) return fallbackRoleForSide(side, cursor);

  const sufficient = pool.filter((row) =>
    side === "buy" ? row.quote >= requiredQuote : row.base >= requiredBase,
  );
  const ranked = (sufficient.length > 0 ? sufficient : pool)
    .sort((a, b) => (side === "buy" ? (b.quote - a.quote) : (b.base - a.base)));
  const topCount = Math.max(1, Math.min(ROLE_SLOTS, ranked.length));
  const pick = ranked[Math.abs(Number(cursor ?? 0)) % topCount];
  return pick.role || fallbackRoleForSide(side, cursor);
};

const selectByWeightedWindow = <T>(
  rows: T[],
  distance: (row: T) => number,
  window: number,
): T | null => {
  if (rows.length === 0) return null;
  const ranked = [...rows].sort((a, b) => distance(a) - distance(b));
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

const sparkline = (values: number[], width: number): string => {
  const bars = "▁▂▃▄▅▆▇█";
  if (values.length === 0) return "-".repeat(Math.min(width, 12));

  const clipped = values.slice(-width);
  const min = Math.min(...clipped);
  const max = Math.max(...clipped);
  if (min === max) {
    return bars[Math.floor((bars.length - 1) / 2)].repeat(clipped.length);
  }

  return clipped
    .map((v) => {
      const idx = Math.floor(((v - min) / (max - min)) * (bars.length - 1));
      return bars[Math.max(0, Math.min(bars.length - 1, idx))];
    })
    .join("");
};

const deriveExecutionPrice = (
  baseDeltaRaw?: string,
  quoteDeltaRaw?: string,
): number | undefined => {
  const base = Math.abs(toNum(baseDeltaRaw));
  const quote = Math.abs(toNum(quoteDeltaRaw));
  if (!Number.isFinite(base) || !Number.isFinite(quote) || base <= 0 || quote <= 0) {
    return undefined;
  }
  return quote / base;
};

const fetchJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${DEMO_UI_BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const body = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
};

const fetchSnapshot = () => fetchJson<Snapshot>("/api/snapshot");

const submitLimitOrder = (body: {
  market: number;
  side: "buy" | "sell";
  amountBase: number;
  priceQuotePerBase: number;
  actorRole: string;
}) =>
  fetchJson<LimitResult>("/api/submit-limit-order", {
    method: "POST",
    body: JSON.stringify(body),
  });

const triggerOrder = (body: {
  market: number;
  side: "buy" | "sell";
  amountBase: number;
  maxQuote?: number;
  actorRole: string;
}) =>
  fetchJson<TriggerResult>("/api/trigger-order", {
    method: "POST",
    body: JSON.stringify(body),
  });

const executeOrder = (body: {
  market: number;
  orderId: number;
  amountBase?: number;
  actorRole: string;
}) =>
  fetchJson<ExecuteResult>("/api/execute-order", {
    method: "POST",
    body: JSON.stringify(body),
  });

const collectExecutedPrices = (actions: ActionRow[]): number[] =>
  actions
    .filter((x) => {
      if (x.status === "executed") return true;
      const base = Math.abs(toNum(x.baseDelta));
      const quote = Math.abs(toNum(x.quoteDelta));
      return base > 0 && quote > 0;
    })
    .map((x) => toNum(x.executionPriceApprox))
    .filter((x) => x > 0)
    .reverse();

async function main() {
  console.log(`Auto trader started: ${DEMO_UI_BASE_URL}`);
  console.log(`Interval: ${INTERVAL_MS}ms`);
  console.log(`Per-market delay: ${PER_MARKET_DELAY_MS}ms`);
  console.log(`Maker offset: ${MAKER_OFFSET_BPS} bps`);
  console.log(
    `Markets filter: ${MARKETS_FILTER.size > 0 ? [...MARKETS_FILTER].join(",") : "all"}`,
  );
  console.log("Press Ctrl+C to stop.\n");

  const driftByMarket = new Map<number, number>();
  let loops = 0;

  while (LOOP_LIMIT === 0 || loops < LOOP_LIMIT) {
    try {
      const snapshot = await fetchSnapshot();
      const markets = snapshot.markets
        .filter((m) => MARKETS_FILTER.size === 0 || MARKETS_FILTER.has(m.index))
        .sort((a, b) => a.index - b.index);

      if (markets.length === 0) {
        console.log("No markets found in snapshot.");
        await sleep(INTERVAL_MS);
        continue;
      }

      for (const market of markets) {
        try {
          const pair = `${(market.baseSymbol ?? "BASE").toUpperCase()}/${(market.quoteSymbol ?? "QUOTE").toUpperCase()}`;
          let liveMarket = market;
          const mid = estimateMid(liveMarket);
          const bounds = priceBoundsForReference(mid);
          const previousDrift = driftByMarket.get(market.index) ?? 0;
          let drift = clampNumber(
            previousDrift
            - previousDrift * 0.16
            + randInt(-DRIFT_STEP_BPS, DRIFT_STEP_BPS)
            + randInt(-DRIFT_STEP_BPS, DRIFT_STEP_BPS) * 0.4
            + (Math.random() < 0.2 ? randInt(-120, 120) : 0),
            -DRIFT_MAX_BPS,
            DRIFT_MAX_BPS,
          );
          driftByMarket.set(market.index, drift);
          let fairMid = clampNumber(mid * (1 + drift / 10_000), bounds.low, bounds.high);
          const takerAmountBase = pickAmountBase(fairMid);
          const makerAmountBase = Math.max(1, Math.floor(takerAmountBase * randFloat(0.35, 0.75)));
          let actorCursor = randInt(0, 10_000);
          let lastExecPrice: number | undefined;

          let makerPlaced = 0;
          let makerFailed = 0;
          let localRefreshCounter = 0;

          const refreshMarket = async (): Promise<MarketSnapshot> => {
            try {
              const snap = await fetchSnapshot();
              return snap.markets.find((m) => m.index === market.index) ?? liveMarket;
            } catch {
              return liveMarket;
            }
          };

          const placeMakerOrder = async (
            side: "buy" | "sell",
            level: number,
          ): Promise<boolean> => {
            const levelOffset = (MAKER_OFFSET_BPS + (level - 1) * 18) / 10_000;
            const rawPrice = side === "buy"
              ? fairMid * (1 - levelOffset)
              : fairMid * (1 + levelOffset);
            const makerPrice = clampNumber(rawPrice, bounds.low, bounds.high);
            const amountBase = Math.max(1, Math.floor(makerAmountBase * randFloat(0.7, 1.45)));
            const actorRole = pickActorRoleForSide(
              liveMarket.balances ?? [],
              side,
              amountBase,
              makerPrice,
              actorCursor,
            );
            actorCursor += 1;

            try {
              await submitLimitOrder({
                market: market.index,
                side,
                amountBase,
                priceQuotePerBase: makerPrice,
                actorRole,
              });
              makerPlaced += 1;
              return true;
            } catch {
              makerFailed += 1;
              return false;
            }
          };

          const replenishBookIfThin = async (): Promise<void> => {
            for (let pass = 0; pass < REPLENISH_MAX_PASSES; pass += 1) {
              const counts = countRestingOrdersBySideFromMarket(liveMarket);
              const buyMissing = Math.max(0, MIN_RESTING_PER_SIDE - counts.buy);
              const sellMissing = Math.max(0, MIN_RESTING_PER_SIDE - counts.sell);
              if (buyMissing === 0 && sellMissing === 0) return;

              for (let i = 0; i < buyMissing; i += 1) {
                await placeMakerOrder("buy", 1 + Math.floor(i / 2));
              }
              for (let i = 0; i < sellMissing; i += 1) {
                await placeMakerOrder("sell", 1 + Math.floor(i / 2));
              }
              await sleep(Math.max(60, PER_MARKET_DELAY_MS));
              liveMarket = await refreshMarket();
            }
          };

          for (let level = 1; level <= MAKER_LEVELS; level += 1) {
            for (const makerSide of ["buy", "sell"] as const) {
              await placeMakerOrder(makerSide, level);
            }
          }

          await sleep(PER_MARKET_DELAY_MS);
          liveMarket = await refreshMarket();
          await replenishBookIfThin();

          const tradesTarget = randInt(TRADES_PER_MARKET_MIN, TRADES_PER_MARKET_MAX);
          let tradesDone = 0;
          let tradeAttempts = 0;
          const maxAttempts = Math.max(14, tradesTarget * 9);

          while (tradesDone < tradesTarget && tradeAttempts < maxAttempts) {
            tradeAttempts += 1;
            localRefreshCounter += 1;
            if (tradeAttempts === 1 || localRefreshCounter >= 2) {
              liveMarket = await refreshMarket();
              localRefreshCounter = 0;
            }

            const counts = countRestingOrdersBySideFromMarket(liveMarket);
            if (
              counts.buy < Math.ceil(MIN_RESTING_PER_SIDE / 2)
              || counts.sell < Math.ceil(MIN_RESTING_PER_SIDE / 2)
            ) {
              await replenishBookIfThin();
            }

            let executedNow = false;
            const candidates = (liveMarket.orders ?? [])
              .filter((row) => parsePositiveNumber(row.remainingBase) >= 1)
              .filter((row) => {
                const px = parsePositiveNumber(row.priceQuotePerBase);
                return px >= bounds.low && px <= bounds.high;
              });

            if (candidates.length > 0) {
              const targetPrice = clampNumber(
                fairMid * (1 + randInt(-240, 240) / 10_000),
                bounds.low,
                bounds.high,
              );
              const picked = selectByWeightedWindow(
                candidates,
                (row) => Math.abs(parsePositiveNumber(row.priceQuotePerBase) - targetPrice),
                TAKE_PICK_WINDOW,
              );

              if (picked) {
                const orderId = Number(picked.id);
                const remainingBase = Math.max(1, Math.floor(parsePositiveNumber(picked.remainingBase)));
                const amountBase = Math.max(
                  1,
                  Math.min(
                    remainingBase,
                    Math.floor(takerAmountBase * randFloat(0.45, 1.6)),
                  ),
                );
                const makerIsBuy = String(picked.side).toLowerCase() === "buy";
                const takerSide: "buy" | "sell" = makerIsBuy ? "sell" : "buy";
                const pickPrice = parsePositiveNumber(picked.priceQuotePerBase) || fairMid;
                const actorRole = pickActorRoleForSide(
                  liveMarket.balances ?? [],
                  takerSide,
                  amountBase,
                  pickPrice,
                  actorCursor,
                );
                actorCursor += 1;

                try {
                  const result = await executeOrder({
                    market: market.index,
                    orderId,
                    amountBase,
                    actorRole,
                  });
                  if (result.executed || result.selectedAffected) {
                    executedNow = true;
                    tradesDone += 1;
                    lastExecPrice =
                      deriveExecutionPrice(result.baseDelta, result.quoteDelta)
                      ?? pickPrice;
                    drift = clampNumber(
                      drift + (takerSide === "buy" ? randInt(8, 30) : -randInt(8, 30)),
                      -DRIFT_MAX_BPS,
                      DRIFT_MAX_BPS,
                    );
                    driftByMarket.set(market.index, drift);
                  }
                } catch {
                  // stale order or temporary liquidity mismatch
                }
              }
            }

            if (!executedNow) {
              const takerSide: "buy" | "sell" = Math.random() < (drift >= 0 ? 0.6 : 0.4)
                ? "buy"
                : "sell";
              const amountBase = Math.max(
                1,
                Math.floor(takerAmountBase * randFloat(0.65, 1.9)),
              );
              const bestAskNow = parsePositiveNumber(liveMarket.bestAsk);
              const maxQuoteRef = Math.max(fairMid, mid, bestAskNow);
              const actorRole = pickActorRoleForSide(
                liveMarket.balances ?? [],
                takerSide,
                amountBase,
                maxQuoteRef,
                actorCursor,
              );
              actorCursor += 1;
              const maxQuote = takerSide === "buy"
                ? estimateMaxQuote(maxQuoteRef, amountBase)
                : undefined;

              try {
                const takerResult = await triggerOrder({
                  market: market.index,
                  side: takerSide,
                  amountBase,
                  maxQuote,
                  actorRole,
                });
                if (takerResult.executed) {
                  tradesDone += 1;
                  executedNow = true;
                  lastExecPrice =
                    deriveExecutionPrice(takerResult.baseDelta, takerResult.quoteDelta)
                    ?? fairMid;
                  drift = clampNumber(
                    drift + (takerSide === "buy" ? randInt(8, 30) : -randInt(8, 30)),
                    -DRIFT_MAX_BPS,
                    DRIFT_MAX_BPS,
                  );
                  driftByMarket.set(market.index, drift);
                }
              } catch {
                // continue
              }
            }

            if (!executedNow && tradeAttempts % 4 === 0) {
              await placeMakerOrder(Math.random() < 0.5 ? "buy" : "sell", randInt(1, 3));
            }

            fairMid = clampNumber(mid * (1 + drift / 10_000), bounds.low, bounds.high);
            await sleep(Math.max(50, Math.floor(PER_MARKET_DELAY_MS / 2)));
          }

          let kickTrades = 0;
          if (tradesDone === 0) {
            for (const kickSide of ["buy", "sell"] as const) {
              liveMarket = await refreshMarket();
              const amountBase = Math.max(1, Math.floor(takerAmountBase * randFloat(0.5, 1.2)));
              const bestAskNow = parsePositiveNumber(liveMarket.bestAsk);
              const maxQuoteRef = Math.max(fairMid, mid, bestAskNow);
              const actorRole = pickActorRoleForSide(
                liveMarket.balances ?? [],
                kickSide,
                amountBase,
                maxQuoteRef,
                actorCursor,
              );
              actorCursor += 1;

              try {
                const result = await triggerOrder({
                  market: market.index,
                  side: kickSide,
                  amountBase,
                  maxQuote: kickSide === "buy"
                    ? estimateMaxQuote(maxQuoteRef, amountBase)
                    : undefined,
                  actorRole,
                });
                if (result.executed) {
                  kickTrades += 1;
                  tradesDone += 1;
                  lastExecPrice =
                    deriveExecutionPrice(result.baseDelta, result.quoteDelta)
                    ?? fairMid;
                }
              } catch {
                // continue
              }
              await sleep(Math.max(50, Math.floor(PER_MARKET_DELAY_MS / 2)));
            }
          }

          await sleep(80);
          const postSnapshot = await fetchSnapshot();
          const postMarket = postSnapshot.markets.find((m) => m.index === market.index) ?? market;
          const prices = collectExecutedPrices(postMarket.recentActions);

          const latestPx =
            prices[prices.length - 1]
            ?? lastExecPrice
            ?? fairMid;

          const chart = sparkline(prices.length > 0 ? prices : [latestPx], CHART_WIDTH);
          console.log(
            [
              `[m${market.index} ${pair}]`,
              `fair=${formatPriceAdaptive(fairMid)} drift=${Math.round(drift)}bps`,
              `| makers=${makerPlaced}/${makerPlaced + makerFailed}`,
              `| trades=${tradesDone}/${tradesTarget}`,
              `| kick=${kickTrades}`,
              `| px~${formatPriceAdaptive(latestPx)}`,
              `| bid=${formatPriceAdaptive(toNum(postMarket.bestBid))} ask=${formatPriceAdaptive(toNum(postMarket.bestAsk))}`,
              chart,
            ].join(" "),
          );
        } catch (marketError) {
          console.error(`market step error: ${(marketError as Error)?.message ?? String(marketError)}`);
        }
      }

      if (snapshot.warning) {
        console.log(`warning: ${snapshot.warning}`);
      }
    } catch (error) {
      console.error(`loop error: ${(error as Error)?.message ?? String(error)}`);
    }

    loops += 1;
    await sleep(INTERVAL_MS);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
