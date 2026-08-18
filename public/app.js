// app.js — vanilla JS SPA. No build step, no framework, no external deps (beyond the
// optional Google/Apple sign-in SDKs, loaded from index.html and only used if configured).
(function () {
  'use strict';

  const app = document.getElementById('app');

  const US_STATES = [
    ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
    ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
    ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
    ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
    ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
    ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
    ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
    ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
    ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
    ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
    ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
  ];
  function stateOptionsHtml(selected) {
    return '<option value="">Select a state…</option>' + US_STATES.map(
      ([code, name]) => `<option value="${code}"${code === selected ? ' selected' : ''}>${name}</option>`
    ).join('');
  }

  // ---------------- API helpers ----------------
  async function api(path, opts) {
    const res = await fetch('/api' + path, {
      method: (opts && opts.method) || 'GET',
      headers: opts && opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function esc(s) {
    return (s || '').toString().replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------------- Google / Apple sign-in (progressive — buttons only appear once the
  // server reports GOOGLE_CLIENT_ID / APPLE_SERVICES_ID are configured) ----------------
  let authConfigPromise = null;
  function getAuthConfig() {
    if (!authConfigPromise) {
      authConfigPromise = api('/auth/config').catch(() => ({ googleClientId: null, appleServicesId: null, appleRedirectUri: null }));
    }
    return authConfigPromise;
  }

  function waitForGlobal(check, tries, interval) {
    return new Promise((resolve) => {
      (function attempt(n) {
        if (check()) return resolve(true);
        if (n <= 0) return resolve(false);
        setTimeout(() => attempt(n - 1), interval || 250);
      })(tries == null ? 16 : tries);
    });
  }

  // Renders Google + Apple buttons into `container` when configured. `onToken(provider,
  // idToken, displayName)` is called on success; displayName is only ever non-null the very
  // first time someone signs in with Apple (Apple only sends the name once, per its API).
  async function renderOAuthButtons(container, onToken) {
    const cfg = await getAuthConfig();
    if (!cfg.googleClientId && !cfg.appleServicesId) return;

    const row = el(`<div class="oauth-row"></div>`);
    container.appendChild(row);

    if (cfg.googleClientId) {
      const ready = await waitForGlobal(() => window.google && window.google.accounts && window.google.accounts.id);
      if (ready) {
        const slot = el(`<div class="oauth-btn-slot"></div>`);
        row.appendChild(slot);
        try {
          window.google.accounts.id.initialize({
            client_id: cfg.googleClientId,
            callback: (resp) => onToken('google', resp.credential, null),
          });
          window.google.accounts.id.renderButton(slot, { theme: 'filled_black', size: 'large', shape: 'pill', width: 260 });
        } catch (e) { /* non-fatal — button just won't appear */ }
      }
    }

    if (cfg.appleServicesId) {
      const ready = await waitForGlobal(() => window.AppleID && window.AppleID.auth);
      if (ready) {
        try {
          window.AppleID.auth.init({
            clientId: cfg.appleServicesId,
            scope: 'name email',
            redirectURI: cfg.appleRedirectUri || window.location.origin,
            usePopup: true,
          });
          const btn = el(`<button type="button" class="btn btn-apple"> Continue with Apple</button>`);
          row.appendChild(btn);
          btn.addEventListener('click', async () => {
            try {
              const data = await window.AppleID.auth.signIn();
              const u = data.user && data.user.name;
              const name = u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || null : null;
              onToken('apple', data.authorization.id_token, name);
            } catch (e) {
              if (e && e.error !== 'popup_closed_by_user') alert('Apple sign-in failed. Please try again.');
            }
          });
        } catch (e) { /* non-fatal */ }
      }
    }
  }

  // ---------------- Router ----------------
  const path = window.location.pathname;
  const realtorDashMatch = path.match(/^\/realtor\/(\d+)/);

  if (realtorDashMatch) {
    renderRealtorDashboard(Number(realtorDashMatch[1]));
  } else {
    boot();
  }

  async function boot() {
    try {
      const me = await api('/auth/me');
      if (me.role === 'client') {
        renderClientApp(me.client.id);
        return;
      }
    } catch (e) {
      // not signed in — fall through to the splash screen
    }
    renderOnboarding();
  }

  // ---------------- Onboarding ----------------
  // First-run entry point: a Tinder-style splash (big wordmark, tagline, card-stack
  // visual, single CTA) rather than dropping straight into a form.
  function renderOnboarding() {
    renderSplash();
  }

  function renderSplash() {
    app.innerHTML = '';
    app.appendChild(el(`
      <div class="screen splash">
        <div class="splash-cards" aria-hidden="true">
          <div class="splash-card c1"></div>
          <div class="splash-card c2"></div>
          <div class="splash-card c3"></div>
        </div>
        <div class="splash-content">
          <div class="splash-logo">Agen<span class="accent">tr</span></div>
          <h1 class="splash-tagline">Find Your<br/><span class="accent">Agent</span>.</h1>
          <p class="splash-sub">Swipe through real agent profiles and match with the right one for you. Free, no obligation.</p>
          <button class="btn btn-primary splash-cta" id="splash-start" type="button">Get Started</button>
          <p class="hint">Already have an account? <a href="#" id="splash-login" style="color:#fff;">Log in</a></p>
          <p class="hint">Real estate agent? <a href="/agent-signup.html" style="color:#fff;">List your profile — $49/mo</a></p>
          <p class="hint" style="margin-top:-4px;"><a href="/privacy.html" style="color:rgba(255,255,255,0.5);">Privacy Policy</a></p>
        </div>
      </div>
    `));
    document.getElementById('splash-start').addEventListener('click', () => renderAuthScreen('signup'));
    document.getElementById('splash-login').addEventListener('click', (e) => { e.preventDefault(); renderAuthScreen('login'); });
  }

  // ---------------- Client auth (signup / login, shared screen) ----------------
  function renderAuthScreen(mode) {
    const isSignup = mode === 'signup';
    app.innerHTML = '';
    app.appendChild(el(`
      <div class="screen onboarding">
        <div class="brand"><img src="/img/ikonick-logo.png" alt="IKONICK" /><span class="brand-text">Agen<span class="accent">tr</span></span></div>
        <h1>${isSignup ? 'Create your<br/>account.' : 'Welcome<br/>back.'}</h1>
        <p class="sub">${isSignup ? "We'll save your matches so you can pick up right where you left off." : 'Log in to see your matches and keep swiping.'}</p>
        <div id="oauth-container"></div>
        <div class="divider"><span>or</span></div>
        <div class="error-banner" id="auth-error" style="display:none;"></div>
        <form id="auth-form" style="display:flex; flex-direction:column; gap:14px;">
          ${isSignup ? `
            <div class="field"><label>Your name</label><input type="text" name="name" placeholder="Jane Smith" required /></div>
            <div class="field"><label>Phone (optional)</label><input type="tel" name="phone" placeholder="(423) 555-0100" /></div>
          ` : ''}
          <div class="field"><label>Email</label><input type="email" name="email" placeholder="jane@example.com" required /></div>
          <div class="field"><label>Password</label><input type="password" name="password" placeholder="${isSignup ? 'At least 8 characters' : '••••••••'}" minlength="8" required /></div>
          <button class="btn btn-primary" type="submit">${isSignup ? 'Create account →' : 'Log in →'}</button>
          ${!isSignup ? `<p class="hint" style="margin:-6px 0 0;"><a href="#" id="forgot-link" style="color:#fff;">Forgot password?</a></p>` : ''}
        </form>
        <p class="hint">${isSignup ? 'Already have an account?' : "Don't have an account?"} <a href="#" id="mode-toggle" style="color:#fff;">${isSignup ? 'Log in' : 'Sign up'}</a></p>
      </div>
    `));

    const errorBanner = document.getElementById('auth-error');
    function showError(msg) { errorBanner.textContent = msg; errorBanner.style.display = 'block'; }

    document.getElementById('mode-toggle').addEventListener('click', (e) => { e.preventDefault(); renderAuthScreen(isSignup ? 'login' : 'signup'); });
    const forgotLink = document.getElementById('forgot-link');
    if (forgotLink) forgotLink.addEventListener('click', (e) => { e.preventDefault(); renderForgotPassword('client', () => renderAuthScreen('login')); });

    renderOAuthButtons(document.getElementById('oauth-container'), async (provider, idToken, name) => {
      errorBanner.style.display = 'none';
      try {
        const { client, isNew } = await api('/auth/client/oauth', { method: 'POST', body: { provider, idToken, name } });
        if (isNew) renderCompleteProfile(client.id);
        else renderClientApp(client.id);
      } catch (err) {
        showError(err.message);
      }
    });

    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      errorBanner.style.display = 'none';
      try {
        if (isSignup) {
          const { client } = await api('/clients', {
            method: 'POST',
            body: { name: fd.get('name'), phone: fd.get('phone'), email: fd.get('email'), password: fd.get('password') },
          });
          renderCompleteProfile(client.id);
        } else {
          const { client } = await api('/auth/client/login', {
            method: 'POST',
            body: { email: fd.get('email'), password: fd.get('password') },
          });
          renderClientApp(client.id);
        }
      } catch (err) {
        btn.disabled = false;
        showError(err.message);
      }
    });
  }

  // Shared by client + realtor "forgot password" — role is 'client' or 'realtor'.
  function renderForgotPassword(role, onBack) {
    app.innerHTML = '';
    app.appendChild(el(`
      <div class="screen onboarding">
        <div class="brand"><img src="/img/ikonick-logo.png" alt="IKONICK" /><span class="brand-text">Agen<span class="accent">tr</span></span></div>
        <h1>Reset your<br/>password.</h1>
        <p class="sub">Enter your email and we'll send you a reset link.</p>
        <div class="error-banner" id="fp-msg" style="display:none;"></div>
        <form id="fp-form" style="display:flex; flex-direction:column; gap:14px;">
          <div class="field"><label>Email</label><input type="email" name="email" required /></div>
          <button class="btn btn-primary" type="submit">Send reset link →</button>
          <button class="btn btn-secondary" type="button" id="fp-back">← Back</button>
        </form>
      </div>
    `));
    document.getElementById('fp-back').addEventListener('click', onBack);
    document.getElementById('fp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        await api('/auth/forgot-password', { method: 'POST', body: { email: fd.get('email'), role } });
        const msg = document.getElementById('fp-msg');
        msg.style.background = 'rgba(52,150,90,0.2)';
        msg.style.borderColor = 'rgba(52,150,90,0.6)';
        msg.textContent = "If that email is registered, we've sent a reset link — check your inbox.";
        msg.style.display = 'block';
        e.target.querySelector('input[name=email]').disabled = true;
        btn.remove();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Send reset link →';
        const msg = document.getElementById('fp-msg');
        msg.textContent = err.message;
        msg.style.display = 'block';
      }
    });
  }

  // "Tell us what you're looking for" — collected once, right after an account is first
  // created (password signup or first-ever Google/Apple sign-in).
  function renderCompleteProfile(clientId) {
    app.innerHTML = '';
    app.appendChild(el(`
      <div class="screen onboarding">
        <div class="brand"><img src="/img/ikonick-logo.png" alt="IKONICK" /><span class="brand-text">Agen<span class="accent">tr</span></span></div>
        <h1>Swipe. Match.<br/>Meet your agent.</h1>
        <p class="sub">Tell us a bit about what you're looking for, then swipe through agents near you to find the right fit.</p>
        <form id="profile-form" style="display:flex; flex-direction:column; gap:14px;">
          <div class="field">
            <label>State</label>
            <select name="state" required>${stateOptionsHtml()}</select>
          </div>
          <div class="field">
            <label>City or zip code (optional)</label>
            <input type="text" name="city" placeholder="e.g. Austin or 78701" />
          </div>
          <div class="field">
            <label>I'm looking to...</label>
            <select name="intent">
              <option value="buy">Buy a home</option>
              <option value="sell">Sell a home</option>
              <option value="invest">Invest / STR</option>
              <option value="rent">Rent</option>
            </select>
          </div>
          <p class="hint" style="margin: 2px 0 -4px;">A few optional questions that help us find your best-fit agent. Skip anything you're not sure about — you can always start swiping right away.</p>
          <div class="field">
            <label>Timeline (optional)</label>
            <select name="timeline">
              <option value="">No preference</option>
              <option value="ASAP">ASAP</option>
              <option value="1-3 months">1–3 months</option>
              <option value="3-6 months">3–6 months</option>
              <option value="Just researching">Just researching</option>
            </select>
          </div>
          <div class="field">
            <label>Budget (optional)</label>
            <select name="budget">
              <option value="">No preference</option>
              <option value="Under $200k">Under $200k</option>
              <option value="$200k-$400k">$200k–$400k</option>
              <option value="$400k-$600k">$400k–$600k</option>
              <option value="$600k-$800k">$600k–$800k</option>
              <option value="$800k-$1M">$800k–$1M</option>
              <option value="$1M+">$1M+</option>
            </select>
          </div>
          <div class="field">
            <label>Property type (optional)</label>
            <select name="propertyType">
              <option value="">No preference</option>
              <option value="Single-family home">Single-family home</option>
              <option value="Condo/Townhouse">Condo/Townhouse</option>
              <option value="Multi-family">Multi-family</option>
              <option value="Land">Land</option>
              <option value="New construction">New construction</option>
            </select>
          </div>
          <button class="btn btn-primary" type="submit">Start swiping →</button>
        </form>
      </div>
    `));

    document.getElementById('profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await api('/clients/me', {
          method: 'PATCH',
          body: {
            intent: fd.get('intent'),
            area: fd.get('city'),
            state: fd.get('state'),
            timeline: fd.get('timeline'),
            budget: fd.get('budget'),
            propertyType: fd.get('propertyType'),
          },
        });
        renderClientApp(clientId);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Start swiping →';
        alert('Something went wrong: ' + err.message);
      }
    });
  }

  // ---------------- Client app (swipe + matches) ----------------
  function renderClientApp(clientId) {
    let currentTab = 'swipe';
    let realtors = [];
    let loading = true;

    async function load() {
      loading = true;
      draw();
      try {
        const data = await api('/realtors');
        realtors = data.realtors;
      } catch (e) {
        realtors = [];
      }
      loading = false;
      draw();
    }

    function shell(innerHtml) {
      app.innerHTML = '';
      const wrap = el(`
        <div style="display:flex; flex-direction:column; min-height:100vh; min-height:100dvh; width:100%;">
          <div class="topbar">
            <div class="brand"><img src="/img/ikonick-logo.png" alt="IKONICK" /><span class="brand-text">Agen<span class="accent">tr</span></span></div>
            <button class="btn btn-secondary" id="logout-btn" style="padding:8px 14px; font-size:12px;">Log out</button>
          </div>
          <div id="tab-content" style="flex:1; display:flex; flex-direction:column;"></div>
          <div class="bottom-nav">
            <button data-tab="swipe" class="${currentTab === 'swipe' ? 'active' : ''}">
              <span class="ic">🔥</span>Discover
            </button>
            <button data-tab="matches" class="${currentTab === 'matches' ? 'active' : ''}">
              <span class="ic">💬</span>Matches
            </button>
            <button data-tab="account" class="${currentTab === 'account' ? 'active' : ''}">
              <span class="ic">⚙️</span>Account
            </button>
          </div>
        </div>
      `);
      wrap.querySelector('#tab-content').innerHTML = innerHtml;
      app.appendChild(wrap);

      wrap.querySelectorAll('.bottom-nav button').forEach((b) => {
        b.addEventListener('click', () => {
          currentTab = b.dataset.tab;
          draw();
        });
      });
      wrap.querySelector('#logout-btn').addEventListener('click', async () => {
        try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
        renderOnboarding();
      });
      return wrap;
    }

    function draw() {
      if (currentTab === 'swipe') {
        drawSwipe();
      } else if (currentTab === 'matches') {
        drawMatches();
      } else {
        drawAccount();
      }
    }

    function drawAccount() {
      shell(`
        <div class="screen" style="padding-top:16px;">
          <div style="background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.1); border-radius:16px; padding:20px;">
            <h3 style="margin:0 0 4px;">Account</h3>
            <p style="color:rgba(255,255,255,0.6); font-size:13px; margin:0 0 18px;">Manage your Agentr account.</p>
            <button class="btn btn-secondary" id="delete-account-btn" style="border-color:#c0392b; color:#e57368;">Delete my account</button>
            <p style="color:rgba(255,255,255,0.4); font-size:12px; margin-top:10px;">This permanently deletes your profile, matches, and swipe history. This cannot be undone.</p>
            <div class="error-banner" id="delete-account-error" style="display:none;"></div>
          </div>
        </div>
      `);
      const btn = document.getElementById('delete-account-btn');
      btn.addEventListener('click', async () => {
        if (!confirm('Delete your Agentr account? This permanently removes your profile and matches and cannot be undone.')) return;
        if (!confirm('Are you sure? This is your last chance to cancel.')) return;
        const errBox = document.getElementById('delete-account-error');
        btn.disabled = true; btn.textContent = 'Deleting…';
        try {
          await api('/clients/me', { method: 'DELETE' });
          renderOnboarding();
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Delete my account';
          errBox.textContent = e.message || 'Something went wrong. Please try again.';
          errBox.style.display = 'block';
        }
      });
    }

    function drawSwipe() {
      if (loading) {
        shell(`<div class="deck-wrap"><p style="color:rgba(255,255,255,0.7)">Loading agents…</p></div>`);
        return;
      }
      if (!realtors.length) {
        shell(`
          <div class="deck-wrap">
            <div class="deck-empty">
              <div class="emoji">🎉</div>
              <h2>You've seen everyone!</h2>
              <p style="color:rgba(255,255,255,0.7)">Check your matches to reach out, or check back later for new agents.</p>
            </div>
          </div>
        `);
        return;
      }

      const wrap = shell(`
        <div class="deck-wrap">
          <div class="deck" id="deck"></div>
        </div>
        <div class="swipe-actions">
          <button class="icon-btn pass" id="btn-pass" title="Pass">✕</button>
          <button class="icon-btn like" id="btn-like" title="Like">♥</button>
        </div>
        <p class="hint">Swipe right to match, left to pass</p>
      `);

      const deckEl = wrap.querySelector('#deck');
      // Render up to 3 cards, top-most is last child visually but we'll stack with z-index.
      const visible = realtors.slice(0, 3);
      visible.forEach((r, i) => {
        const idxFromTop = visible.length - 1 - i; // 0 = top card
        const card = buildCard(r, idxFromTop);
        deckEl.appendChild(card);
      });

      const topCard = deckEl.querySelector('.card[data-top="true"]');
      if (topCard) attachDrag(topCard, realtors[0]);

      wrap.querySelector('#btn-pass').addEventListener('click', () => programmaticSwipe('pass'));
      wrap.querySelector('#btn-like').addEventListener('click', () => programmaticSwipe('like'));
    }

    function buildCard(r, idxFromTop) {
      const isTop = idxFromTop === 0;
      const scale = 1 - idxFromTop * 0.04;
      const translateY = idxFromTop * 10;
      const specialtyTags = r.specialties.slice(0, 3).map((s) => `<span class="tag">${esc(s)}</span>`).join('');
      const areaTags = r.areas.slice(0, 2).map((a) => `<span class="tag area">📍 ${esc(a)}</span>`).join('');
      const card = el(`
        <div class="card" data-top="${isTop}" data-realtor-id="${r.id}"
             style="transform: translateY(${translateY}px) scale(${scale}); z-index:${10 - idxFromTop};">
          <div class="card-photo">
            ${r.photoUrl ? `<img src="${esc(r.photoUrl)}" alt="${esc(r.name)}" />` : `<span>${esc(r.photoEmoji || '🏠')}</span>`}
            <span class="badge">★ ${r.rating != null ? r.rating.toFixed(1) : '—'}</span>
            ${r.videoUrl ? `<button type="button" class="play-video-btn" aria-label="Watch intro video">▶</button>` : ''}
            <div class="stamp like">MATCH</div>
            <div class="stamp nope">PASS</div>
          </div>
          <div class="card-body">
            <h2>${esc(r.name)}</h2>
            <div class="brokerage">${esc(r.brokerage || '')}</div>
            <div class="tag-row">${specialtyTags}${areaTags}</div>
            <p class="bio">${esc(r.bio || '')}</p>
            <div class="stat-row">
              <span><b>${r.yearsExperience ?? '—'}</b> yrs experience</span>
              <span><b>${r.closedSales ?? '—'}</b> closed sales</span>
            </div>
          </div>
        </div>
      `);
      const playBtn = card.querySelector('.play-video-btn');
      if (playBtn) {
        // Stop the tap from also being interpreted as the start of a swipe drag.
        playBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
        playBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showVideoModal(r);
        });
      }
      return card;
    }

    function showVideoModal(r) {
      const modal = el(`
        <div class="modal-backdrop">
          <div class="modal-card" style="padding:16px;">
            <video src="${esc(r.videoUrl)}" controls autoplay playsinline style="width:100%; border-radius:14px; max-height:70vh; background:#000;"></video>
            <h2 style="margin-top:14px;">${esc(r.name)}</h2>
            <button class="btn btn-primary" id="video-modal-close" style="width:100%;">Close</button>
          </div>
        </div>
      `);
      document.body.appendChild(modal);
      const video = modal.querySelector('video');
      modal.querySelector('#video-modal-close').addEventListener('click', () => {
        video.pause();
        modal.remove();
      });
      modal.addEventListener('click', (e) => {
        if (e.target === modal) { video.pause(); modal.remove(); }
      });
    }

    function attachDrag(card, realtor) {
      let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
      const likeStamp = card.querySelector('.stamp.like');
      const nopeStamp = card.querySelector('.stamp.nope');

      function onDown(e) {
        dragging = true;
        const p = pointFromEvent(e);
        startX = p.x; startY = p.y;
        card.style.transition = 'none';
      }
      function onMove(e) {
        if (!dragging) return;
        const p = pointFromEvent(e);
        dx = p.x - startX;
        dy = p.y - startY;
        const rot = dx / 12;
        card.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
        const opacity = Math.min(Math.abs(dx) / 100, 1);
        if (dx > 0) { likeStamp.style.opacity = opacity; nopeStamp.style.opacity = 0; }
        else { nopeStamp.style.opacity = opacity; likeStamp.style.opacity = 0; }
      }
      function onUp() {
        if (!dragging) return;
        dragging = false;
        const threshold = 90;
        card.style.transition = 'transform 0.3s ease';
        if (dx > threshold) {
          flyOut(card, 1, () => commitSwipe(realtor, 'like'));
        } else if (dx < -threshold) {
          flyOut(card, -1, () => commitSwipe(realtor, 'pass'));
        } else {
          card.style.transform = 'translate(0,0) rotate(0)';
          likeStamp.style.opacity = 0;
          nopeStamp.style.opacity = 0;
        }
      }

      card.addEventListener('pointerdown', (e) => { card.setPointerCapture(e.pointerId); onDown(e); });
      card.addEventListener('pointermove', onMove);
      card.addEventListener('pointerup', onUp);
      card.addEventListener('pointercancel', onUp);
    }

    function pointFromEvent(e) {
      return { x: e.clientX, y: e.clientY };
    }

    function flyOut(card, dir, done) {
      card.style.transform = `translate(${dir * 600}px, -40px) rotate(${dir * 30}deg)`;
      card.style.opacity = '0';
      setTimeout(done, 220);
    }

    function programmaticSwipe(direction) {
      const wrap = document.querySelector('.card[data-top="true"]');
      if (!wrap || !realtors.length) return;
      const realtor = realtors[0];
      wrap.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      flyOut(wrap, direction === 'like' ? 1 : -1, () => commitSwipe(realtor, direction));
    }

    async function commitSwipe(realtor, direction) {
      realtors = realtors.filter((r) => r.id !== realtor.id);
      try {
        const result = await api('/swipe', {
          method: 'POST',
          body: { realtor_id: realtor.id, direction },
        });
        if (result.match) {
          showMatchModal(result.realtor);
          return;
        }
      } catch (e) {
        // non-fatal in demo; continue
      }
      draw();
    }

    function showMatchModal(realtor) {
      const modal = el(`
        <div class="modal-backdrop">
          <div class="modal-card">
            <div class="emoji">🎉</div>
            <h2>It's a match!</h2>
            <p>You matched with <b>${esc(realtor.name)}</b> from ${esc(realtor.brokerage || '')}. They'll be added to your Matches tab so you can reach out.</p>
            <button class="btn btn-primary" id="modal-continue" style="width:100%;">Keep swiping</button>
          </div>
        </div>
      `);
      document.body.appendChild(modal);
      modal.querySelector('#modal-continue').addEventListener('click', () => {
        modal.remove();
        draw();
      });
    }

    function drawMatches() {
      shell(`<div class="screen"><p style="color:rgba(255,255,255,0.7)">Loading matches…</p></div>`);
      api('/matches/' + clientId).then(({ matches }) => {
        if (!matches.length) {
          shell(`
            <div class="empty-state">
              <div class="emoji">💌</div>
              <h3>No matches yet</h3>
              <p>Head to Discover and swipe right on an agent you like.</p>
            </div>
          `);
          return;
        }
        const items = matches.map((m) => `
          <div class="match-item" style="flex-direction:column; align-items:stretch;">
            <div style="display:flex; gap:14px; align-items:center;">
              <div class="avatar">${m.photoUrl ? `<img src="${esc(m.photoUrl)}" alt="" />` : esc(m.photoEmoji || '🏠')}</div>
              <div class="info">
                <h3>${esc(m.name)}</h3>
                <p>${esc(m.brokerage || '')} · ★ ${m.rating != null ? m.rating.toFixed(1) : '—'}</p>
              </div>
            </div>
            <div class="match-actions">
              ${m.phone ? `<a href="tel:${esc(m.phone.replace(/[^\d+]/g, ''))}">📞 Call</a>` : ''}
              ${m.phone ? `<a href="sms:${esc(m.phone.replace(/[^\d+]/g, ''))}">💬 Text</a>` : ''}
              ${m.email ? `<a href="mailto:${esc(m.email)}">✉️ Email</a>` : ''}
              ${m.videoUrl ? `<a href="#" class="watch-video-link" data-realtor-id="${m.id}">▶ Watch intro</a>` : ''}
            </div>
          </div>
        `).join('');
        shell(`<div class="screen" style="padding-top:16px;">${items}</div>`);
        document.querySelectorAll('.watch-video-link').forEach((link) => {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            const m = matches.find((x) => String(x.id) === link.dataset.realtorId);
            if (m) showVideoModal(m);
          });
        });
      }).catch(() => {
        shell(`<div class="screen"><p>Couldn't load matches. Try again.</p></div>`);
      });
    }

    load();
  }

  // ---------------- Realtor dashboard ----------------
  function renderRealtorDashboard(realtorId) {
    app.innerHTML = '';
    const wrap = el(`
      <div style="display:flex; flex-direction:column; min-height:100vh; min-height:100dvh;">
        <div class="topbar">
          <div class="brand"><img src="/img/ikonick-logo.png" alt="IKONICK" /><span class="brand-text">Agen<span class="accent">tr</span></span></div>
          <a href="/" class="btn btn-secondary" style="padding:8px 14px; font-size:12px; text-decoration:none; color:white;">Client view</a>
        </div>
        <div id="dash-content">
          <div class="dash-header"><p>Loading dashboard…</p></div>
        </div>
      </div>
    `);
    app.appendChild(wrap);

    Promise.all([
      api('/realtor/' + realtorId),
      api('/realtor/' + realtorId + '/leads'),
    ]).then(([{ realtor }, { leads }]) => {
      const content = wrap.querySelector('#dash-content');
      const leadItems = leads.length
        ? leads.map((l) => `
            <div class="lead-item">
              <h3>${esc(l.name)}</h3>
              <div class="meta">${l.phone ? '📞 ' + esc(l.phone) : ''} ${l.email ? ' · ✉️ ' + esc(l.email) : ''}</div>
              <div class="meta">${l.areaInterest || l.state ? '📍 ' + esc([l.areaInterest, l.state].filter(Boolean).join(', ')) : ''}</div>
              <div class="meta">${esc([l.budgetRange, l.timeline, l.propertyType].filter(Boolean).join(' · '))}</div>
              <span class="pill">${esc(l.intent || 'interested')}</span>
            </div>
          `).join('')
        : `<div class="empty-state"><div class="emoji">📭</div><p>No leads matched yet.</p></div>`;

      const isActive = realtor.subscriptionStatus === 'active';
      const subBanner = isActive
        ? `<div class="sub-banner sub-active">✅ Your profile is live and visible to clients.
            ${realtor.hasBillingAccount ? '<button id="manage-billing" class="link-btn">Manage billing</button>' : ''}
          </div>`
        : `<div class="sub-banner sub-inactive">⚠️ Your profile is hidden from clients until you subscribe.
            <a href="/agent-signup.html" class="link-btn" style="text-decoration:none;">Subscribe — $49/mo</a>
          </div>`;

      content.innerHTML = `
        <div class="dash-header">
          <h1><span class="dash-avatar">${realtor.photoUrl ? `<img src="${esc(realtor.photoUrl)}" alt="" />` : esc(realtor.photoEmoji || '🏠')}</span>${esc(realtor.name)}</h1>
          <p>${esc(realtor.brokerage || '')} · ${leads.length} lead${leads.length === 1 ? '' : 's'} matched</p>
        </div>
        ${subBanner}
        ${leadItems}
        <p class="hint">This is your leads inbox — everyone who swiped right on your profile shows up here.</p>
        <button class="btn btn-secondary" id="dash-logout" style="margin-top:14px;">Log out</button>
        <button id="dash-delete-account" style="display:block; margin:14px auto 0; background:none; border:none; color:#e57368; font-size:12.5px; text-decoration:underline; cursor:pointer; padding:0;">Delete my account</button>
        <div class="error-banner" id="dash-delete-error" style="display:none; margin-top:12px;"></div>
      `;

      const billingBtn = content.querySelector('#manage-billing');
      if (billingBtn) {
        billingBtn.addEventListener('click', async () => {
          billingBtn.disabled = true;
          billingBtn.textContent = 'Opening…';
          try {
            const { url } = await api('/agents/portal', { method: 'POST', body: { email: realtor.email } });
            window.location.href = url;
          } catch (err) {
            billingBtn.disabled = false;
            billingBtn.textContent = 'Manage billing';
            alert('Could not open billing portal: ' + err.message);
          }
        });
      }
      content.querySelector('#dash-logout').addEventListener('click', async () => {
        try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
        window.location.href = '/realtor-login.html';
      });
      const deleteBtn = content.querySelector('#dash-delete-account');
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('Delete your Agentr agent profile? This removes your listing, leads, and cancels any active subscription. This cannot be undone.')) return;
        if (!confirm('Are you sure? This is your last chance to cancel.')) return;
        const errBox = content.querySelector('#dash-delete-error');
        deleteBtn.disabled = true; deleteBtn.textContent = 'Deleting…';
        try {
          await api('/realtor/me', { method: 'DELETE' });
          window.location.href = '/realtor-login.html';
        } catch (err) {
          deleteBtn.disabled = false; deleteBtn.textContent = 'Delete my account';
          errBox.textContent = err.message || 'Something went wrong. Please try again.';
          errBox.style.display = 'block';
        }
      });
    }).catch((err) => {
      const needsLogin = /log in/i.test(err.message || '');
      wrap.querySelector('#dash-content').innerHTML = needsLogin
        ? `<div class="dash-header">
             <p>Please log in to view your dashboard.</p>
             <a href="/realtor-login.html?next=${encodeURIComponent(path)}" class="btn btn-primary" style="display:inline-block; text-decoration:none; margin-top:14px;">Log in</a>
           </div>`
        : `<div class="dash-header"><p>Realtor not found.</p></div>`;
    });
  }
})();
