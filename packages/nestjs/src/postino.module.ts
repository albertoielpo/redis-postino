import { type DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import type { PostinoOptionsInput } from 'redis-postino';
import { PostinoExplorer } from './postino.explorer.js';
import { getAsyncConfigProviders, getChannelProvider, getConfigProviders, getPublisherProvider, getSubscriberProvider } from './postino.provider.js';
import type { PostinoModuleAsyncOptions } from './types/module-option.type.js';

@Module({
  imports: [DiscoveryModule],
})
export class PostinoModule {
  public static forRoot(options: PostinoOptionsInput): DynamicModule {
    return {
      global: true,
      module: PostinoModule,
      providers: [getConfigProviders(options), getSubscriberProvider(), getPublisherProvider(), PostinoExplorer],
      exports: [getPublisherProvider()],
    };
  }

  public static forRootAsync(options: PostinoModuleAsyncOptions): DynamicModule {
    return {
      global: true,
      module: PostinoModule,
      imports: options.imports,
      providers: [getAsyncConfigProviders(options), ...(options.providers ?? []), getSubscriberProvider(), getPublisherProvider(), PostinoExplorer],
      exports: [getPublisherProvider()],
    };
  }

  public static registerChannel(channelName: string): DynamicModule {
    const channelProvider = getChannelProvider(channelName);
    return {
      module: PostinoModule,
      providers: [channelProvider],
      exports: [channelProvider],
    };
  }
}
