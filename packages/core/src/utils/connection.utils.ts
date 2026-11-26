import { randomUUID } from 'node:crypto';
import { createClient, createCluster, type RedisClientOptions, type RedisClusterOptions } from 'redis';
import type { PostinoLogger } from '../types/logger.type.js';
import type { PostinoOptions } from '../types/options.type.js';
import type { PostinoClientRole, PostinoRedisClient, PostinoRedisCluster, PostinoRedisConnection } from '../types/redis-client.type.js';
import { isClusterMode, toRedisClientOptions, toRedisClusterOptions } from './options.utils.js';
import { runWithTimeout } from './timeout.utils.js';

const QUIT_TIMEOUT_MS = 2000;

/**
 * Creates (without connecting) a node-redis client with logging listeners.
 * An `error` listener is always attached: an unhandled `error` event would crash the process.
 */
export function createRedisClient(
  options: PostinoOptions,
  type: PostinoClientRole,
  logger: PostinoLogger,
  instanceId: string = randomUUID(),
): PostinoRedisClient {
  const client = createClient(toRedisClientOptions(options, `postino:${type}:${instanceId}`) as RedisClientOptions) as PostinoRedisClient;

  client.on('error', (err: unknown) => {
    logger.error(`Redis ${type} error: ${err}`);
  });

  client.on('connect', () => {
    logger.log(`Redis ${type} connected`);
  });

  client.on('ready', () => {
    logger.log(`Redis ${type} connection ready`);
  });

  client.on('reconnecting', () => {
    logger.error(`Redis ${type} reconnecting...`);
  });

  client.on('terminated', (cause: unknown) => {
    logger.error(`Redis ${type} connection permanently closed (reconnect strategy exhausted): ${cause}`);
  });

  client.on('end', () => {
    logger.log(`Redis ${type} connection closed`);
  });

  return client;
}

/** Address of a cluster node, for logs. */
function nodeAddress(info: unknown) {
  const { host, port } = (info ?? {}) as { host?: string; port?: number };
  return host ? `${host}:${port}` : 'unknown node';
}

/**
 * Creates (without connecting) a node-redis cluster client with logging listeners.
 * An `error` listener is always attached: an unhandled `error` event would crash the process.
 * Node level events are logged too (`node-error` is not forwarded to `error` by node-redis).
 */
export function createRedisCluster(
  options: PostinoOptions,
  type: PostinoClientRole,
  logger: PostinoLogger,
  instanceId: string = randomUUID(),
): PostinoRedisCluster {
  const cluster = createCluster(toRedisClusterOptions(options, `postino:${type}:${instanceId}`) as RedisClusterOptions) as PostinoRedisCluster;

  cluster.on('error', (err: unknown) => {
    logger.error(`Redis cluster ${type} error: ${err}`);
  });

  cluster.on('connect', () => {
    logger.log(`Redis cluster ${type} connected (topology discovered)`);
  });

  cluster.on('disconnect', () => {
    logger.log(`Redis cluster ${type} connection closed`);
  });

  cluster.on('node-error', (err: unknown, info: unknown) => {
    logger.error(`Redis cluster ${type} node ${nodeAddress(info)} error: ${err}`);
  });

  cluster.on('node-ready', (info: unknown) => {
    logger.verbose(`Redis cluster ${type} node ${nodeAddress(info)} ready`);
  });

  cluster.on('node-reconnecting', (info: unknown) => {
    logger.error(`Redis cluster ${type} node ${nodeAddress(info)} reconnecting...`);
  });

  cluster.on('node-disconnect', (info: unknown) => {
    logger.verbose(`Redis cluster ${type} node ${nodeAddress(info)} disconnected`);
  });

  return cluster;
}

/** Creates (without connecting) a standalone client or a cluster client, depending on `options.cluster`. */
export function createRedisConnection(
  options: PostinoOptions,
  type: PostinoClientRole,
  logger: PostinoLogger,
  instanceId: string = randomUUID(),
): PostinoRedisConnection {
  return isClusterMode(options) ? createRedisCluster(options, type, logger, instanceId) : createRedisClient(options, type, logger, instanceId);
}

/** A client is usable while it is open: ready, connecting or reconnecting. */
export function isConnectionUsable(client?: PostinoRedisConnection | null): client is PostinoRedisConnection {
  return !!client && client.isOpen;
}

/**
 * Graceful close with a timeout, falling back to a forced destroy.
 * Never throws.
 */
export async function safeQuit(client: PostinoRedisConnection | null | undefined, logger: PostinoLogger) {
  try {
    if (!client) {
      logger.debug(`No instance found. Nothing to do.`);
      return;
    }

    if (!client.isOpen) {
      logger.debug(`Instance is already closed. Nothing to do.`);
      return;
    }

    if (client.isReady) {
      logger.debug(`Instance is ready. Try calling .close() method...`);
      const res = await runWithTimeout(() => client.close(), QUIT_TIMEOUT_MS);
      if (res !== 'TIMEOUT' && res !== 'ERROR') {
        logger.log(`Instance closed successfully with .close() method.`);
        return;
      }

      logger.log(`Close method responded ${res}. Closing with .destroy() method.`);
      client.destroy();
      return;
    }

    logger.log(`Instance not ready. Closing with .destroy() method.`);
    client.destroy();
  } catch (err) {
    logger.error(`An error occurred while closing the Redis instance: ${err}`);
  }
}

/**
 * Lazily creates and connects a single client, reusing it while it is usable.
 * Concurrent callers share the same in-flight connection attempt.
 */
export class LazyRedisConnection {
  private client: PostinoRedisConnection | null = null;
  private connecting: Promise<PostinoRedisConnection> | null = null;

  constructor(
    private readonly options: PostinoOptions,
    private readonly type: PostinoClientRole,
    private readonly logger: PostinoLogger,
  ) {}

  public async get(): Promise<PostinoRedisConnection> {
    if (this.connecting) {
      return this.connecting;
    }

    if (isConnectionUsable(this.client)) {
      return this.client;
    }

    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  public async close() {
    if (this.connecting) {
      await this.connecting.catch(() => undefined);
    }

    const { client } = this;
    this.client = null;
    await safeQuit(client, this.logger);
  }

  private async connect() {
    await safeQuit(this.client, this.logger);
    const client = createRedisConnection(this.options, this.type, this.logger);
    this.client = client;

    try {
      await client.connect();
      return client;
    } catch (err) {
      this.client = null;
      client.destroy();
      throw err;
    }
  }
}
