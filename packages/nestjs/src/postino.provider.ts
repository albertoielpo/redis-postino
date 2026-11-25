import { type FactoryProvider, Logger, type ValueProvider } from '@nestjs/common';
import { PostinoPublisherFactory, PostinoSubscriberFactory, type PostinoOptionsInput } from 'redis-postino';
import { PostinoChannel } from './services/postino-channel.service.js';
import { PostinoPublisherService } from './services/postino-publisher.service.js';
import { PostinoSubscriberService } from './services/postino-subscriber.service.js';
import type { PostinoModuleAsyncOptions } from './types/module-option.type.js';
import { POSTINO_MODULE_OPTIONS } from './types/provider.types.js';
import { getChannelToken } from './utils/token.utils.js';

export function getConfigProviders(options: PostinoOptionsInput): ValueProvider {
  return {
    provide: POSTINO_MODULE_OPTIONS,
    useValue: options,
  };
}

export function getAsyncConfigProviders(options: PostinoModuleAsyncOptions): FactoryProvider {
  return {
    useFactory: options.useFactory,
    provide: POSTINO_MODULE_OPTIONS,
    inject: options.inject,
  };
}

export function getChannelProvider(channelName: string): FactoryProvider {
  return {
    provide: getChannelToken(channelName),
    useFactory: (publisherService: PostinoPublisherService) => new PostinoChannel(publisherService, channelName),
    inject: [PostinoPublisherService],
  };
}

export function getSubscriberProvider(): FactoryProvider {
  return {
    provide: PostinoSubscriberService,
    useFactory: (configs: PostinoOptionsInput) => {
      const instance = PostinoSubscriberFactory.getInstance(configs, new Logger('PostinoSubscriber', { timestamp: true }));
      return new PostinoSubscriberService(instance);
    },
    inject: [POSTINO_MODULE_OPTIONS],
  };
}

export function getPublisherProvider(): FactoryProvider {
  return {
    provide: PostinoPublisherService,
    useFactory: (configs: PostinoOptionsInput) => {
      const instance = PostinoPublisherFactory.getInstance(configs, new Logger('PostinoPublisher', { timestamp: true }));
      return new PostinoPublisherService(instance);
    },
    inject: [POSTINO_MODULE_OPTIONS],
  };
}
