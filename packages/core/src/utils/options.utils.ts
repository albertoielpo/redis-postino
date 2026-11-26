import type { RedisClientOptions } from 'redis';
import type {
  PostinoClusterNode,
  PostinoClusterOptions,
  PostinoConnectionOptions,
  PostinoOptions,
  PostinoOptionsInput,
  PostinoQueueOption,
  PostinoRawClientOptions,
  PostinoRawClusterOptions,
} from '../types/options.type.js';
import { DEFAULT_CLUSTER_OPTIONS, DEFAULT_OPTIONS } from '../types/options.type.js';

function resolveClusterOptions(input: PostinoOptionsInput['cluster']): PostinoClusterOptions | undefined {
  if (!input) {
    return undefined;
  }

  if (!Array.isArray(input.rootNodes) || input.rootNodes.length === 0) {
    throw new Error(`Invalid cluster options: at least one root node is required`);
  }

  return {
    ...DEFAULT_CLUSTER_OPTIONS,
    ...input,
    rootNodes: [...input.rootNodes],
  };
}

function resolveQueueOption(key: 'deadLetterQueue' | 'errorQueue', input: PostinoOptionsInput[typeof key] | undefined): PostinoQueueOption {
  if (typeof input?.enable !== 'boolean') {
    throw new Error(`Invalid ${key} options: 'enable' is required and must be a boolean`);
  }

  return {
    ...DEFAULT_OPTIONS[key],
    ...input,
  };
}

/**
 * Applies the defaults to the user options. Nested objects are merged, not replaced.
 * Throws if `deadLetterQueue.enable` or `errorQueue.enable` is not set.
 */
export function resolveOptions(input: PostinoOptionsInput): PostinoOptions {
  // validated first, so a missing input gets the explicit error instead of a TypeError
  const deadLetterQueue = resolveQueueOption('deadLetterQueue', input?.deadLetterQueue);
  const errorQueue = resolveQueueOption('errorQueue', input?.errorQueue);

  const connection: PostinoConnectionOptions = {
    ...DEFAULT_OPTIONS.connection,
    ...input.connection,
    reconnect: {
      ...DEFAULT_OPTIONS.connection.reconnect,
      ...input.connection?.reconnect,
    },
  };

  return {
    connection,
    clientOptions: input.clientOptions,
    ...(input.cluster ? { cluster: resolveClusterOptions(input.cluster) } : {}),
    deadLetterQueue,
    errorQueue,
    dispatchAndClose: typeof input.dispatchAndClose === 'boolean' ? input.dispatchAndClose : DEFAULT_OPTIONS.dispatchAndClose,
  };
}

/**
 * node-redis reconnect strategy: linear backoff (`attempt * delayMs`), gives up after `maxAttempts`.
 * `retries` is 0-based (node-redis), `attempt` is 1-based.
 */
export function buildReconnectStrategy({ maxAttempts, delayMs }: PostinoConnectionOptions['reconnect']) {
  return (retries: number): number | false => {
    const attempt = retries + 1;
    if (attempt > maxAttempts) {
      return false;
    }

    return attempt * delayMs;
  };
}

/** Maps the library options to node-redis client options. `clientOptions` is merged last. */
export function toRedisClientOptions(options: PostinoOptions, clientName?: string): PostinoRawClientOptions {
  const { connection, clientOptions } = options;
  const tls = connection.tls ? { tls: true as const, ...(typeof connection.tls === 'object' ? connection.tls : {}) } : {};

  const socket = {
    host: connection.host,
    port: connection.port,
    connectTimeout: connection.connectTimeout,
    keepAlive: connection.keepAlive > 0,
    ...(connection.keepAlive > 0 ? { keepAliveInitialDelay: connection.keepAlive } : {}),
    reconnectStrategy: buildReconnectStrategy(connection.reconnect),
    ...tls,
    ...clientOptions?.socket,
  } as RedisClientOptions['socket'];

  return {
    username: connection.username,
    password: connection.password,
    database: connection.db,
    name: clientName,
    ...(connection.commandTimeout > 0 ? { commandOptions: { timeout: connection.commandTimeout } } : {}),
    ...clientOptions,
    socket,
  };
}

/** `true` when the options select Redis Cluster mode. */
export function isClusterMode(options: PostinoOptions): options is PostinoOptions & { cluster: PostinoClusterOptions } {
  return !!options.cluster;
}

/** Human readable target, for logs. */
export function describeTarget(options: PostinoOptions) {
  if (isClusterMode(options)) {
    const nodes = options.cluster.rootNodes.map((node) => (typeof node === 'string' ? node : `${node.host}:${node.port}`));
    return `cluster [${nodes.join(', ')}]`;
  }

  return `${options.connection.host}:${options.connection.port}`;
}

function toRootNode(node: PostinoClusterNode) {
  return typeof node === 'string' ? { url: node } : { socket: { host: node.host, port: node.port } };
}

/** Options node-redis accepts only at cluster level (not inside `defaults`). */
const CLUSTER_LEVEL_KEYS = ['RESP', 'modules', 'functions', 'scripts', 'commandOptions'] as const;

/**
 * Maps the library options to node-redis cluster options.
 * - `connection` / `clientOptions` become the `defaults` applied to every node (root and discovered ones);
 *   `host`, `port`, `url` and `database` are dropped (nodes come from the topology, cluster only has db 0).
 * - `cluster.clusterOptions` is merged last.
 */
export function toRedisClusterOptions(options: PostinoOptions, clientName?: string): PostinoRawClusterOptions {
  if (!isClusterMode(options)) {
    throw new Error(`toRedisClusterOptions requires cluster options`);
  }

  const { cluster } = options;
  const nodeOptions: Record<string, any> = { ...toRedisClientOptions(options, clientName) };
  const clusterLevel: Record<string, any> = {};
  CLUSTER_LEVEL_KEYS.forEach((key) => {
    if (nodeOptions[key] !== undefined) {
      clusterLevel[key] = nodeOptions[key];
    }
    delete nodeOptions[key];
  });

  const { database, url, socket, ...defaults } = nodeOptions;
  const { host, port, path, ...socketDefaults } = (socket ?? {}) as Record<string, unknown>;
  const { defaults: rawDefaults, ...rawCluster } = cluster.clusterOptions ?? {};

  return {
    rootNodes: cluster.rootNodes.map(toRootNode),
    useReplicas: cluster.useReplicas,
    maxCommandRedirections: cluster.maxCommandRedirections,
    ...(cluster.nodeAddressMap ? { nodeAddressMap: cluster.nodeAddressMap } : {}),
    ...clusterLevel,
    ...rawCluster,
    defaults: {
      ...defaults,
      ...rawDefaults,
      socket: {
        ...socketDefaults,
        ...rawDefaults?.socket,
      },
    },
  };
}
