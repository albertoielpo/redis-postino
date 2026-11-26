/* eslint-disable no-await-in-loop */
import { randomUUID } from 'node:crypto';
import { PostinoQueueFactory } from '../factories/postino-queue.factory.js';
import type { PostinoLogger } from '../types/logger.type.js';
import type { PostinoOptions, PostinoQueueOption } from '../types/options.type.js';
import type { PostinoMessage, PostinoPublishDto, PostinoPublishOptions, PostinoPublishResult } from '../types/publisher.type.js';
import type { PostinoRedisConnection } from '../types/redis-client.type.js';
import { discoverSubscriberChannels, type PostinoSubscriberChannel } from '../utils/cluster.utils.js';
import { createRedisConnection, LazyRedisConnection, safeQuit } from '../utils/connection.utils.js';
import { describeTarget } from '../utils/options.utils.js';
import { toPublishOptions } from '../utils/publish.utils.js';
import type { PostinoQueue } from './postino-queue.service-provider.js';

export class PostinoPublisher {
  private readonly queueService: PostinoQueue;
  private readonly options: PostinoOptions;
  private readonly deadLetterQueueOptions: PostinoQueueOption;
  private readonly dispatchAndClose: boolean;
  private readonly logger: PostinoLogger;
  private readonly connection?: LazyRedisConnection;

  constructor(options: PostinoOptions, logger: PostinoLogger) {
    this.logger = logger;
    this.options = options;
    this.logger.log(`Connecting publisher instance to Redis on ${describeTarget(options)} and dispatchAndClose=${options.dispatchAndClose}...`);
    this.deadLetterQueueOptions = options.deadLetterQueue;
    this.dispatchAndClose = options.dispatchAndClose;
    this.queueService = PostinoQueueFactory.getInstance(options, this.logger);

    if (options.dispatchAndClose) {
      this.logger.log(`Redis publisher init completed with no connection.`);
      return;
    }

    this.connection = new LazyRedisConnection(options, 'publisher', this.logger);
    // eager connection (as before): publish() still awaits it if it is not ready yet
    this.connection.get().catch((err) => {
      this.logger.error(`Initial publisher connection failed: ${err}`);
    });
  }

  /**
   * Publish a message on a channel.
   * - unicast (default): the message is delivered to one random live subscriber instance.
   * - broadcast: the message is delivered to every live subscriber instance.
   *
   * Never throws. When a unicast message cannot be delivered it is added to the dead letter queue.
   * In cluster mode the subscribers are discovered on every node and each message is published through
   * the node its subscriber is connected to (see `discoverSubscriberChannels`).
   * @param options `retryable` (see {@link PostinoPublishOptions.retryable}: needs the DLQ enabled and a retry job
   * you implement separately) and `broadcast`
   */
  public async publish<T>(dto: PostinoPublishDto<T>, options?: PostinoPublishOptions): Promise<PostinoPublishResult>;
  /** @deprecated use `publish(dto, { retryable, broadcast })` */
  public async publish<T>(dto: PostinoPublishDto<T>, retry?: boolean, broadcast?: boolean): Promise<PostinoPublishResult>;
  public async publish<T>(
    dto: PostinoPublishDto<T>,
    optionsOrRetry?: PostinoPublishOptions | boolean,
    legacyBroadcast?: boolean,
  ): Promise<PostinoPublishResult> {
    const { retryable, broadcast } = toPublishOptions(optionsOrRetry, legacyBroadcast);
    const { payload, channel } = dto;
    const messageId = randomUUID();
    const messageToPublish: PostinoMessage<T> = {
      id: messageId,
      data: payload,
    };
    const serialized = JSON.stringify(messageToPublish);

    let redisInstance: PostinoRedisConnection | undefined;
    try {
      redisInstance = await this.getRedisInstance();
      const subscribers = await discoverSubscriberChannels(redisInstance, `${channel}:*`, this.logger);

      if (broadcast) {
        return await this.broadcast(messageId, channel, subscribers, serialized);
      }

      return await this.unicast(messageId, dto, subscribers, serialized, retryable);
    } catch (err) {
      this.logger.error(`MessageId: ${messageId} | Publish on channel ${channel} failed: ${err}`);
      if (!broadcast) {
        await this.addToDLQ(messageId, dto, retryable);
      }

      return {
        success: false,
        error: `MessageId: ${messageId} | Publish on channel ${channel} failed: ${err}`,
      };
    } finally {
      await this.disconnectIfNeeded(redisInstance);
    }
  }

