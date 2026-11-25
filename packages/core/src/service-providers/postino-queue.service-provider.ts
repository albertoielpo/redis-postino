import type { PostinoLogger } from '../types/logger.type.js';
import type { PostinoOptions, PostinoQueueOption } from '../types/options.type.js';
import { LazyRedisConnection } from '../utils/connection.utils.js';

/**
 * Writes entries on the dead letter queue and on the error queue.
 * The connection is opened lazily and closed after `MAX_CONNECTION_TIME` of inactivity.
 */
export class PostinoQueue {
  public static readonly MAX_CONNECTION_TIME = 300000; // 5 minutes

  private readonly connection: LazyRedisConnection;
  private readonly logger: PostinoLogger;
  private timeoutObj?: NodeJS.Timeout;

  constructor(options: PostinoOptions, logger: PostinoLogger) {
    this.logger = logger;
    this.connection = new LazyRedisConnection(options, 'queueManager', logger);
  }

  /** Never throws: errors are logged. */
  public async addToQueue(queueOption: PostinoQueueOption, messageId: string, message: object) {
    try {
      if (!queueOption.enable) {
        return;
      }

      const { name, ttlInSeconds } = queueOption;
      this.logger.debug(`MessageId: ${messageId} | Adding message ${messageId} to ${name} queue with ttl ${ttlInSeconds}`);
      const redis = await this.connection.get();
      this.resetTimeout();

      const key = `${name}:${messageId}`;
      await redis.multi().setEx(key, ttlInSeconds, JSON.stringify(message)).rPush(name, key).expire(name, ttlInSeconds).exec();
    } catch (err) {
      this.logger.error(`MessageId: ${messageId} | An error occurred while adding message ${messageId} on queue ${queueOption?.name}: ${err}`);
    }
  }

  private resetTimeout() {
    clearTimeout(this.timeoutObj);
    this.timeoutObj = setTimeout(async () => {
      try {
        this.logger.log(`Redis queue manager has been inactive for ${PostinoQueue.MAX_CONNECTION_TIME}ms. Closing instance...`);
        await this.connection.close();
      } catch (err) {
        this.logger.error(`An error occurred while closing queueManager instance ${err}`);
      }
    }, PostinoQueue.MAX_CONNECTION_TIME);
    // never keep the process alive because of the idle timer
    this.timeoutObj.unref();
  }

  public async onApplicationShutdown() {
    try {
      this.logger.log(`Application shutdown. Closing queue Redis connection...`);
      clearTimeout(this.timeoutObj);
      await this.connection.close();
    } catch (err) {
      this.logger.error(`Error on shutting down queue: ${err}`);
    }
  }
}
