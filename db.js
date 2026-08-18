// db.js — zero-dependency SQLite layer using Node's built-in node:sqlite.
// No npm packages required; works out of the box on Node 22.5+.

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'app.db');
const isNewDb = !fs.existsSync(DB_PATH);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS realtors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    brokerage TEXT,
    photo_emoji TEXT,
    bio TEXT,
    specialties TEXT,        -- comma-separated
    areas TEXT,               -- comma-separated
    years_experience INTEGER,
    closed_sales INTEGER,
    rating REAL,
    phone TEXT,
    email TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    intent TEXT,               -- buy / sell / invest / rent
    area_interest TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS swipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    realtor_id INTEGER NOT NULL REFERENCES realtors(id),
    direction TEXT NOT NULL CHECK (direction IN ('like','pass')),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(client_id, realtor_id)
  );

  -- Login sessions for both clients and realtors, keyed by an opaque random token stored
  -- in an httpOnly cookie. subject_type + subject_id point at the clients or realtors row.
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('client', 'realtor')),
    subject_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`);

function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function migrate() {
  // Paywall migration: agents must have an active subscription to appear in the client swipe deck.
  const isFirstPaywallMigration = !columnExists('realtors', 'subscription_status');
  const newColumns = [
    ['subscription_status', "TEXT DEFAULT 'inactive'"],
    ['stripe_customer_id', 'TEXT'],
    ['stripe_subscription_id', 'TEXT'],
    ['subscription_current_period_end', 'TEXT'],
    ['subscription_updated_at', 'TEXT'],
    ['photo_url', 'TEXT'],
    ['state', 'TEXT'],
    ['video_url', 'TEXT'],
  ];
  for (const [col, def] of newColumns) {
    if (!columnExists('realtors', col)) {
      db.exec(`ALTER TABLE realtors ADD COLUMN ${col} ${def}`);
      console.log(`Migrated: added realtors.${col}`);
    }
  }
  if (isFirstPaywallMigration) {
    // Grandfather in every realtor that existed before the paywall shipped, so nothing
    // disappears from the live app. Only agents who sign up from now on must pay to be listed.
    db.exec(`UPDATE realtors SET subscription_status = 'active'`);
    console.log('Grandfathered existing realtors as active (pre-paywall).');
  }

  // State-based matching (nationwide expansion). A realtor with no state set is treated as
  // visible everywhere (see the /api/realtors query) so existing profiles don't vanish the
  // moment this column appears — admins/agents opt into state-scoping by filling it in.
  if (!columnExists('clients', 'state')) {
    db.exec(`ALTER TABLE clients ADD COLUMN state TEXT`);
    console.log('Migrated: added clients.state');
  }

  // Real accounts (password + Google/Apple sign-in) for both clients and realtors. Existing
  // rows just get NULL/0 in these columns — they're "unclaimed" guest records until someone
  // signs up with that email, at which point the signup flow adopts the existing row instead
  // of creating a duplicate (see createClientAccount / upsertPendingRealtor).
  const accountColumns = [
    ['password_hash', 'TEXT'],
    ['google_id', 'TEXT'],
    ['apple_id', 'TEXT'],
    ['email_verified', 'INTEGER DEFAULT 0'],
    ['verify_token', 'TEXT'],
    ['verify_token_expires', 'TEXT'],
    ['reset_token', 'TEXT'],
    ['reset_token_expires', 'TEXT'],
  ];
  for (const table of ['clients', 'realtors']) {
    for (const [col, def] of accountColumns) {
      if (!columnExists(table, col)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
        console.log(`Migrated: added ${table}.${col}`);
      }
    }
  }

  // Optional "help us match you" signals collected on the complete-profile step. All three
  // are optional — a client can hit "Start swiping" without touching any of them (each field
  // defaults to "No preference" in the UI) — so NULL here just means "wasn't asked/answered",
  // never an error state.
  const matchColumns = [
    ['timeline', 'TEXT'],
    ['budget_range', 'TEXT'],
    ['property_type', 'TEXT'],
  ];
  for (const [col, def] of matchColumns) {
    if (!columnExists('clients', col)) {
      db.exec(`ALTER TABLE clients ADD COLUMN ${col} ${def}`);
      console.log(`Migrated: added clients.${col}`);
    }
  }
}

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM realtors').get().c;
  if (count > 0) return;

  // Seed/demo profiles are bootstrap data, not paying signups — list them as active immediately
  // so a fresh database (or a wiped volume) doesn't launch with an empty, agent-less swipe deck.
  const insert = db.prepare(`
    INSERT INTO realtors
      (name, brokerage, photo_emoji, bio, specialties, areas, years_experience, closed_sales, rating, phone, email, subscription_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `);

  const realtors = [
    {
      name: 'Gregory DePasquale',
      brokerage: 'DePasquale Properties',
      photo_emoji: '🏡',
      bio: "107+ closed sales and ~$50M in volume over five years. I work with buyers, sellers, and investors across Chattanooga — and I personally manage a short-term rental portfolio, so I know the numbers on investment property cold.",
      specialties: 'Buyers,Sellers,Investors,Short-Term Rentals,New Development',
      areas: 'North Shore,Signal Mountain,Hixson',
      years_experience: 5,
      closed_sales: 107,
      rating: 4.9,
      phone: '(423) 664-3074',
      email: 'gregorydepasquale@gmail.com',
    },
    {
      name: 'Maria Chen',
      brokerage: 'Ridgeline Realty',
      photo_emoji: '🌆',
      bio: 'Downtown and riverfront condo specialist. First-time buyers love working with me — I break everything down step by step.',
      specialties: 'Buyers,First-Time Buyers,Condos',
      areas: 'Downtown Chattanooga,Southside',
      years_experience: 8,
      closed_sales: 142,
      rating: 4.8,
      phone: '(423) 555-0112',
      email: 'maria.chen@ridgelinerealty.example',
    },
    {
      name: 'Devon Marsh',
      brokerage: 'Summit & Co.',
      photo_emoji: '⛰️',
      bio: 'Signal Mountain native. I focus on land, new construction, and move-up buyers looking for space and views.',
      specialties: 'Land,New Construction,Move-Up Buyers',
      areas: 'Signal Mountain,Walden',
      years_experience: 12,
      closed_sales: 210,
      rating: 4.7,
      phone: '(423) 555-0176',
      email: 'devon.marsh@summitco.example',
    },
    {
      name: 'Priya Natarajan',
      brokerage: 'Volunteer State Realty',
      photo_emoji: '📊',
      bio: 'Investor-focused agent — cash flow analysis on every listing I send you. Big believer in running the numbers before you tour.',
      specialties: 'Investors,Multi-Family,Commercial',
      areas: 'East Ridge,Brainerd,Chattanooga',
      years_experience: 6,
      closed_sales: 88,
      rating: 4.9,
      phone: '(423) 555-0134',
      email: 'priya.n@volstaterealty.example',
    },
    {
      name: 'Sam Whitfield',
      brokerage: 'Whitfield Home Group',
      photo_emoji: '🔑',
      bio: 'Full-service listing agent for sellers. Staging, pro photography, and a marketing plan included with every listing.',
      specialties: 'Sellers,Listings,Staging',
      areas: 'Hixson,Red Bank',
      years_experience: 15,
      closed_sales: 301,
      rating: 4.8,
      phone: '(423) 555-0198',
      email: 'sam@whitfieldhomegroup.example',
    },
  ];

  for (const r of realtors) {
    insert.run(
      r.name, r.brokerage, r.photo_emoji, r.bio, r.specialties, r.areas,
      r.years_experience, r.closed_sales, r.rating, r.phone, r.email
    );
  }
  console.log(`Seeded ${realtors.length} realtor profiles.`);
}

migrate();
seed();
if (isNewDb) console.log('Created new database at', DB_PATH);

// ---------------- Agent (realtor) subscription helpers ----------------

function getRealtorByEmail(email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM realtors WHERE lower(email) = lower(?)').get(email);
}

function getRealtorByStripeCustomerId(customerId) {
  if (!customerId) return null;
  return db.prepare('SELECT * FROM realtors WHERE stripe_customer_id = ?').get(customerId);
}

function getRealtorByStripeSubscriptionId(subscriptionId) {
  if (!subscriptionId) return null;
  return db.prepare('SELECT * FROM realtors WHERE stripe_subscription_id = ?').get(subscriptionId);
}

// A realtor row counts as "claimed" once it has real login credentials — before that,
// re-submitting the signup form with the same email just edits the in-progress draft
// (e.g. retrying after an abandoned Stripe checkout). Once claimed, only that account's
// owner (via login) should be able to change it — see the 409 check in server.js.
function isRealtorClaimed(row) {
  return Boolean(row.password_hash || row.google_id || row.apple_id);
}

// Create (or reuse, if a prior signup attempt never completed checkout) a pending realtor row.
// fields may include passwordHash, googleId, appleId, emailVerified (account credentials) —
// at least one signup method is expected to be set by the caller.
function upsertPendingRealtor(fields) {
  const existing = getRealtorByEmail(fields.email);
  if (existing && existing.subscription_status !== 'active') {
    db.prepare(`
      UPDATE realtors SET
        name = ?, brokerage = ?, photo_emoji = ?, bio = ?, specialties = ?, areas = ?,
        years_experience = ?, phone = ?, email = ?, state = ?,
        password_hash = COALESCE(?, password_hash),
        google_id = COALESCE(?, google_id),
        apple_id = COALESCE(?, apple_id),
        email_verified = CASE WHEN ? = 1 THEN 1 ELSE email_verified END
      WHERE id = ?
    `).run(
      fields.name, fields.brokerage || null, fields.photoEmoji || '🏠', fields.bio || null,
      fields.specialties || null, fields.areas || null, fields.yearsExperience || null,
      fields.phone || null, fields.email, fields.state || null,
      fields.passwordHash || null, fields.googleId || null, fields.appleId || null,
      fields.emailVerified ? 1 : 0, existing.id
    );
    return db.prepare('SELECT * FROM realtors WHERE id = ?').get(existing.id);
  }
  if (existing && existing.subscription_status === 'active') {
    return existing; // already an active, paying agent — nothing to do
  }
  const info = db.prepare(`
    INSERT INTO realtors
      (name, brokerage, photo_emoji, bio, specialties, areas, years_experience, closed_sales, rating, phone, email, subscription_status, state,
       password_hash, google_id, apple_id, email_verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, 'inactive', ?, ?, ?, ?, ?)
  `).run(
    fields.name, fields.brokerage || null, fields.photoEmoji || '🏠', fields.bio || null,
    fields.specialties || null, fields.areas || null, fields.yearsExperience || null,
    fields.phone || null, fields.email, fields.state || null,
    fields.passwordHash || null, fields.googleId || null, fields.appleId || null, fields.emailVerified ? 1 : 0
  );
  return db.prepare('SELECT * FROM realtors WHERE id = ?').get(info.lastInsertRowid);
}

function updateRealtorSubscription(realtorId, { status, stripeCustomerId, stripeSubscriptionId, currentPeriodEnd }) {
  const current = db.prepare('SELECT * FROM realtors WHERE id = ?').get(realtorId);
  if (!current) return null;
  db.prepare(`
    UPDATE realtors SET
      subscription_status = ?,
      stripe_customer_id = COALESCE(?, stripe_customer_id),
      stripe_subscription_id = COALESCE(?, stripe_subscription_id),
      subscription_current_period_end = COALESCE(?, subscription_current_period_end),
      subscription_updated_at = datetime('now')
    WHERE id = ?
  `).run(status, stripeCustomerId || null, stripeSubscriptionId || null, currentPeriodEnd || null, realtorId);
  return db.prepare('SELECT * FROM realtors WHERE id = ?').get(realtorId);
}

// ---------------- Admin helpers (manual profile management) ----------------

function getAllRealtorsAdmin() {
  return db.prepare('SELECT * FROM realtors ORDER BY id').all();
}

function createRealtorAdmin(fields) {
  const info = db.prepare(`
    INSERT INTO realtors
      (name, brokerage, photo_emoji, bio, specialties, areas, years_experience, closed_sales, rating, phone, email, subscription_status, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.name, fields.brokerage || null, fields.photoEmoji || '🏠', fields.bio || null,
    fields.specialties || null, fields.areas || null, fields.yearsExperience || null,
    fields.closedSales || 0, fields.rating || null, fields.phone || null, fields.email || null,
    fields.subscriptionStatus || 'active', fields.state || null
  );
  return db.prepare('SELECT * FROM realtors WHERE id = ?').get(info.lastInsertRowid);
}

