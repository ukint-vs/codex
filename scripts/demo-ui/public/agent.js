const DEFAULT_SYSTEM_PROMPT = `
You are a Dex trading assistant in a web app.
Use tools for factual blockchain data and trading actions.
Rules:
1. Never invent balances, order ids, tx results, or fill status.
2. For write actions, call tools with confirm=false first unless user explicitly confirms.
3. If tool returns needsConfirmation=true, ask user a concise confirmation question.
4. Keep answers concise and human-readable.
5. If walletAddress is provided, use it directly and do not ask again.
6. For order lifecycle queries, prefer get_order_insight and watch_order_status.
7. For complete exchange health queries, use get_dex_status and get_orderbook_depth.
8. For wallet-level order analytics, use get_wallet_orders_overview.
9. After order placement/cancellation, report orderId, status, filled, and remaining.
10. For multi-market questions, use list_markets first and pass marketIndex in tool arguments.
`;

const normalizeAssistantReply = (raw) => {
  const trimmed = String(raw ?? "").trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (typeof parsed?.userMessage === "string" && parsed.userMessage.trim()) {
        return parsed.userMessage.trim();
      }
      if (typeof parsed?.message === "string" && parsed.message.trim()) {
        return parsed.message.trim();
      }
    } catch {
      // Not JSON.
    }
  }
  return trimmed;
};

const asObj = (value) =>
  value && typeof value === "object" ? value : {};

