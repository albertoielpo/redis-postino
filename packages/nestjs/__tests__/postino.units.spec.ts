import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { InjectPostinoChannel } from '../src/decorators/postino-inject-channel.decorator.js';
import { POSTINO_SUBSCRIBE_KEY, PostinoSubscribe } from '../src/decorators/postino-subscribe.decorator.js';
import { POSTINO_SUBSCRIBER_HOST_KEY, PostinoSubscriberHost } from '../src/decorators/postino-subscriber-host.decorator.js';
import { PostinoExplorer } from '../src/postino.explorer.js';
import { PostinoModule } from '../src/postino.module.js';
import { PostinoPublisherFactory, PostinoSubscriberFactory, type PostinoOptionsInput } from 'redis-postino';
import { getAsyncConfigProviders, getChannelProvider, getConfigProviders, getPublisherProvider, getSubscriberProvider } from '../src/postino.provider.js';
import { PostinoChannel } from '../src/services/postino-channel.service.js';
import { PostinoPublisherService } from '../src/services/postino-publisher.service.js';
import { PostinoSubscriberService } from '../src/services/postino-subscriber.service.js';
import { POSTINO_MODULE_OPTIONS } from '../src/types/provider.types.js';
import { getChannelToken } from '../src/utils/token.utils.js';

describe('token utils', () => {
  it('builds the channel token', () => {
    expect(getChannelToken('orders')).toBe('POSTINO_CHANNEL:orders');
  });
});

describe('decorators', () => {
  it('store the subscribe and host metadata', () => {
    @PostinoSubscriberHost()
    class Host {
      @PostinoSubscribe('orders')
      public handle() {
        return this;
      }
    }

    expect(Reflect.getMetadata(POSTINO_SUBSCRIBER_HOST_KEY, Host)).toBe(true);
    expect(Reflect.getMetadata(POSTINO_SUBSCRIBE_KEY, Host.prototype.handle)).toBe('orders');
  });

  it('InjectPostinoChannel injects the channel token', () => {
    class Consumer {
      constructor(@InjectPostinoChannel('orders') public readonly channel: unknown) {}
    }

    expect(Reflect.getMetadata('self:paramtypes', Consumer)).toEqual([{ index: 0, param: 'POSTINO_CHANNEL:orders' }]);
  });
});

describe('PostinoChannel', () => {
  it('publishes on its channel forwarding retry and broadcast', async () => {
    const publisher = { publish: vi.fn().mockResolvedValue({ success: true }) };
    const channel = new PostinoChannel<{ n: number }>(publisher as any, 'orders');

    await expect(channel.publish({ n: 1 })).resolves.toEqual({ success: true });
    await channel.publish({ n: 2 }, true, true);

    expect(publisher.publish).toHaveBeenNthCalledWith(1, { channel: 'orders', payload: { n: 1 } }, false, false);
    expect(publisher.publish).toHaveBeenNthCalledWith(2, { channel: 'orders', payload: { n: 2 } }, true, true);
  });
});

describe('services', () => {
  it('PostinoPublisherService delegates to the core publisher', async () => {
    const core = { publish: vi.fn().mockResolvedValue({ success: true }), onApplicationShutdown: vi.fn() };
    const service = new PostinoPublisherService(core as any);

    await service.publish({ channel: 'c', payload: 1 }, true, false);
    await service.onApplicationShutdown();

    expect(core.publish).toHaveBeenCalledWith({ channel: 'c', payload: 1 }, true, false);
    expect(core.onApplicationShutdown).toHaveBeenCalled();
  });

  it('PostinoSubscriberService delegates to the core subscriber', async () => {
    const core = { subscribe: vi.fn().mockResolvedValue(true), isSubscribed: vi.fn().mockReturnValue(true), onApplicationShutdown: vi.fn() };
    const service = new PostinoSubscriberService(core as any);
    const handler = vi.fn();

    await expect(service.subscribe('c', handler)).resolves.toBe(true);
    expect(service.isSubscribed('c')).toBe(true);
    await service.onApplicationShutdown();

    expect(core.subscribe).toHaveBeenCalledWith('c', handler);
    expect(core.onApplicationShutdown).toHaveBeenCalled();
  });
});

