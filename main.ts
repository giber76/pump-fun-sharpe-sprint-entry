// Breakout Rider v3 — entrypoint: wires the harness to the strategy.
// The harness speaks agent-fun/replay/v2 on stdin/stdout; this file only
// connects it to BreakoutRider and hands the run back when done.

import { runBot } from "./vendor/makefun-bot.ts";
import { BreakoutRider } from "./strategy.ts";

const rider = new BreakoutRider();

const result = await runBot({
  onHello: (state) => {
    // Diagnostics only (stderr never reaches the action log).
    console.error(
      `hello: seed ${state.hello.seed}, capital ${state.hello.capital.lamports} lamports, ` +
        `max ${state.hello.caps.max_orders_per_batch} orders per batch`,
    );
  },
  onBatch: (state, batch) => rider.onBatch(state, batch),
});

console.error(
  `done: ${result.batches} batches answered, ` +
    `final cash ${result.state.cash} lamports, ` +
    `${result.state.positions.size} positions left open`,
);
console.error(`rider: ${rider.summary()}`);
