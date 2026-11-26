import { randomUUID } from 'node:crypto';
import { PostinoQueueFactory } from '../factories/postino-queue.factory.js';
import type { PostinoLogger } from '../types/logger.type.js';
import type { PostinoOptions, PostinoQueueOption } from '../types/options.type.js';
import type { PostinoRedisConnection } from '../types/redis-client.type.js';
import { extractChannelName, getSubscribeChannel } from '../utils/channel.utils.js';
import { isRedisCluster, refreshClusterTopology } from '../utils/cluster.utils.js';
import { createRedisConnection, safeQuit } from '../utils/connection.utils.js';
import { describeTarget, isClusterMode } from '../utils/options.utils.js';
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

  private redis: PostinoRedisConnection;
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
  /** `true` while a healing run is in progress (cluster watchdog must not start another one). */
  private healing = false;
  /** `true` once the current connection attempt succeeded. */
  private connected = false;
  private watchdogTimer?: NodeJS.Timeout;

  constructor(options: PostinoOptions, logger: PostinoLogger) {
    this.logger = logger;
    this.options = options;
    this.queueService = PostinoQueueFactory.getInstance(options, this.logger);
    this.errorQueueOption = options.errorQueue;
    const { client, ready } = this.initConnection();
    this.redis = client;
    this.ready = ready;
    this.startClusterWatchdog();
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

      await this.redisSubscribe(subscribeChannel);
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
    clearInterval(this.watchdogTimer);

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

  /**
   * node-redis exposes the same `subscribe` on both the standalone and the cluster client,
   * but TypeScript cannot call it through the union.
   */
  private async redisSubscribe(subscribeChannels: string | string[]) {
    if (isRedisCluster(this.redis)) {
      return this.redis.subscribe(subscribeChannels, this.onMessage);
    }

    return this.redis.subscribe(subscribeChannels, this.onMessage);
  }

  private initConnection(): { client: PostinoRedisConnection; ready: Promise<boolean> } {
    this.logger.log(`Connecting subscriber instance to Redis on ${describeTarget(this.options)}...`);
    const client = createRedisConnection(this.options, 'subscriber', this.logger, this.INSTANCE_ID);
    this.connected = false;

    // Transient disconnections are handled by node-redis, which also re-subscribes the registered listeners
    // (in cluster mode it also moves the subscriptions when the pub/sub node leaves the topology).
    // 'terminated' (standalone only) means the reconnect strategy is exhausted: the client is dead and must be replaced.
    // The cluster client never emits it: the cluster watchdog covers that case.
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
        this.connected = true;
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

    this.healing = true;
    try {
      this.redis.destroy();
      const { client, ready } = this.initConnection();
      this.redis = client;
      this.ready = ready;

      if (!(await ready) || this.shuttingDown) {
        return;
      }
    } finally {
      this.healing = false;
    }

    this.logger.log(`Redis subscriber healed. Subscribing ${this.subscriberExecution.size} saved executions...`);
    this.resubscribeAll();
  }

  private resubscribeAll() {
    for (const channel of this.subscriberExecution.keys()) {
      const subscribeChannel = getSubscribeChannel(channel, this.INSTANCE_ID, this.logger);
      this.redisSubscribe(subscribeChannel)
        .then(() => {
          this.logger.log(`Subscribed to channel ${channel}`);
        })
        .catch((err) => {
          this.logger.error(`An error occurred while subscribing on channel ${channel}:${this.INSTANCE_ID}: ${err}`);
        });
    }
  }

  private startClusterWatchdog() {
    const interval = this.options.cluster?.healthCheckIntervalMs ?? 0;
    if (!isClusterMode(this.options) || interval <= 0) {
      return;
    }

    this.watchdogTimer = setInterval(() => this.checkClusterHealth(), interval);
    // never keep the process alive because of the watchdog
    this.watchdogTimer.unref();
  }

  /**
   * Cluster mode only. node-redis does not emit `terminated` for a cluster: when the reconnect strategy of the
   * pub/sub node connection is exhausted the subscriptions are silently lost. Detects it and heals:
   * - cluster client closed, or pub/sub connection dead: recreate the cluster client and re-subscribe;
   * - pub/sub connection missing (e.g. its connection attempt failed): re-subscribe, node-redis opens a new one.
   */
  private checkClusterHealth() {
    if (this.shuttingDown || this.healing || this.healingTimer || !this.connected || !this.subscriberExecution.size) {
      return;
    }

    const cluster = this.redis;
    if (!isRedisCluster(cluster)) {
      return;
    }

    if (!cluster.isOpen) {
      this.logger.error(`Redis cluster subscriber is closed. Scheduling self-healing...`);
      this.scheduleHealing();
      return;
    }

    const { pubSubNode } = cluster;
    if (!pubSubNode) {
      this.logger.warn(
        `Redis cluster subscriber has no pub/sub connection. Refreshing the topology and re-subscribing ${this.subscriberExecution.size} channels...`,
      );
      // the pub/sub node is picked from the topology: refresh it first, or a dead node may be picked again
      this.healing = true;
      refreshClusterTopology(cluster, this.logger)
        .then(() => {
          if (!this.shuttingDown && this.redis === cluster) {
            this.resubscribeAll();
          }
        })
        .finally(() => {
          this.healing = false;
        });
      return;
    }

    if (!pubSubNode.connectPromise && !pubSubNode.client.isOpen) {
      this.logger.error(`Redis cluster pub/sub connection to ${pubSubNode.address} is permanently closed. Scheduling self-healing...`);
      this.scheduleHealing();
    }
  }
}
