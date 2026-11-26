import { createClient, createCluster } from 'redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLUSTER_OPTIONS, PostinoPublisher, PostinoSubscriber, resolveOptions, type PostinoOptionsInput } from '../src/index.js';
import { PostinoQueueFactory } from '../src/factories/postino-queue.factory.js';
import { PostinoQueue } from '../src/service-providers/postino-queue.service-provider.js';
import { discoverSubscriberChannels, getQueueEntryKey, hasHashTag, isRedisCluster } from '../src/utils/cluster.utils.js';
import { createRedisConnection } from '../src/utils/connection.utils.js';
import { describeTarget, isClusterMode, toRedisClusterOptions } from '../src/utils/options.utils.js';
import {
  createdClusters,
  createMockLogger,
  fakeCreateClient,
  fakeCreateCluster,
  FakeRedisClient,
  FakeRedisCluster,
  flush,
  resetFakeClients,
  resetFakeClusters,
} from './helpers/fake-redis.js';

vi.mock('redis', () => ({ createClient: vi.fn(), createCluster: vi.fn() }));

const CLUSTER: PostinoOptionsInput = {
  cluster: { rootNodes: [{ host: 'n1', port: 7000 }, 'redis://n2:7001'] },
};

const clustersOf = (role: 'subscriber' | 'publisher' | 'queueManager') => createdClusters.filter((cluster) => cluster.role === role);

describe('cluster options', () => {
  it('is not cluster mode by default', () => {
    const options = resolveOptions();

    expect(isClusterMode(options)).toBe(false);
    expect(options.cluster).toBeUndefined();
    expect(describeTarget(options)).toBe('localhost:6379');
  });

  it('applies the cluster defaults', () => {
    const options = resolveOptions(CLUSTER);

    expect(isClusterMode(options)).toBe(true);
    expect(options.cluster).toEqual({ ...DEFAULT_CLUSTER_OPTIONS, rootNodes: CLUSTER.cluster!.rootNodes });
    expect(describeTarget(options)).toBe('cluster [n1:7000, redis://n2:7001]');
  });

  it('rejects a cluster without root nodes', () => {
    expect(() => resolveOptions({ cluster: { rootNodes: [] } })).toThrow(/root node/);
  });

  it('maps connection options to the per-node defaults', () => {
    const options = toRedisClusterOptions(
      resolveOptions({
        ...CLUSTER,
        connection: { host: 'ignored', port: 1, db: 3, username: 'u', password: 'p', tls: true },
        clientOptions: { RESP: 3 },
      }),
      'postino:publisher:id',
    );

    expect(options.rootNodes).toEqual([{ socket: { host: 'n1', port: 7000 } }, { url: 'redis://n2:7001' }]);
    expect(options).toMatchObject({
      useReplicas: false,
      maxCommandRedirections: 16,
      RESP: 3,
      commandOptions: { timeout: 3000 },
      defaults: {
        username: 'u',
        password: 'p',
        name: 'postino:publisher:id',
        socket: { tls: true, connectTimeout: 5000, keepAlive: true },
      },
    });
    expect(typeof (options.defaults!.socket as any).reconnectStrategy).toBe('function');
    // node addresses come from the topology, cluster only has db 0
    expect(options.defaults).not.toHaveProperty('database');
    expect(options.defaults).not.toHaveProperty('RESP');
    expect(options.defaults).not.toHaveProperty('commandOptions');
    expect(options.defaults!.socket).not.toHaveProperty('host');
    expect(options.defaults!.socket).not.toHaveProperty('port');
  });

  it('merges the raw cluster options last', () => {
    const nodeAddressMap = { '10.0.0.1:7000': { host: 'localhost', port: 7000 } };
    const options = toRedisClusterOptions(
      resolveOptions({
        cluster: {
          ...CLUSTER.cluster!,
          useReplicas: true,
          nodeAddressMap,
          clusterOptions: { maxCommandRedirections: 3, defaults: { password: 'raw', socket: { connectTimeout: 42 } } },
        },
        connection: { password: 'p' },
      }),
    );

    expect(options.useReplicas).toBe(true);
    expect(options.nodeAddressMap).toBe(nodeAddressMap);
    expect(options.maxCommandRedirections).toBe(3);
    expect(options.defaults!.password).toBe('raw');
    expect((options.defaults!.socket as any).connectTimeout).toBe(42);
    expect((options.defaults!.socket as any).keepAlive).toBe(true);
  });

  it('throws when building cluster options without cluster mode', () => {
    expect(() => toRedisClusterOptions(resolveOptions())).toThrow();
  });
});

