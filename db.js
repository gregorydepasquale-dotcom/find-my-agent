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

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM realtors').get().c;
  if (count > 0) return;

  const insert = db.prepare(`
    INSERT INTO realtors
      (name, brokerage, photo_emoji, bio, specialties, areas, years_experience, closed_sales, rating, phone, email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

seed();
if (isNewDb) console.log('Created new database at', DB_PATH);

module.exports = { db };