describe('providers', () => {
  it('getConfigProviders provides the options value', () => {
    const options: PostinoOptionsInput = { dispatchAndClose: true, deadLetterQueue: { enable: true }, errorQueue: { enable: true } };
    expect(getConfigProviders(options)).toEqual({ provide: POSTINO_MODULE_OPTIONS, useValue: options });
  });

  it('getAsyncConfigProviders provides the options factory', () => {
    const useFactory = (): PostinoOptionsInput => ({ deadLetterQueue: { enable: true }, errorQueue: { enable: true } });
    expect(getAsyncConfigProviders({ useFactory, inject: ['X'] })).toEqual({ provide: POSTINO_MODULE_OPTIONS, useFactory, inject: ['X'] });
  });

  it('cluster options reach the core publisher and subscriber factories unchanged', () => {
    const options: PostinoOptionsInput = {
      connection: { password: 'secret' },
      deadLetterQueue: { enable: true },
      errorQueue: { enable: true },
      cluster: { rootNodes: [{ host: 'n1', port: 7000 }, 'redis://n2:7001'], useReplicas: true },
    };
    const publisher = vi.spyOn(PostinoPublisherFactory, 'getInstance').mockReturnValue({} as any);
    const subscriber = vi.spyOn(PostinoSubscriberFactory, 'getInstance').mockReturnValue({} as any);

    expect(getPublisherProvider().useFactory(options)).toBeInstanceOf(PostinoPublisherService);
    expect(getSubscriberProvider().useFactory(options)).toBeInstanceOf(PostinoSubscriberService);
    expect(publisher).toHaveBeenCalledWith(options, expect.anything());
    expect(subscriber).toHaveBeenCalledWith(options, expect.anything());
  });

  it('getChannelProvider builds a PostinoChannel bound to the channel', () => {
    const provider = getChannelProvider('orders');
    const channel = provider.useFactory({ publish: vi.fn() });

    expect(provider.provide).toBe('POSTINO_CHANNEL:orders');
    expect(provider.inject).toEqual([PostinoPublisherService]);
    expect(channel).toBeInstanceOf(PostinoChannel);
  });
});

describe('PostinoModule', () => {
  it('forRoot registers a global module exporting the publisher', () => {
    const module = PostinoModule.forRoot({ deadLetterQueue: { enable: true }, errorQueue: { enable: true } });

    expect(module.global).toBe(true);
    expect(module.providers).toContain(PostinoExplorer);
    expect(module.exports).toEqual([expect.objectContaining({ provide: PostinoPublisherService })]);
  });

  it('forRootAsync passes imports and extra providers through', () => {
    class ConfigModule {}
    const extra = { provide: 'EXTRA', useValue: 1 };
    const module = PostinoModule.forRootAsync({
      imports: [ConfigModule],
      providers: [extra],
      useFactory: () => ({ deadLetterQueue: { enable: true }, errorQueue: { enable: true } }),
    });

    expect(module.imports).toEqual([ConfigModule]);
    expect(module.providers).toContain(extra);
  });

  it('registerChannel provides and exports the channel', () => {
    const module = PostinoModule.registerChannel('orders');

    expect(module.providers).toEqual([expect.objectContaining({ provide: 'POSTINO_CHANNEL:orders' })]);
    expect(module.exports).toEqual(module.providers);
  });
});

describe('PostinoExplorer', () => {
  @Injectable()
  @PostinoSubscriberHost()
  class Host {
    @PostinoSubscribe('orders')
    public onOrder() {
      return this;
    }

    @PostinoSubscribe('users')
    public onUser() {
      return this;
    }

    public notAHandler() {
      return this;
    }
  }

  @Injectable()
  class NotAHost {
    @PostinoSubscribe('ignored')
    public onIgnored() {
      return this;
    }
  }

  const setup = async (subscribed: string[] = []) => {
    const subscriber = {
      subscribe: vi.fn().mockResolvedValue(true),
      isSubscribed: vi.fn((channel: string) => subscribed.includes(channel)),
    };
    const host = new Host();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PostinoExplorer,
        Reflector,
        MetadataScanner,
        { provide: PostinoSubscriberService, useValue: subscriber },
        {
          provide: DiscoveryService,
          useValue: { getProviders: () => [{ instance: host }, { instance: new NotAHost() }, { instance: 'value' }, { instance: undefined }] },
        },
      ],
    }).compile();

    return { explorer: moduleRef.get(PostinoExplorer), subscriber, host };
  };

  it('subscribes only the decorated methods of subscriber hosts, bound to the instance', async () => {
    const { explorer, subscriber, host } = await setup();

    await explorer.onApplicationBootstrap();

    expect(subscriber.subscribe.mock.calls.map(([channel]) => channel).sort()).toEqual(['orders', 'users']);
    const handler = subscriber.subscribe.mock.calls.find(([channel]) => channel === 'orders')![1];
    expect(handler()).toBe(host);
  });

  it('skips channels that are already subscribed', async () => {
    const { explorer, subscriber } = await setup(['orders']);

    await explorer.onApplicationBootstrap();

    expect(subscriber.subscribe.mock.calls.map(([channel]) => channel)).toEqual(['users']);
  });

  it('B11: bootstrap waits for the subscriptions', async () => {
    const { explorer, subscriber } = await setup();
    let resolved = false;
    subscriber.subscribe.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve(true);
          }, 10);
        }),
    );

    await explorer.onApplicationBootstrap();

    expect(resolved).toBe(true);
  });
});
