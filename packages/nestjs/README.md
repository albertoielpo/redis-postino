# nestjs-redis-postino

NestJS module for [`redis-postino`](https://www.npmjs.com/package/redis-postino): decorator-based Redis pub/sub for microservices.

- **Load-balanced unicast:** each message goes to **one** random live instance of the subscribing service (at-most-once).
- **Broadcast:** optionally, deliver to **every** live instance.
- **Dead letter queue** and **error queue** stored in Redis.
- **Typed channels** through generics, injected with a decorator.
- **Self-healing** subscriber connection.
- **Redis Cluster** support through the `cluster` option (experimental).

## Requirements

- Node.js **>= 24.15**
- NestJS **12**
- Redis **>= 7.2**, standalone. Redis Cluster support is **experimental** (see [Redis Cluster](https://www.npmjs.com/package/redis-postino#redis-cluster)).
- ESM only. Node.js 24 can also `require()` it from CommonJS.

## Installation

```bash
npm i nestjs-redis-postino
```

## Quick start

### 1. Register the module once (it is global)

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PostinoModule } from 'nestjs-redis-postino';

@Module({
  imports: [
    ConfigModule.forRoot(),
    PostinoModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: 6379,
        },
        deadLetterQueue: { enable: true }, // required, no default
        errorQueue: { enable: true }, // required, no default
      }),
    }),
    OrdersModule,
  ],
})
export class AppModule {}
```

`PostinoModule.forRoot(options)` accepts the same options synchronously.

To connect to a **Redis Cluster** (**experimental**: not yet validated against a real cluster, see the [`redis-postino` notes](https://www.npmjs.com/package/redis-postino#redis-cluster)), pass `cluster` (the rest of the module is unchanged):

```ts
useFactory: (config: ConfigService) => ({
  connection: { password: config.get<string>('REDIS_PASSWORD') }, // applied to every node
  cluster: {
    rootNodes: config
      .getOrThrow<string>('REDIS_CLUSTER_NODES') // "redis-0:6379,redis-1:6379,redis-2:6379"
      .split(',')
      .map((node) => `redis://${node}`),
  },
  deadLetterQueue: { enable: true },
  errorQueue: { enable: true },
}),
```

### 2. Publish

Register every channel you publish on, then inject it with `@InjectPostinoChannel()`:

```ts
import { Injectable, Module } from '@nestjs/common';
import { InjectPostinoChannel, PostinoChannel, PostinoModule } from 'nestjs-redis-postino';

interface OrderCreated {
  id: number;
}

@Injectable()
export class OrdersService {
  constructor(@InjectPostinoChannel('orders') private readonly orders: PostinoChannel<OrderCreated>) {}

  async create() {
    const { success, error } = await this.orders.publish({ id: 42 });
    // broadcast to every live instance: this.orders.publish(payload, false, true)
  }
}

@Module({
  imports: [PostinoModule.registerChannel('orders')],
  providers: [OrdersService],
})
export class OrdersModule {}
```

`publish(message, retry = false, broadcast = false)` **never throws**. It returns `{ success: boolean; error?: string }`.
`retry` is only stored in the dead letter queue entry, so a job can decide what to resend. Nothing is retried automatically.

### 3. Subscribe

```ts
import { Injectable } from '@nestjs/common';
import { PostinoSubscribe, PostinoSubscriberHost } from 'nestjs-redis-postino';

@Injectable()
@PostinoSubscriberHost()
export class OrdersSubscriber {
  @PostinoSubscribe('orders')
  async onOrderCreated(order: OrderCreated) {
    // ...
  }
}
```

- `@PostinoSubscriberHost()` marks the provider; `@PostinoSubscribe(channel)` marks the handler methods.
- One handler per channel per application: if two methods subscribe to the same channel, only the first one found is used.
- Handlers can be `async`; they are awaited.
- Handlers are wrapped in a try/catch. A failure is logged and stored in the error queue. Don't catch errors yourself if you want them in the error queue.
- Application bootstrap waits for the subscriptions. If Redis is unreachable, the handlers are subscribed as soon as the connection heals.

## Options

| Option                                    | Default                                                              | Description                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `connection.host` / `port`                | `localhost` / `6379`                                                 | Redis server                                                                                                   |
| `connection.username` / `password` / `db` | –                                                                    | ACL credentials and database                                                                                   |
| `connection.tls`                          | –                                                                    | `true` or Node.js TLS options                                                                                  |
| `connection.connectTimeout`               | `5000`                                                               | ms                                                                                                             |
| `connection.keepAlive`                    | `5000`                                                               | TCP keep-alive initial delay in ms, `0` disables it                                                            |
| `connection.commandTimeout`               | `3000`                                                               | ms a command may wait to be sent (e.g. while reconnecting), `0` disables it                                    |
| `connection.reconnect`                    | `{ maxAttempts: 10, delayMs: 1000 }`                                 | linear backoff; after the last attempt the subscriber self-heals (5 s, doubling up to 60 s)                    |
| `clientOptions`                           | –                                                                    | raw node-redis client options, merged last                                                                     |
| `cluster.rootNodes`                       | –                                                                    | enables Redis Cluster mode (experimental); seed nodes as `{ host, port }` or URLs (`host`/`port`/`db` ignored) |
| `cluster.useReplicas`                     | `false`                                                              | distribute read-only commands across replicas                                                                  |
| `cluster.maxCommandRedirections`          | `16`                                                                 | `MOVED` / `ASK` redirections followed per command                                                              |
| `cluster.nodeAddressMap`                  | –                                                                    | announced node address → reachable address (NAT, Docker, Kubernetes)                                           |
| `cluster.healthCheckIntervalMs`           | `10000`                                                              | subscriber watchdog for the pub/sub connection, `0` disables it                                                |
| `cluster.clusterOptions`                  | –                                                                    | raw node-redis cluster options, merged last                                                                    |
| `dispatchAndClose`                        | `false`                                                              | open a dedicated connection per publish and close it afterwards                                                |
| `deadLetterQueue`                         | `enable` **required**; `name: 'postino-dlq'`, `ttlInSeconds: 604800` | undelivered unicast messages                                                                                   |
| `errorQueue`                              | `enable` **required**; `name: 'postino-eq'`, `ttlInSeconds: 604800`  | messages whose handler threw                                                                                   |

The queue formats and a reader example are in the [`redis-postino` README](https://www.npmjs.com/package/redis-postino#queues), the cluster details (including the [things to know](https://www.npmjs.com/package/redis-postino#things-to-know) before enabling it) in its [Redis Cluster](https://www.npmjs.com/package/redis-postino#redis-cluster) section.

## License

MIT
