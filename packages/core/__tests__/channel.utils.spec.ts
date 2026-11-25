import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostinoLogger } from '../src/index.js';
import { extractChannelName, getSubscribeChannel } from '../src/utils/channel.utils.js';

/**
 * Unit tests for the channelUtils module.
 */
describe('channel-utils', () => {
  // Create a mock PostinoLogger object for testing purposes.
  // Mock the PostinoLogger to spy on its methods
  const mockLogger = {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  } as unknown as PostinoLogger;

  // Test suite for the getSubscribeChannel method.
  describe('getSubscribeChannel', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('should return a correctly formatted channel string', () => {
      const channel = 'user-updates';
      const id = '12345';
      const expected = 'user-updates:12345';

      const result = getSubscribeChannel(channel, id, mockLogger);

      expect(result).toBe(expected);
    });

    it('should handle different channel and id values', () => {
      const channel = 'notifications';
      const id = 'abc-xyz';
      const expected = 'notifications:abc-xyz';

      const result = getSubscribeChannel(channel, id, mockLogger);

      expect(result).toBe(expected);
    });

    it('should throw and log an error if channel is missing', () => {
      expect.assertions(3);

      try {
        getSubscribeChannel(null as any, '123', mockLogger);
      } catch (err) {
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(mockLogger.error).toHaveBeenCalledWith('getSubscribeChannel requires both a channel and an id.');
        expect(err).toEqual(new Error(`Invalid channel or id`));
      }
    });

    it('should throw and log an error if id is missing', () => {
      expect.assertions(3);

      try {
        getSubscribeChannel(null as any, '123', mockLogger);
      } catch (err) {
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(mockLogger.error).toHaveBeenCalledWith('getSubscribeChannel requires both a channel and an id.');
        expect(err).toEqual(new Error(`Invalid channel or id`));
      }
    });

    it('should throw and log an error if channel contains a ":"', () => {
      expect.assertions(3);
      const channel = 'channel:123';
      const id = '123';

      try {
        getSubscribeChannel(channel, id, mockLogger);
      } catch (err) {
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(mockLogger.error).toHaveBeenCalledWith(`getSubscribeChannel does not allow for ":" character. Received: ${channel}, ${id}.`);
        expect(err).toEqual(new Error(`Invalid channel or id format`));
      }
    });

    it('should throw and log an error if id contains a ":"', () => {
      expect.assertions(3);
      const channel = 'channel';
      const id = '1:23';

      try {
        getSubscribeChannel(channel, id, mockLogger);
      } catch (err) {
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(mockLogger.error).toHaveBeenCalledWith(`getSubscribeChannel does not allow for ":" character. Received: ${channel}, ${id}.`);
        expect(err).toEqual(new Error(`Invalid channel or id format`));
      }
    });
  });

  // Test suite for the extractChannelName method.
  describe('extractChannelName', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('should extract the channel name from a valid subscribeChannel string', () => {
      const subscribeChannel = 'project-status:67890';
      const expected = 'project-status';

      const result = extractChannelName(subscribeChannel, mockLogger);

      expect(result).toBe(expected);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should throw and log an error for a string without a colon', () => {
      expect.assertions(3);
      const subscribeChannel = 'invalidchannel';

      try {
        extractChannelName(subscribeChannel, mockLogger);
      } catch (err) {
        expect(mockLogger.error).toHaveBeenCalledWith(`Invalid subscribeChannel format. Expected "channel:id", but received "${subscribeChannel}".`);
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(err).toEqual(new Error(`Invalid subscribeChannel`));
      }
    });

    it('should throw and log an error for a string with multiple colons', () => {
      expect.assertions(3);
      const subscribeChannel = 'channel:with:multiple:colons';

      try {
        extractChannelName(subscribeChannel, mockLogger);
      } catch (err) {
        expect(mockLogger.error).toHaveBeenCalledWith(`Invalid subscribeChannel format. Expected "channel:id", but received "${subscribeChannel}".`);
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(err).toEqual(new Error(`Invalid subscribeChannel`));
      }
    });

    it('should throw and log an error for an empty string', () => {
      expect.assertions(3);
      const subscribeChannel = '';

      try {
        extractChannelName(subscribeChannel, mockLogger);
      } catch (err) {
        expect(mockLogger.error).toHaveBeenCalledWith(`Invalid subscribeChannel format. Expected "channel:id", but received "${subscribeChannel}".`);
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(err).toEqual(new Error(`Invalid subscribeChannel`));
      }
    });

    it('should throw and log an error for a string starting with a colon', () => {
      expect.assertions(3);
      const subscribeChannel = ':12345';

      try {
        extractChannelName(subscribeChannel, mockLogger);
      } catch (err) {
        expect(mockLogger.error).toHaveBeenCalledWith(`Invalid subscribeChannel format. Expected "channel:id", but received "${subscribeChannel}".`);
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(err).toEqual(new Error(`Invalid subscribeChannel`));
      }
    });

    it('should throw and log an error for a string ending with a colon', () => {
      expect.assertions(3);
      const subscribeChannel = 'invalidchannel:';

      try {
        extractChannelName(subscribeChannel, mockLogger);
      } catch (err) {
        expect(mockLogger.error).toHaveBeenCalledWith(`Invalid subscribeChannel format. Expected "channel:id", but received "${subscribeChannel}".`);
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        expect(err).toEqual(new Error(`Invalid subscribeChannel`));
      }
    });
  });
});
