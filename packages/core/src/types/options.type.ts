import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import type { RedisClientOptions, RedisClusterOptions, RedisFunctions, RedisModules, RedisScripts } from 'redis';

/** Raw node-redis client options (RESP 2 or 3). */
export type PostinoRawClientOptions = Partial<RedisClientOptions<RedisModules, RedisFunctions, RedisScripts, 2 | 3>>;

/** Raw node-redis cluster options (RESP 2 or 3). */
export type PostinoRawClusterOptions = Partial<RedisClusterOptions<RedisModules, RedisFunctions, RedisScripts, 2 | 3>>;

/** A cluster seed node: `{ host, port }` or a Redis URL (`redis://host:port`, `rediss://host:port`). */
export type PostinoClusterNode = { host: string; port: number } | string;

export interface PostinoClusterOptions {
  /**
   * Seed nodes used to discover the cluster topology (at least 3 are recommended).
   * Credentials, TLS, timeouts and reconnect settings are taken from `connection` and applied to every node.
   */
  rootNodes: PostinoClusterNode[];
  /** Distribute read-only commands across replicas too. */
  useReplicas: boolean;
  /** Maximum number of `MOVED` / `ASK` redirections followed for a single command. */
  maxCommandRedirections: number;
  /**
   * Maps the addresses announced by the cluster to the addresses the client should connect to
   * (useful when the cluster runs behind NAT / in Docker / Kubernetes).
   */
  nodeAddressMap?: RedisClusterOptions['nodeAddressMap'];
  /**
   * Interval in milliseconds of the subscriber watchdog: when the pub/sub connection is found dead
   * the subscriber recreates the cluster client and re-subscribes every channel. `0` disables it.
   */
  healthCheckIntervalMs: number;
  /**
   * Escape hatch: raw node-redis cluster options, merged last (they win over everything else).
   * `defaults` is merged with the per-node options built from `connection` / `clientOptions`.
   */
  clusterOptions?: PostinoRawClusterOptions;
}

export type PostinoClusterOptionsInput = Pick<PostinoClusterOptions, 'rootNodes'> & Partial<Omit<PostinoClusterOptions, 'rootNodes'>>;

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
  /** Ignored in cluster mode (`cluster.rootNodes` is used instead). */
  host: string;
  /** Ignored in cluster mode (`cluster.rootNodes` is used instead). */
  port: number;
  username?: string;
  password?: string;
  /** Database number (`SELECT`). Ignored in cluster mode: Redis Cluster only supports database 0. */
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
  /**
   * Redis Cluster mode. When set, every connection is a node-redis cluster client
   * (`createCluster`) seeded with `cluster.rootNodes`; `connection.host` / `connection.port` are ignored.
   */
  cluster?: PostinoClusterOptions;
  /** When `true` the publisher opens a dedicated connection for every publish and closes it afterwards. */
  dispatchAndClose: boolean;
  deadLetterQueue: PostinoQueueOption;
  errorQueue: PostinoQueueOption;
}

/** Queue options accepted as input: `enable` is required, `name` and `ttlInSeconds` have defaults. */
export type PostinoQueueOptionInput = Partial<Omit<PostinoQueueOption, 'enable'>> & Pick<PostinoQueueOption, 'enable'>;

/** Defaults applied when the user omits an option. The queues' `enable` flag has no default. */
export type PostinoDefaultOptions = Omit<PostinoOptions, 'deadLetterQueue' | 'errorQueue'> & {
  deadLetterQueue: Omit<PostinoQueueOption, 'enable'>;
  errorQueue: Omit<PostinoQueueOption, 'enable'>;
};

/** Options accepted by the factories and by the NestJS module. Only `deadLetterQueue.enable` and `errorQueue.enable` are required. */
export interface PostinoOptionsInput {
  connection?: PostinoConnectionOptionsInput;
  clientOptions?: PostinoRawClientOptions;
  cluster?: PostinoClusterOptionsInput;
  dispatchAndClose?: boolean;
  /** Required: `enable` has no default and must be set explicitly. */
  deadLetterQueue: PostinoQueueOptionInput;
  /** Required: `enable` has no default and must be set explicitly. */
  errorQueue: PostinoQueueOptionInput;
}

export const DEFAULT_CLUSTER_OPTIONS: Omit<PostinoClusterOptions, 'rootNodes'> = {
  useReplicas: false,
  maxCommandRedirections: 16,
  healthCheckIntervalMs: 10000,
};

export const DEFAULT_OPTIONS: PostinoDefaultOptions = {
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
    name: 'postino-dlq',
    ttlInSeconds: 604800, // one week
  },
  errorQueue: {
    name: 'postino-eq',
    ttlInSeconds: 604800, // one week
  },
};
