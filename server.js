// server.js — zero-dependency HTTP server (no express) serving the API + static frontend.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const {
  db,
  getRealtorByEmail,
  getRealtorByStripeCustomerId,
  getRealtorByStripeSubscriptionId,
  upsertPendingRealtor,
  updateRealtorSubscription,
} = require('./db');
const stripe = require('./stripe');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new Error('Body too large')); req.destroy(); return; }
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

function realtorToPublic(row) {
  return {
    id: row.id,
    name: row.name,
    brokerage: row.brokerage,
    photoEmoji: row.photo_emoji,
    bio: row.bio,
    specialties: (row.specialties || '').split(',').filter(Boolean),
    areas: (row.areas || '').split(',').filter(Boolean),
    yearsExperience: row.years_experience,
    closedSales: row.closed_sales,
    rating: row.rating,
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

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // POST /api/clients  { name, phone, email, intent, area }
  if (req.method === 'POST' && parts[1] === 'clients' && parts.length === 2) {
    const body = await readBody(req);
    const name = (body.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'name is required' });
    const stmt = db.prepare(`
      INSERT INTO clients (name, phone, email, intent, area_interest)
      VALUES (?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      name,
      (body.phone || '').trim() || null,
      (body.email || '').trim() || null,
      (body.intent || '').trim() || null,
      (body.area || '').trim() || null
    );
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
    return sendJson(res, 201, { client });
  }

  // GET /api/realtors?client_id=X  -> active, paid realtors not yet swiped by this client
  if (req.method === 'GET' && parts[1] === 'realtors' && parts.length === 2) {
    const clientId = Number(url.searchParams.get('client_id'));
    let rows;
    if (clientId) {
      rows = db.prepare(`
        SELECT * FROM realtors
        WHERE subscription_status = 'active'
          AND id NOT IN (SELECT realtor_id FROM swipes WHERE client_id = ?)
        ORDER BY id
      `).all(clientId);
    } else {
      rows = db.prepare(`SELECT * FROM realtors WHERE subscription_status = 'active' ORDER BY id`).all();
    }
    return sendJson(res, 200, { realtors: rows.map(realtorToPublic) });
  }

  // POST /api/swipe  { client_id, realtor_id, direction }
  if (req.method === 'POST' && parts[1] === 'swipe' && parts.length === 2) {
    const body = await readBody(req);
    const clientId = Number(body.client_id);
    const realtorId = Number(body.realtor_id);
    const direction = body.direction;
    if (!clientId || !realtorId || !['like', 'pass'].includes(direction)) {
      return sendJson(res, 400, { error: 'client_id, realtor_id, and direction (like|pass) are required' });
    }
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
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

  // GET /api/matches/:clientId
  if (req.method === 'GET' && parts[1] === 'matches' && parts.length === 3) {
    const clientId = Number(parts[2]);
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

  // GET /api/realtor/:id  -> profile (for the realtor's own dashboard header)
  if (req.method === 'GET' && parts[1] === 'realtor' && parts.length === 3) {
    const realtor = db.prepare('SELECT * FROM realtors WHERE id = ?').get(Number(parts[2]));
    if (!realtor) return sendJson(res, 404, { error: 'realtor not found' });
    return sendJson(res, 200, { realtor: realtorToOwner(realtor) });
  }

  // POST /api/agents/signup  { name, brokerage, email, phone, bio, specialties, areas, yearsExperience, photoEmoji }
  // Creates (or reuses a not-yet-paid) realtor row, then starts a Stripe subscription checkout.
  if (req.method === 'POST' && parts[1] === 'agents' && parts[2] === 'signup' && parts.length === 3) {
    const body = await readBody(req);
    const name = (body.name || '').trim();
    const email = (body.email || '').trim();
    if (!name) return sendJson(res, 400, { error: 'name is required' });
    if (!email) return sendJson(res, 400, { error: 'email is required' });
    if (!STRIPE_PRICE_ID) {
      return sendJson(res, 503, { error: 'Agent subscriptions are not configured yet. Set STRIPE_PRICE_ID.' });
    }

    const existing = getRealtorByEmail(email);
    if (existing && existing.subscription_status === 'active') {
      return sendJson(res, 409, { error: 'An agent with this email is already listed and active.' });
    }

    const realtor = upsertPendingRealtor({
      name,
      brokerage: (body.brokerage || '').trim(),
      photoEmoji: (body.photoEmoji || '🏠').trim(),
      bio: (body.bio || '').trim(),
      specialties: Array.isArray(body.specialties) ? body.specialties.join(',') : (body.specialties || '').trim(),
      areas: Array.isArray(body.areas) ? body.areas.join(',') : (body.areas || '').trim(),
      yearsExperience: body.yearsExperience ? Number(body.yearsExperience) : null,
      phone: (body.phone || '').trim(),
      email,
    });

    const origin = `https://${req.headers.host}`;
    try {
      const session = await stripe.createCheckoutSession({
        priceId: STRIPE_PRICE_ID,
        successUrl: `${origin}/agent-success.html?session_id={CHECKOUT_SESSION_ID}&realtor_id=${realtor.id}`,
        cancelUrl: `${origin}/agent-signup.html?canceled=1`,
        customerEmail: email,
        realtorId: realtor.id,
      });
      return sendJson(res, 200, { checkoutUrl: session.url });
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

  // GET /api/realtor/:id/leads  -> clients who matched with this realtor (leads inbox)
  if (req.method === 'GET' && parts[1] === 'realtor' && parts[3] === 'leads' && parts.length === 4) {
    const realtorId = Number(parts[2]);
    const rows = db.prepare(`
      SELECT c.*, s.created_at AS matched_at FROM swipes s
      JOIN clients c ON c.id = s.client_id
      WHERE s.realtor_id = ? AND s.direction = 'like'
      ORDER BY s.created_at DESC
    `).all(realtorId);
    return sendJson(res, 200, {
      leads: rows.map((c) => ({
        id: c.id, name: c.name, phone: c.phone, email: c.email,
        intent: c.intent, areaInterest: c.area_interest, matchedAt: c.matched_at,
      })),
    });
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
