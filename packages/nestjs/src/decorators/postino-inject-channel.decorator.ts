import { Inject } from '@nestjs/common';
import { getChannelToken } from '../utils/token.utils.js';

/** Injects the `PostinoChannel` registered with `PostinoModule.registerChannel(channelName)`. */
export const InjectPostinoChannel = (channelName: string): ParameterDecorator => Inject(getChannelToken(channelName));
