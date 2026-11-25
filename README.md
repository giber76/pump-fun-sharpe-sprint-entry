# pump-fun-sharpe-sprint-entry

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/giber76/pump-fun-sharpe-sprint-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/giber76/pump-fun-sharpe-sprint-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Breakout Rider v3 (Sharpe) — a paper-trading bot for pump.fun bonding curves,
built for a 6-hour final window ranked by **hourly Sharpe ratio**, not PnL.
It rides early breakouts (a coin up 15–30% off its create price, with several
distinct wallets still buying in and net SOL flowing in faster than before),
enters small once per coin, and leaves fast on a take-profit, a tight stop, a
trailing stop, a creator sell, or a big dump. Flow-filtered guardrail probes
top the coin count up toward 21 so the 20-coin minimum bar clears on a
6-hour window. Paper trading only — the replay uses market data, never real
funds.

Local 6-hour slices of the dev window: **mean hourly Sharpe −0.08, mean net
PnL +0.001 SOL, 3 of 4 slices positive**, 21–23 coins per slice, max
drawdown ≤0.4%. Full dev window (`grade-local --driver process`):
**net PnL +0.0183 SOL**, 78 fills over 39 coins, 39 round trips, win rate
28.2%, max drawdown 0.36%, guardrails met, L1 regrade byte-identical. Stress
(10 rebuilt copies): median −0.04 SOL, 9 of 10 lost money — the dev score
leans on this window's coins, so treat it as a stress test, not a forecast.
See STRATEGY.md for the full notes.

## Run it

```sh
node main.ts
```

The entrypoint is `main.ts` (Node 22); the strategy lives in `strategy.ts`
and the SDK shim is the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte
in `vendor/`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=giber-way&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
