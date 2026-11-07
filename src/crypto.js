import crypto from 'node:crypto';
import { config } from './config.js';

// AES-256-GCM. Stored format: base64(iv).base64(authTag).base64(ciphertext)
export function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  const [iv, tag, encrypted] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