describe('cluster utils', () => {
  it('detects hash tags', () => {
    expect(hasHashTag('dlq')).toBe(false);
    expect(hasHashTag('{dlq}')).toBe(true);
    expect(hasHashTag('app{dlq}')).toBe(true);
    expect(hasHashTag('{}dlq')).toBe(false);
    expect(hasHashTag('{dlq')).toBe(false);
  });

  it('keeps the standalone entry key unchanged and hash-tags it in cluster mode', () => {
    expect(getQueueEntryKey('dlq', 'id', false)).toBe('dlq:id');
    expect(getQueueEntryKey('dlq', 'id', true)).toBe('{dlq}:id');
    expect(getQueueEntryKey('{app}dlq', 'id', true)).toBe('{app}dlq:id');
  });

  it('creates a cluster client in cluster mode and a standalone client otherwise', () => {
    vi.mocked(createClient).mockImplementation(fakeCreateClient as any);
    vi.mocked(createCluster).mockImplementation(fakeCreateCluster as any);
    const logger = createMockLogger();

    expect(isRedisCluster(createRedisConnection(resolveOptions(CLUSTER), 'publisher', logger) as any)).toBe(true);
    expect(isRedisCluster(createRedisConnection(resolveOptions(), 'publisher', logger) as any)).toBe(false);
  });

  it('logs node level cluster events', () => {
    vi.mocked(createCluster).mockImplementation(fakeCreateCluster as any);
    const logger = createMockLogger();
    const cluster = createRedisConnection(resolveOptions(CLUSTER), 'publisher', logger) as unknown as FakeRedisCluster;

    cluster.emit('node-error', new Error('boom'), { host: 'n1', port: 7000 });
    cluster.emit('error', new Error('global'));

    expect(logger.error).toHaveBeenCalledWith('Redis cluster publisher node n1:7000 error: Error: boom');
    expect(logger.error).toHaveBeenCalledWith('Redis cluster publisher error: Error: global');
  });

  describe('discoverSubscriberChannels', () => {
    it('standalone: a single PUBSUB CHANNELS, published through the client itself', async () => {
      const client = new FakeRedisClient();
      client.pubSubChannels.mockResolvedValue(['orders:a']);

      const result = await discoverSubscriberChannels(client as any, 'orders:*', createMockLogger());

      expect(result).toEqual([{ channel: 'orders:a', target: client }]);
    });

    it('cluster: queries masters and replicas and pairs every channel with its node', async () => {
      const cluster = new FakeRedisCluster({}, 2, 1);
      cluster.masters[0].client.pubSubChannels.mockResolvedValue(['orders:a']);
      cluster.masters[1].client.pubSubChannels.mockResolvedValue(['orders:b', 'orders:a']);
      cluster.replicas[0].client.pubSubChannels.mockResolvedValue(['orders:c']);

      const result = await discoverSubscriberChannels(cluster as any, 'orders:*', createMockLogger());

      expect(cluster.nodeClient).toHaveBeenCalledTimes(3);
      expect(result).toEqual([
        { channel: 'orders:a', target: cluster.masters[0].client },
        { channel: 'orders:b', target: cluster.masters[1].client },
        { channel: 'orders:c', target: cluster.replicas[0].client },
      ]);
    });

    it('cluster: skips unreachable nodes with a warning', async () => {
      const logger = createMockLogger();
      const cluster = new FakeRedisCluster({}, 2);
      cluster.masters[0].client.pubSubChannels.mockRejectedValue(new Error('down'));
      cluster.masters[1].client.pubSubChannels.mockResolvedValue(['orders:b']);

      const result = await discoverSubscriberChannels(cluster as any, 'orders:*', logger);

      expect(result.map(({ channel }) => channel)).toEqual(['orders:b']);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('1/2'));
    });

    it('cluster: refreshes a stale topology and finds the subscribers of a promoted master', async () => {
      const logger = createMockLogger();
      const cluster = new FakeRedisCluster({}, 2);
      cluster.masters[0].client.pubSubChannels.mockRejectedValue(new Error('dead master'));
      cluster.masters[1].client.pubSubChannels.mockResolvedValue(['orders:b']);
      const promoted = { address: 'promoted:7000', client: new FakeRedisClient() };
      promoted.client.pubSubChannels.mockResolvedValue(['orders:a']);
      const rediscover = vi.fn(async () => {
        cluster.masters = [promoted, cluster.masters[1]];
      });
      (cluster as any)._slots = { rediscover };

      const result = await discoverSubscriberChannels(cluster as any, 'orders:*', logger);

      expect(rediscover).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        { channel: 'orders:a', target: promoted.client },
        { channel: 'orders:b', target: cluster.masters[1].client },
      ]);
    });

    it('cluster: keeps the partial result when the topology refresh fails', async () => {
      const logger = createMockLogger();
      const cluster = new FakeRedisCluster({}, 2);
      cluster.masters[0].client.pubSubChannels.mockRejectedValue(new Error('down'));
      cluster.masters[1].client.pubSubChannels.mockResolvedValue(['orders:b']);
      (cluster as any)._slots = { rediscover: vi.fn().mockRejectedValue(new Error('no node')) };

      const result = await discoverSubscriberChannels(cluster as any, 'orders:*', logger);

      expect(result.map(({ channel }) => channel)).toEqual(['orders:b']);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('topology refresh failed'));
    });

    it('cluster: throws when every node fails or the topology is empty', async () => {
      const cluster = new FakeRedisCluster({}, 2);
      cluster.nodeClient.mockRejectedValue(new Error('down'));

      await expect(discoverSubscriberChannels(cluster as any, 'orders:*', createMockLogger())).rejects.toThrow(/every cluster node/);
      await expect(discoverSubscriberChannels(new FakeRedisCluster({}, 0) as any, 'orders:*', createMockLogger())).rejects.toThrow(/empty/);
    });
  });
});

