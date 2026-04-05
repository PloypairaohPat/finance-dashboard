const crypto = require('crypto');

const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

if (KEY.length !== 32) {
  throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [iv, tag, encrypted]
    .map((b) => b.toString('base64'))
    .join('.');
}

function decrypt(str) {
  const [iv, tag, encrypted] = str
    .split('.')
    .map((s) => Buffer.from(s, 'base64'));

  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);

  return decipher.update(encrypted) + decipher.final('utf8');
}

module.exports = { encrypt, decrypt };