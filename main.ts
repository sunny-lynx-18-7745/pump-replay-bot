// pump-replay-bot: an early-flow launch trader for the make.fun
// "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty
// (agent-fun/replay/v2). The grader runs `node /bot/main.ts`;
// the strategy lives in strategy.ts and the SDK shim is the kit's
// sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
