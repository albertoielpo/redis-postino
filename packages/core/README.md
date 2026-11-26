# redis-postino

Redis pub/sub messaging for Node.js microservices, built on [node-redis](https://github.com/redis/node-redis).

- **Load-balanced unicast:** each message goes to **one** random live subscriber instance (at-most-once).
- **Broadcast:** optionally, deliver to **every** live subscriber instance.
- **Dead letter queue (DLQ):** undeliverable messages are stored in Redis, with a TTL.
- **Error queue:** messages whose handler threw are stored in Redis, with the error.
- **No polling:** pure Redis pub/sub.
- **Self-healing:** the subscriber recreates its connection and re-subscribes after Redis comes back.
- **Redis Cluster (experimental):** opt-in `cluster` option, publishers and subscribers can be connected to any node.

For NestJS, use [`nestjs-redis-postino`](https://www.npmjs.com/package/nestjs-redis-postino), which is built on this package.

## Requirements

- Node.js **>= 24.15**
- Redis **>= 7.2**, standalone. [Redis Cluster](#redis-cluster) support is **experimental**.
- ESM only (`import`). Node.js 24 can also `require()` it from CommonJS.

## Installation

```bash
npm i redis-postino
```

## How it works

Every subscriber process gets a random instance id and subscribes to `<channel>:<instanceId>`.
The publisher lists the live instances with `PUBSUB CHANNELS <channel>:*`, then:

- **unicast** (default): publishes to one random instance. If no client receives it, it tries the next instance. If no instance receives it, the message goes to the DLQ.
- **broadcast**: publishes to every instance. It succeeds if at least one instance received the message. The DLQ is not used.

Messages travel as JSON: `{ "id": "<uuid>", "data": <payload> }`. Channel names cannot contain `:`.

## Publish messages

```ts
import { PostinoPublisherFactory } from 'redis-postino';

const publisher = PostinoPublisherFactory.getInstance(
  {
    connection: { host: 'localhost', port: 6379 },
    deadLetterQueue: { enable: true }, // required, no default
    errorQueue: { enable: true }, // required, no default
  },
  console, // any logger with error/warn/debug and log or info
);

const { success, error } = await publisher.publish({ channel: 'orders', payload: { id: 42 } });

// flag the message for a retry job if it ends up in the DLQ
await publisher.publish({ channel: 'orders', payload: { id: 43 } }, true);

// deliver to every live instance
await publisher.publish({ channel: 'cache-invalidation', payload: { key: 'user:1' } }, false, true);
```

`publish(dto, retry = false, broadcast = false)` **never throws**. It returns `{ success: boolean; error?: string }`.

## Subscribe to a channel

```ts
import { PostinoSubscriberFactory } from 'redis-postino';

const subscriber = PostinoSubscriberFactory.getInstance(
  { connection: { host: 'localhost' }, deadLetterQueue: { enable: true }, errorQueue: { enable: true } },
  console,
);

await subscriber.subscribe('orders', async (order: { id: number }) => {
  // handle the message
});
```

- Handlers can be `async`; they are awaited.
- Handlers are wrapped in a try/catch. A failure is logged and stored in the error queue, and never stops the subscriber.
- `subscribe()` never throws. It returns `true` when the Redis subscription is active. If Redis is unreachable the handler is still registered and is subscribed once the connection heals.

## Shutdown

```ts
await publisher.onApplicationShutdown();
await subscriber.onApplicationShutdown();
```

## Options

The factories are process-wide singletons: the options passed to the first `getInstance()` call win.

```ts
interface PostinoOptionsInput {
  connection?: {
    host?: string; // default 'localhost'
    port?: number; // default 6379
    username?: string;
    password?: string;
    db?: number;
    tls?: boolean | tls.ConnectionOptions;
    connectTimeout?: number; // ms, default 5000
    keepAlive?: number; // TCP keep-alive initial delay in ms, default 5000 (0 disables it)
    commandTimeout?: number; // ms a command may wait to be sent (e.g. while reconnecting), default 3000 (0 disables it)
    reconnect?: {
      maxAttempts?: number; // default 10
      delayMs?: number; // linear backoff step, default 1000 (attempt n waits n * delayMs)
    };
  };
  clientOptions?: Partial<RedisClientOptions>; // raw node-redis options, merged last
  cluster?: {
    // enables Redis Cluster mode (experimental, see below); connection.host / port / db are then ignored
    rootNodes: Array<{ host: string; port: number } | string>; // seed nodes, objects or URLs
    useReplicas?: boolean; // default false
    maxCommandRedirections?: number; // default 16
    nodeAddressMap?: NodeAddressMap; // announced address -> reachable address (NAT, Docker, Kubernetes)
    healthCheckIntervalMs?: number; // subscriber watchdog, default 10000 (0 disables it)
    clusterOptions?: Partial<RedisClusterOptions>; // raw node-redis cluster options, merged last
  };
  dispatchAndClose?: boolean; // default false: open a dedicated connection per publish and close it afterwards
  deadLetterQueue: { enable: boolean; name?: string; ttlInSeconds?: number }; // enable required; default 'postino-dlq', one week
  errorQueue: { enable: boolean; name?: string; ttlInSeconds?: number }; // enable required; default 'postino-eq', one week
}
```

`deadLetterQueue.enable` and `errorQueue.enable` have no default: `getInstance()` throws if either is missing.

`commandTimeout` only applies to commands that have not been sent yet. A command already sent to Redis is not cancelled, because cancelling a `PUBLISH` that Redis already ran could deliver the message twice.

When the reconnect attempts run out, the subscriber recreates its connection after 5 s, doubling the delay after each failure up to 60 s. It then re-subscribes every registered channel.

## Redis Cluster

> **Experimental.** Cluster mode is covered by unit tests with mocked clients only; it has not been validated against a real Redis Cluster yet (failover, NAT address mapping, replicas). The `cluster` options and behavior may change in a minor release. Test it in your environment before relying on it in production.

Set `cluster` to connect to a Redis Cluster. Every connection (publisher, subscriber, queues) then uses a node-redis cluster client (`createCluster`).

```ts
const publisher = PostinoPublisherFactory.getInstance(
  {
    connection: { password: 'secret', tls: true }, // applied to every node
    cluster: {
      rootNodes: [{ host: 'redis-0', port: 6379 }, { host: 'redis-1', port: 6379 }, 'rediss://redis-2:6379'],
    },
    deadLetterQueue: { enable: true },
    errorQueue: { enable: true },
  },
  console,
);
```

- `connection` (credentials, TLS, timeouts, reconnect) and `clientOptions` become the node-redis `defaults`, applied to the root nodes and to every discovered node. `connection.host`, `connection.port` and `connection.db` are ignored: nodes come from the cluster topology, and Redis Cluster only has database 0.
- Postino uses classic pub/sub, which Redis Cluster propagates to every node, so publishers and subscribers can be connected to any node.
- Discovery: `PUBSUB CHANNELS` only lists the subscriptions of the node it runs on, so the publisher queries every node of the topology (the masters, plus the replicas when `useReplicas` is enabled) and publishes each message through the node where its subscriber is connected. `PUBLISH` only counts the receivers on its own node, so this keeps its reply a reliable delivery acknowledgement (at-most-once delivery is preserved). If some nodes cannot be queried (e.g. a master that just died), the publisher refreshes the cluster topology and queries the nodes again, so the subscribers that moved to a newly promoted master are found. Nodes still unreachable are skipped with a warning.
- The subscriber's pub/sub connection is managed by node-redis, which moves it when its node leaves the topology. node-redis does not report a pub/sub connection that ran out of reconnect attempts, so a watchdog checks it every `healthCheckIntervalMs` and recreates the cluster connection when it is dead (or refreshes the topology and re-subscribes when the pub/sub connection is missing).
- Queue entries are stored under `{<queue>}:<id>` (hash-tagged) so that the entry and the list `<queue>` live in the same slot. If the queue name already contains a hash tag (e.g. `{app}dlq`), the standalone format `<queue>:<id>` is kept.

### Things to know

- **Queue key format.** In cluster mode, queue entries are stored as `{<queue>}:<id>` instead of `<queue>:<id>`. Code that reads entries by building the key itself must handle this format. Reading keys from the list (`LPOP <queue>` then `GET <key>`, as in the [reader example](#queues)) works unchanged, because the list holds the full entry keys.
- **`dispatchAndClose` is expensive on a cluster.** Every publish opens a new cluster client, which rediscovers the whole topology and connects to the nodes before publishing. Keep `dispatchAndClose: false` (the default) in cluster mode unless publishes are rare.
- **Every publish queries every node.** Subscriber discovery runs `PUBSUB CHANNELS` on each node of the topology, so the cost of a publish grows with the number of nodes.
- **Use the same `useReplicas` value everywhere.** node-redis only tracks replicas when `useReplicas` is enabled, and the subscriber's pub/sub connection is placed on a random node of its topology. A subscriber with `useReplicas: true` may listen on a replica, which a publisher with `useReplicas: false` never queries: its messages would go to the dead letter queue.
- **Failover.** While a master is down and until a replica is promoted (`cluster-node-timeout`, 15 s by default), the subscribers connected to it miss messages: unicast messages are delivered to the other instances, or go to the dead letter queue if none is left. After the failover the subscribers are healed by node-redis or by the watchdog, within `healthCheckIntervalMs` plus the self-healing delay (5 s).
- **Topology refresh relies on a node-redis internal.** node-redis only refreshes the topology a few seconds after a node starts reconnecting, so a short `connection.reconnect` budget can leave a stale topology (a dead master, no promoted replica). Postino forces a refresh through node-redis' internal `_slots.rediscover()`. If a future node-redis version removes it, a warning is logged and the refresh is skipped.
- **All nodes must be reachable from the application.** The publisher connects to every node of the topology, using the addresses the cluster announces. Behind NAT, Docker or Kubernetes, map them with `cluster.nodeAddressMap`.

## Queues

Each queue is a Redis list of keys. An entry is stored under the key `<queue>:<id>` (`{<queue>}:<id>` in cluster mode) with the configured TTL, and its key is pushed to the list `<queue>`.
Redis deletes an expired entry key automatically, but **does not remove its key from the list**: skip keys whose value is gone.

Dead letter queue entry:

```ts
interface DeadLetterQueueEntry<T> {
  channel: string; // the channel
  message: T; // the payload
  retry: boolean; // set by publish()
}
```

Error queue entry:

```ts
interface ErrorQueueEntry {
  subscribeChannel: string; // the instance channel, `<channel>:<instanceId>`
  message: string | null; // the raw message received ({"id":...,"data":...})
  error: { name?: string; message: string; stack?: string };
}
```

Reading a queue with node-redis:

```ts
import { createClient } from 'redis';

const redis = await createClient().connect();
for (let key = await redis.lPop('postino-dlq'); key; key = await redis.lPop('postino-dlq')) {
  const data = await redis.get(key);
  if (!data) continue; // entry expired
  const { channel, message, retry } = JSON.parse(data);
  // ...re-publish with PostinoPublisher if `retry` is true
}
await redis.close();
```

## License

MIT
