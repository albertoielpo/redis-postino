import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithTimeout } from '../src/utils/timeout.utils.js';

describe('runWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the function result when it completes before the timeout', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue('result');

    const result = await runWithTimeout(fn, 1000);

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns "TIMEOUT" when the function does not complete in time', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves

    const promise = runWithTimeout(fn, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe('TIMEOUT');
  });

  it('clears the pending timeout when the function wins the race', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    const fn = vi.fn().mockResolvedValue('done');

    await runWithTimeout(fn, 5000);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('propagates a rejection thrown by the function', async () => {
    vi.useFakeTimers();
    const error = new Error('something went wrong');
    const fn = vi.fn().mockRejectedValue(error);
    const result = await runWithTimeout(fn, 1000);
    expect(result).toBe('ERROR');
  });

  it('does not return "TIMEOUT" when the function just barely beats the deadline', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue(42);

    const promise = runWithTimeout(fn, 500);
    await vi.advanceTimersByTimeAsync(499); // advance to just before deadline
    const result = await promise;

    expect(result).toBe(42);
  });
});
