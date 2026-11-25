import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { POSTINO_SUBSCRIBE_KEY } from './decorators/postino-subscribe.decorator.js';
import { POSTINO_SUBSCRIBER_HOST_KEY } from './decorators/postino-subscriber-host.decorator.js';
import { PostinoSubscriberService } from './services/postino-subscriber.service.js';

@Injectable()
export class PostinoExplorer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PostinoExplorer.name, { timestamp: true });

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly subscriberService: PostinoSubscriberService,
  ) {}

  public async onApplicationBootstrap() {
    const providers = this.discoveryService.getProviders();
    this.logger.log(`Exploring providers to find subscribe declarations...`);
    const subscriptions: Promise<boolean>[] = [];

    providers.forEach((provider) => {
      const { instance } = provider;
      const prototype = instance && Object.getPrototypeOf(instance);

      // filter out variables providers
      if (!instance || !prototype) {
        return;
      }

      // check if the provider is marked as a host
      const isSubscriberHost = this.reflector.get(POSTINO_SUBSCRIBER_HOST_KEY, instance.constructor);
      if (!isSubscriberHost) {
        return;
      }

      // retrieve all methods marked as listeners
      const methodKeys = this.metadataScanner.getAllMethodNames(prototype);
      methodKeys.forEach((methodKey) => {
        const channel = this.reflector.get(POSTINO_SUBSCRIBE_KEY, instance[methodKey]);
        if (!channel || this.subscriberService.isSubscribed(channel)) {
          return;
        }

        subscriptions.push(this.subscriberService.subscribe(channel, instance[methodKey].bind(instance)));
      });
    });

    // bootstrap completes only when the subscriptions are active (or registered for healing)
    await Promise.all(subscriptions);
  }
}
