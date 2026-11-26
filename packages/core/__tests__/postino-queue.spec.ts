import { createClient } from 'redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveOptions } from '../src/index.js';
import { PostinoQueue } from '../src/service-providers/postino-queue.service-provider.js';
import { createdClients, createMockLogger, fakeCreateClient, resetFakeClients } from './helpers/fake-redis.js';
import { QUEUES, withQueues } from './helpers/options.js';

vi.mock('redis', () => ({ createClient: vi.fn() }));

const queueOption = { enable: true, name: 'dlq', ttlInSeconds: 100 };

describe('PostinoQueue', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let queue: PostinoQueue;

  beforeEach(() => {
    resetFakeClients();
    vi.mocked(createClient).mockImplementation(fakeCreateClient as any);
    logger = createMockLogger();
    queue = new PostinoQueue(resolveOptions(QUEUES), logger);
  });

  afterEach(async () => {
    await queue.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('does not connect when the queue is disabled', async () => {
    await queue.addToQueue({ ...queueOption, enable: false }, 'id', {});

    expect(createdClients).toHaveLength(0);
  });

  // regression(H5c): entries are namespaced as `${name}:${messageId}`
  it('regression(H5c): writes the entry and the list reference in a MULTI', async () => {
    await queue.addToQueue(queueOption, 'msg-1', { channel: 'c', message: { a: 1 }, retry: false });

    expect(createdClients).toHaveLength(1);
    expect(createdClients[0].multiCalls).toEqual([
      ['setEx', 'dlq:msg-1', 100, JSON.stringify({ channel: 'c', message: { a: 1 }, retry: false })],
      ['rPush', 'dlq', 'dlq:msg-1'],
      ['expire', 'dlq', 100],
    ]);
  });

  it('reuses the connection between calls', async () => {
    await queue.addToQueue(queueOption, '1', {});
    await queue.addToQueue(queueOption, '2', {});

    expect(createdClients).toHaveLength(1);
  });

  it('never throws, errors are logged', async () => {
    vi.mocked(createClient).mockImplementationOnce((opts: any) => {
      const client = fakeCreateClient(opts);
      client.connect.mockRejectedValue(new Error('down'));
      return client as any;
    });

    await expect(queue.addToQueue(queueOption, 'x', {})).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('An error occurred while adding message x on queue dlq: Error: down'));
  });

  // regression(H1): the idle timer must have an explicit delay (it used to fire immediately)
  it('regression(H1): closes the idle connection only after MAX_CONNECTION_TIME', async () => {
    vi.useFakeTimers();
    await queue.addToQueue(queueOption, '1', {});
    const client = createdClients[0];

    await vi.advanceTimersByTimeAsync(PostinoQueue.MAX_CONNECTION_TIME - 1);
    expect(client.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  // regression(H5c): after the idle close a new connection is created
  it('regression(H5c): reconnects after the idle close', async () => {
    vi.useFakeTimers();
    await queue.addToQueue(queueOption, '1', {});
    await vi.advanceTimersByTimeAsync(PostinoQueue.MAX_CONNECTION_TIME);

    await queue.addToQueue(queueOption, '2', {});

    expect(createdClients).toHaveLength(2);
  });

  // regression(H4): shutdown clears the idle timer
  it('regression(H4): shutdown clears the idle timer and closes the connection', async () => {
    vi.useFakeTimers();
    await queue.addToQueue(queueOption, '1', {});
    const client = createdClients[0];

    await queue.onApplicationShutdown();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
