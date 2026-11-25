import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { PostinoLogger } from '../../src/index.js';

type Listener = (message: string, channel: string) => unknown;

/** Minimal in-memory stand-in for a node-redis client. */
export class FakeRedisClient extends EventEmitter {
  public isOpen = false;
  public isReady = false;
  public readonly subscriptions = new Map<string, Set<Listener>>();
  public readonly multiCalls: unknown[][] = [];

  constructor(public readonly options: any = {}) {
    super();
  }

  public connect = vi.fn(async () => {
    this.isOpen = true;
    this.isReady = true;
    this.emit('ready');
    return this;
  });

  public close = vi.fn(async () => {
    this.isOpen = false;
    this.isReady = false;
    this.emit('end');
  });

  public destroy = vi.fn(() => {
    this.isOpen = false;
    this.isReady = false;
  });

  public subscribe = vi.fn(async (channel: string, listener: Listener) => {
    const set = this.subscriptions.get(channel) ?? new Set<Listener>();
    set.add(listener);
    this.subscriptions.set(channel, set);
  });

  public unsubscribe = vi.fn(async (channels?: string | string[]) => {
    [channels ?? []].flat().forEach((channel) => this.subscriptions.delete(channel));
  });

  public publish = vi.fn(async (_channel: string, _message: string) => 1);

  public pubSubChannels = vi.fn(async (_pattern?: string): Promise<string[]> => []);

  public multi = vi.fn(() => {
    const chain: Record<string, any> = {};
    ['setEx', 'rPush', 'expire'].forEach((method) => {
      chain[method] = vi.fn((...args: unknown[]) => {
        this.multiCalls.push([method, ...args]);
        return chain;
      });
    });
    chain.exec = vi.fn(async () => []);
    return chain;
  });

  /** Simulates a message received from Redis on `channel`. */
  public async deliver(channel: string, message: string) {
    await Promise.all([...(this.subscriptions.get(channel) ?? [])].map((listener) => listener(message, channel)));
  }

  /** Simulates node-redis giving up reconnecting. */
  public terminate() {
    this.isOpen = false;
    this.isReady = false;
    this.emit('terminated', new Error('reconnect strategy exhausted'));
  }

  public get role(): string | undefined {
    return this.options?.name?.split(':')[1];
  }
}

export const createdClients: FakeRedisClient[] = [];

export function clientsOf(role: 'subscriber' | 'publisher' | 'queueManager') {
  return createdClients.filter((client) => client.role === role);
}

export function fakeCreateClient(options: unknown) {
  const client = new FakeRedisClient(options);
  createdClients.push(client);
  return client;
}

export function resetFakeClients() {
  createdClients.length = 0;
}

export function createMockLogger(): PostinoLogger & Record<string, ReturnType<typeof vi.fn>> {
  return {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  };
}

/** Lets pending promise callbacks run. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));
