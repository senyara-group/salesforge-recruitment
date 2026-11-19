const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ds = require('./helpers/designSystemCss');

const recruiter = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', '_spaces', 'recruteur.html'),
  'utf8'
);
const candidat = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', '_spaces', 'candidat.html'),
  'utf8'
);

function assertMessagesWorkspace(html, role) {
  assert.match(html, /class="sec messages-page"/, `${role}: messages-page`);
  assert.match(html, /class="messages-workspace"/, `${role}: workspace`);
  assert.match(html, /class="conversations-panel"/, `${role}: conversations-panel`);
  assert.match(html, /class="conversation-panel"/, `${role}: conversation-panel`);
  assert.match(html, /id="msgs-list"/, `${role}: msgs-list`);
  assert.match(html, /id="chat-placeholder"/, `${role}: placeholder`);
  assert.match(html, /id="chat-panel"/, `${role}: chat-panel`);
  assert.match(html, /Sélectionnez une conversation/, `${role}: empty copy`);
  assert.match(html, /Choisissez un échange dans la liste pour l'afficher ici\./, `${role}: empty hint`);
  assert.match(html, /function setMessagesThreadUi/, `${role}: state helper`);
  assert.match(html, /classList\.toggle\('thread-open'/, `${role}: thread-open class`);
  assert.match(html, /function closeThread/, `${role}: closeThread`);
  assert.match(html, /onclick="closeThread\(\)"/, `${role}: back handler`);
  assert.match(html, /onsubmit="sendThreadMessage\(event\)"/, `${role}: send handler`);
  assert.match(html, /async function sendThreadMessage/, `${role}: send fn`);
  assert.match(html, /POST', '\/messages\/send'/, `${role}: send API`);
  // Style : bloc « Messagerie » du design system, partagé par les deux espaces.
  assert.match(html, /href="\.\.\/design-system\/features\.css"/, `${role}: design system`);
  const css = ds.read('features');
  const mobile = ds.media(css, '(max-width:719px)');
  const desktop = ds.media(css, '(min-width:720px)');
  assert.match(ds.rule(css, '.conversations-panel'), /flex:1 1 280px/, `${role}: list column`);
  assert.match(ds.rule(css, '.conversation-panel'), /flex:999 1 420px;min-width:0/, `${role}: desktop columns`);
  assert.match(ds.rule(mobile, '#p-messages.thread-open .conversations-panel'), /display:none/, `${role}: mobile hide list`);
  assert.match(ds.rule(mobile, '#p-messages.thread-open .conversation-panel'), /display:flex/, `${role}: mobile show chat`);
  assert.match(ds.rule(desktop, '#p-messages:not(.thread-open) .chat-placeholder'), /display:flex/, `${role}: empty only when no thread`);
  assert.match(ds.rule(css, '.chat-placeholder.hidden'), /display:none !important/, `${role}: hide empty when open`);
  assert.match(ds.rule(css, '.messages-workspace'), /overflow:hidden/, `${role}: overflow control present`);
  // Mutual exclusivity: opening adds on + hidden; closing removes on
  assert.match(html, /panel\?\.classList\.add\('on'\)/, `${role}: panel on when open`);
  assert.match(html, /placeholder\?\.classList\.add\('hidden'\)/, `${role}: placeholder hidden when open`);
  assert.match(html, /panel\?\.classList\.remove\('on'\)/, `${role}: panel off when closed`);
}

test('messages workspace UI : structure recruteur', () => {
  assertMessagesWorkspace(recruiter, 'recruteur');
});

test('messages workspace UI : structure candidat', () => {
  assertMessagesWorkspace(candidat, 'candidat');
});

test('messages workspace UI : loadMessages ne réaffiche pas empty si thread actif', () => {
  for (const [role, html] of [['recruteur', recruiter], ['candidat', candidat]]) {
    const start = html.indexOf('async function loadMessages');
    const end = html.indexOf('async function renderMessagesWelcome', start);
    const block = html.slice(start, end);
    assert.match(block, /keepOpen/, `${role}: preserve open thread`);
    assert.match(block, /setMessagesThreadUi\(Boolean\(keepOpen\)\)/, `${role}: sync UI from keepOpen`);
    assert.doesNotMatch(
      block,
      /chat-placeholder'\)\?\.classList\.remove\('hidden'\)/,
      `${role}: no unconditional placeholder restore`
    );
  }
});

test('messages workspace UI : handlers envoi / sélection inchangés', () => {
  for (const html of [recruiter, candidat]) {
    assert.match(html, /onclick="openThread\('/);
    assert.match(html, /receiver_id: ACTIVE_THREAD\.receiver_id/);
    assert.match(html, /match_id: ACTIVE_THREAD\.match_id/);
    assert.match(html, /subscribeToMessages/);
    assert.match(html, /setMessageBadges/);
  }
});
