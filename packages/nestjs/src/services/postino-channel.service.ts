import { type PostinoPublishOptions, type PostinoPublishResult, toPublishOptions } from 'redis-postino';
import type { PostinoPublisherService } from './postino-publisher.service.js';

export class PostinoChannel<T> {
  constructor(
    private readonly publisher: PostinoPublisherService,
    private readonly channel: string,
  ) {}

  /**
   * Publish a message on the channel. Never throws.
   * @param options
   * - `retryable`: flags the message as safe to re-publish if it ends up in the dead letter queue. It only works if
   *   1. the dead letter queue is enabled (`deadLetterQueue.enable: true`; the error queue does not carry this flag), and
   *   2. a retry job reads the DLQ: none ships with Postino yet, for now it has to be implemented separately.
   *   Nothing is retried automatically. See {@link PostinoPublishOptions.retryable}.
   * - `broadcast`: deliver to every live subscriber instance instead of one random instance.
   */
  public async publish(message: T, options?: PostinoPublishOptions): Promise<PostinoPublishResult>;
  /** @deprecated use `publish(message, { retryable, broadcast })` */
  public async publish(message: T, retry?: boolean, broadcast?: boolean): Promise<PostinoPublishResult>;
  public async publish(message: T, optionsOrRetry?: PostinoPublishOptions | boolean, broadcast?: boolean): Promise<PostinoPublishResult> {
    return this.publisher.publish<T>({ payload: message, channel: this.channel }, toPublishOptions(optionsOrRetry, broadcast));
  }
}
