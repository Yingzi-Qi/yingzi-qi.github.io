// AES-GCM token encryption + HMAC cookie signing, keyed from SESSION_SECRET (Worker secret).
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function requireSecret(env) {
  if (!env?.SESSION_SECRET || String(env.SESSION_SECRET).length < 32) throw Object.assign(new Error('SESSION_SECRET is not configured yet.'), { status: 503 });
  return env.SESSION_SECRET;
}
async function baseKey(env) { return crypto.subtle.importKey('raw', enc.encode(requireSecret(env)), 'HKDF', false, ['deriveKey']); }
async function aesKey(env) {
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('tillroll-v2'), info: enc.encode('oauth-token-aes') }, await baseKey(env), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function hmacKey(env) {
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('tillroll-v2'), info: enc.encode('cookie-hmac') }, await baseKey(env), { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
}
export async function encrypt(env, text) {
  if (text === null || text === undefined) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(String(text)));
  return b64(iv) + '.' + b64(ct);
}
export async function decrypt(env, blob) {
  if (!blob) return null;
  const [iv, ct] = String(blob).split('.');
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct)));
}
export async function sign(env, value) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(value));
  return `${value}.${b64url(sig)}`;
}
export async function verify(env, signed) {
  if (!signed || !signed.includes('.')) return null;
  const i = signed.lastIndexOf('.');
  const value = signed.slice(0, i);
  const expected = await sign(env, value);
  if (expected.length !== signed.length) return null;
  let diff = 0; for (let k = 0; k < expected.length; k++) diff |= expected.charCodeAt(k) ^ signed.charCodeAt(k);
  return diff === 0 ? value : null;
}
