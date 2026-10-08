/* First-party interaction tracking: no email, score or recipient supplied by the browser. */
(() => {
  const base = typeof API !== 'undefined' ? API : '/api';
  let enabled = false;
  let lastActivity = 0;
  let lastInteraction = Date.now();
  const saved = new Set();
  async function request(method, path, body) {
    if (typeof TOKEN === 'undefined' || !TOKEN) return null;
    const response = await fetch(base + '/automation' + path, {
      method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error('Préférences temporairement indisponibles');
    return response.status === 204 ? null : response.json();
  }
  async function record(id, kind) {
    if (!enabled || !id) return;
    try { await request('POST', '/offers/' + encodeURIComponent(id) + '/' + kind); }
    catch (_) { /* Tracking must not interrupt an application. */ }
  }
  async function activity() {
    const now = Date.now();
    if (!enabled || document.hidden || now - lastActivity < 300000 || now - lastInteraction > 300000) return;
    try { await request('POST', '/activity'); lastActivity = now; } catch (_) { }
  }
  function addSaveButton(card) {
    const id = card.dataset.offerId;
    if (!id || card.querySelector('.automation-save')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn bo bsm automation-save';
    const render = () => { button.textContent = saved.has(id) ? 'Offre enregistrée' : 'Enregistrer cette offre'; button.setAttribute('aria-pressed', String(saved.has(id))); };
    render();
    button.addEventListener('click', async (event) => {
      event.stopPropagation(); button.disabled = true;
      try {
        const wasSaved = saved.has(id);
        await request('POST', '/offers/' + encodeURIComponent(id) + '/' + (wasSaved ? 'unsaved' : 'saved'));
        if (wasSaved) saved.delete(id); else saved.add(id);
        render();
      } catch (_) { if (typeof toast === 'function') toast('Enregistrement indisponible, réessayez'); }
      finally { button.disabled = false; }
    });
    card.querySelector('.card-body')?.appendChild(button);
  }
  let viewTimer;
  function observeTopCard() {
    clearTimeout(viewTimer);
    const page = document.getElementById('p-swipe');
    const card = document.querySelector('#deck-cards .swipe-card:last-child');
    if (!enabled || document.hidden || !page?.classList.contains('on') || !card) return;
    addSaveButton(card);
    viewTimer = setTimeout(() => {
      if (document.hidden || !page.classList.contains('on') || card !== document.querySelector('#deck-cards .swipe-card:last-child')) return;
      const rect = card.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < innerHeight && rect.width > 0) record(card.dataset.offerId, 'viewed');
    }, 2000);
  }
  async function init() {
    try {
      const config = await fetch(base + '/config').then((r) => r.json());
      if (!config.AUTOMATION_ENABLED) return;
      const preference = await request('GET', '/preferences');
      if (!preference) return;
      enabled = true;
      const expirySection = document.getElementById('automation-expiry-section');
      if (expirySection) expirySection.hidden = false;
      const container = document.querySelector('#p-settings .account-layout, #p-account .account-layout');
      if (container) {
        const section = document.createElement('section');
        section.className = 'account-section card-sec';
        const heading = document.createElement('h2'); heading.textContent = 'Emails et recommandations';
        const label = document.createElement('label');
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = preference.marketing_enabled;
        label.append(checkbox, ' Recevoir les recommandations et relances SwipSales par email.');
        const detail = document.createElement('p'); detail.textContent = 'Vous pouvez désactiver ce choix à tout moment. Les messages de service et de facturation restent disponibles.';
        const status = document.createElement('p'); status.setAttribute('role', 'status');
        checkbox.addEventListener('change', async () => {
          checkbox.disabled = true;
          try { await request('PUT', '/preferences', { marketing_enabled: checkbox.checked }); status.textContent = 'Choix enregistré'; }
          catch (_) { checkbox.checked = !checkbox.checked; status.textContent = 'Enregistrement impossible, réessayez'; }
          finally { checkbox.disabled = false; }
        });
        section.append(heading, label, detail, status); container.appendChild(section);
      }
      if (document.getElementById('deck-cards')) {
        const rows = await request('GET', '/saved');
        (rows || []).forEach((row) => saved.add(row.offre_id));
        new MutationObserver(observeTopCard).observe(document.getElementById('deck-cards'), { childList: true });
        new MutationObserver(observeTopCard).observe(document.getElementById('p-swipe'), { attributes: true, attributeFilter: ['class'] });
        observeTopCard();
      }
      ['pointerdown', 'keydown'].forEach((name) => document.addEventListener(name, () => { lastInteraction = Date.now(); activity(); }, { passive: true }));
      document.addEventListener('visibilitychange', observeTopCard);
      await activity();
      setInterval(activity, 60000);
    } catch (_) { /* Deployment flags and temporary outages keep the product usable. */ }
  }
  let adnTracked = false;
  async function adnStarted() {
    if (!enabled || adnTracked) return;
    try { await request('POST', '/adn-started'); adnTracked = true; } catch (_) { }
  }
  window.SwipAutomation = { record, adnStarted };
  init();
})();