  private async broadcast(messageId: string, channel: string, subscribers: PostinoSubscriberChannel[], serialized: string) {
    this.logger.debug(`Broadcast requested. Publishing message on ${channel}:* with ${subscribers.length} subscribers`);
    // PUBLISH does not support patterns: publish on every instance channel
    const settled = await Promise.allSettled(subscribers.map(({ channel: subscribedChannel, target }) => target.publish(subscribedChannel, serialized)));
    const results = settled.map((result) => (result.status === 'fulfilled' ? Number(result.value) : 0));

    if (results.every((status) => status === 0)) {
      this.logger.error(`MessageId: ${messageId} | Message broadcasting on ${channel} failed on every subscriber.`);
      return {
        success: false,
        error: `Message ${messageId} delivery failed on every subscriber`,
      };
    }

    const totalSuccess = results.filter((status) => status !== 0).length;
    if (totalSuccess !== subscribers.length) {
      this.logger.warn(`Message ${messageId} | Broadcasting successfull on ${totalSuccess}/${subscribers.length}.`);
      return { success: true };
    }

    this.logger.debug(`Message ${messageId} | Broadcasting successfull on every subscriber`);
    return { success: true };
  }

  private async unicast<T>(
    messageId: string,
    dto: PostinoPublishDto<T>,
    subscribers: PostinoSubscriberChannel[],
    serialized: string,
    retryable: boolean,
  ): Promise<PostinoPublishResult> {
    const { channel } = dto;
    this.logger.debug(`MessageId: ${messageId} | Adding message on channel ${channel} with ${subscribers.length} subscribers...`);
    if (!subscribers.length) {
      this.logger.error(`MessageId: ${messageId} | No active subscribers for channel: ${channel}`);
      await this.addToDLQ(messageId, dto, retryable);
      return {
        success: false,
        error: `MessageId: ${messageId} | No active subscribers for channel: ${channel}`,
      };
    }

    const candidates = [...subscribers];
    while (candidates.length > 0) {
      const randomIndex = Math.floor(Math.random() * candidates.length);
      const { channel: randomSubscriber, target } = candidates.splice(randomIndex, 1)[0];

      try {
        const status = Number(await target.publish(randomSubscriber, serialized));
        if (status === 0) {
          throw new Error(`MessageId: ${messageId} | Message delivery on ${channel} failed with status ${status}.`);
        }

        this.logger.debug(`MessageId: ${messageId} | Messaged successfully delivered to ${randomSubscriber}`);
        return { success: true }; // Stop after successful delivery
      } catch (err) {
        this.logger.error(`MessageId: ${messageId} | Delivery to subscriber ${randomSubscriber} failed: ${err}`);
      }
    }

    this.logger.error(`MessageId: ${messageId} | Message delivery failed on every subscriber. Adding message ${messageId} to dead letter queue...`);
    await this.addToDLQ(messageId, dto, retryable);

    return {
      success: false,
      error: `Message ${messageId} delivery failed on every subscriber`,
    };
  }

  private async addToDLQ<T>(messageId: string, message: PostinoPublishDto<T>, retryable: boolean) {
    return this.queueService.addToQueue(this.deadLetterQueueOptions, messageId, {
      channel: message.channel,
      message: message.payload,
      retry: retryable, // DLQ wire format keeps the `retry` field (regression H2)
    });
  }

  /**
   * dispatchAndClose: a dedicated connection per publish, so concurrent publishes never close each other's connection.
   * Otherwise: the shared connection, reconnected only when it is no longer usable.
   */
  private async getRedisInstance(): Promise<PostinoRedisConnection> {
    if (!this.connection) {
      const client = createRedisConnection(this.options, 'publisher', this.logger);
      try {
        await client.connect();
      } catch (err) {
        client.destroy();
        throw err;
      }
      return client;
    }

    return this.connection.get();
  }

  private async disconnectIfNeeded(instance?: PostinoRedisConnection) {
    if (!this.dispatchAndClose) {
      return;
    }

    await safeQuit(instance, this.logger);
  }

  public async onApplicationShutdown() {
    try {
      this.logger.log(`Application shutdown. Closing publisher Redis connection...`);
      await this.connection?.close();
      await this.queueService?.onApplicationShutdown();
    } catch (err) {
      this.logger.error(`Error on shutting down publisher: ${err}`);
    }
  }
}