function updateRealtorAdmin(id, fields) {
  const current = db.prepare('SELECT * FROM realtors WHERE id = ?').get(id);
  if (!current) return null;
  db.prepare(`
    UPDATE realtors SET
      name = ?, brokerage = ?, photo_emoji = ?, bio = ?, specialties = ?, areas = ?,
      years_experience = ?, closed_sales = ?, rating = ?, phone = ?, email = ?, subscription_status = ?, state = ?
    WHERE id = ?
  `).run(
    fields.name, fields.brokerage || null, fields.photoEmoji || null, fields.bio || null,
    fields.specialties || null, fields.areas || null, fields.yearsExperience || null,
    fields.closedSales || 0, fields.rating || null, fields.phone || null, fields.email || null,
    fields.subscriptionStatus || current.subscription_status, fields.state || null, id
  );
  return db.prepare('SELECT * FROM realtors WHERE id = ?').get(id);
}

function deleteRealtorAdmin(id) {
  db.prepare('DELETE FROM swipes WHERE realtor_id = ?').run(id);
  db.prepare("DELETE FROM sessions WHERE subject_type = 'realtor' AND subject_id = ?").run(id);
  const info = db.prepare('DELETE FROM realtors WHERE id = ?').run(id);
  return info.changes > 0;
}

