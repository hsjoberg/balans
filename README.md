# balans

An interactive CLI for manually rebalancing Lightning channels, built with Bun and powered by [Balance of Satoshis](https://github.com/alexbosworth/balanceofsatoshis).

Choose whether to increase outbound or inbound liquidity, pick peers by name, and set targets and fee limits. Review and start the session; Balans handles the individual rebalance attempts and shows what changed when it finishes.

## Try the demo

With [Bun](https://bun.sh) installed, run these commands from the project directory:

```sh
bun install --frozen-lockfile
bun run demo
```

The demo uses fictional peers and simulated payments. It needs no node connection and resets its balances each time.

The first step asks what you want to achieve:

```text
BALANS  /  DEMO — simulated payments only

? 1/7 · What do you want to achieve?
> Increase outbound liquidity — refill channels so they can send more
  Increase inbound liquidity — drain channels so they can receive more
  I don't know — help me choose
```

Step 2 always selects the channels you want to improve. In inbound mode, that means choosing full channels to drain:

```text
Bar = outbound / capacity · Amounts in sats · [n] = combined channels
? 2/7 · Which peers need more inbound liquidity? (≥95% outbound preselected)
›[x] Amber Bridge         ████████████████ 100.0%    8.00M /   8.00M
 [x] Quartz Express       ████████████████ 100.0%   30.00M /  30.00M
  -  Sleeping Fox         ███████████████▋  97.3%    9.73M /  10.00M (low out)
 [ ] Cedar Relay          ████████████▊░░░  79.4%   14.28M /  18.00M
  -  Copper Finch         ▉░░░░░░░░░░░░░░░   5.8%   43.68k / 750.00k (low out)
  -  Cloud Orchard        ░░░░░░░░░░░░░░░░   0.0%        0 /   1.50M (low out)
  -  Dune Sparrow         ░░░░░░░░░░░░░░░░   0.0%        0 /   3.00M (low out)
  -  Paper Lantern        ░░░░░░░░░░░░░░░░   0.0%        0 /   6.50M (low out)
  -  Pine Pocket          ░░░░░░░░░░░░░░░░   0.0%        0 / 250.00k (low out)
```

Use **↑/↓** to move, **Space** to toggle a peer, and **Enter** to continue. In this inbound flow, the next step chooses where the drained sats may go. In outbound mode, you first choose channels to refill, then choose funding peers.

## Use your node

Run Balans where your existing BOS saved-node configuration and LND endpoint are accessible. Both Balans and its bundled BOS backend run under Bun; Node.js and a global BOS executable are not required.

Replace `my-node` with your BOS saved-node name:

```sh
# Read live balances and review a plan without making payments
bun run start --node my-node --dry-run

# Build a plan and confirm before starting rebalances
bun run start --node my-node
```

Omit `--node` to enter the name interactively. Run `bun run start --help` for options. After updating the project, run `bun install --frozen-lockfile` again: the bundled BOS dependency includes a required rebalance amount-limit patch.

Use `--target-outbound` to set the default outbound goal for destinations, or `--target-inbound` to set the default inbound goal for sources:

```sh
bun run start --node my-node --target-outbound 2m
bun run start --node my-node --target-inbound 2m
bun run demo --target-inbound 500k
```

The flag for your chosen mode supplies each goal prompt's default, capped by its available liquidity. Both default to 1 million sats. Press Enter to accept or enter a different value for a peer. Source floors and receiving limits are configured separately; these flags do not skip the goal choice.

## The wizard

1. **Choose a goal.** Increase outbound, increase inbound, or ask for help choosing.
2. **Choose the channels to improve.** Outbound mode starts with channels to refill, lowest outbound first (≤5% preselected). Inbound mode starts with channels to drain, highest outbound first (≥95% preselected).
3. **Choose the other side.** Outbound mode asks where the sats should come from. Inbound mode asks where the sats may go. Peers already selected in step 2 are excluded.
4. **Set goals and limits.** Outbound mode sets destination outbound minimums and source floors. Inbound mode sets source inbound minimums, source floors, and destination outbound maximums.
5. **Set a session fee budget.** This covers routing fees, separate from the sats moved between your channels.
6. **Set fee limits.** Choose the maximum fee per rebalance and maximum fee rate. Optionally adjust attempt size, timeout, and count.
7. **Review and confirm.** Check the plan before any payments start.

**I don't know** explains both directions and shows sending and receiving candidates from your channel balances. It suggests a mode based on the counts of eligible nearly empty/full peers, then asks you to choose. The suggestion does not select peers or start a session for you. Circular rebalancing redistributes existing liquidity; it does not create additional inbound liquidity overall.

Amounts accept `500000`, `500k`, or `1.5m`.

| Setting | Default |
| --- | --- |
| Destination outbound goal (outbound mode) | 1,000,000 sats, limited by available liquidity |
| Source inbound goal (inbound mode) | 1,000,000 sats, limited by available liquidity and source floor |
| Destination outbound maximum (inbound mode) | 50% of capacity, bounded by current balance and available liquidity |
| Source minimum retained outbound | 1,000,000 sats, limited by current balance |
| Total routing-fee budget | 15,000 sats |
| Maximum fee per rebalance | 5,000 sats, limited by the session budget |
| Maximum fee rate | 5,000 ppm |
| Maximum amount per attempt | 500,000 sats |
| Route-search timeout | 5 minutes per attempt |
| Maximum attempts per goal item | 20 per destination in outbound mode; 20 per source in inbound mode |

## What to expect

Balans reads **public channels only**. Inactive channels and channels with pending HTLCs contribute no available liquidity. Multiple channels with the same peer appear as one selection; goals and limits apply to their combined balances.

Rebalances run one at a time, refreshing balances before each attempt. In outbound mode, each destination gets up to 20 attempts across the selected sources. In inbound mode, each source gets up to 20 attempts across the permitted destinations. Balans then continues to the next goal item. Successful and failed attempts both count; the fee budget covers the whole session. An item finishes earlier when its target is met or no eligible pair remains.

Sending **out** through a source decreases its outbound liquidity and increases its inbound liquidity. Receiving **in** through a destination increases its outbound liquidity. BOS has a 50,000-sat minimum attempt size, so a final attempt may exceed a minimum goal slightly; source floors and destination maximums still apply. Targets depend on available routes and your limits.

At the end, the report lists each attempt, sats moved, fees, and each selected channel's observed before/after balance. It also shows which targets were reached. Balance changes can include forwarding or other activity during the session. Fees shown with `≈` are approximate, rounded conservatively for budget accounting.

**Ctrl+C** requests a stop after the current attempt finishes. Sessions are interactive; scheduling and headless execution are not available yet.

## Session history and recovery

Session journals are saved in `~/.balans/`. A lock prevents overlapping Balans sessions for the same saved-node name on the same machine and OS account. Balans checks for an existing lock as soon as the node name is known, before reading channels or starting the wizard, and acquires the lock after you confirm the plan.

An unresolved payment stops execution and retains the lock. Check the journal and reconcile the payment outcome and pending HTLCs in LND before trying again. Only remove that session's lock after the previous process has stopped and the payment outcome is known. There is no automatic resume.

An invoice creation error also stops the session, but happens before payment: its fee reservation is released and the lock is removed automatically. The error report includes the available RPC status and any rejection from Balans's payment guard.

## Development

```sh
bun test
bun run typecheck
```
