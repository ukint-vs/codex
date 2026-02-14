import { setTimeout as sleep } from "node:timers/promises";

type ActionRow = {
  ts: string;
  kind: "market" | "take" | "limit";
  status: "submitted" | "executed" | "failed";
  side: "buy" | "sell";
  amountBase: number;
  executionPriceApprox?: string;
};

type MarketSnapshot = {
  index: number;
  baseSymbol?: string;
  quoteSymbol?: string;
  bestBid: string;
  bestAsk: string;
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

const collectExecutedPrices = (actions: ActionRow[]): number[] =>
  actions
    .filter((x) => x.status === "executed")
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
          const mid = estimateMid(market);
          const bestAsk = toNum(market.bestAsk);
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
          const fairMid = clampNumber(mid * (1 + drift / 10_000), mid * 0.35, mid * 2.6);
          const takerAmountBase = pickAmountBase(fairMid);
          const makerAmountBase = Math.max(1, Math.floor(takerAmountBase * randFloat(0.35, 0.75)));

          let makerPlaced = 0;
          for (let level = 1; level <= MAKER_LEVELS; level += 1) {
            const levelOffset = (MAKER_OFFSET_BPS + (level - 1) * 18) / 10_000;
            for (const makerSide of ["buy", "sell"] as const) {
              const rawPrice = makerSide === "buy"
                ? fairMid * (1 - levelOffset)
                : fairMid * (1 + levelOffset);
              const makerPrice = clampNumber(rawPrice, mid * 0.35, mid * 2.6);
              const makerActorRole =
                makerSide === "buy"
                  ? `quote-maker-${(market.index + level) % 4}`
                  : `base-maker-${(market.index + level) % 4}`;
              try {
                await submitLimitOrder({
                  market: market.index,
                  side: makerSide,
                  amountBase: Math.max(1, Math.floor(makerAmountBase * randFloat(0.7, 1.45))),
                  priceQuotePerBase: makerPrice,
                  actorRole: makerActorRole,
                });
                makerPlaced += 1;
              } catch {
                // keep running to sustain activity
              }
            }
          }

          await sleep(PER_MARKET_DELAY_MS);

          const tradesTarget = randInt(TRADES_PER_MARKET_MIN, TRADES_PER_MARKET_MAX);
          let tradesDone = 0;
          let tradeAttempts = 0;
          let lastTrigger: TriggerResult | undefined;

          while (tradesDone < tradesTarget && tradeAttempts < tradesTarget * 7) {
            tradeAttempts += 1;
            const takerSide: "buy" | "sell" = Math.random() < (drift >= 0 ? 0.6 : 0.4)
              ? "buy"
              : "sell";
            const actorRole =
              takerSide === "buy"
                ? `quote-maker-${(market.index + tradesDone + 1) % 4}`
                : `base-maker-${(market.index + tradesDone + 1) % 4}`;
            const amountBase = Math.max(
              1,
              Math.floor(takerAmountBase * randFloat(0.65, 1.9)),
            );
            const maxQuoteRef = Math.max(fairMid, mid, bestAsk);
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
              lastTrigger = takerResult;
              if (takerResult.executed) {
                tradesDone += 1;
                drift = clampNumber(
                  drift + (takerSide === "buy" ? randInt(8, 30) : -randInt(8, 30)),
                  -DRIFT_MAX_BPS,
                  DRIFT_MAX_BPS,
                );
                driftByMarket.set(market.index, drift);
              }
            } catch {
              // continue selecting another side/size; liquidity can be transient
            }
            await sleep(Math.max(50, Math.floor(PER_MARKET_DELAY_MS / 2)));
          }

          await sleep(80);
          const postSnapshot = await fetchSnapshot();
          const postMarket = postSnapshot.markets.find((m) => m.index === market.index) ?? market;
          const prices = collectExecutedPrices(postMarket.recentActions);

          const latestPx =
            prices[prices.length - 1]
            ?? deriveExecutionPrice(lastTrigger?.baseDelta, lastTrigger?.quoteDelta)
            ?? fairMid;

          const chart = sparkline(prices.length > 0 ? prices : [latestPx], CHART_WIDTH);
          console.log(
            [
              `[m${market.index} ${pair}]`,
              `fair=${formatPriceAdaptive(fairMid)} drift=${Math.round(drift)}bps`,
              `| makers=${makerPlaced}`,
              `| trades=${tradesDone}/${tradesTarget}`,
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
