// stripe.js — minimal Stripe API client using node:https. No npm package required,
// keeping this project's zero-dependency architecture even for billing.
'use strict';

const https = require('node:https');
const crypto = require('node:crypto');

const STRIPE_API_HOST = 'api.stripe.com';

function secretKey() {
  return process.env.STRIPE_SECRET_KEY || '';
}

// Stripe expects PHP-style nested form encoding, e.g. line_items[0][price]=price_123
function encodeParams(obj, prefix) {
  const pairs = [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val === undefined || val === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(val)) {
      val.forEach((item, i) => {
        if (item !== null && typeof item === 'object') {
          pairs.push(...encodeParams(item, `${fullKey}[${i}]`));
        } else {
          pairs.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else if (typeof val === 'object') {
      pairs.push(...encodeParams(val, fullKey));
    } else {
      pairs.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(val)}`);
    }
  }
  return pairs;
}

function stripeRequest(method, path, params) {
  return new Promise((resolve, reject) => {
    const key = secretKey();
    if (!key) return reject(new Error('STRIPE_SECRET_KEY is not configured'));

    const body = params ? encodeParams(params).join('&') : '';
    const options = {
      hostname: STRIPE_API_HOST,
      path,
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${key}:`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json;
        try {
          json = data ? JSON.parse(data) : {};
        } catch (e) {
          return reject(new Error('Invalid response from Stripe'));
        }
        if (res.statusCode >= 400) {
          return reject(new Error((json.error && json.error.message) || `Stripe API error (${res.statusCode})`));
        }
        resolve(json);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function createCheckoutSession({ priceId, successUrl, cancelUrl, customerEmail, realtorId }) {
  return stripeRequest('POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customerEmail || undefined,
    client_reference_id: String(realtorId),
    subscription_data: { metadata: { realtor_id: String(realtorId) } },
    metadata: { realtor_id: String(realtorId) },
  });
}

function createBillingPortalSession({ customerId, returnUrl }) {
  return stripeRequest('POST', '/v1/billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl,
  });
}

function retrieveSubscription(subscriptionId) {
  return stripeRequest('GET', `/v1/subscriptions/${subscriptionId}`);
}

// Cancels immediately (not at period end) — used when a realtor deletes their own account,
// so closing the account also stops future billing rather than leaving the subscription active.
function cancelSubscription(subscriptionId) {
  return stripeRequest('DELETE', `/v1/subscriptions/${subscriptionId}`);
}

// Verifies the Stripe-Signature header against the raw request body without needing the SDK.
function verifyWebhookSignature(rawBody, signatureHeader, webhookSecret, toleranceSeconds = 300) {
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  if (!signatureHeader) throw new Error('Missing Stripe-Signature header');

  const parsed = signatureHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    if (k === 't') acc.timestamp = v;
    if (k === 'v1') { acc.signatures = acc.signatures || []; acc.signatures.push(v); }
    return acc;
  }, {});
  if (!parsed.timestamp || !parsed.signatures) throw new Error('Malformed Stripe-Signature header');

  const signedPayload = `${parsed.timestamp}.${rawBody}`;
  const expectedSig = crypto.createHmac('sha256', webhookSecret).update(signedPayload, 'utf8').digest('hex');

  const matches = parsed.signatures.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
    } catch (e) {
      return false;
    }
  });
  if (!matches) throw new Error('Webhook signature verification failed');

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(parsed.timestamp));
  if (ageSeconds > toleranceSeconds) throw new Error('Webhook timestamp too old');

  return true;
}

module.exports = {
  createCheckoutSession,
  createBillingPortalSession,
  retrieveSubscription,
  cancelSubscription,
  verifyWebhookSignature,
};
