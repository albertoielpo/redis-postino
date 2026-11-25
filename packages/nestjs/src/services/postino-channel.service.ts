import type { PostinoPublishResult } from 'redis-postino';
import type { PostinoPublisherService } from './postino-publisher.service.js';

export class PostinoChannel<T> {
  constructor(
    private readonly publisher: PostinoPublisherService,
    private readonly channel: string,
  ) {}

  /**
   * Publish a message on the channel. Never throws.
   * @param retry stored in the dead letter queue entry, to flag it for a later retry
   * @param broadcast deliver to every live subscriber instance instead of a random one
   */
  public async publish(message: T, retry = false, broadcast = false): Promise<PostinoPublishResult> {
    return this.publisher.publish<T>(
      {
        payload: message,
        channel: this.channel,
      },
      retry,
      broadcast,
    );
  }
}
