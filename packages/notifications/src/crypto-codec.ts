import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { PushSubscriptionCryptoCodec } from './postgres.js';

const context = Buffer.from('hypermail/push-subscription/v1');

/** Stable authenticated encryption shared by web writes and worker delivery reads. */
export class PushSubscriptionAesCodec implements PushSubscriptionCryptoCodec {
  private readonly encryptionKey: Buffer;
  private readonly hashKey: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('Push subscription encryption key must be at least 32 characters');
    this.encryptionKey = Buffer.from(hkdfSync('sha256', secret, context, Buffer.from('encryption'), 32));
    this.hashKey = Buffer.from(hkdfSync('sha256', secret, context, Buffer.from('endpoint-hash'), 32));
  }

  encrypt(value: string): Promise<string> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Promise.resolve(`v1.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`);
  }

  decrypt(value: string): Promise<string> {
    const [version, nonce, ciphertext, tag, extra] = value.split('.');
    if (version !== 'v1' || !nonce || !ciphertext || !tag || extra) return Promise.reject(new Error('Invalid push subscription ciphertext'));
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(nonce, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Promise.resolve(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
    } catch {
      return Promise.reject(new Error('Invalid push subscription ciphertext'));
    }
  }

  hashEndpoint(endpoint: string): Promise<string> {
    return Promise.resolve(createHmac('sha256', this.hashKey).update(endpoint, 'utf8').digest('base64url'));
  }
}
