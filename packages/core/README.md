# redis-postino

Redis pub/sub messaging for Node.js microservices, built on [node-redis](https://github.com/redis/node-redis).

- **Load-balanced unicast:** each message goes to **one** random live subscriber instance (at-most-once).
- **Broadcast:** optionally, deliver to **every** live subscriber instance.
- **Dead letter queue (DLQ):** undeliverable messages are stored in Redis, with a TTL.
- **Error queue:** messages whose handler threw are stored in Redis, with the error.
- **No polling:** pure Redis pub/sub.
- **Self-healing:** the subscriber recreates its connection and re-subscribes after Redis comes back.

For NestJS, use [`nestjs-redis-postino`](https://www.npmjs.com/package/nestjs-redis-postino), which is built on this package.

## Requirements

- Node.js **>= 24.15**
- Redis **>= 7.2**, standalone. **Redis Cluster is not supported.**
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

const subscriber = PostinoSubscriberFactory.getInstance({ connection: { host: 'localhost' } }, console);

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
  dispatchAndClose?: boolean; // default false: open a dedicated connection per publish and close it afterwards
  deadLetterQueue?: { enable?: boolean; name?: string; ttlInSeconds?: number }; // default enabled, 'postino-dlq', one week
  errorQueue?: { enable?: boolean; name?: string; ttlInSeconds?: number }; // default enabled, 'postino-eq', one week
}
```

`commandTimeout` only applies to commands that have not been sent yet. A command already sent to Redis is not cancelled, because cancelling a `PUBLISH` that Redis already ran could deliver the message twice.

When the reconnect attempts run out, the subscriber recreates its connection after 5 s, doubling the delay after each failure up to 60 s. It then re-subscribes every registered channel.

## Queues

Each queue is a Redis list of keys. An entry is stored under the key `<queue>:<id>` with the configured TTL, and its key is pushed to the list `<queue>`.
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
