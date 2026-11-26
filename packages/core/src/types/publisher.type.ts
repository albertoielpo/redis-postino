export interface PostinoPublishDto<T> {
  channel: string;
  payload: T;
}

/** Wire format of every message published on Redis. */
export interface PostinoMessage<T> {
  id: string; // unique id (crypto.randomUUID)
  data: T;
}

export interface PostinoPublishResult {
  success: boolean;
  error?: string;
}

export interface PostinoPublishOptions {
  /**
   * Flags the message as safe to re-publish if it ends up in the dead letter queue.
   * It is stored as `retry` in the DLQ entry: `{ channel, message, retry }`.
   *
   * It has no effect unless:
   * 1. the dead letter queue is enabled (`deadLetterQueue.enable: true`). Only the DLQ carries this flag:
   *    the error queue (`errorQueue`) stores subscriber handler failures and does not record it.
   * 2. a retry job reads the DLQ. No such job ships with Postino yet: for now it has to be implemented
   *    separately (read the DLQ entries and re-publish the ones with `retry: true`).
   *
   * Nothing is ever retried automatically. Ignored when `broadcast` is true (broadcasts never go to the DLQ).
   * @default false
   */
  retryable?: boolean;
  /**
   * Deliver to every live subscriber instance instead of one random instance.
   * @default false
   */
  broadcast?: boolean;
}