export const summarizeToolResult = (toolName, result) => {
  const r = asObj(result);
  const data = asObj(r.data);

  if (r.ok === false && r.needsConfirmation) {
    if (toolName === "place_order" || toolName === "smart_place_order") {
      const side = String(data.side ?? "").toUpperCase();
      const amount = data.amountBase ?? "?";
      const orderType = String(data.orderType ?? "order").toUpperCase();
      const strategy = data.strategy ? ` (${data.strategy})` : "";
      return `You are about to place a ${orderType} ${side} order for ${amount} BASE${strategy}. Confirm to proceed.`;
    }
    if (toolName === "cancel_order") {
      return `You are about to cancel order #${data.orderId ?? "?"}. Confirm to proceed.`;
    }
  }

  if (r.ok === false) {
    return classifyToolError(toolName, r.message ?? "unknown error");
  }

  if (toolName === "list_markets") {
    const markets = Array.isArray(data.markets) ? data.markets : [];
    if (!markets.length) return "No markets are configured.";
    const rows = markets
      .map((m) => `#${m.index} ${m.baseSymbol ?? "BASE"}/${m.quoteSymbol ?? "QUOTE"}`)
      .join(", ");
    return `Configured markets (${data.count ?? markets.length}): ${rows}.`;
  }

  if (toolName === "get_balance") {
    const vault = asObj(data.vault);
    const vb = asObj(vault.base);
    const vq = asObj(vault.quote);
    const ob = asObj(data.orderbook);
    return [
      "Here is your balance:",
      `Vault: base ${vb.available ?? "n/a"} (reserved ${vb.reserved ?? "n/a"}), quote ${vq.available ?? "n/a"} (reserved ${vq.reserved ?? "n/a"}).`,
      `Orderbook (market #${data.marketIndex ?? 0}): base ${ob.base ?? "n/a"}, quote ${ob.quote ?? "n/a"}.`,
    ].join(" ");
  }

  if (toolName === "place_order" || toolName === "smart_place_order") {
    const d = data.statusDetail ? asObj(data.statusDetail) : data;
    const impact = asObj(data.executionImpact);
    const inferred = String(data.inferredOutcome ?? "");
    const orderType = String(data.orderType ?? "limit").toUpperCase();
    const side = String(d.side ?? data.side ?? "n/a").toUpperCase();
    const amountBase = data.amountBase ?? d.amountBase ?? "n/a";
    const price = d.limitPrice ?? data.priceInQuotePerBase ?? "market";
    const impactLine = impact.hadExecutionImpact
      ? `- **Balance Impact:** BASE ${impact.deltaBase ?? "n/a"}, QUOTE ${impact.deltaQuote ?? "n/a"}`
      : `- **Balance Impact:** none observed yet`;
    if (String(data.status ?? "") === "closed_or_not_found") {
      return [
        `**Order Submitted** (#${data.orderId ?? "?"})`,
        `- **Type:** ${orderType} ${side}`,
        `- **Requested:** ${amountBase} BASE @ ${price}`,
        `- **Status:** terminal/not-found in active order storage`,
        `- **Fill Details:** unavailable from direct lookup`,
        impactLine,
        `- **Inferred Outcome:** ${inferred || "unknown"}`,
        "",
        `Use \`get_wallet_orders_overview\` and balance checks for final execution impact.`,
      ].join("\n");
    }
    return [
      `**Order Submitted** (#${data.orderId ?? "?"})`,
      `- **Type:** ${orderType} ${side}`,
      `- **Requested:** ${amountBase} BASE @ ${price}`,
      `- **Status:** ${data.status ?? "submitted"}`,
      `- **Filled Now:** ${d.filledBase ?? "n/a"} BASE`,
      `- **Remaining:** ${d.remainingBase ?? "n/a"} BASE`,
      impactLine,
      `- **Inferred Outcome:** ${inferred || "unknown"}`,
      "",
      `You can ask: \`watch order #${data.orderId ?? "?"} status\`.`,
    ].join("\n");
  }

  if (toolName === "cancel_order") {
    return `Cancellation submitted for order #${data.orderId ?? "?"}. Current status is ${data.statusAfterCancel ?? "unknown"}.`;
  }

  if (toolName === "get_order_status" || toolName === "get_order_insight") {
    const analytics = asObj(data.analytics);
    if (String(data.status ?? "") === "closed_or_not_found") {
      return `Order #${data.orderId ?? "?"} is in terminal/not-found state. Active-book fill details are unavailable; use balances and wallet order overview to assess final execution impact.`;
    }
    const extra =
      analytics.distanceFromMidBps == null
        ? ""
        : ` Distance from mid-price: ${Number(analytics.distanceFromMidBps).toFixed(2)} bps.`;
    return `Order #${data.orderId ?? "?"}: ${data.side ?? "n/a"} ${data.status ?? "n/a"}, amount ${data.amountBase ?? "n/a"}, filled ${data.filledBase ?? "n/a"}, remaining ${data.remainingBase ?? "n/a"}, limit ${data.limitPrice ?? "n/a"}.${extra}`;
  }

  if (toolName === "watch_order_status") {
    const hist = Array.isArray(data.history) ? data.history : [];
    const last = hist[hist.length - 1] || {};
    return `Order #${data.orderId ?? "?"} monitoring finished after ${data.polls ?? hist.length} polls. Final status: ${data.finalStatus ?? last.status ?? "unknown"}, filled ${last.filledBase ?? "n/a"}, remaining ${last.remainingBase ?? "n/a"}.`;
  }

  if (toolName === "list_orders") {
    const orders = Array.isArray(data.orders) ? data.orders : [];
    const counts = orders.reduce(
      (acc, o) => {
        const s = String(o.status ?? "unknown");
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      },
      {},
    );
    return `Found ${data.returned ?? orders.length} orders (status filter: ${data.statusFilter ?? "any"}, side filter: ${data.sideFilter ?? "any"}). Breakdown: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}.`;
  }

  if (toolName === "get_wallet_orders_overview") {
    const totals = asObj(data.totals);
    return `Wallet order overview: ${data.discoveredOrders ?? 0} orders found. Open exposure ${totals.openBase ?? "n/a"} BASE, filled ${totals.filledBase ?? "n/a"} BASE, open notional ${totals.openNotionalQuote ?? "n/a"} QUOTE.`;
  }

  if (toolName === "get_market_overview") {
    return `Market #${data.marketIndex ?? 0} overview: best bid ${data.bestBid ?? "n/a"}, best ask ${data.bestAsk ?? "n/a"}, mid ${data.midPrice ?? "n/a"}, spread ${data.spreadBps ?? "n/a"} bps.`;
  }

  if (toolName === "get_orderbook_depth") {
    const depth = asObj(data.depth);
    const bids = Array.isArray(depth.bids) ? depth.bids : [];
    const asks = Array.isArray(depth.asks) ? depth.asks : [];
    const topBid = asObj(bids[0]);
    const topAsk = asObj(asks[0]);
    return `Market #${data.marketIndex ?? 0} depth scanned ${data.scannedOrders ?? "n/a"} orders. Top bid ${topBid.price ?? "n/a"} (${topBid.sizeBase ?? "n/a"} BASE), top ask ${topAsk.price ?? "n/a"} (${topAsk.sizeBase ?? "n/a"} BASE).`;
  }

  if (toolName === "get_dex_status") {
    const market = asObj(data.market);
    const liq = asObj(data.liquidity);
    return `Market #${data.marketIndex ?? 0} status: ${market.isTwoSided ? "two-sided book available" : "book is one-sided"}, bid ${market.bestBid ?? "n/a"}, ask ${market.bestAsk ?? "n/a"}, spread ${market.spreadBps ?? "n/a"} bps. Open liquidity: buy ${liq.openBuyBase ?? "n/a"} BASE vs sell ${liq.openSellBase ?? "n/a"} BASE (buy imbalance ${liq.imbalanceBuyPct ?? "n/a"}%).`;
  }

  if (toolName === "get_price_recommendation") {
    return `Market #${data.marketIndex ?? 0}: recommended ${data.side ?? "n/a"} price is ${data.recommendedPrice ?? "n/a"} using ${data.strategy ?? "n/a"} strategy. Reason: ${data.reason ?? "n/a"}.`;
  }

  if (toolName === "get_currency_info") {
    const base = asObj(data.base);
    const quote = asObj(data.quote);
    return `Market currencies: ${base.symbol ?? "BASE"} (${base.decimals ?? "?"} decimals) and ${quote.symbol ?? "QUOTE"} (${quote.decimals ?? "?"} decimals).`;
  }

  return `Tool ${toolName} completed successfully.`;
};

const detectScopeFromText = (text) => {
  const lower = String(text ?? "").toLowerCase();
  const hasVault = lower.includes("vault");
  const hasOrderbook = lower.includes("orderbook") || lower.includes("exchange");
  if (hasVault && !hasOrderbook) return "vault";
  if (!hasVault && hasOrderbook) return "orderbook";
  return "both";
};

const hasWord = (text, word) => new RegExp(`\\b${word}\\b`, "i").test(String(text ?? ""));

