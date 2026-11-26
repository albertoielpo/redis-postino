import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { type PostinoPublishDto, type PostinoPublisher, type PostinoPublishOptions, type PostinoPublishResult, toPublishOptions } from 'redis-postino';

@Injectable()
export class PostinoPublisherService implements OnApplicationShutdown {
  private readonly logger = new Logger(PostinoPublisherService.name, { timestamp: true });

  constructor(private readonly corePublisher: PostinoPublisher) {}

  /**
   * Publish a message. Never throws.
   * @param options `retryable` (see {@link PostinoPublishOptions.retryable}: needs the DLQ enabled and a retry job
   * you implement separately) and `broadcast`
   */
  public async publish<T>(dto: PostinoPublishDto<T>, options?: PostinoPublishOptions): Promise<PostinoPublishResult>;
  /** @deprecated use `publish(dto, { retryable, broadcast })` */
  public async publish<T>(dto: PostinoPublishDto<T>, retry?: boolean, broadcast?: boolean): Promise<PostinoPublishResult>;
  public async publish<T>(dto: PostinoPublishDto<T>, optionsOrRetry?: PostinoPublishOptions | boolean, broadcast?: boolean): Promise<PostinoPublishResult> {
    return this.corePublisher.publish(dto, toPublishOptions(optionsOrRetry, broadcast));
  }

  public async onApplicationShutdown() {
    this.logger.log(`Application shutdown. Closing publisher Redis connection...`);
    await this.corePublisher.onApplicationShutdown();
  }
}
