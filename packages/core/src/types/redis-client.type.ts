import type { createClient, createCluster } from 'redis';

export type PostinoRedisClient = ReturnType<typeof createClient>;

export type PostinoRedisCluster = ReturnType<typeof createCluster>;

/** A standalone client or a cluster client. */
export type PostinoRedisConnection = PostinoRedisClient | PostinoRedisCluster;

export type PostinoClientRole = 'subscriber' | 'publisher' | 'queueManager';