// Every client who has ever completed onboarding, whether or not they've matched with
// anyone yet — this is the full lead list, not just the per-realtor "matched" subset.
function getAllClientsAdmin() {
  return db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
}

// Deletes a client signup — used from the admin panel to clean up test accounts or handle
// a deletion request. Also removes their swipes/matches and any active login sessions so a
// stale session cookie can't keep using a deleted account.
function deleteClientAdmin(id) {
  db.prepare('DELETE FROM swipes WHERE client_id = ?').run(id);
  db.prepare("DELETE FROM sessions WHERE subject_type = 'client' AND subject_id = ?").run(id);
  const info = db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  return info.changes > 0;
}

// Headline counts for the admin dashboard. Kept as simple COUNT(*) queries (SQLite handles
// these instantly even at real-world scale for this app) rather than caching, since the admin
// panel is low-traffic and always wants a fresh number.
function getAdminStats() {
  const realtorTotals = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN subscription_status = 'active' THEN 1 ELSE 0 END) AS active
    FROM realtors
  `).get();
  const clientTotals = db.prepare('SELECT COUNT(*) AS total FROM clients').get();
  const matchedClients = db.prepare(`
    SELECT COUNT(DISTINCT client_id) AS total FROM swipes WHERE direction = 'like'
  `).get();
  return {
    totalRealtors: realtorTotals.total || 0,
    activeRealtors: realtorTotals.active || 0,
    totalClients: clientTotals.total || 0,
    matchedClients: matchedClients.total || 0,
  };
}

// Sets (or clears, when photoUrl is null) an uploaded profile photo, independent of the
// text-field form save so a photo upload never accidentally clobbers other fields.
function setRealtorPhoto(id, photoUrl) {
  const current = db.prepare('SELECT * FROM realtors WHERE id = ?').get(id);
  if (!current) return null;
  db.prepare('UPDATE realtors SET photo_url = ? WHERE id = ?').run(photoUrl, id);
  return db.prepare('SELECT * FROM realtors WHERE id = ?').get(id);
}

function setRealtorVideo(id, videoUrl) {
  const current = db.prepare('SELECT * FROM realtors WHERE id = ?').get(id);
  if (!current) return null;
  db.prepare('UPDATE realtors SET video_url = ? WHERE id = ?').run(videoUrl, id);
  return db.prepare('SELECT * FROM realtors WHERE id = ?').get(id);
}

// ---------------- Sessions (both clients and realtors) ----------------

function createSession(subjectType, subjectId, token, ttlDays = 30) {
  // Opportunistic cleanup of expired rows — cheap at this scale, keeps the table from
  // growing forever without needing a separate cron job.
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
  db.prepare(`
    INSERT INTO sessions (token, subject_type, subject_id, expires_at)
    VALUES (?, ?, ?, datetime('now', '+' || ? || ' days'))
  `).run(token, subjectType, subjectId, ttlDays);
}

function getSession(token) {
  if (!token) return null;
  return db.prepare(`SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')`).get(token) || null;
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function deleteAllSessionsForSubject(subjectType, subjectId) {
  db.prepare('DELETE FROM sessions WHERE subject_type = ? AND subject_id = ?').run(subjectType, subjectId);
}

