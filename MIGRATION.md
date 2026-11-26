# Migrating from `@redis-pubsub/*` (ioredis) to `redis-postino` / `nestjs-redis-postino` (node-redis)

The wire format did not change: messages are `{ "id", "data" }` JSON and subscriber channels are `<channel>:<instanceId>`.
Services on the old and the new library can therefore exchange messages during a rolling migration.

## 1. Packages

```diff
- npm i @redis-pubsub/nestjs
+ npm i nestjs-redis-postino
```

Requirements: Node.js >= 24.15, NestJS 12, Redis >= 7.2, ESM.

## 2. Renamed API

| Old                                                                        | New                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------ |
| `RedisPubsubModule`                                                        | `PostinoModule`                                        |
| `@SubscriberHost()`                                                        | `@PostinoSubscriberHost()`                             |
| `@Subscribe(channel)`                                                      | `@PostinoSubscribe(channel)`                           |
| `@InjectChannel(channel)`                                                  | `@InjectPostinoChannel(channel)`                       |
| `ChannelService<T>`                                                        | `PostinoChannel<T>`                                    |
| `RedisCorePublisherFactory` / `RedisCoreSubscriberFactory`                 | `PostinoPublisherFactory` / `PostinoSubscriberFactory` |
| `RedisCorePublisherServiceProvider` / `RedisCoreSubscriberServiceProvider` | `PostinoPublisher` / `PostinoSubscriber`               |
| `RedisPubsubModuleOptionInput` / `RedisPubsubModuleOption`                 | `PostinoOptionsInput` / `PostinoOptions`               |
| `RedisPublisherDto` / `RedisPublisherMessage`                              | `PostinoPublishDto` / `PostinoMessage`                 |
| `ILogger` / `InputILogger`                                                 | `PostinoLogger` / `PostinoLoggerInput`                 |

## 3. Options

```diff
  {
-   redisOptions: {
+   connection: {
      host: 'redis',
      port: 6379,
-     keepAlive: 5000,
-     connectTimeout: 5000,
-     commandTimeout: 3000,
-     maxRetriesPerRequest: 5,
-     autoResubscribe: true,
-     retryStrategy: (times) => (times > 10 ? null : times * 1000),
+     keepAlive: 5000,
+     connectTimeout: 5000,
+     commandTimeout: 3000,
+     reconnect: { maxAttempts: 10, delayMs: 1000 },
    },
    dispatchAndClose: false,
-   deadLetterQueue: { name: 'redis-comm-dlq' },
-   errorQueue: { name: 'redis-comm-eq' },
+   // `enable` is required; keep the old names during the migration, so existing DLQ/EQ jobs keep working
+   deadLetterQueue: { enable: true, name: 'redis-comm-dlq' },
+   errorQueue: { enable: true, name: 'redis-comm-eq' },
  }
```

| ioredis option                                  | New option                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `host`, `port`, `username`, `password`          | same name under `connection`                                                 |
| `db`                                            | `connection.db`                                                              |
| `tls`                                           | `connection.tls` (`true` or TLS options)                                     |
| `keepAlive`, `connectTimeout`, `commandTimeout` | same name under `connection` (see below for `commandTimeout`)                |
| `retryStrategy`                                 | `connection.reconnect: { maxAttempts, delayMs }`                             |
| `maxRetriesPerRequest`                          | removed: `commandTimeout` bounds how long a command waits while reconnecting |
| `autoResubscribe`                               | removed: node-redis always re-subscribes after a reconnection                |
| anything else                                   | `clientOptions` (raw node-redis options, merged last)                        |

- **`deadLetterQueue.enable` and `errorQueue.enable` are required** (no default): the factories and the module throw if either is missing. Set `enable: true` to keep the previous behavior.
- **Default queue names changed** to `postino-dlq` / `postino-eq`. Set the old names explicitly (as above) until the jobs that read the queues are migrated.
- **`commandTimeout`** now applies only to commands that are not yet sent. A sent command is not cancelled, so a `PUBLISH` that Redis already ran is never retried on another instance.

## 4. Behavior changes

- **Error queue entries**: `message` is the raw message string (it was double-encoded) and `error` is `{ name, message, stack }` (it was `"{}"` for `Error` objects).
- **`publish()` really never throws**: Redis errors (e.g. connection refused) return `{ success: false, error }`, and the unicast message goes to the DLQ.
- **`dispatchAndClose`** opens a dedicated connection per publish, so concurrent publishes no longer close each other's connection.
- **Subscriber self-healing** starts when node-redis gives up reconnecting. It retries with a backoff (5 s doubling up to 60 s) instead of a single attempt, and never starts after an intentional shutdown.
- **`subscribe()`** returns `true`/`false`. A handler registered while Redis is down is subscribed when the connection heals.
- **NestJS bootstrap** waits until the `@PostinoSubscribe` subscriptions are active.
- **`forRootAsync({ imports, providers })`**: `imports` and `providers` are now applied (they were ignored).
- **DLQ/EQ writes** use `MULTI` (atomic) instead of a pipeline.
