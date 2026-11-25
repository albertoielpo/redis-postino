import { POSTINO_CHANNEL } from '../types/provider.types.js';

export function getChannelToken(channelName: string) {
  return `${POSTINO_CHANNEL}:${channelName}`;
}