// ---------------- Client account helpers ----------------

function getClientById(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id) || null;
}

function getClientByEmail(email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM clients WHERE lower(email) = lower(?)').get(email) || null;
}

function getClientByGoogleId(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM clients WHERE google_id = ?').get(id) || null;
}

function getClientByAppleId(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM clients WHERE apple_id = ?').get(id) || null;
}

// A client row counts as "claimed" once it has real login credentials. Rows created before
// accounts existed (or an incomplete guest record) have none of these set, so a fresh signup
// with the same email adopts that row (keeping any swipe/match history) instead of erroring.
function isClientClaimed(row) {
  return Boolean(row.password_hash || row.google_id || row.apple_id);
}

// Password signup. Returns { client, claimed } — claimed=true means an existing unclaimed
// guest row was adopted rather than a brand-new row being created.
function createClientAccount(fields) {
  const existing = getClientByEmail(fields.email);
  if (existing) {
    db.prepare(`
      UPDATE clients SET
        name = ?, phone = COALESCE(?, phone), intent = COALESCE(?, intent),
        area_interest = COALESCE(?, area_interest), state = COALESCE(?, state),
        password_hash = ?, verify_token = ?, verify_token_expires = ?
      WHERE id = ?
    `).run(
      fields.name, fields.phone || null, fields.intent || null, fields.area || null,
      fields.state || null, fields.passwordHash, fields.verifyToken || null,
      fields.verifyTokenExpires || null, existing.id
    );
    return { client: getClientById(existing.id), claimed: true };
  }
  const info = db.prepare(`
    INSERT INTO clients (name, phone, email, intent, area_interest, state, password_hash, verify_token, verify_token_expires)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.name, fields.phone || null, fields.email, fields.intent || null, fields.area || null,
    fields.state || null, fields.passwordHash, fields.verifyToken || null, fields.verifyTokenExpires || null
  );
  return { client: getClientById(info.lastInsertRowid), claimed: false };
}

// Google/Apple sign-in for clients: find by provider id, else link an existing row by email
// (claiming it, same as password signup), else create a fresh minimal account. Returns
// { client, isNew } — isNew=true means this is their very first sign-in (used to route them
// through the "tell us what you're looking for" step instead of straight into the app).
function createOrLinkClientOAuth({ provider, sub, email, name }) {
  const getByProvider = provider === 'google' ? getClientByGoogleId : getClientByAppleId;
  const providerColumn = provider === 'google' ? 'google_id' : 'apple_id';

  const byProvider = getByProvider(sub);
  if (byProvider) return { client: byProvider, isNew: false };

  const byEmail = email ? getClientByEmail(email) : null;
  if (byEmail) {
    db.prepare(`UPDATE clients SET ${providerColumn} = ?, email_verified = 1 WHERE id = ?`).run(sub, byEmail.id);
    return { client: getClientById(byEmail.id), isNew: false };
  }

  const info = db.prepare(`
    INSERT INTO clients (name, email, ${providerColumn}, email_verified)
    VALUES (?, ?, ?, 1)
  `).run(name || 'New Client', email || null, sub);
  return { client: getClientById(info.lastInsertRowid), isNew: true };
}

function updateClientProfile(id, fields) {
  const current = getClientById(id);
  if (!current) return null;
  db.prepare(`
    UPDATE clients SET
      name = COALESCE(?, name), phone = COALESCE(?, phone), intent = COALESCE(?, intent),
      area_interest = COALESCE(?, area_interest), state = COALESCE(?, state),
      timeline = COALESCE(?, timeline), budget_range = COALESCE(?, budget_range),
      property_type = COALESCE(?, property_type)
    WHERE id = ?
  `).run(
    fields.name || null, fields.phone || null, fields.intent || null, fields.area || null, fields.state || null,
    fields.timeline || null, fields.budgetRange || null, fields.propertyType || null, id
  );
  return getClientById(id);
}

function setClientPasswordHash(id, hash) {
  db.prepare('UPDATE clients SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?').run(hash, id);
}

function setClientResetToken(id, token, expiresAt) {
  db.prepare('UPDATE clients SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(token, expiresAt, id);
}

function getClientByResetToken(token) {
  if (!token) return null;
  return db.prepare(`SELECT * FROM clients WHERE reset_token = ? AND reset_token_expires > datetime('now')`).get(token) || null;
}

function getClientByVerifyToken(token) {
  if (!token) return null;
  return db.prepare(`SELECT * FROM clients WHERE verify_token = ? AND verify_token_expires > datetime('now')`).get(token) || null;
}

function markClientEmailVerified(id) {
  db.prepare('UPDATE clients SET email_verified = 1, verify_token = NULL, verify_token_expires = NULL WHERE id = ?').run(id);
}

// ---------------- Realtor account helpers ----------------

function getRealtorById(id) {
  return db.prepare('SELECT * FROM realtors WHERE id = ?').get(id) || null;
}

function getRealtorByGoogleId(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM realtors WHERE google_id = ?').get(id) || null;
}

function getRealtorByAppleId(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM realtors WHERE apple_id = ?').get(id) || null;
}

// Login-only lookup for returning realtors signing in via Google/Apple (does NOT create an
// account — realtor profiles need brokerage/bio/specialties that only the signup form
// collects). Links the provider id to a matching email if that email exists but was
// registered a different way. Returns the realtor row, or null if no match.
function findRealtorForOAuthLogin(provider, sub, email) {
  const getByProvider = provider === 'google' ? getRealtorByGoogleId : getRealtorByAppleId;
  const providerColumn = provider === 'google' ? 'google_id' : 'apple_id';

  const byProvider = getByProvider(sub);
  if (byProvider) return byProvider;

  const byEmail = email ? getRealtorByEmail(email) : null;
  if (byEmail) {
    db.prepare(`UPDATE realtors SET ${providerColumn} = ?, email_verified = 1 WHERE id = ?`).run(sub, byEmail.id);
    return getRealtorById(byEmail.id);
  }
  return null;
}

function setRealtorPasswordHash(id, hash) {
  db.prepare('UPDATE realtors SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?').run(hash, id);
}

function setRealtorResetToken(id, token, expiresAt) {
  db.prepare('UPDATE realtors SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(token, expiresAt, id);
}

function getRealtorByResetToken(token) {
  if (!token) return null;
  return db.prepare(`SELECT * FROM realtors WHERE reset_token = ? AND reset_token_expires > datetime('now')`).get(token) || null;
}

function getRealtorByVerifyToken(token) {
  if (!token) return null;
  return db.prepare(`SELECT * FROM realtors WHERE verify_token = ? AND verify_token_expires > datetime('now')`).get(token) || null;
}

function markRealtorEmailVerified(id) {
  db.prepare('UPDATE realtors SET email_verified = 1, verify_token = NULL, verify_token_expires = NULL WHERE id = ?').run(id);
}

function setRealtorVerifyToken(id, token, expiresAt) {
  db.prepare('UPDATE realtors SET verify_token = ?, verify_token_expires = ? WHERE id = ?').run(token, expiresAt, id);
}

function setClientVerifyToken(id, token, expiresAt) {
  db.prepare('UPDATE clients SET verify_token = ?, verify_token_expires = ? WHERE id = ?').run(token, expiresAt, id);
}

module.exports = {
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
  deleteClientAdmin,
  getAdminStats,
  // sessions
  createSession,
  getSession,
  deleteSession,
  deleteAllSessionsForSubject,
  // client accounts
  getClientById,
  getClientByEmail,
  getClientByGoogleId,
  getClientByAppleId,
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
  // realtor accounts
  getRealtorById,
  getRealtorByGoogleId,
  getRealtorByAppleId,
  findRealtorForOAuthLogin,
  setRealtorPasswordHash,
  setRealtorResetToken,
  getRealtorByResetToken,
  getRealtorByVerifyToken,
  markRealtorEmailVerified,
  setRealtorVerifyToken,
};
