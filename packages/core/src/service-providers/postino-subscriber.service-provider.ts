import { randomUUID } from 'node:crypto';
import { PostinoQueueFactory } from '../factories/postino-queue.factory.js';
import type { PostinoLogger } from '../types/logger.type.js';
import type { PostinoOptions, PostinoQueueOption } from '../types/options.type.js';
import type { PostinoRedisClient } from '../types/redis-client.type.js';
import { extractChannelName, getSubscribeChannel } from '../utils/channel.utils.js';
import { createRedisClient, safeQuit } from '../utils/connection.utils.js';
import type { PostinoQueue } from './postino-queue.service-provider.js';

export type PostinoMessageHandler<T> = (message: T) => void | Promise<void>;

function serializeError(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }

  return { message: String(err) };
}

export class PostinoSubscriber<T = object> {
  public static readonly HEALING_DELAY_MS = 5000;
  public static readonly HEALING_MAX_DELAY_MS = 60000;

  private redis: PostinoRedisClient;
  /** Resolves to `true` once connected, `false` if the connection attempt failed (healing is then scheduled). Never rejects. */
  private ready: Promise<boolean>;

  private readonly INSTANCE_ID: string = randomUUID();
  private readonly subscriberExecution = new Map<string, PostinoMessageHandler<T>>();
  private readonly queueService: PostinoQueue;
  private readonly errorQueueOption: PostinoQueueOption;
  private readonly options: PostinoOptions;
  private readonly logger: PostinoLogger;

  private shuttingDown = false;
  private healingTimer?: NodeJS.Timeout;
  private healingAttempts = 0;

  constructor(options: PostinoOptions, logger: PostinoLogger) {
    this.logger = logger;
    this.options = options;
    this.queueService = PostinoQueueFactory.getInstance(options, this.logger);
    this.errorQueueOption = options.errorQueue;
    const { client, ready } = this.initConnection();
    this.redis = client;
    this.ready = ready;
  }

  /**
   * Subscribe a handler to a channel. Never throws.
   * The handler is registered even if Redis is unreachable: the subscription is applied as soon as the connection heals.
   * @returns `true` if the Redis subscription is active
   */
  public async subscribe(channel: string, execute: PostinoMessageHandler<T>): Promise<boolean> {
    try {
      this.logger.log(`Subscribing to channel ${channel}`);
      const subscribeChannel = getSubscribeChannel(channel, this.INSTANCE_ID, this.logger);
      this.subscriberExecution.set(channel, execute);

      if (!(await this.ready)) {
        this.logger.warn(`Redis subscriber not connected. Channel ${channel} will be subscribed when the connection heals.`);
        return false;
      }

      await this.redis.subscribe(subscribeChannel, this.onMessage);
      this.logger.log(`Subscribed to channel ${channel}`);
      return true;
    } catch (err) {
      this.logger.error(`An error occurred while subscribing on channel ${channel}:${this.INSTANCE_ID}: ${err}`);
      return false;
    }
  }

  public isSubscribed(channel: string) {
    return this.subscriberExecution.has(channel);
  }

  public async onApplicationShutdown() {
    this.shuttingDown = true;
    clearTimeout(this.healingTimer);

    try {
      this.logger.log(`Application shutdown. Unsubscribe and close subscriber Redis connection...`);
      if (this.subscriberExecution.size && this.redis.isReady) {
        const instanceChannels = [...this.subscriberExecution.keys()].map((channel) => getSubscribeChannel(channel, this.INSTANCE_ID, this.logger));
        try {
          await this.redis.unsubscribe(instanceChannels);
          this.logger.log(`Channels unsubscribed`);
        } catch (err) {
          this.logger.error(`An error occurred while unsubscribing on application shutdown: ${err}`);
        }
      }

      await safeQuit(this.redis, this.logger);
      await this.queueService?.onApplicationShutdown();
    } catch (err) {
      this.logger.error(`Error on shutting down subscriber: ${err}`);
    }
  }

  /**
   * Single listener shared by every channel. node-redis stores listeners in a Set,
   * so subscribing the same channel twice never registers a duplicate listener.
   */
  private readonly onMessage = async (message: string, subscribeChannel: string) => {
    try {
      this.logger.debug(`Channel ${subscribeChannel}, message ${message}`);
      const payload = message ? JSON.parse(message) : {};
      const messageId = payload?.id;
      const channelName = extractChannelName(subscribeChannel, this.logger);
      const executor = this.subscriberExecution.get(channelName);

      if (typeof executor === 'function') {
        // await only if promise
        await executor(payload?.data);
      } else {
        this.logger.error(`MessageId: ${messageId} | Executor is not a function ${executor}`);
      }
    } catch (e) {
      this.logger.error(`An error occurred on channel ${subscribeChannel} on the execution of message: ${message}: ${e}`);
      const errorId = randomUUID();
      await this.queueService.addToQueue(this.errorQueueOption, errorId, {
        subscribeChannel,
        message: message ?? null,
        error: serializeError(e),
      });
    }
  };

  private initConnection(): { client: PostinoRedisClient; ready: Promise<boolean> } {
    const { host, port } = this.options.connection;
    this.logger.log(`Connecting subscriber instance to Redis on ${host}:${port}...`);
    const client = createRedisClient(this.options, 'subscriber', this.logger, this.INSTANCE_ID);

    // Transient disconnections are handled by node-redis, which also re-subscribes the registered listeners.
    // 'terminated' means the reconnect strategy is exhausted: the client is dead and must be replaced.
    client.on('terminated', () => {
      if (this.shuttingDown) {
        return;
      }

      this.logger.error(`Redis subscriber connection permanently closed. Scheduling self-healing...`);
      this.scheduleHealing();
    });

    const ready = client
      .connect()
      .then(() => {
        this.healingAttempts = 0;
        return true;
      })
      .catch((err) => {
        this.logger.error(`Redis subscriber connection failed: ${err}`);
        this.scheduleHealing();
        return false;
      });

    return { client, ready };
  }

  private scheduleHealing() {
    if (this.shuttingDown || this.healingTimer) {
      return;
    }

    const delay = Math.min(PostinoSubscriber.HEALING_DELAY_MS * 2 ** this.healingAttempts, PostinoSubscriber.HEALING_MAX_DELAY_MS);
    this.healingAttempts += 1;
    this.logger.log(`Redis subscriber self-healing in ${delay}ms (attempt ${this.healingAttempts})`);
    this.healingTimer = setTimeout(() => {
      this.healingTimer = undefined;
      this.heal().catch((err) => {
        this.logger.error(`Redis subscriber self-healing failed: ${err}`);
        this.scheduleHealing();
      });
    }, delay);
    this.healingTimer.unref();
  }

  private async heal() {
    if (this.shuttingDown) {
      return;
    }

    this.redis.destroy();
    const { client, ready } = this.initConnection();
    this.redis = client;
    this.ready = ready;

    if (!(await ready) || this.shuttingDown) {
      return;
    }

    this.logger.log(`Redis subscriber healed. Subscribing ${this.subscriberExecution.size} saved executions...`);
    for (const channel of this.subscriberExecution.keys()) {
      const subscribeChannel = getSubscribeChannel(channel, this.INSTANCE_ID, this.logger);
      this.redis
        .subscribe(subscribeChannel, this.onMessage)
        .then(() => {
          this.logger.log(`Subscribed to channel ${channel}`);
        })
        .catch((err) => {
          this.logger.error(`An error occurred while subscribing on channel ${channel}:${this.INSTANCE_ID}: ${err}`);
        });
    }
  }
}
