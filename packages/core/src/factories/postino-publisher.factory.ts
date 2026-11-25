import { PostinoPublisher } from '../service-providers/postino-publisher.service-provider.js';
import type { PostinoLoggerInput } from '../types/logger.type.js';
import type { PostinoOptionsInput } from '../types/options.type.js';
import { resolveOptions } from '../utils/options.utils.js';
import { mapLogger } from '../utils/map-logger.utils.js';

/** Process-wide singleton: options passed to later calls are ignored. */
export class PostinoPublisherFactory {
  private static instance?: PostinoPublisher;

  public static getInstance(options: PostinoOptionsInput, logger: PostinoLoggerInput) {
    if (this.instance) {
      return this.instance;
    }

    this.instance = new PostinoPublisher(resolveOptions(options), mapLogger(logger));
    return this.instance;
  }

  /** @internal Drops the singleton (tests only). Does not close connections. */
  public static reset() {
    this.instance = undefined;
  }
}