describe('cluster mode', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    resetFakeClients();
    resetFakeClusters();
    vi.mocked(createClient).mockImplementation(fakeCreateClient as any);
    vi.mocked(createCluster).mockImplementation(fakeCreateCluster as any);
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('PostinoQueue', () => {
    it('writes a hash-tagged entry key in the same slot as the list', async () => {
      const queue = new PostinoQueue(resolveOptions(CLUSTER), logger);
      await queue.addToQueue({ enable: true, name: 'dlq', ttlInSeconds: 100 }, 'msg-1', { a: 1 });
      await queue.onApplicationShutdown();

      expect(clustersOf('queueManager')).toHaveLength(1);
      expect(clustersOf('queueManager')[0].multiCalls).toEqual([
        ['setEx', '{dlq}:msg-1', 100, JSON.stringify({ a: 1 })],
        ['rPush', 'dlq', '{dlq}:msg-1'],
        ['expire', 'dlq', 100],
      ]);
    });
  });

  describe('PostinoPublisher', () => {
    let queue: { addToQueue: ReturnType<typeof vi.fn>; onApplicationShutdown: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      queue = { addToQueue: vi.fn().mockResolvedValue(undefined), onApplicationShutdown: vi.fn().mockResolvedValue(undefined) };
      vi.spyOn(PostinoQueueFactory, 'getInstance').mockReturnValue(queue as any);
    });

    const createPublisher = async (input: PostinoOptionsInput = {}) => {
      const publisher = new PostinoPublisher(resolveOptions({ ...CLUSTER, ...input }), logger);
      await flush();
      return { publisher, cluster: clustersOf('publisher')[0] };
    };

    it('unicast publishes through the node the subscriber is connected to', async () => {
      const { publisher, cluster } = await createPublisher();
      cluster.masters[2].client.pubSubChannels.mockResolvedValue(['orders:a']);

      const result = await publisher.publish({ channel: 'orders', payload: { n: 1 } });

      expect(result).toEqual({ success: true });
      expect(cluster.publish).not.toHaveBeenCalled();
      expect(cluster.masters[2].client.publish).toHaveBeenCalledWith('orders:a', expect.any(String));
      expect(queue.addToQueue).not.toHaveBeenCalled();
    });

    it('unicast falls back to another subscriber and then to the DLQ', async () => {
      const { publisher, cluster } = await createPublisher();
      cluster.masters[0].client.pubSubChannels.mockResolvedValue(['orders:a']);
      cluster.masters[1].client.pubSubChannels.mockResolvedValue(['orders:b']);
      cluster.masters[0].client.publish.mockResolvedValue(0);
      cluster.masters[1].client.publish.mockResolvedValue(0);

      const result = await publisher.publish({ channel: 'orders', payload: {} });

      expect(result.success).toBe(false);
      expect(cluster.masters[0].client.publish).toHaveBeenCalledTimes(1);
      expect(cluster.masters[1].client.publish).toHaveBeenCalledTimes(1);
      expect(queue.addToQueue).toHaveBeenCalledTimes(1);
    });

    it('broadcast publishes every instance channel through its own node', async () => {
      const { publisher, cluster } = await createPublisher();
      cluster.masters[0].client.pubSubChannels.mockResolvedValue(['orders:a']);
      cluster.masters[1].client.pubSubChannels.mockResolvedValue(['orders:b']);

      const result = await publisher.publish({ channel: 'orders', payload: {} }, false, true);

      expect(result).toEqual({ success: true });
      expect(cluster.masters[0].client.publish).toHaveBeenCalledWith('orders:a', expect.any(String));
      expect(cluster.masters[1].client.publish).toHaveBeenCalledWith('orders:b', expect.any(String));
    });

    it('dispatchAndClose opens and closes a cluster client per publish', async () => {
      const { publisher } = await createPublisher({ dispatchAndClose: true });
      expect(clustersOf('publisher')).toHaveLength(0);

      await publisher.publish({ channel: 'orders', payload: {} });

      expect(clustersOf('publisher')).toHaveLength(1);
      expect(clustersOf('publisher')[0].close).toHaveBeenCalled();
    });
  });

  describe('PostinoSubscriber', () => {
    let subscriber: PostinoSubscriber;
    const interval = 1000;

    beforeEach(() => {
      vi.spyOn(PostinoQueueFactory, 'getInstance').mockReturnValue({
        addToQueue: vi.fn().mockResolvedValue(undefined),
        onApplicationShutdown: vi.fn().mockResolvedValue(undefined),
      } as any);
    });

    afterEach(async () => {
      await subscriber?.onApplicationShutdown();
    });

    const createSubscriber = () => {
      subscriber = new PostinoSubscriber(resolveOptions({ cluster: { ...CLUSTER.cluster!, healthCheckIntervalMs: interval } }), logger);
      return subscriber;
    };
    const current = () => clustersOf('subscriber').at(-1)!;
    const instanceChannel = (channel: string) => `${channel}:${(subscriber as any).INSTANCE_ID}`;

    it('subscribes the instance channel on the cluster client', async () => {
      createSubscriber();
      const handler = vi.fn();

      await expect(subscriber.subscribe('orders', handler)).resolves.toBe(true);
      await current().deliver(instanceChannel('orders'), JSON.stringify({ id: '1', data: { n: 1 } }));

      expect(current().options.defaults.name).toBe(`postino:subscriber:${(subscriber as any).INSTANCE_ID}`);
      expect(handler).toHaveBeenCalledWith({ n: 1 });
    });

    it('watchdog: heals when the pub/sub connection is permanently closed', async () => {
      vi.useFakeTimers();
      createSubscriber();
      const handler = vi.fn();
      await subscriber.subscribe('orders', handler);
      const dead = current();

      await vi.advanceTimersByTimeAsync(interval);
      expect(clustersOf('subscriber')).toHaveLength(1); // healthy

      dead.pubSubNode!.client.isOpen = false;
      await vi.advanceTimersByTimeAsync(interval + PostinoSubscriber.HEALING_DELAY_MS);

      const healed = current();
      expect(healed).not.toBe(dead);
      expect(dead.destroy).toHaveBeenCalled();
      await healed.deliver(instanceChannel('orders'), JSON.stringify({ id: '1', data: 'ok' }));
      expect(handler).toHaveBeenCalledWith('ok');
    });

    it('watchdog: re-subscribes when the pub/sub connection is missing', async () => {
      vi.useFakeTimers();
      createSubscriber();
      await subscriber.subscribe('orders', vi.fn());
      const cluster = current();
      cluster.pubSubNode = undefined;
      const rediscover = vi.fn().mockResolvedValue(undefined);
      (cluster as any)._slots = { rediscover };

      await vi.advanceTimersByTimeAsync(interval);

      expect(clustersOf('subscriber')).toHaveLength(1);
      expect(rediscover).toHaveBeenCalledTimes(1);
      expect(cluster.subscribe).toHaveBeenCalledTimes(2);
      expect(cluster.pubSubNode).toBeDefined();
    });

    it('watchdog: is disabled with healthCheckIntervalMs = 0 and stopped on shutdown', async () => {
      vi.useFakeTimers();
      subscriber = new PostinoSubscriber(resolveOptions({ cluster: { ...CLUSTER.cluster!, healthCheckIntervalMs: 0 } }), logger);
      await subscriber.subscribe('orders', vi.fn());
      expect(vi.getTimerCount()).toBe(0);
      await subscriber.onApplicationShutdown();

      createSubscriber();
      expect(vi.getTimerCount()).toBe(1);
      await subscriber.onApplicationShutdown();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
