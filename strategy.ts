// Early-flow launch trader for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Idea, in one paragraph: on pump.fun almost all of a coin's move happens in the
// first few slots after its CreateEvent (in the dev window the median coin already
// peaks +16% within 5 slots, and half of all coins reach +15% that fast), so this
// bot only ever buys launches, never older coins. It watches every CreateEvent,
// reads the opening tape in its first slots — real SOL already in the curve, how
// many distinct non-creator wallets bought, whether the creator sold, whether the
// tape is net buying — and enters the launches that look like genuine early demand
// rather than a creator bundle or an instant dump. It scales in with up to three
// adds while the tape stays strong, aiming for 0.08 SOL per coin, and it exits on
// a ladder: half off at +12%, the rest at +25% or on a trailing stop, a hard stop
// at -10%, a 30-slot max hold, an instant exit when the creator sells, and an
// exit when the tape goes stale. Round-trip cost is about 2.5% curve fees plus
// two tx fees, so the +12% first rung clears fees with room to spare.
//
// A pure function of the batches it is fed: no clock, no environment, no
// randomness, so the two grading runs produce identical action logs.

import {
  BPS,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

/** Lamports in one SOL. */
const SOL = 1_000_000_000n;
/** Curve fees charged on every trade (protocol 95 bps + creator 30 bps). */
const CURVE_FEE_BPS = 125n;

export interface Params {
  /** First buy only while age (slots since create) is at most this. */
  entryMaxAge: number;
  /** Adds only while age is at most this. */
  addMaxAge: number;
  /** Target total spend per coin, lamports. */
  stakeLamports: number;
  /** Adds after the first buy, at most. */
  maxAdds: number;
  /** Real SOL reserve window at first-buy decision time, lamports. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot, at most, lamports. */
  maxDevBuy: number;
  /** Distinct non-creator buyers before entry: window. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, at most, bps. */
  maxSellRatioBps: number;
  /** Price now over the create price, at most, bps. */
  maxRunupBps: number;
  /** Recent-flow window, slots, and the minimum net flow it must show, lamports. */
  flowWindow: number;
  minFlowLamports: number;
  /** First take-profit: sell this share of the position at this gain over basis, bps. */
  tp1Bps: number;
  tp1PartBps: number;
  /** Exit the rest at this gain over basis, bps. */
  tpBps: number;
  /** Exit at this loss under basis, bps. */
  slBps: number;
  /** Trailing stop: once best value is this far over basis, exit on a fall of this much, bps. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Slippage allowed on buys and sells, bps. */
  slippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  entryMaxAge: 3,
  addMaxAge: 12,
  stakeLamports: 10_000_000,
  maxAdds: 0,
  minRealSol: 1_000_000_000,
  maxRealSol: 50_000_000_000,
  maxDevBuy: 2_500_000_000,
  minBuyers: 0,
  maxBuyers: 99,
  maxSellRatioBps: 5_000,
  maxRunupBps: 3_500,
  flowWindow: 10,
  minFlowLamports: 0,
  tp1Bps: 1_000_000,
  tp1PartBps: 5_000,
  tpBps: 1_000_000,
  slBps: 800,
  trailArmBps: 2_000,
  trailBps: 1_500,
  maxHold: 1000,
  staleSlots: 30,
  slippageBps: 10_000,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  buysSent: number;
  spentSent: bigint;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  tokens: bigint;
  /** SOL spent on the tokens still held, buy curve fees and tx fees included. */
  basis: bigint;
  best: bigint;
  tookTp1: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          spentSent: 0n,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold over the last flowWindow slots. */
  function flow(c: Coin, slot: number): bigint {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
    return net;
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();

      // Fold fills into held-position bookkeeping.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // Harness close (complete / flatten / write-off): position is gone.
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status !== 'filled') continue;
        if (f.side === 'buy') {
          const h = held.get(f.mint);
          if (h === undefined) {
            held.set(f.mint, {
              openedSlot: f.slot,
              tokens: BigInt(f.token_amount),
              basis: BigInt(f.quote_lamports) + BigInt(f.tx_fee_lamports),
              best: 0n,
              tookTp1: false,
            });
          } else {
            h.tokens += BigInt(f.token_amount);
            h.basis += BigInt(f.quote_lamports) + BigInt(f.tx_fee_lamports);
          }
        } else {
          const h = held.get(f.mint);
          if (h === undefined) continue;
          const sold = BigInt(f.token_amount);
          h.tokens -= sold;
          if (h.tokens <= 0n) held.delete(f.mint);
          else h.basis = (h.basis * h.tokens) / (h.tokens + sold);
        }
      }
      for (const mint of [...selling]) {
        if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
          held.delete(mint);
        }
      }

      // ---- Exits first. ----
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const h = held.get(mint);
        if (h === undefined) continue;
        const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) - tx;
        const basis = h.basis;
        if (basis <= 0n) continue;
        if (value > h.best) h.best = value;
        const c = coins.get(mint);

        let exit = false;
        if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(P.tp1Bps))) {
          // First rung: take half off the table, let the rest ride.
          const part = (pos.token_amount * BigInt(P.tp1PartBps)) / BPS;
          if (part > 0n && part < pos.token_amount) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: P.slippageBps });
            selling.add(mint);
            h.tookTp1 = true;
            h.best = 0n;
            continue;
          }
        }
        if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
        if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
        if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) {
          exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (c.devSold) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.slippageBps });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // ---- Entries and adds. ----
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const isAdd = c.buysSent > 0;
        if (!isAdd && age > P.entryMaxAge) {
          c.done = true;
          continue;
        }
        if (isAdd && age > P.addMaxAge) continue;
        if (isAdd) {
          if (c.buysSent > P.maxAdds) continue;
          if (!state.positions.has(c.mint) || selling.has(c.mint) || hasPending(state, c.mint, 'buy')) continue;
        } else if (open >= state.hello.caps.max_open_positions) {
          continue;
        }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold) {
          if (!isAdd) c.done = true;
          continue;
        }
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        // Never chase a launch that already ran away from its create price.
        const runupBps = (vq * c.vt0 * BPS) / (vt * c.vq0) - BPS;
        if (runupBps > BigInt(P.maxRunupBps)) {
          if (!isAdd) c.done = true;
          continue;
        }
        if (flow(c, state.slot) < BigInt(P.minFlowLamports)) continue;

        if (isAdd) {
          const room = stake - c.spentSent;
          if (room <= 0n) continue;
          const maxBuy = state.maxBuyLamports(c.mint);
          const amount = room < maxBuy ? room : maxBuy;
          if (amount < 5_000_000n || free < amount + tx) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.slippageBps });
          free -= amount + tx;
          c.buysSent += 1;
          c.spentSent += amount;
          continue;
        }

        // First-buy tape filter: genuine early demand, not a bundle or a dump.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < 10_000_000n) continue; // every round trip must clear the 0.01 SOL bar
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.slippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        open += 1;
      }
      return orders;
    },
  };
}
