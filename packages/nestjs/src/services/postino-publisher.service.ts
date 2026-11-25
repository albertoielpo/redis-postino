import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { PostinoPublishDto, PostinoPublisher, PostinoPublishResult } from 'redis-postino';

@Injectable()
export class PostinoPublisherService implements OnApplicationShutdown {
  private readonly logger = new Logger(PostinoPublisherService.name, { timestamp: true });

  constructor(private readonly corePublisher: PostinoPublisher) {}

  public async publish<T>(dto: PostinoPublishDto<T>, retry = false, broadcast = false): Promise<PostinoPublishResult> {
    return this.corePublisher.publish(dto, retry, broadcast);
  }

  public async onApplicationShutdown() {
    this.logger.log(`Application shutdown. Closing publisher Redis connection...`);
    await this.corePublisher.onApplicationShutdown();
  }
}
