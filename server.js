// server.js — zero-dependency HTTP server (no express) serving the API + static frontend.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const {
  db,
  getRealtorByEmail,
  getRealtorByStripeCustomerId,
  getRealtorByStripeSubscriptionId,
  upsertPendingRealtor,
  isRealtorClaimed,
  updateRealtorSubscription,
  getAllRealtorsAdmin,
  createRealtorAdmin,
  updateRealtorAdmin,
  deleteRealtorAdmin,
  setRealtorPhoto,
  setRealtorVideo,
  getAllClientsAdmin,
  createSession,
  getSession,
  deleteSession,
  deleteAllSessionsForSubject,
  getClientById,
  getClientByEmail,
  isClientClaimed,
  createClientAccount,
  createOrLinkClientOAuth,
  updateClientProfile,
  setClientPasswordHash,
  setClientResetToken,
  getClientByResetToken,
  getClientByVerifyToken,
  markClientEmailVerified,
  setClientVerifyToken,
  getRealtorById,
  findRealtorForOAuthLogin,
  setRealtorPasswordHash,
  setRealtorResetToken,
  getRealtorByResetToken,
  getRealtorByVerifyToken,
  markRealtorEmailVerified,
  setRealtorVerifyToken,
} = require('./db');
const stripe = require('./stripe');
const {
  hashPassword,
  verifyPassword,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
  randomToken,
  verifyGoogleIdToken,
  verifyAppleIdToken,
} = require('./auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('./email');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Lives on the same persistent volume as the SQLite database (mounted at /app/data in
// production), so uploaded photos survive redeploys instead of vanishing with the container.
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const APPLE_SERVICES_ID = process.env.APPLE_SERVICES_ID || '';
const APPLE_REDIRECT_URI = process.env.APPLE_REDIRECT_URI || '';
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const VERIFY_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PHOTO_MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};
const MAX_PHOTO_BYTES = 4 * 1024 * 1024; // 4MB decoded
const VIDEO_MIME_EXT = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};
const MAX_VIDEO_BYTES = 60 * 1024 * 1024; // 60MB — short intro clips, sent as raw binary (no base64 inflation)

// Constant-time comparison of the X-Admin-Password header against ADMIN_PASSWORD.
function checkAdminAuth(req) {
  if (!ADMIN_PASSWORD) return false;
  const supplied = Buffer.from(String(req.headers['x-admin-password'] || ''));
  const expected = Buffer.from(ADMIN_PASSWORD);
  if (supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(supplied, expected);
}

function sqliteFutureTimestamp(ms) {
  // Matches SQLite's own datetime('now') format (UTC, 'YYYY-MM-DD HH:MM:SS') so token
  // expiry columns compare correctly against it as plain text.
  return new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' ');
}

function getCurrentSession(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  return getSession(token);
}

function clientToPublic(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    intent: row.intent,
    areaInterest: row.area_interest,
    state: row.state,
    timeline: row.timeline || null,
    budgetRange: row.budget_range || null,
    propertyType: row.property_type || null,
    emailVerified: Boolean(row.email_verified),
  };
}

// ---------------- Client <-> realtor match scoring ----------------
// Realtor `specialties` and `areas` are free-text, comma-separated tags an agent typed in
// themselves (no controlled taxonomy) — so this is a soft heuristic ranking, not an exact
// filter. It only ever re-orders the deck; it never removes a realtor from it, so a client
// who skips every optional question still sees every eligible agent, just in original order.
const INTENT_KEYWORDS = {
  buy: ['buyer', 'first-time buyer'],
  sell: ['seller', 'listing'],
  invest: ['investor', 'multi-family', 'commercial', 'short-term rental'],
  rent: ['rent', 'rental', 'renter'],
};

