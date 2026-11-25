import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import type { RedisClientOptions, RedisFunctions, RedisModules, RedisScripts } from 'redis';

/** Raw node-redis client options (RESP 2 or 3). */
export type PostinoRawClientOptions = Partial<RedisClientOptions<RedisModules, RedisFunctions, RedisScripts, 2 | 3>>;

export interface PostinoQueueOption {
  /** Enable the queue. */
  enable: boolean;
  /** Redis list name. Each entry is stored under the key `${name}:${messageId}`. */
  name: string;
  /** TTL applied to both the entry key and the list. */
  ttlInSeconds: number;
}

export interface PostinoReconnectOptions {
  /** Number of reconnection attempts before the client gives up (and the subscriber starts self-healing). */
  maxAttempts: number;
  /** Linear backoff step: attempt `n` waits `n * delayMs` milliseconds. */
  delayMs: number;
}

export interface PostinoConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Database number (`SELECT`). */
  db?: number;
  /** `true` to enable TLS with default settings, or Node.js TLS options. */
  tls?: boolean | TlsConnectionOptions;
  /** Connection timeout in milliseconds. */
  connectTimeout: number;
  /** TCP keep-alive initial delay in milliseconds. `0` disables keep-alive. */
  keepAlive: number;
  /**
   * Maximum time in milliseconds a command may wait to be sent (e.g. while the client is reconnecting).
   * Commands already sent to Redis are not cancelled, to avoid duplicated deliveries.
   * `0` disables the timeout.
   */
  commandTimeout: number;
  reconnect: PostinoReconnectOptions;
}

export type PostinoConnectionOptionsInput = Partial<Omit<PostinoConnectionOptions, 'reconnect'>> & {
  reconnect?: Partial<PostinoReconnectOptions>;
};

/** Fully resolved options (defaults applied). */
export interface PostinoOptions {
  connection: PostinoConnectionOptions;
  /**
   * Escape hatch: raw node-redis client options, merged last (they win over `connection`).
   * Use it for anything not covered by `connection` (e.g. `url`, `RESP`, `credentialsProvider`).
   */
  clientOptions?: PostinoRawClientOptions;
  /** When `true` the publisher opens a dedicated connection for every publish and closes it afterwards. */
  dispatchAndClose: boolean;
  deadLetterQueue: PostinoQueueOption;
  errorQueue: PostinoQueueOption;
}

/** Options accepted by the factories and by the NestJS module. Every field is optional. */
export interface PostinoOptionsInput {
  connection?: PostinoConnectionOptionsInput;
  clientOptions?: PostinoRawClientOptions;
  dispatchAndClose?: boolean;
  deadLetterQueue?: Partial<PostinoQueueOption>;
  errorQueue?: Partial<PostinoQueueOption>;
}

export const DEFAULT_OPTIONS: PostinoOptions = {
  connection: {
    host: 'localhost',
    port: 6379,
    connectTimeout: 5000,
    keepAlive: 5000,
    commandTimeout: 3000,
    reconnect: {
      maxAttempts: 10,
      delayMs: 1000,
    },
  },
  dispatchAndClose: false,
  deadLetterQueue: {
    enable: true,
    name: 'postino-dlq',
    ttlInSeconds: 604800, // one week
  },
  errorQueue: {
    enable: true,
    name: 'postino-eq',
    ttlInSeconds: 604800, // one week
  },
};
