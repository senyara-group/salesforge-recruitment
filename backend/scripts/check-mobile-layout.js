#!/usr/bin/env node
// Contrôle de mise en page mobile dans un VRAI moteur (Chrome/Edge headless via le
// protocole DevTools, WebSocket natif de Node >= 22) : émulation mobile (viewport
// meta, DPR 3, tactile, UA mobile), données réalistes (historique Coach rempli) et
// gestes de scroll tactiles réels. Aucune dépendance npm.
//
// Usage : npm run test:layout            (frontend du dépôt)
//         node scripts/check-mobile-layout.js --root <dossier frontend> [--json]
// Navigateur : CHROME_PATH, sinon Chrome/Edge aux emplacements standards.
// Sortie non nulle si un élément du Coach sort du viewport ou si la barre basse bouge.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const argValue = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const FRONTEND = path.resolve(argValue('--root') || path.join(__dirname, '../../frontend'));
const JSON_OUTPUT = args.includes('--json');
const VIEWPORTS = [[320, 700], [360, 800], [375, 812], [390, 844], [430, 932], [768, 1024], [1280, 900]];
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

function findBrowser() {
  const candidates = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file));
}

function serveFrontend() {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.resolve(FRONTEND, '.' + url);
    if (!file.startsWith(FRONTEND)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launchBrowser(executable) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'swipsales-layout-'));
  const child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Navigateur non démarré')), 20000);
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on('exit', () => reject(new Error('Navigateur arrêté')));
  });
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const messageId = ++id; pending.set(messageId, { resolve, reject });
    socket.send(JSON.stringify({ id: messageId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const close = () => { try { socket.close(); } catch (_) { /* déjà fermé */ } child.kill(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* profil verrouillé */ } };
  return { send, close };
}

async function openPage(browser, width, height) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  await send('Page.enable'); await send('Runtime.enable');
  const mobile = width < 1024;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
  if (mobile) {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });
  }
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const navigate = async (url, readyExpression) => {
    await send('Page.navigate', { url });
    for (let i = 0; i < 100; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { if (await evaluate(readyExpression)) return; } catch (_) { /* page en cours de chargement */ }
    }
    throw new Error('Page non prête : ' + url);
  };
  // Geste tactile réel (légèrement diagonal, comme un pouce) puis retour au calme.
  const swipe = (xDistance, yDistance) => send('Input.synthesizeScrollGesture', {
    x: Math.round(width / 2), y: Math.round(height * 0.6), xDistance, yDistance, speed: 1200,
    gestureSourceType: mobile ? 'touch' : 'mouse', repeatCount: 1,
  });
  return { evaluate, navigate, swipe, close: () => browser.send('Target.closeTarget', { targetId }) };
}

// Mesures exécutées DANS la page. Un élément compte comme débordant s'il sort du
// viewport, sauf s'il est à l'intérieur d'un conteneur défilant (overflow != visible)
// lui-même entièrement visible (liste horizontale d'historique par exemple).
const MEASURE_HELPERS = `
  window.__layout = {
    vw: () => document.documentElement.clientWidth,
    inScroller(el, root) {
      for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
        if (p === document.body || p === document.documentElement) break;
        const s = getComputedStyle(p);
        if (s.overflowX !== 'visible' && s.overflowX !== 'clip') { const b = p.getBoundingClientRect(); return b.left >= -0.5 && b.right <= this.vw() + 0.5; }
      }
      return false;
    },
    outside(root) {
      const vw = this.vw();
      return [...root.querySelectorAll('*')].filter((el) => {
        const b = el.getBoundingClientRect(); const s = getComputedStyle(el);
        if (!b.width || !b.height || s.visibility === 'hidden') return false;
        if (b.right <= vw + 0.5 && b.left >= -0.5) return false;
        return !this.inScroller(el, root);
      }).map((el) => (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).trim().split(/\\s+/).join('.')) + ' [' + Math.round(el.getBoundingClientRect().left) + '→' + Math.round(el.getBoundingClientRect().right) + ']');
    },
    nav(id) {
      const b = document.getElementById(id).getBoundingClientRect(); const v = window.visualViewport;
      // Position vue par l'utilisateur = rect layout corrigé du décalage du viewport visuel.
      return { left: +(b.left - v.offsetLeft).toFixed(2), right: +(b.right - v.offsetLeft).toFixed(2), top: +(b.top - v.offsetTop).toFixed(2), height: +b.height.toFixed(2), scale: +v.scale.toFixed(3), pageLeft: +v.pageLeft.toFixed(2), scrollX: window.scrollX };
    },
  };
  true`;

