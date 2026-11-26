import type { PostinoLogger } from '../types/logger.type.js';
import type { PostinoRedisCluster, PostinoRedisConnection } from '../types/redis-client.type.js';

/** The subset of a node-redis client used to publish a message. */
export interface PostinoPublishTarget {
  publish(channel: string, message: string): Promise<unknown>;
}

/** An instance channel (`channel:instanceId`) and the connection to publish it through. */
export interface PostinoSubscriberChannel {
  channel: string;
  target: PostinoPublishTarget;
}

/** `true` when the connection is a node-redis cluster client. */
export function isRedisCluster(connection: PostinoRedisConnection): connection is PostinoRedisCluster {
  return typeof (connection as PostinoRedisCluster).nodeClient === 'function';
}

/** `true` when `key` contains a valid Redis Cluster hash tag (`{...}` with a non-empty content). */
export function hasHashTag(key: string) {
  const start = key.indexOf('{');
  if (start === -1) {
    return false;
  }

  const end = key.indexOf('}', start + 1);
  return end > start + 1;
}

/**
 * Key of a queue entry.
 * - standalone: `${name}:${messageId}` (unchanged).
 * - cluster: `{${name}}:${messageId}` so the entry hashes to the same slot as the list `name`
 *   (the `MULTI` writing both would otherwise fail with `CROSSSLOT`).
 *   When `name` already contains a hash tag the standalone format already shares the slot.
 */
export function getQueueEntryKey(name: string, messageId: string, cluster: boolean) {
  if (cluster && !hasHashTag(name)) {
    return `{${name}}:${messageId}`;
  }

  return `${name}:${messageId}`;
}

/**
 * Forces a refresh of the cluster topology (`CLUSTER SLOTS` on a known node). Never throws.
 *
 * node-redis only refreshes the topology a few seconds after a node starts reconnecting: when the reconnect strategy
 * gives up earlier, or the failover completes later, the client keeps a stale topology (a dead master, no promoted
 * replica) indefinitely. node-redis has no public API for this: the internal `_slots.rediscover()` is used,
 * and the refresh is skipped if it is not available.
 * @returns `true` if the topology was refreshed
 */
export async function refreshClusterTopology(cluster: PostinoRedisCluster, logger: PostinoLogger) {
  // eslint-disable-next-line no-underscore-dangle -- node-redis internal, see above
  const slots = (cluster as unknown as { _slots?: { rediscover?: () => Promise<void> } })._slots;
  if (typeof slots?.rediscover !== 'function') {
    logger.warn(`Redis cluster topology refresh is not supported by this node-redis version.`);
    return false;
  }

  try {
    await slots.rediscover();
    return true;
  } catch (err) {
    logger.error(`Redis cluster topology refresh failed: ${err}`);
    return false;
  }
}

async function queryClusterNodes(cluster: PostinoRedisCluster, pattern: string) {
  const nodes = [...cluster.masters, ...cluster.replicas];
  const settled = await Promise.allSettled(
    nodes.map(async (node) => {
      const client = await cluster.nodeClient(node);
      const channels = await client.pubSubChannels(pattern);
      return channels.map((channel) => ({ channel: String(channel), target: client }));
    }),
  );

  return settled;
}

/**
 * Lists the instance channels matching `pattern` and the connection each one must be published through.
 *
 * - standalone: a single `PUBSUB CHANNELS` on the client.
 * - cluster: `PUBSUB CHANNELS` only reports the subscriptions of the node it runs on, and `PUBLISH` only counts
 *   the receivers connected to the node it runs on. Every node of the topology (masters, and replicas when
 *   `useReplicas` is enabled) is queried, and each channel is paired with the node it was found on,
 *   so the `PUBLISH` reply stays a reliable delivery acknowledgement.
 *   When some nodes fail (e.g. a dead master after a failover) the topology is refreshed and the nodes queried again,
 *   otherwise the subscribers connected to a newly promoted master would never be found.
 *
 * Throws only when no node could be queried.
 */
export async function discoverSubscriberChannels(
  connection: PostinoRedisConnection,
  pattern: string,
  logger: PostinoLogger,
): Promise<PostinoSubscriberChannel[]> {
  if (!isRedisCluster(connection)) {
    const channels = await connection.pubSubChannels(pattern);
    return channels.map((channel) => ({ channel: String(channel), target: connection }));
  }

  let settled = await queryClusterNodes(connection, pattern);
  if (settled.some((result) => result.status === 'rejected')) {
    logger.warn(`PUBSUB CHANNELS ${pattern} failed on some cluster nodes. Refreshing the cluster topology...`);
    if (await refreshClusterTopology(connection, logger)) {
      settled = await queryClusterNodes(connection, pattern);
    }
  }

  if (!settled.length) {
    throw new Error(`Redis cluster topology is empty`);
  }

  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length === settled.length) {
    throw new Error(`PUBSUB CHANNELS failed on every cluster node: ${failures[0].reason}`);
  }

  if (failures.length) {
    logger.warn(`PUBSUB CHANNELS ${pattern} failed on ${failures.length}/${settled.length} cluster nodes: subscribers on those nodes are skipped.`);
  }

  const byChannel = new Map<string, PostinoSubscriberChannel>();
  settled.forEach((result) => {
    if (result.status === 'fulfilled') {
      result.value.forEach((entry) => {
        if (!byChannel.has(entry.channel)) {
          byChannel.set(entry.channel, entry);
        }
      });
    }
  });

  return [...byChannel.values()];
}
