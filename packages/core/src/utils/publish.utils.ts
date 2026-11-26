import type { PostinoPublishOptions } from '../types/publisher.type.js';

/**
 * Normalizes the `publish()` arguments: accepts the options object, or the deprecated
 * positional `(retry, broadcast)` booleans.
 */
export function toPublishOptions(optionsOrRetry: PostinoPublishOptions | boolean = {}, broadcast = false): Required<PostinoPublishOptions> {
  if (typeof optionsOrRetry === 'boolean') {
    return { retryable: optionsOrRetry, broadcast };
  }

  return { retryable: optionsOrRetry.retryable ?? false, broadcast: optionsOrRetry.broadcast ?? false };
}
