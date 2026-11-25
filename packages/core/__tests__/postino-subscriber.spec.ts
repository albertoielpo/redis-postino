import { createClient } from 'redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostinoSubscriber, resolveOptions } from '../src/index.js';
import { PostinoQueueFactory } from '../src/factories/postino-queue.factory.js';
import { clientsOf, createMockLogger, fakeCreateClient, flush, resetFakeClients } from './helpers/fake-redis.js';

vi.mock('redis', () => ({ createClient: vi.fn() }));

const message = (data: unknown, id = 'msg-1') => JSON.stringify({ id, data });

describe('PostinoSubscriber', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let queue: { addToQueue: ReturnType<typeof vi.fn>; onApplicationShutdown: ReturnType<typeof vi.fn> };
  let subscriber: PostinoSubscriber;

  const instanceChannel = (channel: string) => `${channel}:${(subscriber as any).INSTANCE_ID}`;
  const current = () => clientsOf('subscriber').at(-1)!;

  beforeEach(() => {
    resetFakeClients();
    vi.mocked(createClient).mockImplementation(fakeCreateClient as any);
    logger = createMockLogger();
    queue = { addToQueue: vi.fn().mockResolvedValue(undefined), onApplicationShutdown: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(PostinoQueueFactory, 'getInstance').mockReturnValue(queue as any);
  });

  afterEach(async () => {
    await subscriber?.onApplicationShutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('connects at construction with a client named after the instance', async () => {
    subscriber = new PostinoSubscriber(resolveOptions(), logger);
    await flush();

    expect(clientsOf('subscriber')).toHaveLength(1);
    expect(current().connect).toHaveBeenCalled();
    expect(current().options.name).toBe(`postino:subscriber:${(subscriber as any).INSTANCE_ID}`);
  });

  it('subscribes to the instance channel and runs the handler with the message data', async () => {
    subscriber = new PostinoSubscriber(resolveOptions(), logger);
    const handler = vi.fn();

    await expect(subscriber.subscribe('orders', handler)).resolves.toBe(true);
    await current().deliver(instanceChannel('orders'), message({ n: 1 }));

    expect(subscriber.isSubscribed('orders')).toBe(true);
    expect(current().subscribe).toHaveBeenCalledWith(instanceChannel('orders'), expect.any(Function));
    expect(handler).toHaveBeenCalledWith({ n: 1 });
  });

  it('awaits async handlers', async () => {
    subscriber = new PostinoSubscriber(resolveOptions(), logger);
    let done = false;
    await subscriber.subscribe('orders', async () => {
      await flush();
      done = true;
    });

    await current().deliver(instanceChannel('orders'), message({}));

    expect(done).toBe(true);
  });

  it('rejects channel names containing ":" without registering them', async () => {
    subscriber = new PostinoSubscriber(resolveOptions(), logger);

    await expect(subscriber.subscribe('bad:name', vi.fn())).resolves.toBe(false);
    expect(subscriber.isSubscribed('bad:name')).toBe(false);
  });

  // regression(H2) + B5: error queue payload { subscribeChannel, message, error } with real error details
  it('regression(H2): sends failed executions to the error queue', async () => {
    subscriber = new PostinoSubscriber(resolveOptions(), logger);
    await subscriber.subscribe('orders', () => {
      throw new Error('handler failed');
    });
    const raw = message({ n: 1 });

    await current().deliver(instanceChannel('orders'), raw);

    expect(queue.addToQueue).toHaveBeenCalledWith(resolveOptions().errorQueue, expect.any(String), {
      subscribeChannel: instanceChannel('orders'),
      message: raw,
      error: { name: 'Error', message: 'handler failed', stack: expect.any(String) },
    });
  });

  it('sends unparsable messages to the error queue', async () => {
    subscriber = new PostinoSubscriber(resolveOptions(), logger);
    await subscriber.subscribe('orders', vi.fn());

    await current().deliver(instanceChannel('orders'), 'not-json');

    expect(queue.addToQueue).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({ message: 'not-json' }));
  });

  // B4: node-redis re-subscribes by itself; subscribing again must never duplicate executions
  it('B4: executes a message exactly once, even if the channel is subscribed twice', async () => {
    subscriber = new PostinoSubscriber(resolveOptions(), logger);
    const handler = vi.fn();
    await subscriber.subscribe('orders', handler);
    await subscriber.subscribe('orders', handler);
    current().emit('ready'); // a reconnection must not trigger a manual re-subscribe

    await current().deliver(instanceChannel('orders'), message({}));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  // B6: the handler is kept even when Redis is down, and subscribed once the connection heals
  it('B6: keeps the handler when the initial connection fails and subscribes it after healing', async () => {
    vi.useFakeTimers();
    vi.mocked(createClient).mockImplementationOnce((opts: any) => {
      const client = fakeCreateClient(opts);
      client.connect.mockRejectedValue(new Error('ECONNREFUSED'));
      return client as any;
    });
    subscriber = new PostinoSubscriber(resolveOptions(), logger);
    const handler = vi.fn();

    await expect(subscriber.subscribe('orders', handler)).resolves.toBe(false);
    expect(subscriber.isSubscribed('orders')).toBe(true);

    await vi.advanceTimersByTimeAsync(PostinoSubscriber.HEALING_DELAY_MS);

    expect(clientsOf('subscriber')).toHaveLength(2);
    await current().deliver(instanceChannel('orders'), message({ ok: true }));
    expect(handler).toHaveBeenCalledWith({ ok: true });
  });

  // regression(H5d): self-healing after the client is terminated
  it('regression(H5d): replaces a terminated client after the healing delay and re-subscribes every channel', async () => {
    vi.useFakeTimers();
    subscriber = new PostinoSubscriber(resolveOptions(), logger);
    const orders = vi.fn();
    const users = vi.fn();
    await subscriber.subscribe('orders', orders);
    await subscriber.subscribe('users', users);
    const dead = current();

    dead.terminate();
    await vi.advanceTimersByTimeAsync(PostinoSubscriber.HEALING_DELAY_MS - 1);
    expect(clientsOf('subscriber')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    const healed = current();
    expect(healed).not.toBe(dead);
    expect(dead.destroy).toHaveBeenCalled();

    await healed.deliver(instanceChannel('orders'), message(1));
    await healed.deliver(instanceChannel('users'), message(2));
    expect(orders).toHaveBeenCalledTimes(1);
    expect(users).toHaveBeenCalledTimes(1);
  });

  it('backs off when healing keeps failing', async () => {
    vi.useFakeTimers();
    subscriber = new PostinoSubscriber(resolveOptions(), logger);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(createClient).mockImplementation((opts: any) => {
      const client = fakeCreateClient(opts);
      client.connect.mockRejectedValue(new Error('down'));
      return client as any;
    });

    current().terminate();
    await vi.advanceTimersByTimeAsync(PostinoSubscriber.HEALING_DELAY_MS); // attempt 1 fails
    expect(clientsOf('subscriber')).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(PostinoSubscriber.HEALING_DELAY_MS * 2 - 1);
    expect(clientsOf('subscriber')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); // attempt 2 after 10s
    expect(clientsOf('subscriber')).toHaveLength(3);
  });

  // B2: shutdown unsubscribes the instance channels; B3: no healing after an intentional shutdown
  it('B2/B3: shutdown unsubscribes the instance channels, closes, and never heals afterwards', async () => {
    vi.useFakeTimers();
    subscriber = new PostinoSubscriber(resolveOptions(), logger);
    await subscriber.subscribe('orders', vi.fn());
    const client = current();

    await subscriber.onApplicationShutdown();
    client.terminate();
    await vi.advanceTimersByTimeAsync(PostinoSubscriber.HEALING_MAX_DELAY_MS * 2);

    expect(client.unsubscribe).toHaveBeenCalledWith([instanceChannel('orders')]);
    expect(client.close).toHaveBeenCalled();
    expect(queue.onApplicationShutdown).toHaveBeenCalled();
    expect(clientsOf('subscriber')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('B1: logs the subscription once, without undefined', async () => {
    subscriber = new PostinoSubscriber(resolveOptions(), logger);
    await subscriber.subscribe('orders', vi.fn());

    expect(logger.log).toHaveBeenCalledWith('Subscribed to channel orders');
    expect(logger.log).not.toHaveBeenCalledWith(undefined);
  });
});
