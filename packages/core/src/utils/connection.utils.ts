import { randomUUID } from 'node:crypto';
import { createClient, type RedisClientOptions } from 'redis';
import type { PostinoLogger } from '../types/logger.type.js';
import type { PostinoOptions } from '../types/options.type.js';
import type { PostinoClientRole, PostinoRedisClient } from '../types/redis-client.type.js';
import { toRedisClientOptions } from './options.utils.js';
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

/** A client is usable while it is open: ready, connecting or reconnecting. */
export function isConnectionUsable(client?: PostinoRedisClient | null): client is PostinoRedisClient {
  return !!client && client.isOpen;
}

/**
 * Graceful close with a timeout, falling back to a forced destroy.
 * Never throws.
 */
export async function safeQuit(client: PostinoRedisClient | null | undefined, logger: PostinoLogger) {
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
  private client: PostinoRedisClient | null = null;
  private connecting: Promise<PostinoRedisClient> | null = null;

  constructor(
    private readonly options: PostinoOptions,
    private readonly type: PostinoClientRole,
    private readonly logger: PostinoLogger,
  ) {}

  public async get(): Promise<PostinoRedisClient> {
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
    const client = createRedisClient(this.options, this.type, this.logger);
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
