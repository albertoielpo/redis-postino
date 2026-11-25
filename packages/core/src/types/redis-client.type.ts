import type { createClient } from 'redis';

export type PostinoRedisClient = ReturnType<typeof createClient>;

export type PostinoClientRole = 'subscriber' | 'publisher' | 'queueManager';
