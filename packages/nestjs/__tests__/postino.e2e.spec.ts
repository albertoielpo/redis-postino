import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createClient } from 'redis';
import { PostinoPublisherFactory, PostinoSubscriberFactory } from 'redis-postino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InjectPostinoChannel, PostinoChannel, PostinoModule, PostinoSubscribe, PostinoSubscriberHost } from '../src/index.js';
import { clientsOf, fakeCreateClient, resetFakeClients } from './helpers/fake-redis.js';

vi.mock('redis', () => ({ createClient: vi.fn() }));

interface Order {
  id: number;
}

const received: Order[] = [];

@Injectable()
@PostinoSubscriberHost()
class OrderSubscriber {
  @PostinoSubscribe('orders')
  public async onOrder(order: Order) {
    received.push(order);
  }
}

@Injectable()
class OrderPublisher {
  constructor(@InjectPostinoChannel('orders') private readonly channel: PostinoChannel<Order>) {}

  public send(order: Order) {
    return this.channel.publish(order);
  }
}

@Module({
  imports: [PostinoModule.registerChannel('orders')],
  providers: [OrderPublisher, OrderSubscriber],
})
class OrdersModule {}

describe('PostinoModule (e2e, fake Redis)', () => {
  beforeEach(() => {
    resetFakeClients();
    received.length = 0;
    PostinoPublisherFactory.reset();
    PostinoSubscriberFactory.reset();

    // route PUBLISH from the publisher client to the subscriber client, like a real Redis would
    vi.mocked(createClient).mockImplementation((opts: any) => {
      const client = fakeCreateClient(opts);
      client.pubSubChannels.mockImplementation(async (pattern?: string) => {
        const prefix = pattern?.replace('*', '') ?? '';
        return clientsOf('subscriber').flatMap((subscriber) => [...subscriber.subscriptions.keys()].filter((channel) => channel.startsWith(prefix)));
      });
      client.publish.mockImplementation(async (channel: string, message: string) => {
        const targets = clientsOf('subscriber').filter((subscriber) => subscriber.subscriptions.has(channel));
        await Promise.all(targets.map((subscriber) => subscriber.deliver(channel, message)));
        return targets.length;
      });
      return client as any;
    });
  });

  afterEach(() => {
    PostinoPublisherFactory.reset();
    PostinoSubscriberFactory.reset();
  });

  it('delivers a message published through an injected channel to a @PostinoSubscribe handler', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PostinoModule.forRootAsync({
          useFactory: async () => ({ connection: { host: 'redis.test' } }),
        }),
        OrdersModule,
      ],
    }).compile();
    const app = await moduleRef.init();

    const result = await app.get(OrderPublisher).send({ id: 42 });

    expect(result).toEqual({ success: true });
    expect(received).toEqual([{ id: 42 }]);
    expect(clientsOf('subscriber')[0].options.socket.host).toBe('redis.test');

    await app.close();
    expect(clientsOf('subscriber')[0].close).toHaveBeenCalled();
    expect(clientsOf('publisher')[0].close).toHaveBeenCalled();
  });

  it('returns a failure when nobody is subscribed', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PostinoModule.forRoot({ errorQueue: { enable: false } }), PostinoModule.registerChannel('orders')],
      providers: [OrderPublisher],
    }).compile();
    const app = await moduleRef.init();

    const result = await app.get(OrderPublisher).send({ id: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No active subscribers for channel: orders/);
    await app.close();
  });
});