const extractMarketIndex = (text) => {
  const m = String(text ?? "").match(/market\s*#?\s*(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.floor(n) : null;
};

const extractOrderId = (text) => {
  const m = String(text ?? "").match(/(?:order(?:\s*#|\s+id\s*)?|#)\s*(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? String(Math.floor(n)) : null;
};

const parsePositiveNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const classifyToolError = (toolName, message) => {
  const lower = String(message ?? "").toLowerCase();
  if (lower.includes("unknown marketindex") || lower.includes("unknown market")) {
    return "I couldn't find that market. Ask me to list markets and pick one by index.";
  }
  if (lower.includes("invalid wallet address")) {
    return "The wallet address format is invalid.";
  }
  if (lower.includes("insufficient") || lower.includes("balance")) {
    return "The action failed due to insufficient balance for this market.";
  }
  if (lower.includes("no market quotes available")) {
    return "There are no live quotes in this market yet, so pricing/execution is unavailable right now.";
  }
  if (lower.includes("maxquoteamount is required")) {
    return "Buy market orders need a max quote cap. Provide one or ask for a smart recommendation first.";
  }
  if (toolName === "place_order" && lower.includes("priceinquoteperbase is required")) {
    return "Limit/FOK/IOC orders require a price. Please provide one.";
  }
  return `I couldn't complete ${toolName}: ${message ?? "unknown error"}.`;
};

const isTransientProviderError = (status, message) => {
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const lower = String(message ?? "").toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("temporar") ||
    lower.includes("rate limit") ||
    lower.includes("overloaded") ||
    lower.includes("networkerror") ||
    lower.includes("failed to fetch")
  );
};

const isConfirmIntent = (text) => {
  const answer = String(text ?? "").trim().toLowerCase();
  return (
    answer === "yes" ||
    answer === "y" ||
    answer === "confirm" ||
    answer === "confirmed" ||
    answer === "ok" ||
    answer === "go ahead" ||
    answer === "proceed"
  );
};

const isRejectIntent = (text) => {
  const answer = String(text ?? "").trim().toLowerCase();
  return (
    answer === "no" ||
    answer === "n" ||
    answer === "cancel" ||
    answer === "stop" ||
    answer === "never mind" ||
    answer === "dont" ||
    answer === "don't"
  );
};

const deriveForcedTool = ({ walletAddress, messages }) => {
  if (!walletAddress) return null;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;
  const text = String(lastUser.content ?? "").toLowerCase();
  const balanceIntent =
    text.includes("balance") ||
    text.includes("how much do i have") ||
    text.includes("funds");
  if (!balanceIntent) return null;
  return {
    name: "get_balance",
    arguments: {
      walletAddress,
      marketIndex: extractMarketIndex(lastUser.content) ?? undefined,
      scope: detectScopeFromText(lastUser.content),
    },
  };
};

const deriveConfirmationTool = ({ walletAddress, messages }) => {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;
  if (!isConfirmIntent(lastUser.content)) return null;

  const prevAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.content ?? "";
  if (!prevAssistant) return null;

  const smartMatch = prevAssistant.match(
    /smart\s+(bid|ask).+?for\s+([0-9]+(?:\.[0-9]+)?)\s+base.+?(passive|balanced|aggressive)/i,
  );
  if (smartMatch) {
    return {
      name: "smart_place_order",
      arguments: {
        walletAddress,
        side: smartMatch[1].toLowerCase() === "bid" ? "buy" : "sell",
        amountBase: Number(smartMatch[2]),
        strategy: smartMatch[3].toLowerCase(),
        confirm: true,
      },
    };
  }

  const cancelMatch = prevAssistant.match(
    /cancel.+order(?:\s*#| id[:\s]*)\s*([0-9]+)/i,
  );
  if (cancelMatch) {
    return {
      name: "cancel_order",
      arguments: {
        walletAddress,
        orderId: cancelMatch[1],
        confirm: true,
      },
    };
  }

  return null;
};

export class DexBrowserAgent {
  constructor(opts = {}) {
    this.toolEndpoint = opts.toolEndpoint ?? "/api/agent/tool";
    this.schemaEndpoint = opts.schemaEndpoint ?? "/api/agent/schema";
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.tools = null;
    this.pendingAction = null;
    this.pendingActionId = 0;
    this.activeMarketIndex = null;
    this.marketsCache = null;
    this.debug = opts.debug ?? true;
  }

  log(event, payload = {}) {
    if (!this.debug) return;
    try {
      console.info(`[dex-agent] ${event}`, {
        ts: new Date().toISOString(),
        ...payload,
      });
    } catch {
      // no-op
    }
  }

  normalizeToolArgs(name, args = {}, walletAddress) {
    const out = { ...(args || {}) };

    if (
      walletAddress &&
      typeof out.walletAddress !== "string" &&
      (name === "get_balance" ||
        name === "place_order" ||
        name === "cancel_order" ||
        name === "list_orders" ||
        name === "get_wallet_orders_overview" ||
        name === "smart_place_order")
    ) {
      out.walletAddress = walletAddress;
    }

    const usesMarket =
      name === "get_balance" ||
      name === "place_order" ||
      name === "cancel_order" ||
      name === "get_order_status" ||
      name === "list_orders" ||
      name === "watch_order_status" ||
      name === "get_order_insight" ||
      name === "get_wallet_orders_overview" ||
      name === "get_orderbook_depth" ||
      name === "get_dex_status" ||
      name === "get_market_overview" ||
      name === "get_price_recommendation" ||
      name === "smart_place_order" ||
      name === "get_currency_info";
    if (usesMarket && typeof out.marketIndex !== "number" && this.activeMarketIndex != null) {
      out.marketIndex = this.activeMarketIndex;
    }

    if (typeof out.marketIndex === "string") {
      const parsed = Number(out.marketIndex);
      if (Number.isFinite(parsed)) out.marketIndex = Math.floor(parsed);
    }

    if ("amountBase" in out) {
      const n = parsePositiveNumber(out.amountBase);
      if (n != null) out.amountBase = n;
    }
    if ("priceInQuotePerBase" in out) {
      const n = parsePositiveNumber(out.priceInQuotePerBase);
      if (n != null) out.priceInQuotePerBase = n;
    }
    if ("maxQuoteAmount" in out) {
      const n = parsePositiveNumber(out.maxQuoteAmount);
      if (n != null) out.maxQuoteAmount = n;
    }
    if ("orderId" in out && out.orderId != null) {
      out.orderId = String(out.orderId);
    }

    return out;
  }

  async ensureTools(signal) {
    if (this.tools) return this.tools;
    const response = await fetch(this.schemaEndpoint, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to load tool schema: HTTP ${response.status}`);
    }
    const payload = await response.json();
    this.tools = Array.isArray(payload?.tools) ? payload.tools : [];
    return this.tools;
  }

  async fetchWithProviderRetry(url, options = {}, meta = {}) {
    const maxAttempts = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const response = await fetch(url, options);
        if (!response.ok) {
          const body = await response.text();
          const retryable =
            attempt < maxAttempts && isTransientProviderError(response.status, body);
          this.log("provider_http", {
            provider: meta.provider ?? "unknown",
            attempt,
            status: response.status,
            retryable,
          });
          if (retryable) {
            await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** (attempt - 1)));
            continue;
          }
          const err = new Error(`${meta.provider ?? "provider"} error: ${response.status} ${body}`);
          err.status = response.status;
          throw err;
        }
        return response;
      } catch (error) {
        lastErr = error;
        const retryable =
          attempt < maxAttempts &&
          isTransientProviderError(Number(error?.status ?? 0), error?.message ?? String(error));
        this.log("provider_error", {
          provider: meta.provider ?? "unknown",
          attempt,
          retryable,
          message: String(error?.message ?? error),
        });
        if (!retryable) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** (attempt - 1)));
      }
    }
    throw lastErr ?? new Error("Provider request failed");
  }

  async executeToolWithRetry(name, args, walletAddress, signal) {
    const maxAttempts = 3;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        return await this.executeTool(name, args, walletAddress, signal);
      } catch (error) {
        lastError = error;
        const status = Number(error?.status ?? 0);
        const message = String(error?.message ?? error);
        const retryable = attempt < maxAttempts && isTransientProviderError(status, message);
        this.log("tool_error", { tool: name, attempt, status, retryable, message });
        if (!retryable) throw error;
        const waitMs = 250 * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw lastError ?? new Error(`Tool ${name} failed`);
  }

  async executeTool(name, args, walletAddress, signal) {
    const normalizedArgs = this.normalizeToolArgs(name, args, walletAddress);
    const started = Date.now();
    const response = await fetch(this.toolEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        name,
        args: normalizedArgs ?? {},
        walletAddress: walletAddress || undefined,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(payload?.error ?? `Tool ${name} failed`);
      err.status = response.status;
      throw err;
    }
    const withSummary =
      payload && typeof payload === "object"
        ? {
            ...payload,
            userMessage:
              typeof payload.userMessage === "string" && payload.userMessage.trim()
                ? payload.userMessage
                : summarizeToolResult(name, payload),
          }
        : payload;
    const resultData = asObj(withSummary?.data);
    if (typeof resultData.marketIndex === "number") {
      this.activeMarketIndex = resultData.marketIndex;
    }
    this.log("tool_call", {
      tool: name,
      ok: Boolean(withSummary?.ok),
      ms: Date.now() - started,
      marketIndex: resultData.marketIndex ?? normalizedArgs?.marketIndex ?? null,
    });
    return withSummary;
  }

  async ensureMarkets(signal, walletAddress) {
    if (this.marketsCache?.length) return this.marketsCache;
    const result = await this.executeToolWithRetry("list_markets", {}, walletAddress, signal);
    const data = asObj(result?.data);
    const markets = Array.isArray(data.markets) ? data.markets : [];
    this.marketsCache = markets;
    if (typeof data.defaultMarketIndex === "number") {
      this.activeMarketIndex = data.defaultMarketIndex;
    } else if (this.activeMarketIndex == null && markets[0]?.index != null) {
      this.activeMarketIndex = Number(markets[0].index);
    }
    return this.marketsCache;
  }

  async enrichLifecycleResult(toolName, result, walletAddress, signal) {
    if (!result?.ok || result?.needsConfirmation) return result;
    if (toolName !== "place_order" && toolName !== "smart_place_order" && toolName !== "cancel_order") {
      return result;
    }
    const orderId = result?.data?.orderId;
    if (!orderId) return result;
    const marketIndex = result?.data?.marketIndex;
    try {
      const [status, insight] = await Promise.all([
        this.executeToolWithRetry(
          "get_order_status",
          { orderId: String(orderId), marketIndex },
          walletAddress,
          signal,
        ),
        this.executeToolWithRetry(
          "get_order_insight",
          { orderId: String(orderId), marketIndex },
          walletAddress,
          signal,
        ),
      ]);
      const merged = {
        ...result,
        data: {
          ...asObj(result.data),
          statusDetail: asObj(insight?.data),
          latestStatus: asObj(status?.data),
        },
      };
      merged.userMessage = this.formatPendingExecutionMessage(toolName, merged, status);
      return merged;
    } catch {
      return result;
    }
  }

  formatPendingExecutionMessage(toolName, result, statusResult) {
    if (!result?.ok) {
      return `I tried to execute ${toolName}, but it failed: ${result?.message ?? "unknown error"}`;
    }
    const data = result?.data ?? {};
    if (toolName === "place_order" || toolName === "smart_place_order") {
      const orderId = data.orderId ?? "unknown";
      const marketLabel =
        typeof data.marketIndex === "number" ? ` (market #${data.marketIndex})` : "";
      const status =
        statusResult?.data?.status ??
        data.status ??
        "submitted";
      const impact = asObj(data.executionImpact);
      const d = data.statusDetail ? asObj(data.statusDetail) : data;
      const orderType = String(data.orderType ?? "limit").toUpperCase();
      const side = String(d.side ?? data.side ?? "n/a").toUpperCase();
      const amountBase = data.amountBase ?? d.amountBase ?? "n/a";
      const price = d.limitPrice ?? data.priceInQuotePerBase ?? "market";
      const impactLine = impact.hadExecutionImpact
        ? `- **Balance Impact:** BASE ${impact.deltaBase ?? "n/a"}, QUOTE ${impact.deltaQuote ?? "n/a"}`
        : `- **Balance Impact:** none observed yet`;
      if (status === "closed_or_not_found") {
        return [
          `**Order Submitted** (#${orderId})${marketLabel}`,
          `- **Type:** ${orderType} ${side}`,
          `- **Requested:** ${amountBase} BASE @ ${price}`,
          `- **Status:** terminal/not-found in active storage`,
          `- **Fill Details:** unavailable from direct lookup`,
          impactLine,
          `- **Inferred Outcome:** ${data.inferredOutcome ?? "unknown"}`,
          "",
          `Use balances and wallet overview to verify final effect.`,
        ].join("\n");
      }
      const filled =
        statusResult?.data?.filledBase ??
        data?.statusDetail?.filledBase ??
        "n/a";
      const remaining =
        statusResult?.data?.remainingBase ??
        data?.statusDetail?.remainingBase ??
        "n/a";
      return [
        `**Order Submitted** (#${orderId})${marketLabel}`,
        `- **Type:** ${orderType} ${side}`,
        `- **Requested:** ${amountBase} BASE @ ${price}`,
        `- **Status:** ${status}`,
        `- **Filled Now:** ${filled} BASE`,
        `- **Remaining:** ${remaining} BASE`,
        impactLine,
        `- **Inferred Outcome:** ${data.inferredOutcome ?? "unknown"}`,
        "",
        `You can ask me to watch this order status.`,
      ].join("\n");
    }
    if (toolName === "cancel_order") {
      return `Cancel request sent for order #${data.orderId ?? "unknown"}. Current status: ${data.statusAfterCancel ?? "unknown"}.`;
    }
    return `Action ${toolName} executed successfully.`;
  }

  async tryExecutePendingConfirmation(input) {
    const lastUser = [...(input.messages ?? [])].reverse().find((m) => m.role === "user");
    if (!this.pendingAction) return null;
    if (Date.now() - (this.pendingAction.createdAt ?? 0) > 5 * 60_000) {
      this.pendingAction = null;
      return "That pending confirmation expired. Please send the action again.";
    }
    if (!lastUser) return null;
    if (isRejectIntent(lastUser.content)) {
      this.pendingAction = null;
      return "Cancelled. I did not execute the pending action.";
    }
    if (!isConfirmIntent(lastUser.content)) return null;

    const pending = this.pendingAction;
    const confirmedArgs = {
      ...(pending.args ?? {}),
      confirm: true,
    };
    const walletAddress = input.walletAddress || pending.walletAddress;
    const result = await this.executeToolWithRetry(
      pending.name,
      confirmedArgs,
      walletAddress,
      input?.signal,
    );

    if (result?.needsConfirmation) {
      this.pendingAction = null;
      return "The action still needs missing parameters. Please provide side/type/amount/price clearly, then confirm.";
    }

    let statusResult = null;
    let insightResult = null;
    const orderId = result?.data?.orderId;
    const marketIndex = result?.data?.marketIndex ?? pending?.args?.marketIndex;
    if (orderId) {
      try {
        statusResult = await this.executeToolWithRetry(
          "get_order_status",
          { orderId: String(orderId), marketIndex },
          walletAddress,
          input?.signal,
        );
        insightResult = await this.executeToolWithRetry(
          "get_order_insight",
          { orderId: String(orderId), marketIndex },
          walletAddress,
          input?.signal,
        );
      } catch {
        // Ignore status fetch failure; return primary execution result.
      }
    }

    this.pendingAction = null;
    return this.formatPendingExecutionMessage(
      pending.name,
      insightResult ?? result,
      statusResult,
    );
  }

  setPendingAction(name, args, walletAddress) {
    this.pendingActionId += 1;
    this.pendingAction = {
      id: this.pendingActionId,
      name,
      args,
      walletAddress,
      createdAt: Date.now(),
    };
  }

  detectDeterministicIntent(input) {
    const lastUser = [...(input.messages ?? [])].reverse().find((m) => m.role === "user");
    if (!lastUser) return null;
    const raw = String(lastUser.content ?? "");
    const text = raw.toLowerCase();
    const marketIndex = extractMarketIndex(raw);

    if (hasWord(text, "market") && /(switch|use|select|set)/i.test(text) && marketIndex != null) {
      return { type: "switch_market", marketIndex };
    }
    if ((/what market/i.test(text) || /active market/i.test(text)) && !/overview|status|depth/i.test(text)) {
      return { type: "current_market" };
    }
    if (/list markets|available markets|show markets|what markets/i.test(text)) {
      return { type: "list_markets" };
    }
    if (/balance|how much do i have|funds/i.test(text)) {
      return { type: "balance", marketIndex };
    }
    if (/open orders|my orders|order history|recent orders/i.test(text)) {
      return { type: "orders_overview", marketIndex };
    }
    if (/cancel/i.test(text) && /order/i.test(text)) {
      const orderId = extractOrderId(raw);
      if (orderId) return { type: "cancel_order", marketIndex, orderId };
    }
    if (/order status|status of order|watch order/i.test(text) || /order\s*#\s*\d+/i.test(text)) {
      const orderId = extractOrderId(raw);
      if (orderId) return { type: "order_status", marketIndex, orderId };
    }
    if (/market overview|best bid|best ask|mid price|spread/i.test(text)) {
      return { type: "market_overview", marketIndex };
    }
    if (/depth|orderbook/i.test(text)) {
      return { type: "depth", marketIndex };
    }
    if (/dex status|market status|health/i.test(text)) {
      return { type: "dex_status", marketIndex };
    }

    const recommend = raw.match(
      /(recommend|smart).*(buy|sell|bid|ask).*(?:for|with)?\s*([0-9]+(?:\.[0-9]+)?)?/i,
    );
    if (recommend) {
      return {
        type: "price_recommendation",
        marketIndex,
        side: /sell|ask/i.test(recommend[2]) ? "sell" : "buy",
      };
    }

    const place = raw.match(
      /\b(buy|sell)\b.*?([0-9]+(?:\.[0-9]+)?)\s*base(?:.*?(?:at|price)\s*([0-9]+(?:\.[0-9]+)?))?/i,
    );
    if (place) {
      const side = place[1].toLowerCase();
      const amountBase = Number(place[2]);
      const price = place[3] ? Number(place[3]) : null;
      const orderType = /market/i.test(text) ? "market" : "limit";
      return { type: "place_order", marketIndex, side, amountBase, price, orderType };
    }

    return null;
  }

  async runDeterministicIntent(input) {
    const intent = this.detectDeterministicIntent(input);
    if (!intent) return null;
    const walletAddress = input.walletAddress;
    await this.ensureMarkets(input?.signal, walletAddress);
    if (intent.marketIndex != null) this.activeMarketIndex = intent.marketIndex;
    const marketIndex = this.activeMarketIndex ?? 0;

    this.log("intent_route", { type: intent.type, marketIndex });

    if (intent.type === "switch_market") {
      const markets = await this.ensureMarkets(input?.signal, walletAddress);
      const exists = markets.some((m) => Number(m.index) === intent.marketIndex);
      if (!exists) {
        return `Market #${intent.marketIndex} is not available. Ask me to list markets.`;
      }
      this.activeMarketIndex = intent.marketIndex;
      return `Switched to market #${intent.marketIndex}.`;
    }

    if (intent.type === "current_market") {
      return this.activeMarketIndex == null
        ? "No active market selected yet. Ask me to list markets."
        : `You are on market #${this.activeMarketIndex}.`;
    }

    if (intent.type === "list_markets") {
      const result = await this.executeToolWithRetry("list_markets", {}, walletAddress, input?.signal);
      return summarizeToolResult("list_markets", result);
    }

    if (intent.type === "balance") {
      const lastMessage = input.messages?.[input.messages.length - 1];
      const result = await this.executeToolWithRetry(
        "get_balance",
        { walletAddress, scope: detectScopeFromText(lastMessage?.content), marketIndex },
        walletAddress,
        input?.signal,
      );
      return summarizeToolResult("get_balance", result);
    }

    if (intent.type === "orders_overview") {
      const result = await this.executeToolWithRetry(
        "get_wallet_orders_overview",
        { walletAddress, marketIndex, maxRows: 200 },
        walletAddress,
        input?.signal,
      );
      return summarizeToolResult("get_wallet_orders_overview", result);
    }

    if (intent.type === "order_status") {
      const insight = await this.executeToolWithRetry(
        "get_order_insight",
        { orderId: intent.orderId, marketIndex },
        walletAddress,
        input?.signal,
      );
      return summarizeToolResult("get_order_insight", insight);
    }

    if (intent.type === "cancel_order") {
      const pre = await this.executeToolWithRetry(
        "cancel_order",
        { orderId: intent.orderId, marketIndex, confirm: false },
        walletAddress,
        input?.signal,
      );
      if (pre?.needsConfirmation) {
        this.setPendingAction("cancel_order", { orderId: intent.orderId, marketIndex }, walletAddress);
      }
      return summarizeToolResult("cancel_order", pre);
    }

    if (intent.type === "market_overview") {
      const result = await this.executeToolWithRetry(
        "get_market_overview",
        { marketIndex },
        walletAddress,
        input?.signal,
      );
      return summarizeToolResult("get_market_overview", result);
    }

    if (intent.type === "depth") {
      const result = await this.executeToolWithRetry(
        "get_orderbook_depth",
        { marketIndex, levels: 10 },
        walletAddress,
        input?.signal,
      );
      return summarizeToolResult("get_orderbook_depth", result);
    }

    if (intent.type === "dex_status") {
      const result = await this.executeToolWithRetry(
        "get_dex_status",
        { marketIndex, depthLevels: 10 },
        walletAddress,
        input?.signal,
      );
      return summarizeToolResult("get_dex_status", result);
    }

    if (intent.type === "price_recommendation") {
      const result = await this.executeToolWithRetry(
        "get_price_recommendation",
        { marketIndex, side: intent.side, strategy: "balanced" },
        walletAddress,
        input?.signal,
      );
      return summarizeToolResult("get_price_recommendation", result);
    }

    if (intent.type === "place_order") {
      const args = {
        marketIndex,
        walletAddress,
        side: intent.side,
        orderType: intent.orderType,
        amountBase: intent.amountBase,
        ...(intent.price != null ? { priceInQuotePerBase: intent.price } : {}),
        ...(intent.orderType === "market" && intent.side === "buy" && intent.price != null
          ? { maxQuoteAmount: Math.ceil(intent.amountBase * intent.price * 1.2) }
          : {}),
        confirm: false,
      };
      const pre = await this.executeToolWithRetry("place_order", args, walletAddress, input?.signal);
      if (pre?.needsConfirmation) {
        this.setPendingAction(
          "place_order",
          { ...args, confirm: undefined },
          walletAddress,
        );
      }
      return summarizeToolResult("place_order", pre);
    }

    return null;
  }

  async runOpenAICompatible(input, provider) {
    const signal = input?.signal;
    const apiKey = input.apiKey?.trim();
    if (!apiKey) throw new Error(`${provider} api key is required.`);
    const model =
      input.model?.trim() ||
      (provider === "openrouter" ? "openai/gpt-4o-mini" : "gpt-4o-mini");
    const endpoint =
      provider === "openrouter"
        ? (input.baseUrl?.trim() || "https://openrouter.ai/api/v1") + "/chat/completions"
        : "https://api.openai.com/v1/chat/completions";

    const messages = [
      { role: "system", content: this.systemPrompt },
      ...(input.walletAddress
        ? [
            {
              role: "system",
              content: `Request context walletAddress: ${input.walletAddress}. Use this wallet directly.`,
            },
          ]
        : []),
      ...input.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    await this.ensureMarkets(signal, input.walletAddress);
    const forcedTool = deriveConfirmationTool(input) ?? deriveForcedTool(input);
    if (forcedTool) {
      if (
        forcedTool?.arguments &&
        typeof forcedTool.arguments.marketIndex !== "number" &&
        this.activeMarketIndex != null
      ) {
        forcedTool.arguments.marketIndex = this.activeMarketIndex;
      }
      messages.push({
        role: "system",
        content: `Forced action hint: call tool "${forcedTool.name}" with arguments ${JSON.stringify(forcedTool.arguments)}.`,
      });
    }

    const tools = await this.ensureTools(signal);
    const lastToolSummaries = [];
    for (let i = 0; i < 6; i += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };
      if (provider === "openrouter") {
        headers["HTTP-Referer"] = window.location.origin;
        headers["X-Title"] = "dex-demo-ui-browser-agent";
      }

      const response = await this.fetchWithProviderRetry(endpoint, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          model,
          messages,
          tools: tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
          tool_choice:
            forcedTool && i === 0
              ? { type: "function", function: { name: forcedTool.name } }
              : "auto",
        }),
      }, { provider });

      const json = await response.json();
      const msg = json?.choices?.[0]?.message;
      if (!msg) throw new Error(`${provider} response had no message.`);

      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        const normalized = normalizeAssistantReply(msg.content ?? "");
        if (!normalized || /^[\s{}[\]":,`]+$/.test(normalized)) {
          return lastToolSummaries[lastToolSummaries.length - 1] ?? normalized;
        }
        return normalized;
      }

      messages.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(call.function.arguments || "{}");
        } catch {
          parsedArgs = {};
        }
        let result = await this.executeToolWithRetry(
          call.function.name,
          parsedArgs,
          input.walletAddress,
          signal,
        );
        result = await this.enrichLifecycleResult(
          call.function.name,
          result,
          input.walletAddress,
          signal,
        );
        if (result?.needsConfirmation) {
          this.setPendingAction(call.function.name, parsedArgs, input.walletAddress);
        } else if (parsedArgs?.confirm === true) {
          this.pendingAction = null;
        }
        if (typeof result?.userMessage === "string" && result.userMessage.trim()) {
          lastToolSummaries.push(result.userMessage.trim());
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    throw new Error(`${provider} tool loop exceeded max iterations.`);
  }

  async runAnthropic(input) {
    const signal = input?.signal;
    const apiKey = input.apiKey?.trim();
    if (!apiKey) throw new Error("anthropic api key is required.");
    const model = input.model?.trim() || "claude-3-7-sonnet-latest";
    const tools = await this.ensureTools(signal);
    await this.ensureMarkets(signal, input.walletAddress);

    const messages = [
      ...(input.walletAddress
        ? [
            {
              role: "user",
              content: `Context: walletAddress=${input.walletAddress}. Use this wallet directly.`,
            },
          ]
        : []),
      ...input.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const forcedTool = deriveConfirmationTool(input) ?? deriveForcedTool(input);
    if (forcedTool) {
      if (
        forcedTool?.arguments &&
        typeof forcedTool.arguments.marketIndex !== "number" &&
        this.activeMarketIndex != null
      ) {
        forcedTool.arguments.marketIndex = this.activeMarketIndex;
      }
      messages.push({
        role: "user",
        content: `Forced action hint: call tool "${forcedTool.name}" with arguments ${JSON.stringify(forcedTool.arguments)}.`,
      });
    }

    const lastToolSummaries = [];
    for (let i = 0; i < 6; i += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const response = await this.fetchWithProviderRetry("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: this.systemPrompt,
          messages,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          })),
          ...(forcedTool && i === 0
            ? { tool_choice: { type: "tool", name: forcedTool.name } }
            : {}),
        }),
      }, { provider: "anthropic" });

      const json = await response.json();
      const parts = Array.isArray(json?.content) ? json.content : [];
      const toolUses = parts.filter((p) => p.type === "tool_use");
      if (toolUses.length === 0) {
        const text = parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        const normalized = normalizeAssistantReply(text);
        if (!normalized || /^[\s{}[\]":,`]+$/.test(normalized)) {
          return lastToolSummaries[lastToolSummaries.length - 1] ?? normalized;
        }
        return normalized;
      }

      messages.push({ role: "assistant", content: parts });
      const toolResults = [];
      for (const toolUse of toolUses) {
        let result = await this.executeToolWithRetry(
          toolUse.name,
          toolUse.input,
          input.walletAddress,
          signal,
        );
        result = await this.enrichLifecycleResult(
          toolUse.name,
          result,
          input.walletAddress,
          signal,
        );
        if (result?.needsConfirmation) {
          this.setPendingAction(toolUse.name, toolUse.input ?? {}, input.walletAddress);
        } else if (toolUse?.input?.confirm === true) {
          this.pendingAction = null;
        }
        if (typeof result?.userMessage === "string" && result.userMessage.trim()) {
          lastToolSummaries.push(result.userMessage.trim());
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    throw new Error("anthropic tool loop exceeded max iterations.");
  }

  async run(input) {
    const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.log("turn_start", {
      turnId,
      provider: input.provider ?? "openrouter",
      activeMarketIndex: this.activeMarketIndex,
    });
    const directConfirmation = await this.tryExecutePendingConfirmation(input);
    if (directConfirmation) {
      this.log("turn_end", { turnId, path: "confirmation" });
      return directConfirmation;
    }

    try {
      const deterministic = await this.runDeterministicIntent(input);
      if (deterministic) {
        this.log("turn_end", { turnId, path: "deterministic", activeMarketIndex: this.activeMarketIndex });
        return deterministic;
      }
    } catch (error) {
      const intent = this.detectDeterministicIntent(input);
      const toolName =
        intent?.type === "balance" ? "get_balance" :
          intent?.type === "orders_overview" ? "get_wallet_orders_overview" :
            intent?.type === "order_status" ? "get_order_insight" :
              intent?.type === "cancel_order" ? "cancel_order" :
                intent?.type === "market_overview" ? "get_market_overview" :
                  intent?.type === "depth" ? "get_orderbook_depth" :
                    intent?.type === "dex_status" ? "get_dex_status" :
                      intent?.type === "price_recommendation" ? "get_price_recommendation" :
                        intent?.type === "place_order" ? "place_order" :
                          "tool";
      const mapped = classifyToolError(toolName, error?.message ?? String(error));
      this.log("turn_end", { turnId, path: "deterministic_error", toolName, error: String(error?.message ?? error) });
      return mapped;
    }

    try {
      if (input.provider === "anthropic") {
        const out = await this.runAnthropic(input);
        this.log("turn_end", { turnId, path: "anthropic", activeMarketIndex: this.activeMarketIndex });
        return out;
      }
      if (input.provider === "openai") {
        const out = await this.runOpenAICompatible(input, "openai");
        this.log("turn_end", { turnId, path: "openai", activeMarketIndex: this.activeMarketIndex });
        return out;
      }
      const out = await this.runOpenAICompatible(input, "openrouter");
      this.log("turn_end", { turnId, path: "openrouter", activeMarketIndex: this.activeMarketIndex });
      return out;
    } catch (error) {
      const msg = String(error?.message ?? error);
      if (input?.model) {
        this.log("provider_model_fallback", { turnId, provider: input.provider ?? "openrouter", model: input.model });
        try {
          const retryInput = { ...input, model: undefined };
          if (retryInput.provider === "anthropic") {
            return await this.runAnthropic(retryInput);
          }
          if (retryInput.provider === "openai") {
            return await this.runOpenAICompatible(retryInput, "openai");
          }
          return await this.runOpenAICompatible(retryInput, "openrouter");
        } catch {
          // fall through to mapped errors
        }
      }
      if (/401/.test(msg) && /openrouter/i.test(msg)) {
        throw new Error("OpenRouter authentication failed (401). Check your API key and account.");
      }
      if (/401/.test(msg) && /anthropic/i.test(msg)) {
        throw new Error("Anthropic authentication failed (401). Check your API key.");
      }
      if (/401/.test(msg) && /openai/i.test(msg)) {
        throw new Error("OpenAI authentication failed (401). Check your API key.");
      }
      if (/429/.test(msg)) {
        throw new Error("Provider rate limit reached (429). Retry shortly or switch provider/model.");
      }
      this.log("turn_end", { turnId, path: "provider_error", error: msg });
      throw error;
    }
  }
}