function matchScore(client, realtor) {
  if (!client) return 0;
  let score = 0;
  const specialties = (realtor.specialties || '').toLowerCase();
  const areas = (realtor.areas || '').toLowerCase();

  // Strongest signal: does this agent work with buyers/sellers/investors/renters?
  const keywords = INTENT_KEYWORDS[(client.intent || '').toLowerCase()] || [];
  if (keywords.some((kw) => specialties.includes(kw))) score += 3;

  // Does the agent list the client's city/neighborhood as a service area?
  const area = (client.area_interest || '').toLowerCase().trim();
  if (area && areas.includes(area)) score += 2;

  // Does the agent's specialty list mention the client's preferred property type?
  const propKeyword = (client.property_type || '').toLowerCase().split(/[\s/]+/)[0];
  if (propKeyword && specialties.includes(propKeyword)) score += 1;

  return score;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Like readRawBody, but returns a Buffer (not decoded to text) and allows a larger cap —
// used for binary uploads like video, sent as a raw request body (not base64/JSON) so we
// don't pay the ~33% base64 size penalty on top of an already-large file.
function readRawBinaryBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function realtorToPublic(row) {
  return {
    id: row.id,
    name: row.name,
    brokerage: row.brokerage,
    photoEmoji: row.photo_emoji,
    photoUrl: row.photo_url || null,
    videoUrl: row.video_url || null,
    bio: row.bio,
    specialties: (row.specialties || '').split(',').filter(Boolean),
    areas: (row.areas || '').split(',').filter(Boolean),
    yearsExperience: row.years_experience,
    closedSales: row.closed_sales,
    rating: row.rating,
    state: row.state || null,
  };
}

function realtorToContact(row) {
  return { ...realtorToPublic(row), phone: row.phone, email: row.email };
}

// Includes subscription info — only ever sent back to the agent viewing their own dashboard.
function realtorToOwner(row) {
  return {
    ...realtorToContact(row),
    subscriptionStatus: row.subscription_status || 'inactive',
    subscriptionCurrentPeriodEnd: row.subscription_current_period_end || null,
    hasBillingAccount: Boolean(row.stripe_customer_id),
  };
}

// Full row shape for the password-gated admin panel — raw comma strings (not arrays)
// so they round-trip cleanly through plain text form fields.
function realtorToAdmin(row) {
  return {
    id: row.id,
    name: row.name,
    brokerage: row.brokerage || '',
    photoEmoji: row.photo_emoji || '',
    photoUrl: row.photo_url || null,
    videoUrl: row.video_url || null,
    bio: row.bio || '',
    specialties: row.specialties || '',
    areas: row.areas || '',
    yearsExperience: row.years_experience,
    closedSales: row.closed_sales,
    rating: row.rating,
    phone: row.phone || '',
    email: row.email || '',
    subscriptionStatus: row.subscription_status || 'inactive',
    state: row.state || '',
  };
}

function adminFieldsFromBody(body) {
  return {
    name: (body.name || '').trim(),
    brokerage: (body.brokerage || '').trim(),
    photoEmoji: (body.photoEmoji || '🏠').trim(),
    bio: (body.bio || '').trim(),
    specialties: Array.isArray(body.specialties) ? body.specialties.join(',') : (body.specialties || '').trim(),
    areas: Array.isArray(body.areas) ? body.areas.join(',') : (body.areas || '').trim(),
    yearsExperience: body.yearsExperience !== undefined && body.yearsExperience !== '' ? Number(body.yearsExperience) : null,
    closedSales: body.closedSales !== undefined && body.closedSales !== '' ? Number(body.closedSales) : 0,
    rating: body.rating !== undefined && body.rating !== '' ? Number(body.rating) : null,
    phone: (body.phone || '').trim(),
    email: (body.email || '').trim(),
    subscriptionStatus: body.subscriptionStatus === 'inactive' ? 'inactive' : 'active',
    state: (body.state || '').trim().toUpperCase().slice(0, 2) || null,
  };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // ---------------- /api/auth/* ----------------
  if (parts[1] === 'auth') {
    // GET /api/auth/config -> tells the frontend which OAuth buttons to show. Both are null
    // (buttons hidden) until GOOGLE_CLIENT_ID / APPLE_SERVICES_ID are set in the environment.
    if (req.method === 'GET' && parts[2] === 'config' && parts.length === 3) {
      return sendJson(res, 200, {
        googleClientId: GOOGLE_CLIENT_ID || null,
        appleServicesId: APPLE_SERVICES_ID || null,
        appleRedirectUri: APPLE_REDIRECT_URI || null,
      });
    }

    // GET /api/auth/me -> whoever the session cookie currently identifies, client or realtor.
    if (req.method === 'GET' && parts[2] === 'me' && parts.length === 3) {
      const session = getCurrentSession(req);
      if (!session) return sendJson(res, 401, { error: 'Not signed in.' });
      if (session.subject_type === 'client') {
        const client = getClientById(session.subject_id);
        if (!client) { deleteSession(session.token); clearSessionCookie(req, res); return sendJson(res, 401, { error: 'Not signed in.' }); }
        return sendJson(res, 200, { role: 'client', client: clientToPublic(client) });
      }
      const realtor = getRealtorById(session.subject_id);
      if (!realtor) { deleteSession(session.token); clearSessionCookie(req, res); return sendJson(res, 401, { error: 'Not signed in.' }); }
      return sendJson(res, 200, { role: 'realtor', realtor: realtorToOwner(realtor) });
    }

    // POST /api/auth/logout
    if (req.method === 'POST' && parts[2] === 'logout' && parts.length === 3) {
      const token = getSessionToken(req);
      if (token) deleteSession(token);
      clearSessionCookie(req, res);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/auth/client/login  { email, password }
    if (req.method === 'POST' && parts[2] === 'client' && parts[3] === 'login' && parts.length === 4) {
      const body = await readBody(req);
      const client = getClientByEmail((body.email || '').trim());
      if (!client || !verifyPassword(String(body.password || ''), client.password_hash)) {
        return sendJson(res, 401, { error: 'Incorrect email or password.' });
      }
      const token = randomToken();
      createSession('client', client.id, token);
      setSessionCookie(req, res, token);
      return sendJson(res, 200, { client: clientToPublic(client) });
    }

    // POST /api/auth/client/oauth  { provider: 'google'|'apple', idToken, name? }
    // Signs a client in, creating (and auto-linking-by-email) their account on first use —
    // clients don't need a rich profile up front, so unlike realtors this can be fully
    // automatic. `isNew` tells the frontend whether to show the "what are you looking for?"
    // follow-up step.
    if (req.method === 'POST' && parts[2] === 'client' && parts[3] === 'oauth' && parts.length === 4) {
      const body = await readBody(req);
      const provider = body.provider === 'apple' ? 'apple' : 'google';
      if (provider === 'google' && !GOOGLE_CLIENT_ID) return sendJson(res, 503, { error: 'Google sign-in is not configured yet.' });
      if (provider === 'apple' && !APPLE_SERVICES_ID) return sendJson(res, 503, { error: 'Apple sign-in is not configured yet.' });
      let payload;
      try {
        payload = provider === 'google'
          ? await verifyGoogleIdToken(body.idToken, GOOGLE_CLIENT_ID)
          : await verifyAppleIdToken(body.idToken, APPLE_SERVICES_ID);
      } catch (e) {
        return sendJson(res, 401, { error: 'Could not verify sign-in: ' + e.message });
      }
      const { client, isNew } = createOrLinkClientOAuth({
        provider, sub: payload.sub, email: payload.email, name: (body.name || '').trim() || null,
      });
      const token = randomToken();
      createSession('client', client.id, token);
      setSessionCookie(req, res, token);
      return sendJson(res, 200, { client: clientToPublic(client), isNew });
    }

    // POST /api/auth/realtor/login  { email, password }
    if (req.method === 'POST' && parts[2] === 'realtor' && parts[3] === 'login' && parts.length === 4) {
      const body = await readBody(req);
      const realtor = getRealtorByEmail((body.email || '').trim());
      if (!realtor || !realtor.password_hash) {
        return sendJson(res, 401, { error: 'Incorrect email or password, or this account has no password set yet — use "Forgot password" to set one.' });
      }
      if (!verifyPassword(String(body.password || ''), realtor.password_hash)) {
        return sendJson(res, 401, { error: 'Incorrect email or password.' });
      }
      const token = randomToken();
      createSession('realtor', realtor.id, token);
      setSessionCookie(req, res, token);
      return sendJson(res, 200, { realtor: realtorToOwner(realtor) });
    }

    // POST /api/auth/realtor/oauth-login  { provider, idToken }
    // Login only — does NOT create a new realtor account, since a real profile needs
    // brokerage/bio/specialties that only the full signup form on agent-signup.html collects.
    if (req.method === 'POST' && parts[2] === 'realtor' && parts[3] === 'oauth-login' && parts.length === 4) {
      const body = await readBody(req);
      const provider = body.provider === 'apple' ? 'apple' : 'google';
      if (provider === 'google' && !GOOGLE_CLIENT_ID) return sendJson(res, 503, { error: 'Google sign-in is not configured yet.' });
      if (provider === 'apple' && !APPLE_SERVICES_ID) return sendJson(res, 503, { error: 'Apple sign-in is not configured yet.' });
      let payload;
      try {
        payload = provider === 'google'
          ? await verifyGoogleIdToken(body.idToken, GOOGLE_CLIENT_ID)
          : await verifyAppleIdToken(body.idToken, APPLE_SERVICES_ID);
      } catch (e) {
        return sendJson(res, 401, { error: 'Could not verify sign-in: ' + e.message });
      }
      const realtor = findRealtorForOAuthLogin(provider, payload.sub, payload.email);
      if (!realtor) return sendJson(res, 404, { error: 'No Agentr account found for that sign-in. List your profile first.' });
      const token = randomToken();
      createSession('realtor', realtor.id, token);
      setSessionCookie(req, res, token);
      return sendJson(res, 200, { realtor: realtorToOwner(realtor) });
    }

    // POST /api/auth/forgot-password  { email, role }
    // Always responds 200 regardless of whether the email matches an account, so this can't
    // be used to probe which emails are registered.
    if (req.method === 'POST' && parts[2] === 'forgot-password' && parts.length === 3) {
      const body = await readBody(req);
      const email = (body.email || '').trim();
      const role = body.role === 'realtor' ? 'realtor' : 'client';
      const account = role === 'client' ? getClientByEmail(email) : getRealtorByEmail(email);
      if (account && account.email) {
        const token = randomToken();
        const expires = sqliteFutureTimestamp(RESET_TOKEN_TTL_MS);
        if (role === 'client') setClientResetToken(account.id, token, expires);
        else setRealtorResetToken(account.id, token, expires);
        const origin = `https://${req.headers.host}`;
        sendPasswordResetEmail(account.email, `${origin}/reset-password.html?token=${token}&role=${role}`);
      }
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/auth/reset-password  { token, role, password }
    if (req.method === 'POST' && parts[2] === 'reset-password' && parts.length === 3) {
      const body = await readBody(req);
      const role = body.role === 'realtor' ? 'realtor' : 'client';
      const password = String(body.password || '');
      if (password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
      const account = role === 'client' ? getClientByResetToken(body.token) : getRealtorByResetToken(body.token);
      if (!account) return sendJson(res, 400, { error: 'That reset link is invalid or has expired. Request a new one.' });
      const hash = hashPassword(password);
      if (role === 'client') setClientPasswordHash(account.id, hash);
      else setRealtorPasswordHash(account.id, hash);
      // Log out everywhere else — whoever is resetting the password shouldn't leave old
      // sessions (e.g. on a lost device) valid.
      deleteAllSessionsForSubject(role, account.id);
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/auth/verify-email?token=...&role=client|realtor
    if (req.method === 'GET' && parts[2] === 'verify-email' && parts.length === 3) {
      const token = url.searchParams.get('token');
      const role = url.searchParams.get('role') === 'realtor' ? 'realtor' : 'client';
      const account = role === 'client' ? getClientByVerifyToken(token) : getRealtorByVerifyToken(token);
      if (!account) return sendJson(res, 400, { error: 'That verification link is invalid or has expired.' });
      if (role === 'client') markClientEmailVerified(account.id);
      else markRealtorEmailVerified(account.id);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  // PATCH /api/clients/me  { name, phone, intent, area, state }  -> session-authenticated;
  // used to fill in the rest of a client's profile right after Google/Apple sign-in, or to
  // edit it later.
  if (req.method === 'PATCH' && parts[1] === 'clients' && parts[2] === 'me' && parts.length === 3) {
    const session = getCurrentSession(req);
    if (!session || session.subject_type !== 'client') return sendJson(res, 401, { error: 'Please log in.' });
    const body = await readBody(req);
    const client = updateClientProfile(session.subject_id, {
      name: (body.name || '').trim() || null,
      phone: (body.phone || '').trim() || null,
      intent: (body.intent || '').trim() || null,
      area: (body.area || '').trim() || null,
      state: (body.state || '').trim().toUpperCase().slice(0, 2) || null,
      timeline: (body.timeline || '').trim() || null,
      budgetRange: (body.budget || '').trim() || null,
      propertyType: (body.propertyType || '').trim() || null,
    });
    return sendJson(res, 200, { client: clientToPublic(client) });
  }

  // POST /api/clients  { name, phone, email, password, intent, area, state }
  if (req.method === 'POST' && parts[1] === 'clients' && parts.length === 2) {
    const body = await readBody(req);
    const name = (body.name || '').trim();
    const email = (body.email || '').trim();
    const password = String(body.password || '');
    if (!name) return sendJson(res, 400, { error: 'name is required' });
    if (!email) return sendJson(res, 400, { error: 'email is required' });
    if (password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });

    const existing = getClientByEmail(email);
    if (existing && isClientClaimed(existing)) {
      return sendJson(res, 409, { error: 'An account with this email already exists. Please log in instead.' });
    }

    const verifyToken = randomToken();
    const { client } = createClientAccount({
      name,
      phone: (body.phone || '').trim() || null,
      email,
      intent: (body.intent || '').trim() || null,
      area: (body.area || '').trim() || null,
      state: (body.state || '').trim().toUpperCase().slice(0, 2) || null,
      passwordHash: hashPassword(password),
      verifyToken,
      verifyTokenExpires: sqliteFutureTimestamp(VERIFY_TOKEN_TTL_MS),
    });

    const origin = `https://${req.headers.host}`;
    sendVerificationEmail(client.email, `${origin}/verify-email.html?token=${verifyToken}&role=client`);

    const sessionToken = randomToken();
    createSession('client', client.id, sessionToken);
    setSessionCookie(req, res, sessionToken);
    return sendJson(res, 201, { client: clientToPublic(client) });
  }

  // GET /api/realtors  -> active, paid realtors not yet swiped by the signed-in client,
  // scoped to their state. A realtor with no state set is treated as visible everywhere
  // (see the migration note in db.js) so profiles never silently disappear. Requires login —
  // client_id is taken from the session now, never from the query string.
  //
  // Eligibility (state/subscription/not-already-swiped) is still a hard SQL filter — nobody
  // is ever excluded based on match quality. Ordering on top of that is a soft ranking by
  // matchScore(), so a client who answered the optional "help us match you" questions sees
  // their best-fit agents first, while a client who skipped them still sees everyone, just in
  // insertion order (score 0 for all == stable id order, same as before this feature shipped).
  if (req.method === 'GET' && parts[1] === 'realtors' && parts.length === 2) {
    const session = getCurrentSession(req);
    const clientId = session && session.subject_type === 'client' ? session.subject_id : null;
    let rows;
    let client = null;
    if (clientId) {
      client = getClientById(clientId);
      const clientState = client && client.state;
      rows = db.prepare(`
        SELECT * FROM realtors
        WHERE subscription_status = 'active'
          AND (state IS NULL OR state = '' OR state = ?)
          AND id NOT IN (SELECT realtor_id FROM swipes WHERE client_id = ?)
      `).all(clientState || '', clientId);
      rows.sort((a, b) => matchScore(client, b) - matchScore(client, a) || a.id - b.id);
    } else {
      rows = db.prepare(`SELECT * FROM realtors WHERE subscription_status = 'active' ORDER BY id`).all();
    }
    return sendJson(res, 200, { realtors: rows.map(realtorToPublic) });
  }

  // POST /api/swipe  { realtor_id, direction }  -> client_id comes from the session, never
  // the request body, so one client can't record swipes (or read match state) as another.
  if (req.method === 'POST' && parts[1] === 'swipe' && parts.length === 2) {
    const session = getCurrentSession(req);
    if (!session || session.subject_type !== 'client') return sendJson(res, 401, { error: 'Please log in to swipe.' });
    const clientId = session.subject_id;
    const body = await readBody(req);
    const realtorId = Number(body.realtor_id);
    const direction = body.direction;
    if (!realtorId || !['like', 'pass'].includes(direction)) {
      return sendJson(res, 400, { error: 'realtor_id and direction (like|pass) are required' });
    }
    const client = getClientById(clientId);
    const realtor = db.prepare('SELECT * FROM realtors WHERE id = ?').get(realtorId);
    if (!client) return sendJson(res, 404, { error: 'client not found' });
    if (!realtor) return sendJson(res, 404, { error: 'realtor not found' });

    try {
      db.prepare(`
        INSERT INTO swipes (client_id, realtor_id, direction) VALUES (?, ?, ?)
        ON CONFLICT(client_id, realtor_id) DO UPDATE SET direction = excluded.direction
      `).run(clientId, realtorId, direction);
    } catch (e) {
      return sendJson(res, 500, { error: 'failed to record swipe' });
    }

    // Instant-match model: a right swipe (like) immediately creates a match/lead.
    const isMatch = direction === 'like';
    return sendJson(res, 200, {
      match: isMatch,
      realtor: isMatch ? realtorToContact(realtor) : realtorToPublic(realtor),
    });
  }

  // GET /api/matches/:clientId  -> requires the signed-in client to be that same client.
  if (req.method === 'GET' && parts[1] === 'matches' && parts.length === 3) {
    const clientId = Number(parts[2]);
    const session = getCurrentSession(req);
    if (!session || session.subject_type !== 'client' || session.subject_id !== clientId) {
      return sendJson(res, 401, { error: 'Please log in to view matches.' });
    }
    const rows = db.prepare(`
      SELECT r.*, s.created_at AS matched_at FROM swipes s
      JOIN realtors r ON r.id = s.realtor_id
      WHERE s.client_id = ? AND s.direction = 'like'
      ORDER BY s.created_at DESC
    `).all(clientId);
    return sendJson(res, 200, {
      matches: rows.map((r) => ({ ...realtorToContact(r), matchedAt: r.matched_at })),
    });
  }

  // GET /api/realtor/:id  -> profile, for the realtor's own dashboard header. Only the
  // signed-in owner of that profile can view it (it includes subscription/billing info).
  if (req.method === 'GET' && parts[1] === 'realtor' && parts.length === 3) {
    const id = Number(parts[2]);
    const session = getCurrentSession(req);
    if (!session || session.subject_type !== 'realtor' || session.subject_id !== id) {
      return sendJson(res, 401, { error: 'Please log in to view this dashboard.' });
    }
    const realtor = getRealtorById(id);
    if (!realtor) return sendJson(res, 404, { error: 'realtor not found' });
    return sendJson(res, 200, { realtor: realtorToOwner(realtor) });
  }

  // POST /api/agents/signup  { name, brokerage, email, phone, bio, specialties, areas, state,
  // yearsExperience, photoEmoji, and exactly one of: password, googleIdToken, appleIdToken }
  // Creates (or reuses a not-yet-paid) realtor row, then starts a Stripe subscription checkout.
  if (req.method === 'POST' && parts[1] === 'agents' && parts[2] === 'signup' && parts.length === 3) {
    const body = await readBody(req);
    const name = (body.name || '').trim();
    let email = (body.email || '').trim();
    if (!name) return sendJson(res, 400, { error: 'name is required' });
    if (!STRIPE_PRICE_ID) {
      return sendJson(res, 503, { error: 'Agent subscriptions are not configured yet. Set STRIPE_PRICE_ID.' });
    }

    // Exactly one signup method: password, Google, or Apple. For OAuth, the email comes
    // from the verified token (never trusted from the request body).
    let passwordHash = null, googleId = null, appleId = null, emailVerified = false;
    if (body.googleIdToken) {
      if (!GOOGLE_CLIENT_ID) return sendJson(res, 503, { error: 'Google sign-in is not configured yet.' });
      let payload;
      try { payload = await verifyGoogleIdToken(body.googleIdToken, GOOGLE_CLIENT_ID); }
      catch (e) { return sendJson(res, 401, { error: 'Could not verify Google sign-in: ' + e.message }); }
      googleId = payload.sub;
      email = payload.email;
      emailVerified = true;
    } else if (body.appleIdToken) {
      if (!APPLE_SERVICES_ID) return sendJson(res, 503, { error: 'Apple sign-in is not configured yet.' });
      let payload;
      try { payload = await verifyAppleIdToken(body.appleIdToken, APPLE_SERVICES_ID); }
      catch (e) { return sendJson(res, 401, { error: 'Could not verify Apple sign-in: ' + e.message }); }
      appleId = payload.sub;
      email = payload.email;
      emailVerified = true;
    } else {
      const password = String(body.password || '');
      if (password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
      passwordHash = hashPassword(password);
    }
    if (!email) return sendJson(res, 400, { error: 'email is required' });

    const existing = getRealtorByEmail(email);
    if (existing && existing.subscription_status === 'active') {
      return sendJson(res, 409, { error: 'An agent with this email is already listed and active.' });
    }
    // Password signups can't "claim" an already-claimed account just by typing its email —
    // but Google/Apple tokens prove real ownership of that email, so those are allowed to
    // link to (and update) an existing row even if it was claimed a different way before.
    if (existing && passwordHash && isRealtorClaimed(existing)) {
      return sendJson(res, 409, { error: 'An account with this email already exists. Please log in instead.' });
    }

    const realtor = upsertPendingRealtor({
      name,
      brokerage: (body.brokerage || '').trim(),
      photoEmoji: (body.photoEmoji || '🏠').trim(),
      bio: (body.bio || '').trim(),
      specialties: Array.isArray(body.specialties) ? body.specialties.join(',') : (body.specialties || '').trim(),
      areas: Array.isArray(body.areas) ? body.areas.join(',') : (body.areas || '').trim(),
      state: (body.state || '').trim().toUpperCase().slice(0, 2) || null,
      passwordHash, googleId, appleId, emailVerified,
      yearsExperience: body.yearsExperience ? Number(body.yearsExperience) : null,
      phone: (body.phone || '').trim(),
      email,
    });

    if (!emailVerified) {
      const verifyToken = randomToken();
      setRealtorVerifyToken(realtor.id, verifyToken, sqliteFutureTimestamp(VERIFY_TOKEN_TTL_MS));
      sendVerificationEmail(realtor.email, `https://${req.headers.host}/verify-email.html?token=${verifyToken}&role=realtor`);
    }

    // Sign them in immediately — payment hasn't happened yet, but the account (and its
    // dashboard, once active) belongs to them starting now.
    const sessionToken = randomToken();
    createSession('realtor', realtor.id, sessionToken);
    setSessionCookie(req, res, sessionToken);

    const origin = `https://${req.headers.host}`;
    try {
      const checkout = await stripe.createCheckoutSession({
        priceId: STRIPE_PRICE_ID,
        successUrl: `${origin}/agent-success.html?session_id={CHECKOUT_SESSION_ID}&realtor_id=${realtor.id}`,
        cancelUrl: `${origin}/agent-signup.html?canceled=1`,
        customerEmail: email,
        realtorId: realtor.id,
      });
      return sendJson(res, 200, { checkoutUrl: checkout.url });
    } catch (e) {
      console.error('Stripe checkout session error:', e.message);
      return sendJson(res, 502, { error: 'Could not start checkout: ' + e.message });
    }
  }

  // POST /api/agents/portal  { email }  -> Stripe billing portal link so an agent can manage/cancel.
  if (req.method === 'POST' && parts[1] === 'agents' && parts[2] === 'portal' && parts.length === 3) {
    const body = await readBody(req);
    const email = (body.email || '').trim();
    const realtor = getRealtorByEmail(email);
    if (!realtor || !realtor.stripe_customer_id) {
      return sendJson(res, 404, { error: 'No billing account found for that email.' });
    }
    const origin = `https://${req.headers.host}`;
    try {
      const session = await stripe.createBillingPortalSession({
        customerId: realtor.stripe_customer_id,
        returnUrl: `${origin}/realtor/${realtor.id}`,
      });
      return sendJson(res, 200, { url: session.url });
    } catch (e) {
      console.error('Stripe billing portal error:', e.message);
      return sendJson(res, 502, { error: 'Could not open billing portal: ' + e.message });
    }
  }

  // GET /api/realtor/:id/leads  -> clients who matched with this realtor (leads inbox).
  // Contains client contact info, so it's restricted to that realtor's own session.
  if (req.method === 'GET' && parts[1] === 'realtor' && parts[3] === 'leads' && parts.length === 4) {
    const realtorId = Number(parts[2]);
    const leadsSession = getCurrentSession(req);
    if (!leadsSession || leadsSession.subject_type !== 'realtor' || leadsSession.subject_id !== realtorId) {
      return sendJson(res, 401, { error: 'Please log in to view your leads.' });
    }
    const rows = db.prepare(`
      SELECT c.*, s.created_at AS matched_at FROM swipes s
      JOIN clients c ON c.id = s.client_id
      WHERE s.realtor_id = ? AND s.direction = 'like'
      ORDER BY s.created_at DESC
    `).all(realtorId);
    return sendJson(res, 200, {
      leads: rows.map((c) => ({
        id: c.id, name: c.name, phone: c.phone, email: c.email,
        intent: c.intent, areaInterest: c.area_interest, state: c.state,
        timeline: c.timeline || null, budgetRange: c.budget_range || null, propertyType: c.property_type || null,
        matchedAt: c.matched_at,
      })),
    });
  }

  // POST /api/admin/login  { password }  -> lets the admin page verify before storing the password.
  if (req.method === 'POST' && parts[1] === 'admin' && parts[2] === 'login' && parts.length === 3) {
    if (!ADMIN_PASSWORD) {
      return sendJson(res, 503, { error: 'Admin panel is not configured yet. Set ADMIN_PASSWORD.' });
    }
    const body = await readBody(req);
    const supplied = Buffer.from(String(body.password || ''));
    const expected = Buffer.from(ADMIN_PASSWORD);
    const ok = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    if (!ok) return sendJson(res, 401, { error: 'Incorrect password' });
    return sendJson(res, 200, { ok: true });
  }

  // Every other /api/admin/* route requires the X-Admin-Password header on each request.
  if (parts[1] === 'admin') {
    if (!checkAdminAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    // GET /api/admin/realtors  -> full roster, including inactive/pending agents.
    if (req.method === 'GET' && parts[2] === 'realtors' && parts.length === 3) {
      return sendJson(res, 200, { realtors: getAllRealtorsAdmin().map(realtorToAdmin) });
    }

    // POST /api/admin/realtors  -> add a new profile directly (bypasses the Stripe paywall).
    if (req.method === 'POST' && parts[2] === 'realtors' && parts.length === 3) {
      const body = await readBody(req);
      const fields = adminFieldsFromBody(body);
      if (!fields.name) return sendJson(res, 400, { error: 'name is required' });
      const realtor = createRealtorAdmin(fields);
      return sendJson(res, 201, { realtor: realtorToAdmin(realtor) });
    }

    // PUT /api/admin/realtors/:id  -> edit any field, including subscription status.
    if (req.method === 'PUT' && parts[2] === 'realtors' && parts.length === 4) {
      const body = await readBody(req);
      const fields = adminFieldsFromBody(body);
      if (!fields.name) return sendJson(res, 400, { error: 'name is required' });
      const realtor = updateRealtorAdmin(Number(parts[3]), fields);
      if (!realtor) return sendJson(res, 404, { error: 'realtor not found' });
      return sendJson(res, 200, { realtor: realtorToAdmin(realtor) });
    }

    // DELETE /api/admin/realtors/:id
    if (req.method === 'DELETE' && parts[2] === 'realtors' && parts.length === 4) {
      const ok = deleteRealtorAdmin(Number(parts[3]));
      if (!ok) return sendJson(res, 404, { error: 'realtor not found' });
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/admin/realtors/:id/photo  { imageBase64, contentType }  -> upload/replace profile photo.
    if (req.method === 'POST' && parts[2] === 'realtors' && parts[4] === 'photo' && parts.length === 5) {
      const id = Number(parts[3]);
      const current = getAllRealtorsAdmin().find((r) => r.id === id);
      if (!current) return sendJson(res, 404, { error: 'realtor not found' });

      let body;
      try {
        body = await readBody(req, 8_000_000); // base64 inflates ~33% over the 4MB decoded cap
      } catch (e) {
        return sendJson(res, 413, { error: 'Photo is too large (max 4MB).' });
      }
      const contentType = String(body.contentType || '').toLowerCase();
      const ext = PHOTO_MIME_EXT[contentType];
      if (!ext) return sendJson(res, 400, { error: 'Unsupported image type. Use PNG, JPEG, or WEBP.' });

      let buffer;
      try {
        buffer = Buffer.from(String(body.imageBase64 || ''), 'base64');
      } catch (e) {
        return sendJson(res, 400, { error: 'Invalid image data.' });
      }
      if (!buffer.length) return sendJson(res, 400, { error: 'No image data provided.' });
      if (buffer.length > MAX_PHOTO_BYTES) return sendJson(res, 413, { error: 'Photo is too large (max 4MB).' });

      const filename = `realtor-${id}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);

      // Best-effort cleanup of the previous photo file so uploads don't accumulate forever.
      if (current.photo_url && current.photo_url.startsWith('/uploads/')) {
        const oldPath = path.join(UPLOADS_DIR, path.basename(current.photo_url));
        fs.unlink(oldPath, () => {});
      }

      const updated = setRealtorPhoto(id, '/uploads/' + filename);
      return sendJson(res, 200, { realtor: realtorToAdmin(updated) });
    }

    // DELETE /api/admin/realtors/:id/photo  -> remove photo, revert to the emoji placeholder.
    if (req.method === 'DELETE' && parts[2] === 'realtors' && parts[4] === 'photo' && parts.length === 5) {
      const id = Number(parts[3]);
      const current = getAllRealtorsAdmin().find((r) => r.id === id);
      if (!current) return sendJson(res, 404, { error: 'realtor not found' });
      if (current.photo_url && current.photo_url.startsWith('/uploads/')) {
        const oldPath = path.join(UPLOADS_DIR, path.basename(current.photo_url));
        fs.unlink(oldPath, () => {});
      }
      const updated = setRealtorPhoto(id, null);
      return sendJson(res, 200, { realtor: realtorToAdmin(updated) });
    }

    // POST /api/admin/realtors/:id/video  -> upload/replace intro video.
    // Body is the raw video bytes (not JSON/base64) — the browser sends the File object
    // directly as the fetch body, with its MIME type in Content-Type. Keeps the upload path
    // simple and avoids the ~33% size penalty base64 would add on top of an already-large file.
    if (req.method === 'POST' && parts[2] === 'realtors' && parts[4] === 'video' && parts.length === 5) {
      const id = Number(parts[3]);
      const current = getAllRealtorsAdmin().find((r) => r.id === id);
      if (!current) return sendJson(res, 404, { error: 'realtor not found' });

      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      const ext = VIDEO_MIME_EXT[contentType];
      if (!ext) return sendJson(res, 400, { error: 'Unsupported video type. Use MP4, MOV, or WEBM.' });

      let buffer;
      try {
        buffer = await readRawBinaryBody(req, MAX_VIDEO_BYTES);
      } catch (e) {
        return sendJson(res, 413, { error: 'Video is too large (max 60MB).' });
      }
      if (!buffer.length) return sendJson(res, 400, { error: 'No video data provided.' });

      const filename = `realtor-${id}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);

      // Best-effort cleanup of the previous video file so uploads don't accumulate forever.
      if (current.video_url && current.video_url.startsWith('/uploads/')) {
        const oldPath = path.join(UPLOADS_DIR, path.basename(current.video_url));
        fs.unlink(oldPath, () => {});
      }

      const updated = setRealtorVideo(id, '/uploads/' + filename);
      return sendJson(res, 200, { realtor: realtorToAdmin(updated) });
    }

    // DELETE /api/admin/realtors/:id/video  -> remove the intro video.
    if (req.method === 'DELETE' && parts[2] === 'realtors' && parts[4] === 'video' && parts.length === 5) {
      const id = Number(parts[3]);
      const current = getAllRealtorsAdmin().find((r) => r.id === id);
      if (!current) return sendJson(res, 404, { error: 'realtor not found' });
      if (current.video_url && current.video_url.startsWith('/uploads/')) {
        const oldPath = path.join(UPLOADS_DIR, path.basename(current.video_url));
        fs.unlink(oldPath, () => {});
      }
      const updated = setRealtorVideo(id, null);
      return sendJson(res, 200, { realtor: realtorToAdmin(updated) });
    }

    // GET /api/admin/clients  -> every completed onboarding signup, matched or not.
    if (req.method === 'GET' && parts[2] === 'clients' && parts.length === 3) {
      const clients = getAllClientsAdmin().map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        intent: c.intent,
        areaInterest: c.area_interest,
        state: c.state,
        createdAt: c.created_at,
      }));
      return sendJson(res, 200, { clients });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  return sendJson(res, 404, { error: 'not found' });
}

// POST /api/stripe/webhook — handled outside handleApi() because it needs the raw,
// unparsed request body to verify Stripe's signature before trusting the payload.
async function handleStripeWebhook(req, res) {
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'Could not read request body' });
  }

  try {
    stripe.verifyWebhookSignature(rawBody, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Stripe webhook signature check failed:', e.message);
    return sendJson(res, 400, { error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }

  try {
    const obj = event.data && event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        const realtorId = Number((obj.metadata && obj.metadata.realtor_id) || obj.client_reference_id);
        if (realtorId) {
          updateRealtorSubscription(realtorId, {
            status: 'active',
            stripeCustomerId: obj.customer,
            stripeSubscriptionId: obj.subscription,
          });
          console.log(`Agent #${realtorId} subscription activated via checkout.`);
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const status = ['active', 'trialing'].includes(obj.status) ? 'active' : 'inactive';
        const realtorId = Number(obj.metadata && obj.metadata.realtor_id);
        const realtor = realtorId
          ? db.prepare('SELECT * FROM realtors WHERE id = ?').get(realtorId)
          : getRealtorByStripeSubscriptionId(obj.id) || getRealtorByStripeCustomerId(obj.customer);
        if (realtor) {
          updateRealtorSubscription(realtor.id, {
            status,
            stripeCustomerId: obj.customer,
            stripeSubscriptionId: obj.id,
            currentPeriodEnd: obj.current_period_end
              ? new Date(obj.current_period_end * 1000).toISOString()
              : null,
          });
          console.log(`Agent #${realtor.id} subscription -> ${status}.`);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const realtor = getRealtorByStripeSubscriptionId(obj.id) || getRealtorByStripeCustomerId(obj.customer);
        if (realtor) {
          updateRealtorSubscription(realtor.id, { status: 'inactive' });
          console.log(`Agent #${realtor.id} subscription canceled -> inactive.`);
        }
        break;
      }
      default:
        break; // ignore events we don't act on
    }
  } catch (e) {
    console.error('Error processing Stripe webhook event:', e);
    // Still acknowledge with 200 below — Stripe retries on non-2xx, and a processing bug
    // shouldn't cause it to hammer us; the error is logged for follow-up.
  }

  return sendJson(res, 200, { received: true });
}

const UPLOAD_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};

// Supports HTTP Range requests (206 Partial Content) — iOS/Safari's <video> element requires
// this to play at all (WKWebView, which the Capacitor app runs on, refuses to play video
// served without Range support), and it lets any browser seek/scrub instead of downloading
// the whole clip up front.
function serveUpload(req, res, pathname) {
  const filename = path.basename(pathname); // strips any path traversal attempts
  const fullPath = path.join(UPLOADS_DIR, filename);
  const ext = path.extname(fullPath);
  const contentType = UPLOAD_MIME[ext] || 'application/octet-stream';

  fs.stat(fullPath, (err, stats) => {
    if (err || !stats.isFile()) { res.writeHead(404); return res.end('Not found'); }

    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stats.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
      });
      return fs.createReadStream(fullPath).pipe(res);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` }); return res.end(); }
    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : stats.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stats.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stats.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    });
    fs.createReadStream(fullPath, { start, end }).pipe(res);
  });
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  let fullPath = path.join(PUBLIC_DIR, filePath);

  fs.stat(fullPath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA-style fallback for client-side routes like /realtor/3
      fullPath = path.join(PUBLIC_DIR, 'index.html');
    }
    const ext = path.extname(fullPath);
    fs.readFile(fullPath, (err2, data) => {
      if (err2) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/stripe/webhook' && req.method === 'POST') {
      await handleStripeWebhook(req, res);
    } else if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else if (url.pathname.startsWith('/uploads/')) {
      serveUpload(req, res, url.pathname);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Realtor Swipe app running at http://localhost:${PORT}`);
});
