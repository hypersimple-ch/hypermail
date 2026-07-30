import { describe, expect, it } from 'vitest';
import { AuthSecretPushSubscriptionCodec } from '../../src/notifications/crypto-codec.js';

describe('push subscription codec', () => {
  it('uses randomized authenticated encryption and rejects tampering', async () => {
    const codec = new AuthSecretPushSubscriptionCodec('test-secret'.repeat(4)); const first = await codec.encrypt('https://push.example/endpoint'); const second = await codec.encrypt('https://push.example/endpoint');
    expect(first).not.toBe(second); await expect(codec.decrypt(first)).resolves.toBe('https://push.example/endpoint');
    const tampered = `${first[0] === 'A' ? 'B' : 'A'}${first.slice(1)}`;
    await expect(codec.decrypt(tampered)).rejects.toThrow('Invalid push subscription ciphertext');
  });
});
