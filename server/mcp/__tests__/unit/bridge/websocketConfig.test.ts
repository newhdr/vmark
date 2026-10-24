/**
 * resolveBridgeConfig — the pending-request timeout must outlast the Rust
 * bridge's 20 s wake-and-retry worst case, or a write the bridge recovered is
 * reported to the AI client as timed out (and may be retried).
 */
import { describe, expect, it } from 'vitest';
import { resolveBridgeConfig } from '../../../src/bridge/websocketConfig.js';

describe('resolveBridgeConfig requestTimeout', () => {
  it('defaults to 25 s', () => {
    expect(resolveBridgeConfig().requestTimeout).toBe(25_000);
  });

  it('accepts a value past the bridge worst case', () => {
    expect(resolveBridgeConfig({ requestTimeout: 20_001 }).requestTimeout).toBe(20_001);
  });

  it.each([20_000, 10_000, 100, 1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    'refuses %s: not past the 20 s wake-and-retry, or not a delay a timer can hold',
    (requestTimeout) => {
      expect(() => resolveBridgeConfig({ requestTimeout })).toThrow(RangeError);
      expect(() => resolveBridgeConfig({ requestTimeout })).toThrow(/requestTimeout/);
    },
  );
});

describe('resolveBridgeConfig maxQueueSize', () => {
  it('defaults to 100', () => {
    expect(resolveBridgeConfig().maxQueueSize).toBe(100);
  });

  it.each([1, 2, 100, 10_000])('accepts the positive integer %s', (maxQueueSize) => {
    expect(resolveBridgeConfig({ maxQueueSize }).maxQueueSize).toBe(maxQueueSize);
  });

  // A NaN cap makes `length >= cap` permanently false, so the queue grows
  // without bound; a fraction or non-positive value is a caller mistake that
  // used to be clamped silently.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 0.5, 0, -1, 2 ** 53])(
    'refuses %s: not a finite positive integer',
    (maxQueueSize) => {
      expect(() => resolveBridgeConfig({ maxQueueSize })).toThrow(RangeError);
      expect(() => resolveBridgeConfig({ maxQueueSize })).toThrow(/maxQueueSize/);
    },
  );
});
