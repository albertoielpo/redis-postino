import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapLogger } from '../src/utils/map-logger.utils.js';

describe('mapLogger', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should map logger.info to log when available', () => {
    const mockInfo = vi.fn();
    const logger = {
      info: mockInfo,
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };

    const result = mapLogger(logger);

    result.log('test');
    expect(mockInfo).toHaveBeenCalledWith('test');
  });

  it('should fall back to logger.log if logger.info is not available', () => {
    const mockLog = vi.fn();
    const logger = {
      log: mockLog,
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };

    const result = mapLogger(logger);

    result.log('test');
    expect(mockLog).toHaveBeenCalledWith('test');
  });

  it('should fall back to console.log if neither info nor log exists', () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };

    const result = mapLogger(logger);

    result.log('test fallback');
    expect(consoleLogSpy).toHaveBeenCalledWith('test fallback');
  });

  it('should map debug, error, and warn directly', () => {
    const mockDebug = vi.fn();
    const mockError = vi.fn();
    const mockWarn = vi.fn();

    const logger = {
      debug: mockDebug,
      error: mockError,
      warn: mockWarn,
    };

    const result = mapLogger(logger);

    result.debug('debug message');
    result.error('error message');
    result.warn('warn message');

    expect(mockDebug).toHaveBeenCalledWith('debug message');
    expect(mockError).toHaveBeenCalledWith('error message');
    expect(mockWarn).toHaveBeenCalledWith('warn message');
  });

  it('should map verbose if available', () => {
    const mockVerbose = vi.fn();

    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      verbose: mockVerbose,
    };

    const result = mapLogger(logger);

    result.verbose('verbose message');
    expect(mockVerbose).toHaveBeenCalledWith('verbose message');
  });

  it('should fall back to trace if verbose is not available', () => {
    const mockTrace = vi.fn();

    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      trace: mockTrace,
    };

    const result = mapLogger(logger);

    result.verbose('trace message');
    expect(mockTrace).toHaveBeenCalledWith('trace message');
  });

  it('should fall back to console.log for verbose if neither verbose nor trace exists', () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };

    const result = mapLogger(logger);

    result.verbose('console fallback');
    expect(consoleLogSpy).toHaveBeenCalledWith('console fallback');
  });
});
