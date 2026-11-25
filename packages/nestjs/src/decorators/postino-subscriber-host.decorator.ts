import { SetMetadata } from '@nestjs/common';

export const POSTINO_SUBSCRIBER_HOST_KEY = 'POSTINO_SUBSCRIBER_HOST_KEY';

/** Marks a provider as containing `@PostinoSubscribe()` handlers. */
export function PostinoSubscriberHost(): ClassDecorator {
  return SetMetadata(POSTINO_SUBSCRIBER_HOST_KEY, true);
}
