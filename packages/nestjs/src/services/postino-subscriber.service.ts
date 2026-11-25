import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { PostinoMessageHandler, PostinoSubscriber } from 'redis-postino';

@Injectable()
export class PostinoSubscriberService<T = object> implements OnApplicationShutdown {
  private readonly logger = new Logger(PostinoSubscriberService.name, { timestamp: true });

  constructor(private readonly coreSubscriber: PostinoSubscriber<T>) {}

  public async subscribe(channel: string, execute: PostinoMessageHandler<T>) {
    return this.coreSubscriber.subscribe(channel, execute);
  }

  public isSubscribed(channel: string) {
    return this.coreSubscriber.isSubscribed(channel);
  }

  public async onApplicationShutdown() {
    this.logger.log(`Application shutdown. Closing subscriber Redis connection...`);
    await this.coreSubscriber.onApplicationShutdown();
  }
}
