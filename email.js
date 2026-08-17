// email.js — transactional email via Resend's HTTP API (https://resend.com), using node:https
// directly instead of the Resend SDK, matching this app's zero-npm-dependency approach.
//
// If RESEND_API_KEY isn't set, sends are skipped (logged, not thrown) so account creation and
// password resets keep working without email — the caller should treat this as best-effort.

const https = require('node:https');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'Agentr <onboarding@resend.dev>';

function sendEmail({ to, subject, html }) {
  return new Promise((resolve, reject) => {
    if (!RESEND_API_KEY) {
      console.warn(`RESEND_API_KEY not set — skipping email to ${to}: "${subject}"`);
      resolve({ skipped: true });
      return;
    }
    const body = JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html });
    const req = https.request(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data || '{}'));
          } else {
            reject(new Error(`Resend API error ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function wrapHtml(bodyHtml) {
  return `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #15110a;">
      <h2 style="margin: 0 0 16px;">Agen<span style="color:#e9c21c;">tr</span></h2>
      ${bodyHtml}
      <p style="margin-top: 32px; font-size: 12px; color: #888;">Agentr — swipe to find your agent.</p>
    </div>
  `;
}

// Best-effort — failures are logged, never thrown, so a broken email provider never blocks
// signup/reset flows that otherwise succeeded.
function sendVerificationEmail(to, verifyUrl) {
  return sendEmail({
    to,
    subject: 'Verify your Agentr email',
    html: wrapHtml(`
      <p>Welcome to Agentr! Click below to verify your email address.</p>
      <p><a href="${verifyUrl}" style="display:inline-block; background:#e9c21c; color:#15110a; font-weight:bold; padding:12px 20px; border-radius:10px; text-decoration:none;">Verify email</a></p>
      <p style="font-size:13px; color:#666;">If you didn't sign up for Agentr, you can safely ignore this email.</p>
    `),
  }).catch((e) => console.error('sendVerificationEmail failed:', e.message));
}

function sendPasswordResetEmail(to, resetUrl) {
  return sendEmail({
    to,
    subject: 'Reset your Agentr password',
    html: wrapHtml(`
      <p>Click below to reset your password. This link expires in 1 hour.</p>
      <p><a href="${resetUrl}" style="display:inline-block; background:#e9c21c; color:#15110a; font-weight:bold; padding:12px 20px; border-radius:10px; text-decoration:none;">Reset password</a></p>
      <p style="font-size:13px; color:#666;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
    `),
  }).catch((e) => console.error('sendPasswordResetEmail failed:', e.message));
}

module.exports = { sendEmail, sendVerificationEmail, sendPasswordResetEmail };
