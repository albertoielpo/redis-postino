import { createClient } from 'redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostinoPublisher, PostinoPublisherFactory, PostinoSubscriber, PostinoSubscriberFactory } from '../src/index.js';
import { PostinoQueueFactory } from '../src/factories/postino-queue.factory.js';
import { createMockLogger, fakeCreateClient, resetFakeClients } from './helpers/fake-redis.js';

vi.mock('redis', () => ({ createClient: vi.fn() }));

describe('factories', () => {
  beforeEach(() => {
    resetFakeClients();
    vi.mocked(createClient).mockImplementation(fakeCreateClient as any);
    PostinoPublisherFactory.reset();
    PostinoSubscriberFactory.reset();
    PostinoQueueFactory.reset();
  });

  afterEach(async () => {
    await PostinoPublisherFactory.getInstance({}, createMockLogger()).onApplicationShutdown();
    await PostinoSubscriberFactory.getInstance({}, createMockLogger()).onApplicationShutdown();
  });

  it('PostinoPublisherFactory returns a singleton built with the resolved options', () => {
    const first = PostinoPublisherFactory.getInstance({ connection: { host: 'h' } }, createMockLogger());
    const second = PostinoPublisherFactory.getInstance({ connection: { host: 'other' } }, createMockLogger());

    expect(first).toBeInstanceOf(PostinoPublisher);
    expect(second).toBe(first);
    expect((first as any).options.connection.host).toBe('h');
  });

  it('PostinoSubscriberFactory returns a singleton', () => {
    const first = PostinoSubscriberFactory.getInstance({}, createMockLogger());

    expect(first).toBeInstanceOf(PostinoSubscriber);
    expect(PostinoSubscriberFactory.getInstance({}, createMockLogger())).toBe(first);
  });

  it('publisher and subscriber share the queue singleton', () => {
    const publisher = PostinoPublisherFactory.getInstance({}, createMockLogger());
    const subscriber = PostinoSubscriberFactory.getInstance({}, createMockLogger());

    expect((publisher as any).queueService).toBe((subscriber as any).queueService);
  });

  it('accepts loggers with info/trace instead of log/verbose', () => {
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() };

    PostinoPublisherFactory.getInstance({}, logger);

    expect(logger.info).toHaveBeenCalled();
  });
});
