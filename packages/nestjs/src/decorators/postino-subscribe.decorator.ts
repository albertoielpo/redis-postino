import { SetMetadata } from '@nestjs/common';

export const POSTINO_SUBSCRIBE_KEY = 'POSTINO_SUBSCRIBE_KEY';

/** Marks a method of a `@PostinoSubscriberHost()` provider as the handler of `channel`. */
export const PostinoSubscribe = (channel: string) => SetMetadata(POSTINO_SUBSCRIBE_KEY, channel);
