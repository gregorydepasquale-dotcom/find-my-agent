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

// Create (or reuse, if a prior signup attempt never completed checkout) a pending realtor row.
function upsertPendingRealtor(fields) {
  const existing = getRealtorByEmail(fields.email);
  if (existing && existing.subscription_status !== 'active') {
    db.prepare(`
      UPDATE realtors SET
        name = ?, brokerage = ?, photo_emoji = ?, bio = ?, specialties = ?, areas = ?,
        years_experience = ?, phone = ?, email = ?
      WHERE id = ?
    `).run(
      fields.name, fields.brokerage || null, fields.photoEmoji || '🏠', fields.bio || null,
      fields.specialties || null, fields.areas || null, fields.yearsExperience || null,
      fields.phone || null, fields.email, existing.id
    );
    return db.prepare('SELECT * FROM realtors WHERE id = ?').get(existing.id);
  }
  if (existing && existing.subscription_status === 'active') {
    return existing; // already an active, paying agent — nothing to do
  }
  const info = db.prepare(`
    INSERT INTO realtors
      (name, brokerage, photo_emoji, bio, specialties, areas, years_experience, closed_sales, rating, phone, email, subscription_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, 'inactive')
  `).run(
    fields.name, fields.brokerage || null, fields.photoEmoji || '🏠', fields.bio || null,
    fields.specialties || null, fields.areas || null, fields.yearsExperience || null,
    fields.phone || null, fields.email
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

module.exports = {
  db,
  getRealtorByEmail,
  getRealtorByStripeCustomerId,
  getRealtorByStripeSubscriptionId,
  upsertPendingRealtor,
  updateRealtorSubscription,
};
