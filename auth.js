// auth.js — password hashing, session cookies, and Google/Apple "Sign in" token verification.
// Zero extra npm dependencies, matching the rest of this app: password hashing uses Node's
// built-in scrypt, and ID-token verification is a from-scratch minimal JWT/JWKS check using
// node:crypto's JWK import support (Node 16+) instead of a jsonwebtoken/jwks-rsa package.

const crypto = require('node:crypto');
const https = require('node:https');

const SESSION_COOKIE = 'agentr_session';
const SESSION_TTL_DAYS = 30;

// ---------------- Password hashing ----------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ---------------- Cookies ----------------

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

// Railway terminates TLS and forwards over HTTP with x-forwarded-proto: https, so the
// process itself sees a plain socket even in production — check the forwarded header (and
// the raw socket, for completeness) rather than always requiring `Secure`, otherwise cookies
// would silently fail to set during local `node server.js` testing over http://localhost.
function isSecureRequest(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket && req.socket.encrypted);
}

function setSessionCookie(req, res, token) {
  const maxAgeSec = SESSION_TTL_DAYS * 24 * 60 * 60;
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSec}`];
  if (isSecureRequest(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
  const attrs = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (isSecureRequest(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function getSessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE] || null;
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---------------- Minimal JWT verification (RS256) for Google / Apple ID tokens ----------------

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`GET ${url} -> ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const jwksCache = {}; // url -> { keys, fetchedAt }
const JWKS_CACHE_MS = 60 * 60 * 1000;

async function getJwks(url) {
  const cached = jwksCache[url];
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_MS) return cached.keys;
  const data = await httpGetJson(url);
  jwksCache[url] = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

// Verifies an RS256 JWT's signature, issuer, audience, and expiry against a provider's JWKS
// endpoint. Returns the decoded payload on success, throws a descriptive Error otherwise.
async function verifyIdToken(idToken, { jwksUrl, issuer, audience }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch (e) {
    throw new Error('Malformed token');
  }
  if (header.alg !== 'RS256') throw new Error('Unsupported token algorithm');

  const keys = await getJwks(jwksUrl);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown signing key (JWKS may have rotated — try again)');

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signature = base64UrlDecode(sigB64);
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${headerB64}.${payloadB64}`), publicKey, signature);
  if (!ok) throw new Error('Invalid token signature');

  const issuers = Array.isArray(issuer) ? issuer : [issuer];
  if (!issuers.includes(payload.iss)) throw new Error('Invalid token issuer');
  if (payload.aud !== audience) throw new Error('Invalid token audience');
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error('Token expired');

  return payload;
}

function verifyGoogleIdToken(idToken, clientId) {
  return verifyIdToken(idToken, {
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    issuer: ['accounts.google.com', 'https://accounts.google.com'],
    audience: clientId,
  });
}

function verifyAppleIdToken(idToken, servicesId) {
  return verifyIdToken(idToken, {
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    issuer: 'https://appleid.apple.com',
    audience: servicesId,
  });
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
  hashPassword,
  verifyPassword,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
  randomToken,
  verifyGoogleIdToken,
  verifyAppleIdToken,
};
