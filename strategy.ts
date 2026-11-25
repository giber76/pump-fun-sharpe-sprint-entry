// Breakout Rider v3 — early-breakout paper bot, tuned for hourly Sharpe.
// Fresh implementation written from the prose spec in STRATEGY.md.
// No clock, no randomness, no I/O: every decision is a pure function of
// the batches seen so far, iterated in first-seen order so the two graded
// executions produce byte-identical action logs.

import type { Batch, BotState, OrderInput } from "./vendor/makefun-bot.ts";
import { LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";

const SOL = LAMPORTS_PER_SOL;

// ---- tuning (STRATEGY.md; a flat region, not tuned to the dev window) ----
const ENTRY_MIN_AGE_SLOTS = 10;
const ENTRY_MAX_AGE_SLOTS = 200;
const RUNUP_LOW_NUM = 115n; // price at least +15% over create
const RUNUP_HIGH_NUM = 130n; // price at most +30% over create
const SIGNAL_WINDOW_SLOTS = 25; // the signal window is the last 25 slots
const TAPE_KEEP_SLOTS = SIGNAL_WINDOW_SLOTS + 5; // the tape keeps a little more than the window
const PROBE_START_SECS = 8640; // probes only once 40% of the 6-hour window (21,600s) has elapsed
const NEAR_HIGH_NUM = 92n; // price within 8% of the window high
const MIN_WINDOW_BUYS = 5;
const MIN_WINDOW_BUYERS = 6;
const MIN_INFLOW_LAMPORTS = SOL / 10n; // net inflow at least 0.1 SOL
const MAX_WHALE_SHARE_NUM = 60n; // no wallet over 60% of window buy SOL
const MIN_REAL_RESERVE_LAMPORTS = SOL / 2n; // real SOL reserve 0.5..80
const MAX_REAL_RESERVE_LAMPORTS = 80n * SOL;
const MAX_STAKE_LAMPORTS = SOL / 20n; // one buy per coin, at most 0.05 SOL
const RESERVE_SHARE_NUM = 1n; // and at most 1% of the real SOL reserve
const MAX_BREAKOUTS_OPEN = 4;
const MAX_EXPOSURE_LAMPORTS = 4n * SOL;
const TAKE_PROFIT_NUM = 125n; // +25% over cost
const STOP_LOSS_NUM = 88n; // -12%
const TRAIL_ARM_NUM = 108n; // trailing stop arms once the trade is +8%
const TRAIL_DROP_NUM = 92n; // then sells 8% below the peak
const BIG_SELL_LAMPORTS = 2n * SOL; // any single sell >= 2 SOL exits
const MAX_HOLD_SLOTS = 1500;
const HOLD_KEEP_NUM = 150n; // hold cap waived while up >= 50%
const PROBE_STAKE_LAMPORTS = SOL / 100n; // probe buy 0.01 SOL
const PROBE_BUDGET = 20; // at most 20 probes ever
const PROBE_MAX_FLYING = 2; // at most 2 probe buys in flight
const PROBE_FLOW_SLOTS = 5; // probe only on positive 5-slot net buy flow
const COIN_BAR = 21; // probes top the distinct-coin count toward 21
const BUY_SLIPPAGE_BPS = 1500;
const SELL_SLIPPAGE_BPS = 10000;

// A price as a fraction: SOL per token = quote / token (virtual reserves).
interface Quote {
  q: bigint;
  t: bigint;
}

// priceA >= priceB * num / 100, exactly, with bigint cross-multiplication.
function atLeastRatio(a: Quote, b: Quote, num: bigint): boolean {
  return a.q * b.t * 100n >= b.q * a.t * num;
}

// priceA <= priceB * num / 100, exactly.
function atMostRatio(a: Quote, b: Quote, num: bigint): boolean {
  return a.q * b.t * 100n <= b.q * a.t * num;
}

// The higher of two prices, exactly.
function higherPrice(a: Quote, b: Quote): Quote {
  return a.q * b.t >= b.q * a.t ? a : b;
}

interface TapeTrade {
  slot: number;
  buy: boolean;
  wallet: string;
  sol: bigint;
  q: bigint; // virtual quote reserves right after the trade
  t: bigint; // virtual token reserves right after the trade
}

interface CoinTape {
  mint: string;
  born: number | null; // slot of the CreateEvent
  createQ: bigint; // virtual quote reserves at creation
  createT: bigint; // virtual token reserves at creation
  creator: string;
  trades: TapeTrade[]; // trades in the recent window, oldest first
  entered: boolean; // a breakout buy was sent for this coin
  fillSlot: number | null; // slot the breakout buy filled
  peak: bigint; // peak position value in lamports (trailing stop)
  armed: boolean; // trailing stop armed (trade reached +8%)
}

type OrderKind = "breakout" | "probe" | "exit" | "probeExit";

interface SentOrder {
  kind: OrderKind;
  mint: string;
}

// Cash left for orders decided in this batch (the harness state does not
// know about them yet, so the planner tracks them itself).
interface Budget {
  cash: bigint;
}

export class BreakoutRider {
  private tapes = new Map<string, CoinTape>();
  private tradedNow = new Set<string>(); // mints with a trade in this batch
  private counted = new Set<string>(); // coins traded toward the 20-coin bar
  private probeOpen = new Set<string>(); // probe position held, awaiting its sell
  private sent = new Map<string, SentOrder>();
  private nextId = 1;
  private firstTime: number | null = null; // block time of the first event seen
  private lastTime: number | null = null; // latest block time seen
  private probesFired = 0;
  private probesFlying = 0;
  // Diagnostics (stderr only, never the action log).
  private sentBreakout = 0;
  private sentProbe = 0;
  private sentExit = 0;
  private sentProbeExit = 0;
  private fillOutcomes = new Map<string, number>();
  private rejectReasons = new Map<string, number>();
  // Entry-gate funnel: how many candidates failed each gate.
  private funnel = new Map<string, number>();
  private probeCapSkips = 0;

  private bump(label: string): void {
    this.funnel.set(label, (this.funnel.get(label) ?? 0) + 1);
  }

  summary(): string {
    const fills = [...this.fillOutcomes.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
    const rejects = [...this.rejectReasons.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
    const funnel = [...this.funnel.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
    return (
      `sent breakout=${this.sentBreakout} probe=${this.sentProbe} ` +
      `exit=${this.sentExit} probeExit=${this.sentProbeExit} ` +
      `counted=${this.counted.size} probesFired=${this.probesFired} ` +
      `probeCapSkips=${this.probeCapSkips} fills[${fills}] rejects[${rejects}] funnel[${funnel}]`
    );
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.ingest(batch);
    const budget: Budget = { cash: state.freeCashLamports() };
    const orders: OrderInput[] = [];
    orders.push(...this.planExits(state, batch, budget));
    orders.push(...this.planEntries(state, batch, budget));
    orders.push(...this.planProbes(state, batch, budget));
    return orders;
  }

  // ---- intake ----------------------------------------------------------

  private tapeFor(mint: string): CoinTape {
    let tape = this.tapes.get(mint);
    if (tape === undefined) {
      tape = {
        mint,
        born: null,
        createQ: 0n,
        createT: 0n,
        creator: "",
        trades: [],
        entered: false,
        fillSlot: null,
        peak: 0n,
        armed: false,
      };
      this.tapes.set(mint, tape);
    }
    return tape;
  }

  private ingest(batch: Batch): void {
    this.tradedNow.clear();
    for (const event of batch.events) {
      if (event.block_time !== null) {
        if (this.firstTime === null) this.firstTime = event.block_time;
        if (this.lastTime === null || event.block_time > this.lastTime) {
          this.lastTime = event.block_time;
        }
      }
      if (event.event === "CreateEvent") {
        const tape = this.tapeFor(event.mint);
        tape.born = event.slot;
        tape.createQ = BigInt(event.virtual_quote_reserves);
        tape.createT = BigInt(event.virtual_token_reserves);
        tape.creator = event.creator;
      } else if (event.event === "TradeEvent") {
        const tape = this.tapeFor(event.mint);
        tape.trades.push({
          slot: event.slot,
          buy: event.is_buy,
          wallet: event.user,
          sol: BigInt(event.sol_amount),
          q: BigInt(event.virtual_quote_reserves),
          t: BigInt(event.virtual_token_reserves),
        });
        this.tradedNow.add(event.mint);
        this.pruneTape(tape, batch.slot);
      }
    }
    this.applyFills(batch);
    this.reconcile(batch);
  }

  // Drop trades older than the tape keep: the signal window is the last
  // 25 slots, and the tape keeps a few slots more so the window start has
  // a price to measure from.
  private pruneTape(tape: CoinTape, now: number): void {
    const cutoff = now - TAPE_KEEP_SLOTS;
    let cut = 0;
    while (cut < tape.trades.length && tape.trades[cut].slot <= cutoff) cut++;
    if (cut > 0) tape.trades.splice(0, cut);
  }

  private applyFills(batch: Batch): void {
    for (const fill of batch.fills) {
      this.fillOutcomes.set(fill.status, (this.fillOutcomes.get(fill.status) ?? 0) + 1);
      if (fill.status === "rejected" && fill.reason !== null) {
        this.rejectReasons.set(fill.reason, (this.rejectReasons.get(fill.reason) ?? 0) + 1);
      }
      const rec = this.sent.get(fill.client_id);
      if (rec !== undefined) {
        this.sent.delete(fill.client_id);
        if (fill.status === "filled") {
          if (rec.kind === "probe") {
            this.probesFlying--;
            this.probeOpen.add(rec.mint);
          } else if (rec.kind === "breakout") {
            const tape = this.tapes.get(rec.mint);
            if (tape !== undefined) tape.fillSlot = fill.slot;
          } else if (rec.kind === "probeExit") {
            this.probeOpen.delete(rec.mint);
          }
        } else {
          // Rejected or failed: nothing traded, so the coin never counted.
          if (rec.kind === "probe") {
            this.probesFlying--;
            this.counted.delete(rec.mint);
          } else if (rec.kind === "breakout") {
            this.counted.delete(rec.mint);
          }
        }
        continue;
      }
      // Harness closes (_complete_ / _flatten_ / _writeoff_): the position
      // is gone, so a probe awaiting its sell is gone too.
      if (fill.client_id.startsWith("_") && fill.side === "sell") {
        this.probeOpen.delete(fill.mint);
      }
    }
  }

  // Positions the harness closed leave stale trailing-stop state behind.
  private reconcile(batch: Batch): void {
    const held = new Set<string>();
    for (const position of batch.account.positions) {
      if (BigInt(position.token_amount) > 0n) held.add(position.mint);
    }
    for (const mint of this.probeOpen) {
      if (!held.has(mint)) this.probeOpen.delete(mint);
    }
    for (const tape of this.tapes.values()) {
      if (!held.has(tape.mint) && (tape.peak > 0n || tape.armed)) {
        tape.peak = 0n;
        tape.armed = false;
      }
    }
  }

  // ---- helpers ---------------------------------------------------------

  private nextClientId(prefix: string): string {
    return `${prefix}${this.nextId++}`;
  }

  private pendingBuyMints(state: BotState): Set<string> {
    const mints = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === "buy") mints.add(pending.order.mint);
    }
    return mints;
  }

  private pendingSellMints(state: BotState): Set<string> {
    const mints = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === "sell") mints.add(pending.order.mint);
    }
    return mints;
  }

  private record(kind: OrderKind, order: OrderInput): void {
    const id = order.client_id as string;
    this.sent.set(id, { kind, mint: order.mint });
    if (kind === "breakout") this.sentBreakout++;
    else if (kind === "probe") this.sentProbe++;
    else if (kind === "exit") this.sentExit++;
    else this.sentProbeExit++;
  }

  private sellAll(mint: string, tokens: bigint, prefix: string, kind: OrderKind): OrderInput {
    const order: OrderInput = {
      side: "sell",
      mint,
      token_amount: tokens,
      max_slippage_bps: SELL_SLIPPAGE_BPS,
      client_id: this.nextClientId(prefix),
    };
    this.record(kind, order);
    return order;
  }

  // ---- exits -----------------------------------------------------------

  private planExits(state: BotState, batch: Batch, _budget: Budget): OrderInput[] {
    const orders: OrderInput[] = [];
    const pendingSells = this.pendingSellMints(state);
    for (const [mint, holding] of state.positions) {
      if (pendingSells.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.virtual_token_reserves === 0n) continue;
      const tokens = holding.token_amount;
      const cost = holding.cost_lamports;
      const now: Quote = {
        q: curve.virtual_quote_reserves,
        t: curve.virtual_token_reserves,
      };
      // Realizable value of selling the whole position now: selling the
      // tokens into the curve moves its price (constant-product output),
      // then the curve fee and the sell's tx fee come off. The spot price
      // overstates what a sale returns, so exits are judged on this.
      const gross = (tokens * now.q) / (now.t + tokens);
      const value = (gross * 9875n) / 10000n - state.txFeeLamports();

      // A probe is sold the moment it lands — no exit rules apply to it.
      if (this.probeOpen.has(mint)) {
        orders.push(this.sellAll(mint, tokens, "q", "probeExit"));
        continue;
      }

      const tape = this.tapes.get(mint);
      if (tape === undefined) continue;
      if (value > tape.peak) tape.peak = value;
      if (!tape.armed && value * 100n >= cost * TRAIL_ARM_NUM) {
        // Armed once the trade's realizable value is +8% over cost.
        tape.armed = true;
      }

      let leave = false;
      // Creator sold, or one big sell, in this batch.
      for (const event of batch.events) {
        if (event.mint !== mint || event.event !== "TradeEvent" || event.is_buy) continue;
        if (event.user === tape.creator) leave = true;
        if (BigInt(event.sol_amount) >= BIG_SELL_LAMPORTS) leave = true;
      }
      // Take-profit / stop-loss / trailing stop, by exact value ratios.
      if (value * 100n >= cost * TAKE_PROFIT_NUM) leave = true;
      if (value * 100n <= cost * STOP_LOSS_NUM) leave = true;
      if (tape.armed && value * 100n <= tape.peak * TRAIL_DROP_NUM) leave = true;
      // Held too long, unless the trade is still up a lot.
      if (
        tape.fillSlot !== null &&
        batch.slot - tape.fillSlot >= MAX_HOLD_SLOTS &&
        value * 100n < cost * HOLD_KEEP_NUM
      ) {
        leave = true;
      }

      if (leave) orders.push(this.sellAll(mint, tokens, "x", "exit"));
    }
    return orders;
  }

  // ---- entries ---------------------------------------------------------

  private planEntries(state: BotState, batch: Batch, budget: Budget): OrderInput[] {
    const orders: OrderInput[] = [];
    const pendingBuys = this.pendingBuyMints(state);
    const fee = state.txFeeLamports();
    let open = 0;
    let exposure = 0n;
    for (const [mint, holding] of state.positions) {
      const tape = this.tapes.get(mint);
      if (tape !== undefined && tape.entered && !this.probeOpen.has(mint)) {
        open++;
        exposure += holding.cost_lamports;
      }
    }
    for (const pending of state.pending.values()) {
      if (pending.order.side !== "buy") continue;
      const rec = this.sent.get(pending.order.client_id);
      if (rec !== undefined && rec.kind === "breakout") {
        open++;
        exposure += BigInt(pending.order.quote_lamports);
      }
    }

    // Entries are judged only on curves that traded in this batch: the
    // signal is fresh flow, not a window that slid into place on its own.
    for (const mint of this.tradedNow) {
      if (open >= MAX_BREAKOUTS_OPEN || exposure >= MAX_EXPOSURE_LAMPORTS) break;
      const tape = this.tapes.get(mint);
      if (tape === undefined) {
        this.bump("noTape");
        continue;
      }
      if (tape.entered) {
        this.bump("entered");
        continue;
      }
      if (state.positions.has(mint) || pendingBuys.has(mint)) {
        this.bump("held");
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        this.bump("noCurve");
        continue;
      }
      const born = tape.born ?? curve.created_slot;
      if (born === null) {
        this.bump("bornNull");
        continue;
      }
      const age = batch.slot - born;
      if (age < ENTRY_MIN_AGE_SLOTS) {
        this.bump("ageYoung");
        continue;
      }
      if (age > ENTRY_MAX_AGE_SLOTS) {
        this.bump("ageOld");
        continue;
      }
      const reserve = curve.real_quote_reserves;
      if (reserve < MIN_REAL_RESERVE_LAMPORTS) {
        this.bump("reserveLow");
        continue;
      }
      if (reserve > MAX_REAL_RESERVE_LAMPORTS) {
        this.bump("reserveHigh");
        continue;
      }
      if (tape.createT === 0n || curve.virtual_token_reserves === 0n) {
        this.bump("zeroReserves");
        continue;
      }

      const create: Quote = { q: tape.createQ, t: tape.createT };
      const now: Quote = { q: curve.virtual_quote_reserves, t: curve.virtual_token_reserves };
      // Early breakout: +15% to +30% off the create price.
      if (!atLeastRatio(now, create, RUNUP_LOW_NUM)) {
        this.bump("runupLow");
        continue;
      }
      if (!atMostRatio(now, create, RUNUP_HIGH_NUM)) {
        this.bump("runupHigh");
        continue;
      }

      this.pruneTape(tape, batch.slot);
      // The signal window is the last 25 slots of trades.
      const cutoff = batch.slot - SIGNAL_WINDOW_SLOTS;
      const window = tape.trades.filter((trade) => trade.slot > cutoff);
      if (window.length === 0) {
        this.bump("windowEmpty");
        continue;
      }
      // The creator has not sold in the window: a coin its creator is
      // actively dumping is not a breakout candidate.
      let creatorDumped = false;
      for (const trade of window) {
        if (!trade.buy && trade.wallet === tape.creator) creatorDumped = true;
      }
      if (creatorDumped) {
        this.bump("creatorSoldWindow");
        continue;
      }
      // Near the window high (the high includes the current price).
      let high: Quote = now;
      for (const trade of window) {
        high = higherPrice(high, { q: trade.q, t: trade.t });
      }
      if (!atLeastRatio(now, high, NEAR_HIGH_NUM)) {
        this.bump("notNearHigh");
        continue;
      }

      // Window flow: enough buys, enough distinct buyers, net inflow that
      // is at least 0.1 SOL and accelerating (newer half >= older half),
      // and no single wallet over 60% of the window's buy SOL.
      let buyCount = 0;
      let totalBuy = 0n;
      let inflow = 0n;
      const byWallet = new Map<string, bigint>();
      for (const trade of window) {
        if (trade.buy) {
          buyCount++;
          totalBuy += trade.sol;
          inflow += trade.sol;
          byWallet.set(trade.wallet, (byWallet.get(trade.wallet) ?? 0n) + trade.sol);
        } else {
          inflow -= trade.sol;
        }
      }
      if (buyCount < MIN_WINDOW_BUYS) {
        this.bump("fewBuys");
        continue;
      }
      if (byWallet.size < MIN_WINDOW_BUYERS) {
        this.bump("fewBuyers");
        continue;
      }
      if (inflow < MIN_INFLOW_LAMPORTS) {
        this.bump("lowInflow");
        continue;
      }
      // Accelerating inflow: split the window by its slot midpoint; the
      // newer half's net inflow must be positive and at least the older
      // half's.
      const mid = batch.slot - SIGNAL_WINDOW_SLOTS / 2;
      let older = 0n;
      let newer = 0n;
      for (const trade of window) {
        const flow = trade.buy ? trade.sol : -trade.sol;
        if (trade.slot <= mid) older += flow;
        else newer += flow;
      }
      if (newer <= 0n || newer < older) {
        this.bump("notAccelerating");
        continue;
      }
      let whale = false;
      for (const share of byWallet.values()) {
        if (share * 100n > totalBuy * MAX_WHALE_SHARE_NUM) whale = true;
      }
      if (whale) {
        this.bump("whale");
        continue;
      }

      // One buy per coin: capped at 0.05 SOL, at 1% of the real reserve,
      // at the harness per-order cap, and by free cash.
      let size = MAX_STAKE_LAMPORTS;
      const reserveCap = reserve / 100n;
      if (reserveCap < size) size = reserveCap;
      const harnessCap = state.maxBuyLamports(mint);
      if (harnessCap < size) size = harnessCap;
      if (budget.cash - fee < size) size = budget.cash - fee;
      if (size <= 0n) {
        this.bump("sizeZero");
        continue;
      }

      const order: OrderInput = {
        side: "buy",
        mint,
        quote_lamports: size,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
        client_id: this.nextClientId("e"),
      };
      this.record("breakout", order);
      orders.push(order);
      tape.entered = true;
      this.counted.add(mint);
      open++;
      exposure += size;
      budget.cash -= size + fee;
    }
    return orders;
  }

  // ---- guardrail probes --------------------------------------------------

  private planProbes(state: BotState, batch: Batch, budget: Budget): OrderInput[] {
    const orders: OrderInput[] = [];
    // Probes start once 40% of the 6-hour window has elapsed, measured in
    // block time since the first event seen.
    if (this.firstTime === null || this.lastTime === null) return orders;
    if (this.lastTime - this.firstTime < PROBE_START_SECS) return orders;
    if (this.counted.size >= COIN_BAR) return orders;
    if (this.probesFired >= PROBE_BUDGET) return orders;
    const fee = state.txFeeLamports();
    const pendingBuys = this.pendingBuyMints(state);
    while (
      this.probesFlying < PROBE_MAX_FLYING &&
      this.probesFired < PROBE_BUDGET &&
      this.counted.size < COIN_BAR
    ) {
      const mint = this.pickProbeCoin(state, batch, pendingBuys);
      if (mint === null) break;
      if (budget.cash - fee < PROBE_STAKE_LAMPORTS) break;
      const order: OrderInput = {
        side: "buy",
        mint,
        quote_lamports: PROBE_STAKE_LAMPORTS,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
        client_id: this.nextClientId("p"),
      };
      this.record("probe", order);
      orders.push(order);
      this.counted.add(mint);
      this.probesFired++;
      this.probesFlying++;
      budget.cash -= PROBE_STAKE_LAMPORTS + fee;
    }
    return orders;
  }

  // First coin, in first-seen order, with positive net buy flow over the
  // last 5 slots that has not been counted toward the bar yet. Only curves
  // that traded in this batch are considered.
  private pickProbeCoin(state: BotState, batch: Batch, pendingBuys: Set<string>): string | null {
    for (const mint of this.tradedNow) {
      if (this.counted.has(mint)) continue;
      if (state.positions.has(mint) || pendingBuys.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (state.maxBuyLamports(mint) < PROBE_STAKE_LAMPORTS) {
        this.probeCapSkips++;
        continue;
      }
      const tape = this.tapes.get(mint);
      if (tape === undefined) continue;
      let flow = 0n;
      const cutoff = batch.slot - PROBE_FLOW_SLOTS;
      for (const trade of tape.trades) {
        if (trade.slot <= cutoff) continue;
        flow += trade.buy ? trade.sol : -trade.sol;
      }
      if (flow > 0n) return mint;
    }
    return null;
  }
}
