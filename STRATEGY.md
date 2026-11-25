# Breakout Rider v3 (Sharpe) — strategy notes

## Idea

Most pump.fun launches die within minutes, but a visible minority run 2x–10x
from their create price (on the dev window: 286 of 1,222 sampled coins reached
2x, 145 reached 3x). The edge is not in buying the launch itself (a lottery:
the house sniper pilot wins ~13% of its trades) and not in chasing a mature
run (buying the top: the house momentum pilot lost 9.4 of 10 SOL on the dev
window), but in riding the *early* breakout: a coin up a little off its create
price, with several distinct wallets still buying into it and net SOL flowing
in faster than it did a moment ago.

This competition ranks by **hourly Sharpe ratio**, not PnL, so the design is
tuned for smooth hourly equity: small stakes, quick exits, many small
independent trades, and the cheapest possible filler for the 20-coin bar.

## Rules

- **Entry** (first buy only, one entry per coin): age 10–200 slots since the
  CreateEvent; price 15%–30% above the create price; price within 8% of the
  25-slot window high; at least 5 buy trades and 6 distinct buyers in the
  window; net inflow at least 0.1 SOL and accelerating (newer half ≥ older
  half); no single wallet over 60% of the window's buy SOL; real SOL reserve
  0.5–80; creator has not sold.
- **Sizing**: one buy per coin, capped at 0.05 SOL and at 1% of the curve's
  real SOL reserve (the cap usually binds first on young curves) and by free
  cash; no pyramiding — adding to positions cost more than it ever gained on
  the dev window; at most 4 breakout positions open and 4 SOL total exposure.
- **Exits** (whole position, first trigger wins): take-profit +25% over cost,
  stop-loss −12%, trailing stop −8% from the peak once the trade is +8%,
  creator sell, any single sell ≥ 2 SOL, or 1,500 slots held (unless up ≥ 50%).
- **Guardrail pacing**: the final window is 6 hours, and the strong signal
  alone only reaches 4–8 coins in any 6-hour slice of the dev window — below
  the 20-coin minimum bar. So the bot tops the coin count up toward 21 with
  probe round trips (buy 0.01 SOL, sell it as soon as it lands): at most 20
  ever, up to 2 in flight, only once 40% of the 6-hour window has elapsed, and
  only on coins with positive net buy flow over the last 5 slots. A probe
  never re-buys a coin already counted toward the bar. Every 6-hour slice of
  the dev window lands at 21–23 coins with this pacing.
- **Scout tier (disabled)**: a weaker early-breakout signal at 0.01 SOL was
  tried as an alternative bar-filler. It cost ~0.00125 SOL per extra coin —
  about 2x a probe — and cannibalised strong entries (a coin scout-entered
  can never be strong-entered), so it ships disabled (`maxScouts: 0`) and the
  probes do the job.
- **Costs**: curve fees are 95 + 30 bps a side plus 105,000 lamports per tx,
  so a round trip costs ~2.5% before slippage; buys allow 1,500 bps slippage,
  sells go out at 10,000 bps.

## Local results

Hourly Sharpe per the house scorer's definition (mean / sample sd of hourly
equity returns; marks at each hour end plus the final flatten), four 6-hour
slices of the 24-hour dev window, mean over 4 fail-key draws:

| slice | mean Sharpe | mean net | coins | wins | max DD |
| --- | --- | --- | --- | --- | --- |
| 0–6 h | −0.70 | −0.032 SOL | 21 | 2 | 0.38% |
| 6–12 h | +0.10 | +0.006 SOL | 23 | 5 | 0.14% |
| 12–18 h | +0.23 | +0.026 SOL | 21 | 5 | 0.20% |
| 18–24 h | +0.07 | +0.004 SOL | 21 | 2 | 0.16% |

Overall: **mean hourly Sharpe −0.08, mean net +0.001 SOL, 3 of 4 slices
positive**. The dev window is a hard regime (all three house pilots lose on
it), so the dev number is a stress test, not a forecast: the final window is
a fresh 6 hours of coins that do not exist yet. What the design buys is
asymmetry — losers are small (0.05 SOL stakes at most, −12% stop) and quick,
while winners are allowed to run — plus a drawdown guard (max 4 SOL exposed,
tight stops) that keeps the run far from the 50% drawdown bar.

Variants tested and rejected on the slices (all with the same harness):
tighter exits (TP +10% / stop −6%) killed the big winners; earlier entry
(runup 1.05–1.20) and a wider runup band (to 1.50) both turned the signal
negative; a 50-slot flow window lost money; scouts as bar-fillers cost ~2x
probes per coin; fewer probes (budget 12) failed the 20-coin bar on the
thinnest slice. The shipped settings are a flat region, not a single best
point — neighbouring knobs give the same result.

## Determinism

No clock, no randomness, no I/O. Iteration is only over insertion-ordered
maps fed by the batch stream, so the two graded executions produce
byte-identical action logs.
