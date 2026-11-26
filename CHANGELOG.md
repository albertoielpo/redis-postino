# Changelog

## Unreleased

### Added

- **Experimental** Redis Cluster support (`cluster` option) in `redis-postino` and `nestjs-redis-postino`:
  - connections use a node-redis cluster client; `connection` / `clientOptions` are applied to every node.
  - the publisher discovers subscribers on every node of the topology and publishes through the node each subscriber is connected to (`PUBLISH` replies only count local receivers in a cluster).
  - the cluster topology is refreshed when some nodes cannot be queried, so subscribers on a newly promoted master are found after a failover.
  - queue entries are hash-tagged (`{<queue>}:<id>`) so the `MULTI` writing entry and list does not fail with `CROSSSLOT`.
  - subscriber watchdog (`cluster.healthCheckIntervalMs`) that heals a dead pub/sub connection, since node-redis does not emit `terminated` for clusters.

## Unreleased: first release

Port of the previous internal ioredis-based library to node-redis, under the new names `redis-postino` and `nestjs-redis-postino`.
See [MIGRATION.md](MIGRATION.md).

### Design notes: fixes carried over from the previous library

Each of these has a `regression(...)` unit test so it cannot silently come back.

- **Queue idle timer** has an explicit delay (5 min). It used to fire immediately and close the connection after every write. `regression(H1)`
- **DLQ entry** is `{ channel, message, retry }`; **error queue entry** includes `subscribeChannel`. `regression(H2)`
- **Broadcast** lists the instance channels with `PUBSUB CHANNELS` and publishes to each of them, because `PUBLISH` does not support patterns. `regression(H3)`
- **`MessageId:`** prefix in the delivery logs; the idle timer is cleared on shutdown. `regression(H4)`
- **Connection self-healing** `regression(H5)`:
  - the publisher reuses its connection and reconnects only when it is no longer usable;
  - `safeQuit`: graceful `close()` with a 2 s timeout, then a forced `destroy()`;
  - queue entries are namespaced as `<queue>:<id>`, and the idle close drops the connection;
  - the subscriber recreates its connection when it is permanently closed and re-subscribes every channel;
  - tuned defaults (keep-alive 5 s, connect timeout 5 s, command timeout 3 s, bounded reconnects);
  - every shutdown is async, awaited and never throws.
- NestJS is a peer dependency expressed as a range; the core has no NestJS dependency.

### Fixed during the port

- Subscriber logs no longer print `undefined` (nested `logger.log` call).
- Shutdown unsubscribes the real instance channels, and awaits the unsubscribe.
- No self-healing reconnection after an intentional shutdown.
- No duplicated handler execution after a reconnection (node-redis re-subscribes by itself; the listener is registered once).
- Error queue entries keep the raw message and the real error (`name`, `message`, `stack`).
- A handler registered while Redis is down is kept and subscribed once the connection heals.
- NestJS bootstrap waits for the subscriptions.
- `forRootAsync` applies `imports` and `providers`.

### Known behavior (unchanged)

- Broadcast with no live subscriber returns `success: false` and does not use the DLQ.
- Factories are process-wide singletons: the options of the first `getInstance()` call win.
- Publisher and subscriber share the queue connection; both close it on shutdown (idempotent).
- The queue list TTL is refreshed on every write, while each entry expires on its own: the list can reference expired keys.
- One handler per channel per process.
