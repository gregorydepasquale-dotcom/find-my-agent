// app.js — vanilla JS SPA. No build step, no framework, no external deps.
(function () {
  'use strict';

  const app = document.getElementById('app');
  const LS_KEY = 'realtorSwipe.clientId';

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

  // ---------------- Router ----------------
  const path = window.location.pathname;
  const realtorDashMatch = path.match(/^\/realtor\/(\d+)/);

  if (realtorDashMatch) {
    renderRealtorDashboard(Number(realtorDashMatch[1]));
  } else {
    const savedClientId = localStorage.getItem(LS_KEY);
    if (savedClientId) {
      renderClientApp(Number(savedClientId));
    } else {
      renderOnboarding();
    }
  }

  // ---------------- Onboarding ----------------
  // Step 1 asks where the client is looking (state required, city optional) so the swipe
  // deck can be scoped to agents who actually serve that state. Step 2 collects the rest.
  function renderOnboarding() {
    renderLocationStep();
  }

  function renderLocationStep() {
    app.innerHTML = '';
    app.appendChild(el(`
      <div class="screen onboarding">
        <div class="brand"><img src="/img/ikonick-logo.png" alt="IKONICK" /><span class="brand-text">Agen<span class="accent">tr</span></span></div>
        <h1>Where are you<br/>looking?</h1>
        <p class="sub">We'll match you with agents who serve that area.</p>
        <form id="location-form" style="display:flex; flex-direction:column; gap:14px;">
          <div class="field">
            <label>State</label>
            <select name="state" required>${stateOptionsHtml()}</select>
          </div>
          <div class="field">
            <label>City (optional)</label>
            <input type="text" name="city" placeholder="e.g. Austin" />
          </div>
          <button class="btn btn-primary" type="submit">Continue →</button>
        </form>
        <p class="hint">Real estate agent? <a href="/agent-signup.html" style="color:#fff;">List your profile — $49/mo</a></p>
        <p class="hint" style="margin-top:-4px;"><a href="/privacy.html" style="color:rgba(255,255,255,0.5);">Privacy Policy</a></p>
      </div>
    `));

    document.getElementById('location-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      renderDetailsStep({ state: fd.get('state'), city: fd.get('city') });
    });
  }

  function renderDetailsStep(location) {
    app.innerHTML = '';
    app.appendChild(el(`
      <div class="screen onboarding">
        <div class="brand"><img src="/img/ikonick-logo.png" alt="IKONICK" /><span class="brand-text">Agen<span class="accent">tr</span></span></div>
        <h1>Swipe. Match.<br/>Meet your agent.</h1>
        <p class="sub">Tell us a bit about what you're looking for, then swipe through agents near you to find the right fit.</p>
        <form id="onboard-form" style="display:flex; flex-direction:column; gap:14px;">
          <div class="field">
            <label>Your name</label>
            <input type="text" name="name" placeholder="Jane Smith" required />
          </div>
          <div class="field">
            <label>Phone</label>
            <input type="tel" name="phone" placeholder="(423) 555-0100" />
          </div>
          <div class="field">
            <label>Email</label>
            <input type="email" name="email" placeholder="jane@example.com" />
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
          <button class="btn btn-primary" type="submit">Start swiping →</button>
          <button class="btn btn-secondary" type="button" id="back-btn">← Back</button>
        </form>
      </div>
    `));

    document.getElementById('back-btn').addEventListener('click', () => renderLocationStep());

    document.getElementById('onboard-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Creating your profile…';
      try {
        const { client } = await api('/clients', {
          method: 'POST',
          body: {
            name: fd.get('name'),
            phone: fd.get('phone'),
            email: fd.get('email'),
            intent: fd.get('intent'),
            area: location.city,
            state: location.state,
          },
        });
        localStorage.setItem(LS_KEY, client.id);
        renderClientApp(client.id);
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
        const data = await api('/realtors?client_id=' + clientId);
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
            <button class="btn btn-secondary" id="reset-btn" style="padding:8px 14px; font-size:12px;">Start over</button>
          </div>
          <div id="tab-content" style="flex:1; display:flex; flex-direction:column;"></div>
          <div class="bottom-nav">
            <button data-tab="swipe" class="${currentTab === 'swipe' ? 'active' : ''}">
              <span class="ic">🔥</span>Discover
            </button>
            <button data-tab="matches" class="${currentTab === 'matches' ? 'active' : ''}">
              <span class="ic">💬</span>Matches
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
      wrap.querySelector('#reset-btn').addEventListener('click', () => {
        if (confirm('Clear your profile and start over on this device?')) {
          localStorage.removeItem(LS_KEY);
          renderOnboarding();
        }
      });
      return wrap;
    }

    function draw() {
      if (currentTab === 'swipe') {
        drawSwipe();
      } else {
        drawMatches();
      }
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
      return card;
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
          body: { client_id: clientId, realtor_id: realtor.id, direction },
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
            </div>
          </div>
        `).join('');
        shell(`<div class="screen" style="padding-top:16px;">${items}</div>`);
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
    }).catch(() => {
      wrap.querySelector('#dash-content').innerHTML = `<div class="dash-header"><p>Realtor not found.</p></div>`;
    });
  }
})();
