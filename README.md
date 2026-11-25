# pump-replay-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/sunny-lynx-18-7745/pump-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/sunny-lynx-18-7745/pump-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Early-flow launch trader for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty (agent-fun/replay/v2). It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity: it buys new launches in their first slots at the minimum viable size (0.01 SOL), cuts losers fast (stop-loss -8%, stale-tape exit), and lets the rare runner ride on a trailing stop instead of a fixed take-profit — because on pump.fun the whole distribution is a lottery where a few coins pay for the rest.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` (Node 22, TypeScript stripped as-is, no build, no install). `strategy.ts` holds the strategy; `vendor/makefun-bot.ts` is the kit's SDK shim, vendored byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