const HISTORY = [
  'Objections commerciales — relance budget', 'Entretien — Account Executive SaaS', 'Pitch — résultats 2025',
  'Objections recrutement — mobilité', 'Entretien — Business Developer', 'Pitch — prise de parole comité de direction',
  'Objections commerciales — concurrence installée', 'Entretien — Key Account Manager grands comptes',
].map((title, i) => ({ id: 'c' + i, title, mode: 'pitch', updated_at: `2026-09-${String(10 + i).padStart(2, '0')}` }));
const LONG_URL = 'https://www.exemple-prospect.fr/objection/budget/' + 'segment/'.repeat(30) + '?ref=' + 'x'.repeat(60);
const LONG_WORD = 'Supercalifragilisticexpialidocious'.repeat(9);

const COACH_PROBE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const L = window.__layout; const page = document.getElementById('p-coach'); const out = { checks: {} };
  go('coach'); await wait(250);
  document.getElementById('coach-tool-content').hidden = false; document.getElementById('coach-access-gate').hidden = true;
  renderCoachHistory(${JSON.stringify(HISTORY)});
  showCoachSetup(); await wait(60);
  out.checks['setup'] = L.outside(page);
  for (const [id, label] of [['coach-mode-objections', 'setup+objections']]) { selectCoachMode(document.getElementById(id), 'simulation'); await wait(60); out.checks[label] = L.outside(page); }
  const long = ${JSON.stringify(LONG_URL)}; const word = ${JSON.stringify(LONG_WORD)};
  const messages = [
    { role: 'assistant', content: 'Votre prix est trop élevé. Pourquoi changer de prestataire ?', kind: 'question' },
    { role: 'user', content: 'Réponse courte.' },
    { role: 'user', content: 'Je comprends votre point de vue sur le budget. '.repeat(12) + long },
    { role: 'assistant', content: 'Ce qui fonctionne : ' + word, kind: 'feedback' },
    { role: 'assistant', content: 'Question suivante : ' + 'reformulez la valeur perçue. '.repeat(20) },
  ];
  for (const [mode, sim, title] of [['interview', '', 'Entretien'], ['pitch', '', 'Pitch'], ['simulation', 'commercial', 'Objections commerciales'], ['simulation', 'recruitment', 'Objections-recrutement-' + 'x'.repeat(80)]]) {
    COACH_MODE = mode; COACH_SIMULATION_TYPE = sim;
    showCoachConversation({ mode, simulation_type: sim, title, messages });
    const input = document.getElementById('coach-input'); input.value = 'ligne 1\\nligne 2\\nligne 3\\n' + word;
    await wait(60);
    out.checks['conversation:' + mode + (sim ? ':' + sim : '')] = L.outside(page);
    input.value = '';
  }
  showCoachSetup(); await wait(40); out.checks['back-to-setup'] = L.outside(page);
  out.scroll = { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  out.column = getComputedStyle(document.querySelector('.coach-layout')).gridTemplateColumns;
  return out;
})()`;

// Balayage des pages principales (sans données serveur : structure et textes statiques).
const PAGES_PROBE = (pages) => `(async () => {
  const out = {};
  for (const name of ${JSON.stringify(pages)}) {
    go(name); await new Promise((r) => setTimeout(r, 200));
    const page = document.querySelector('.page.on');
    out[name] = page ? window.__layout.outside(page) : ['page absente'];
  }
  return out;
})()`;
const CANDIDATE_PAGES = ['home', 'swipe', 'coaching', 'messages', 'profile', 'account', 'cv'];

async function navStability(pageApi, navId, pages) {
  const samples = [];
  for (const pageName of pages) {
    await pageApi.evaluate(`(async () => { go(${JSON.stringify(pageName)}); await new Promise((r) => setTimeout(r, 200)); window.scrollTo(0, 0); return true; })()`);
    samples.push({ page: pageName, when: 'start', ...(await pageApi.evaluate(`window.__layout.nav(${JSON.stringify(navId)})`)) });
    for (const [dx, dy] of [[-18, -420], [12, 380], [-25, -600], [30, -200]]) {
      await pageApi.swipe(dx, dy);
      samples.push({ page: pageName, when: `swipe ${dx},${dy}`, ...(await pageApi.evaluate(`window.__layout.nav(${JSON.stringify(navId)})`)) });
    }
  }
  const key = (s) => `${s.left}/${s.right}/${s.top}/${s.height}/${s.scale}`;
  const distinct = [...new Set(samples.map(key))];
  return { stable: distinct.length === 1, distinct, moved: samples.filter((s) => key(s) !== key(samples[0])).slice(0, 6) };
}

async function main() {
  const executable = findBrowser();
  if (!executable) { console.error('Aucun Chrome/Edge trouvé : définir CHROME_PATH.'); process.exit(2); }
  const server = await serveFrontend();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchBrowser(executable);
  const report = { frontend: FRONTEND, browser: path.basename(executable), viewports: {} };
  let failures = 0;
  try {
    for (const [width, height] of VIEWPORTS) {
      const entry = report.viewports[`${width}x${height}`] = {};
      const candidate = await openPage(browser, width, height);
      await candidate.navigate(base + '/swipsales_app.html', 'document.readyState === "complete"');
      await candidate.evaluate(`localStorage.setItem('sf_token','layout-check'); localStorage.setItem('sf_user', JSON.stringify({ id: 'layout-candidate', role: 'candidat', prenom: 'Test' })); true`);
      await candidate.navigate(base + '/_spaces/candidat.html', 'typeof go === "function" && document.readyState === "complete"');
      await candidate.evaluate(MEASURE_HELPERS);
      const coach = await candidate.evaluate(COACH_PROBE);
      entry.coach = coach;
      for (const [name, outside] of Object.entries(coach.checks)) if (outside.length) { failures += 1; entry.coachFailures = (entry.coachFailures || []).concat(`${name}: ${outside.slice(0, 4).join(' ; ')}${outside.length > 4 ? ` (+${outside.length - 4})` : ''}`); }
      entry.pages = await candidate.evaluate(PAGES_PROBE(CANDIDATE_PAGES));
      for (const [name, outside] of Object.entries(entry.pages)) if (outside.length) { failures += 1; entry.pageFailures = (entry.pageFailures || []).concat(`${name}: ${outside.slice(0, 3).join(' ; ')}`); }
      if (width < 1024) {
        entry.candidateNav = await navStability(candidate, 'bnav', ['home', 'coach', 'cv', 'profile']);
        if (!entry.candidateNav.stable) failures += 1;
      }
      await candidate.close();
      if (width < 1024) {
        const recruiter = await openPage(browser, width, height);
        await recruiter.navigate(base + '/swipsales_app.html', 'document.readyState === "complete"');
        await recruiter.evaluate(`localStorage.setItem('sf_rec_token','layout-check'); localStorage.setItem('sf_rec_user', JSON.stringify({ id: 'layout-recruiter', role: 'recruteur', prenom: 'Test' })); true`);
        await recruiter.navigate(base + '/_spaces/recruteur.html', 'typeof go === "function" && document.readyState === "complete" && !!document.getElementById("bnav")');
        await recruiter.evaluate(MEASURE_HELPERS);
        const pages = await recruiter.evaluate(`[...document.querySelectorAll('.bnav .bn[id^="nav-"]')].map((b) => b.id.slice(4)).slice(0, 4)`);
        entry.recruiterNav = await navStability(recruiter, 'bnav', pages.length ? pages : ['dashboard']);
        if (!entry.recruiterNav.stable) failures += 1;
        await recruiter.close();
      }
    }
  } finally {
    browser.close(); server.close();
  }
  report.failures = failures;
  if (JSON_OUTPUT) console.log(JSON.stringify(report, null, 1));
  else {
    for (const [viewport, entry] of Object.entries(report.viewports)) {
      const coachState = entry.coachFailures ? 'ÉCHEC ' + entry.coachFailures.join(' | ') : `OK (colonne ${entry.coach.column}, scrollWidth ${entry.coach.scroll.scrollWidth}/${entry.coach.scroll.clientWidth})`;
      const nav = (label, value) => value ? `${label} ${value.stable ? 'stable ' + value.distinct[0] : 'INSTABLE ' + value.distinct.join(' ~ ')}` : '';
      const pagesState = entry.pageFailures ? 'ÉCHEC ' + entry.pageFailures.join(' | ') : 'OK';
      console.log(`${viewport.padEnd(9)} Coach: ${coachState}\n          Pages: ${pagesState}\n          ${nav('nav candidat', entry.candidateNav)}  ${nav('nav recruteur', entry.recruiterNav)}`);
    }
    console.log(failures ? `\n${failures} échec(s) de mise en page.` : '\nMise en page mobile : aucun débordement Coach, barres basses stables.');
  }
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(2); });
