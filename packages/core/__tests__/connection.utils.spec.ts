import { createClient } from 'redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveOptions } from '../src/index.js';
import { createRedisClient, isConnectionUsable, LazyRedisConnection, safeQuit } from '../src/utils/connection.utils.js';
import { createdClients, createMockLogger, fakeCreateClient, FakeRedisClient, resetFakeClients } from './helpers/fake-redis.js';
import { QUEUES, withQueues } from './helpers/options.js';

vi.mock('redis', () => ({ createClient: vi.fn() }));

const options = resolveOptions(QUEUES);

describe('connection.utils', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    resetFakeClients();
    vi.mocked(createClient).mockImplementation(fakeCreateClient as any);
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createRedisClient', () => {
    it('creates a named client without connecting it', () => {
      const client = createRedisClient(options, 'publisher', logger, 'abc') as unknown as FakeRedisClient;

      expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ name: 'postino:publisher:abc' }));
      expect(client.connect).not.toHaveBeenCalled();
    });

    it('always attaches an error listener, so an error event never crashes the process', () => {
      const client = createRedisClient(options, 'subscriber', logger) as unknown as FakeRedisClient;

      expect(client.listenerCount('error')).toBe(1);
      expect(() => client.emit('error', new Error('boom'))).not.toThrow();
      expect(logger.error).toHaveBeenCalledWith('Redis subscriber error: Error: boom');
    });

    it('logs the lifecycle events', () => {
      const client = createRedisClient(options, 'queueManager', logger) as unknown as FakeRedisClient;

      ['connect', 'ready', 'reconnecting', 'terminated', 'end'].forEach((event) => client.emit(event));

      expect(logger.log).toHaveBeenCalledWith('Redis queueManager connected');
      expect(logger.log).toHaveBeenCalledWith('Redis queueManager connection ready');
      expect(logger.log).toHaveBeenCalledWith('Redis queueManager connection closed');
      expect(logger.error).toHaveBeenCalledWith('Redis queueManager reconnecting...');
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Redis queueManager connection permanently closed'));
    });
  });

  describe('isConnectionUsable', () => {
    it('is false for missing or closed clients and true for open ones', () => {
      const client = new FakeRedisClient();

      expect(isConnectionUsable(undefined)).toBe(false);
      expect(isConnectionUsable(null)).toBe(false);
      expect(isConnectionUsable(client as any)).toBe(false);

      client.isOpen = true; // open but reconnecting
      expect(isConnectionUsable(client as any)).toBe(true);
    });
  });

  // regression(H5b): graceful close with timeout, then forced destroy
  describe('regression(H5b): safeQuit', () => {
    it('does nothing without an instance', async () => {
      await safeQuit(undefined, logger);
      expect(logger.debug).toHaveBeenCalledWith('No instance found. Nothing to do.');
    });

    it('does nothing when the instance is already closed', async () => {
      const client = new FakeRedisClient();
      await safeQuit(client as any, logger);

      expect(client.close).not.toHaveBeenCalled();
      expect(client.destroy).not.toHaveBeenCalled();
    });

    it('closes a ready instance gracefully', async () => {
      const client = new FakeRedisClient();
      await client.connect();

      await safeQuit(client as any, logger);

      expect(client.close).toHaveBeenCalledTimes(1);
      expect(client.destroy).not.toHaveBeenCalled();
    });

    it('destroys a ready instance when close() times out', async () => {
      vi.useFakeTimers();
      const client = new FakeRedisClient();
      await client.connect();
      client.close.mockImplementation(() => new Promise(() => undefined));

      const quit = safeQuit(client as any, logger);
      await vi.advanceTimersByTimeAsync(2000);
      await quit;

      expect(client.destroy).toHaveBeenCalledTimes(1);
      expect(logger.log).toHaveBeenCalledWith('Close method responded TIMEOUT. Closing with .destroy() method.');
    });

    it('destroys a ready instance when close() fails', async () => {
      const client = new FakeRedisClient();
      await client.connect();
      client.close.mockRejectedValue(new Error('fail'));

      await safeQuit(client as any, logger);

      expect(client.destroy).toHaveBeenCalledTimes(1);
    });

    it('destroys an open instance that is not ready', async () => {
      const client = new FakeRedisClient();
      client.isOpen = true;

      await safeQuit(client as any, logger);

      expect(client.close).not.toHaveBeenCalled();
      expect(client.destroy).toHaveBeenCalledTimes(1);
    });

    it('never throws', async () => {
      const client = new FakeRedisClient();
      client.isOpen = true;
      client.destroy.mockImplementation(() => {
        throw new Error('boom');
      });

      await expect(safeQuit(client as any, logger)).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('LazyRedisConnection', () => {
    it('creates the client lazily and reuses it while usable', async () => {
      const connection = new LazyRedisConnection(options, 'publisher', logger);
      expect(createdClients).toHaveLength(0);

      const first = await connection.get();
      const second = await connection.get();

      expect(first).toBe(second);
      expect(createdClients).toHaveLength(1);
    });

    it('shares one in-flight connection between concurrent callers', async () => {
      const connection = new LazyRedisConnection(options, 'publisher', logger);

      const [a, b, c] = await Promise.all([connection.get(), connection.get(), connection.get()]);

      expect(createdClients).toHaveLength(1);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    // regression(H5a): reconnect only when the connection is no longer usable
    it('regression(H5a): replaces a client that is no longer usable', async () => {
      const connection = new LazyRedisConnection(options, 'publisher', logger);
      const first = (await connection.get()) as unknown as FakeRedisClient;
      first.terminate();

      const second = await connection.get();

      expect(second).not.toBe(first);
      expect(createdClients).toHaveLength(2);
    });

    it('destroys the client and rethrows when connect fails, then retries on the next call', async () => {
      vi.mocked(createClient).mockImplementationOnce((opts: any) => {
        const client = fakeCreateClient(opts);
        client.connect.mockRejectedValue(new Error('ECONNREFUSED'));
        return client as any;
      });
      const connection = new LazyRedisConnection(options, 'publisher', logger);

      await expect(connection.get()).rejects.toThrow('ECONNREFUSED');
      expect(createdClients[0].destroy).toHaveBeenCalled();

      const retried = await connection.get();
      expect(createdClients).toHaveLength(2);
      expect(retried).toBe(createdClients[1]);
    });

    it('closes the current client', async () => {
      const connection = new LazyRedisConnection(options, 'publisher', logger);
      const client = (await connection.get()) as unknown as FakeRedisClient;

      await connection.close();

      expect(client.close).toHaveBeenCalled();
    });
  });
});
