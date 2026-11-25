import { createClient } from 'redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostinoPublisher, resolveOptions, type PostinoOptionsInput } from '../src/index.js';
import { PostinoQueueFactory } from '../src/factories/postino-queue.factory.js';
import { clientsOf, createMockLogger, fakeCreateClient, FakeRedisClient, flush, resetFakeClients } from './helpers/fake-redis.js';

vi.mock('redis', () => ({ createClient: vi.fn() }));

describe('PostinoPublisher', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let queue: { addToQueue: ReturnType<typeof vi.fn>; onApplicationShutdown: ReturnType<typeof vi.fn> };

  const createPublisher = async (input: PostinoOptionsInput = {}) => {
    const publisher = new PostinoPublisher(resolveOptions(input), logger);
    await flush();
    return publisher;
  };

  const publisherClient = () => clientsOf('publisher')[0];

  beforeEach(() => {
    resetFakeClients();
    vi.mocked(createClient).mockImplementation(fakeCreateClient as any);
    logger = createMockLogger();
    queue = { addToQueue: vi.fn().mockResolvedValue(undefined), onApplicationShutdown: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(PostinoQueueFactory, 'getInstance').mockReturnValue(queue as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connects eagerly when dispatchAndClose is false', async () => {
    await createPublisher();

    expect(clientsOf('publisher')).toHaveLength(1);
    expect(publisherClient().connect).toHaveBeenCalled();
  });

  it('does not connect at construction when dispatchAndClose is true', async () => {
    await createPublisher({ dispatchAndClose: true });

    expect(clientsOf('publisher')).toHaveLength(0);
  });

  describe('unicast', () => {
    it('lists the instance channels and publishes the wire format on one of them', async () => {
      const publisher = await createPublisher();
      const client = publisherClient();
      client.pubSubChannels.mockResolvedValue(['orders:a', 'orders:b']);

      const result = await publisher.publish({ channel: 'orders', payload: { n: 1 } });

      expect(result).toEqual({ success: true });
      expect(client.pubSubChannels).toHaveBeenCalledWith('orders:*');
      expect(client.publish).toHaveBeenCalledTimes(1);
      const [target, message] = client.publish.mock.calls[0];
      expect(['orders:a', 'orders:b']).toContain(target);
      expect(JSON.parse(message)).toEqual({ id: expect.any(String), data: { n: 1 } });
    });

    it('tries the next instance when a publish reaches no receiver', async () => {
      const publisher = await createPublisher();
      const client = publisherClient();
      client.pubSubChannels.mockResolvedValue(['orders:a', 'orders:b', 'orders:c']);
      client.publish.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(1);

      const result = await publisher.publish({ channel: 'orders', payload: {} });

      expect(result).toEqual({ success: true });
      expect(client.publish).toHaveBeenCalledTimes(3);
      expect(new Set(client.publish.mock.calls.map(([target]) => target)).size).toBe(3);
      expect(queue.addToQueue).not.toHaveBeenCalled();
    });

    // regression(H2): DLQ payload is { channel, message, retry }
    it('regression(H2): adds the message to the DLQ when every instance fails', async () => {
      const publisher = await createPublisher();
      const client = publisherClient();
      client.pubSubChannels.mockResolvedValue(['orders:a', 'orders:b']);
      client.publish.mockResolvedValue(0);

      const result = await publisher.publish({ channel: 'orders', payload: { n: 1 } }, true);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/delivery failed on every subscriber/);
      expect(queue.addToQueue).toHaveBeenCalledWith(resolveOptions().deadLetterQueue, expect.any(String), {
        channel: 'orders',
        message: { n: 1 },
        retry: true,
      });
    });

    it('adds the message to the DLQ when there are no subscribers', async () => {
      const publisher = await createPublisher();

      const result = await publisher.publish({ channel: 'orders', payload: 'p' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No active subscribers for channel: orders/);
      expect(queue.addToQueue).toHaveBeenCalledWith(expect.anything(), expect.any(String), { channel: 'orders', message: 'p', retry: false });
    });

    it('never throws: a Redis failure returns an error and adds the message to the DLQ', async () => {
      const publisher = await createPublisher();
      publisherClient().pubSubChannels.mockRejectedValue(new Error('TimeoutError'));

      const result = await publisher.publish({ channel: 'orders', payload: 'p' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Publish on channel orders failed: Error: TimeoutError/);
      expect(queue.addToQueue).toHaveBeenCalledTimes(1);
    });
  });

  // regression(H3): broadcast enumerates the instance channels (PUBLISH does not support patterns)
  describe('regression(H3): broadcast', () => {
    it('publishes on every instance channel, never on the pattern', async () => {
      const publisher = await createPublisher();
      const client = publisherClient();
      client.pubSubChannels.mockResolvedValue(['orders:a', 'orders:b']);

      const result = await publisher.publish({ channel: 'orders', payload: {} }, false, true);

      expect(result).toEqual({ success: true });
      expect(client.publish.mock.calls.map(([target]) => target).sort()).toEqual(['orders:a', 'orders:b']);
      expect(client.publish).not.toHaveBeenCalledWith('orders:*', expect.anything());
    });

    it('succeeds with a warning on partial delivery', async () => {
      const publisher = await createPublisher();
      const client = publisherClient();
      client.pubSubChannels.mockResolvedValue(['orders:a', 'orders:b']);
      client.publish.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('x'));

      const result = await publisher.publish({ channel: 'orders', payload: {} }, false, true);

      expect(result).toEqual({ success: true });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Broadcasting successfull on 1/2'));
    });

    it('fails without DLQ when no instance receives it (B7: also with 0 subscribers)', async () => {
      const publisher = await createPublisher();
      const client = publisherClient();
      client.pubSubChannels.mockResolvedValue(['orders:a']);
      client.publish.mockResolvedValue(0);

      expect((await publisher.publish({ channel: 'orders', payload: {} }, false, true)).success).toBe(false);

      client.pubSubChannels.mockResolvedValue([]);
      expect((await publisher.publish({ channel: 'orders', payload: {} }, false, true)).success).toBe(false);
      expect(queue.addToQueue).not.toHaveBeenCalled();
    });
  });

  // regression(H5): dispatchAndClose closes the connection on every return path
  describe('regression(H5): dispatchAndClose', () => {
    const scenarios: [string, (client: FakeRedisClient) => void, boolean][] = [
      ['unicast success', (c) => c.pubSubChannels.mockResolvedValue(['orders:a']), false],
      ['no subscribers', () => undefined, false],
      ['delivery failure', (c) => (c.pubSubChannels.mockResolvedValue(['orders:a']), c.publish.mockResolvedValue(0)), false],
      ['redis error', (c) => c.pubSubChannels.mockRejectedValue(new Error('x')), false],
      ['broadcast', (c) => c.pubSubChannels.mockResolvedValue(['orders:a']), true],
    ];

    it.each(scenarios)('closes the dedicated connection: %s', async (_, setup, broadcast) => {
      vi.mocked(createClient).mockImplementation((opts: any) => {
        const client = fakeCreateClient(opts);
        setup(client);
        return client as any;
      });
      const publisher = await createPublisher({ dispatchAndClose: true });

      await publisher.publish({ channel: 'orders', payload: {} }, false, broadcast);

      const client = publisherClient();
      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it('uses a dedicated connection per publish', async () => {
      const publisher = await createPublisher({ dispatchAndClose: true });

      await Promise.all([publisher.publish({ channel: 'a', payload: 1 }), publisher.publish({ channel: 'b', payload: 2 })]);

      expect(clientsOf('publisher')).toHaveLength(2);
      clientsOf('publisher').forEach((client) => expect(client.close).toHaveBeenCalledTimes(1));
    });

    it('returns an error (and DLQ) when the connection cannot be opened', async () => {
      vi.mocked(createClient).mockImplementation((opts: any) => {
        const client = fakeCreateClient(opts);
        client.connect.mockRejectedValue(new Error('ECONNREFUSED'));
        return client as any;
      });
      const publisher = await createPublisher({ dispatchAndClose: true });

      const result = await publisher.publish({ channel: 'orders', payload: {} });

      expect(result.success).toBe(false);
      expect(publisherClient().destroy).toHaveBeenCalled();
      expect(queue.addToQueue).toHaveBeenCalledTimes(1);
    });
  });

  // regression(H5a): reuse the connection, reconnect only when unusable
  it('regression(H5a): reuses the connection and reconnects only when it is no longer usable', async () => {
    const publisher = await createPublisher();
    await publisher.publish({ channel: 'orders', payload: {} });
    await publisher.publish({ channel: 'orders', payload: {} });
    expect(clientsOf('publisher')).toHaveLength(1);

    publisherClient().terminate();
    await publisher.publish({ channel: 'orders', payload: {} });

    expect(clientsOf('publisher')).toHaveLength(2);
  });

  it('closes the connection and the queue on shutdown', async () => {
    const publisher = await createPublisher();

    await publisher.onApplicationShutdown();

    expect(publisherClient().close).toHaveBeenCalled();
    expect(queue.onApplicationShutdown).toHaveBeenCalled();
  });
});
