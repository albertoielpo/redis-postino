import { PostinoQueue } from '../service-providers/postino-queue.service-provider.js';
import type { PostinoLoggerInput } from '../types/logger.type.js';
import type { PostinoOptions } from '../types/options.type.js';
import { mapLogger } from '../utils/map-logger.utils.js';

/** Process-wide singleton: options passed to later calls are ignored. */
export class PostinoQueueFactory {
  private static instance?: PostinoQueue;

  public static getInstance(options: PostinoOptions, logger: PostinoLoggerInput) {
    if (this.instance) {
      return this.instance;
    }

    this.instance = new PostinoQueue(options, mapLogger(logger));
    return this.instance;
  }

  /** @internal Drops the singleton (tests only). Does not close connections. */
  public static reset() {
    this.instance = undefined;
  }
}
