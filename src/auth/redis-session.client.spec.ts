import { redisReconnectDelay } from './redis-session.client.js';

describe('Redis reconnection', () => {
  it('keeps retrying with bounded exponential backoff', () => {
    for (const [retries, minimum, maximum] of [
      [0, 100, 299],
      [1, 200, 399],
      [3, 800, 999],
      [5, 3000, 3199],
      [20, 3000, 3199],
      [100, 3000, 3199],
    ]) {
      const delay = redisReconnectDelay(retries);
      expect(delay).toBeGreaterThanOrEqual(minimum);
      expect(delay).toBeLessThanOrEqual(maximum);
    }
  });
});
