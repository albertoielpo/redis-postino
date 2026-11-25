import type { PostinoLogger } from '../types/logger.type.js';

export function getSubscribeChannel(channel: string, id: string, logger: PostinoLogger) {
  if (!channel || !id) {
    logger.error(`getSubscribeChannel requires both a channel and an id.`);
    throw new Error(`Invalid channel or id`);
  }

  if (channel.includes(':') || id.includes(':')) {
    logger.error(`getSubscribeChannel does not allow for ":" character. Received: ${channel}, ${id}.`);
    throw new Error(`Invalid channel or id format`);
  }
  return `${channel}:${id}`;
}

export function extractChannelName(subscribeChannel: string, logger: PostinoLogger) {
  const regex = /^[^:]+[:][^:]+$/;
  const isFormatOk = regex.test(subscribeChannel);

  if (!isFormatOk) {
    logger.error(`Invalid subscribeChannel format. Expected "channel:id", but received "${subscribeChannel}".`);
    throw new Error(`Invalid subscribeChannel`);
  }

  return subscribeChannel.split(':')[0];
}
