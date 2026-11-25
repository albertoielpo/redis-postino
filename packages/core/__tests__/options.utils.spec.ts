import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../src/index.js';
import { buildReconnectStrategy, resolveOptions, toRedisClientOptions } from '../src/utils/options.utils.js';

describe('resolveOptions', () => {
  it('applies every default when no input is given', () => {
    expect(resolveOptions()).toEqual({ ...DEFAULT_OPTIONS, clientOptions: undefined });
  });

  it('keeps the default reconnect options when only the host is overridden', () => {
    const options = resolveOptions({ connection: { host: 'redis.local' } });

    expect(options.connection.host).toBe('redis.local');
    expect(options.connection.port).toBe(6379);
    expect(options.connection.reconnect).toEqual(DEFAULT_OPTIONS.connection.reconnect);
  });

  it('merges partial reconnect and queue options', () => {
    const options = resolveOptions({
      connection: { reconnect: { maxAttempts: 3 } },
      deadLetterQueue: { name: 'redis-comm-dlq' },
      errorQueue: { enable: false },
      dispatchAndClose: true,
    });

    expect(options.connection.reconnect).toEqual({ maxAttempts: 3, delayMs: 1000 });
    expect(options.deadLetterQueue).toEqual({ ...DEFAULT_OPTIONS.deadLetterQueue, name: 'redis-comm-dlq' });
    expect(options.errorQueue).toEqual({ ...DEFAULT_OPTIONS.errorQueue, enable: false });
    expect(options.dispatchAndClose).toBe(true);
  });

  it('does not mutate the defaults', () => {
    resolveOptions({ connection: { host: 'x', reconnect: { delayMs: 1 } } });

    expect(DEFAULT_OPTIONS.connection.host).toBe('localhost');
    expect(DEFAULT_OPTIONS.connection.reconnect.delayMs).toBe(1000);
  });
});

describe('buildReconnectStrategy', () => {
  // regression(H5e): bounded retries with linear backoff (10 attempts x 1s)
  it('regression(H5e): linear backoff, gives up after maxAttempts', () => {
    const strategy = buildReconnectStrategy({ maxAttempts: 10, delayMs: 1000 });

    expect(strategy(0)).toBe(1000);
    expect(strategy(2)).toBe(3000);
    expect(strategy(9)).toBe(10000);
    expect(strategy(10)).toBe(false);
  });
});

describe('toRedisClientOptions', () => {
  it('maps the connection options to node-redis options', () => {
    const options = toRedisClientOptions(
      resolveOptions({ connection: { host: 'h', port: 1234, username: 'u', password: 'p', db: 2 } }),
      'postino:publisher:id',
    );

    expect(options).toMatchObject({
      username: 'u',
      password: 'p',
      database: 2,
      name: 'postino:publisher:id',
      commandOptions: { timeout: 3000 },
      socket: {
        host: 'h',
        port: 1234,
        connectTimeout: 5000,
        keepAlive: true,
        keepAliveInitialDelay: 5000,
      },
    });
    expect(typeof (options.socket as any).reconnectStrategy).toBe('function');
    expect((options.socket as any).tls).toBeUndefined();
  });

  it('disables keep-alive and command timeout when set to 0', () => {
    const options = toRedisClientOptions(resolveOptions({ connection: { keepAlive: 0, commandTimeout: 0 } }));

    expect((options.socket as any).keepAlive).toBe(false);
    expect((options.socket as any).keepAliveInitialDelay).toBeUndefined();
    expect(options.commandOptions).toBeUndefined();
  });

  it('enables TLS with defaults or with custom TLS options', () => {
    expect((toRedisClientOptions(resolveOptions({ connection: { tls: true } })).socket as any).tls).toBe(true);

    const socket = toRedisClientOptions(resolveOptions({ connection: { tls: { servername: 'redis.example.com' } } })).socket as any;
    expect(socket.tls).toBe(true);
    expect(socket.servername).toBe('redis.example.com');
  });

  it('merges clientOptions last, socket included', () => {
    const options = toRedisClientOptions(
      resolveOptions({
        connection: { host: 'h' },
        clientOptions: { password: 'override', RESP: 2, socket: { connectTimeout: 42 } },
      }),
    );

    expect(options.password).toBe('override');
    expect(options.RESP).toBe(2);
    expect((options.socket as any).connectTimeout).toBe(42);
    expect((options.socket as any).host).toBe('h');
  });
});
