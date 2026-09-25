const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/_spaces/candidat.html'), 'utf8');

function sourceBetween(start, end) {
  const first = html.indexOf(start);
  const last = html.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `${start} not found`);
  return html.slice(first, last);
}

function el(overrides = {}) {
  return {
    hidden: true, disabled: false, checked: false, value: '', textContent: '', classList: {
      add() { this._on = true; }, remove() { this._on = false; }, contains() { return Boolean(this._on); },
    },
    setAttribute(name, value) { this[name] = value; },
    ...overrides,
  };
}

function harness() {
  const feedback = [];
  const elements = {
    'coach-use-cv': el({ checked: false }),
    'coach-use-profile': el({ checked: true }),
    'coach-offer-text': el({ value: '' }),
    'cv-source-text': el({ value: '' }),
    'coach-start-btn': el({ disabled: true }),
    'coach-simulation-types': el({ hidden: true }),
    'coach-setup': el({ hidden: false }),
    'coach-conversation': el({ hidden: true }),
    'coach-title': el(),
    'coach-phase': el(),
    'coach-messages': { innerHTML: '', querySelector() { return null; }, appendChild() {}, scrollTop: 0 },
    'coach-setup-feedback': el(),
  };
  const buttons = {
    interview: el(), simulation: el(), pitch: el(),
    commercial: el(), recruitment: el(),
  };
  const queries = {
    '.coach-starters > button': [buttons.interview, buttons.simulation, buttons.pitch],
    '#coach-simulation-types button': [buttons.commercial, buttons.recruitment],
  };
  const posted = [];
  const sandbox = {
    COACH_MODE: '', COACH_SIMULATION_TYPE: '', AI_AVAILABLE: true, COACH_ALLOWED: true,
    ACTIVE_CONVERSATION_ID: '', COACH_SENDING: false,
    document: {
      getElementById: id => elements[id] || null,
      querySelectorAll: sel => queries[sel] || [],
    },
    setFeedback: (...args) => feedback.push(args),
    setBtn() {},
    api: async (method, route, body) => {
      posted.push({ method, route, body });
      if (method === 'POST' && route === '/assistant/conversations') {
        return { id: 'c1', mode: body.mode, title: body.title, simulation_type: body.simulation_type, messages: [] };
      }
      return {};
    },
    showCoachConversation() {},
    sendCoachContent: async () => {},
    refreshCoachHistory: async () => {},
    toast() {},
    posted,
    feedback,
    elements,
    buttons,
  };
  const src = `${sourceBetween('function showCoachSetup()', 'function renderCoachMessages(')}\n`;
  vm.runInNewContext(`${src}\nthis.showCoachSetup=showCoachSetup;this.selectCoachMode=selectCoachMode;this.selectSimulationType=selectSimulationType;this.coachConversationPayload=coachConversationPayload;this.createCoachConversation=createCoachConversation;this.coachDisplayLabel=coachDisplayLabel;this.coachOpenerForCurrent=coachOpenerForCurrent;`, sandbox);
  return sandbox;
}

test('frontend : Objections exige un sous-type avant démarrage', async () => {
  const s = harness();
  s.selectCoachMode(s.buttons.simulation, 'simulation');
  assert.equal(s.elements['coach-simulation-types'].hidden, false);
  assert.equal(s.elements['coach-start-btn'].disabled, true);
  await s.createCoachConversation();
  assert.match(s.feedback.at(-1)[1], /Choisissez Objections/);
  assert.equal(s.posted.length, 0);
});

test('frontend : commercial envoie simulation_type=commercial', async () => {
  const s = harness();
  s.selectCoachMode(s.buttons.simulation, 'simulation');
  s.selectSimulationType(s.buttons.commercial, 'commercial');
  assert.equal(s.elements['coach-start-btn'].disabled, false);
  await s.createCoachConversation();
  assert.equal(s.posted[0].body.mode, 'simulation');
  assert.equal(s.posted[0].body.simulation_type, 'commercial');
  assert.match(s.posted[0].body.title, /commerciales/i);
});

test('frontend : recruitment envoie simulation_type=recruitment', async () => {
  const s = harness();
  s.selectCoachMode(s.buttons.simulation, 'simulation');
  s.selectSimulationType(s.buttons.recruitment, 'recruitment');
  const payload = s.coachConversationPayload('simulation');
  assert.equal(payload.simulation_type, 'recruitment');
  assert.match(s.coachOpenerForCurrent(), /recruteur/i);
});

test('frontend : changer de mode masque le sous-choix et n’envoie pas simulation_type', () => {
  const s = harness();
  s.selectCoachMode(s.buttons.simulation, 'simulation');
  s.selectSimulationType(s.buttons.commercial, 'commercial');
  s.selectCoachMode(s.buttons.interview, 'interview');
  assert.equal(s.elements['coach-simulation-types'].hidden, true);
  assert.equal(Object.hasOwn(s.coachConversationPayload('interview'), 'simulation_type'), false);
});

test('frontend : labels distincts et legacy recruitment', () => {
  const s = harness();
  assert.equal(s.coachDisplayLabel({ mode: 'simulation', simulation_type: 'commercial' }), 'Objections commerciales');
  assert.equal(s.coachDisplayLabel({ mode: 'simulation' }), 'Objections recrutement');
  assert.equal(s.coachDisplayLabel({ mode: 'interview' }), 'Entretien');
});

test('frontend : aria-pressed suit la sélection', () => {
  const s = harness();
  s.selectCoachMode(s.buttons.simulation, 'simulation');
  s.selectSimulationType(s.buttons.commercial, 'commercial');
  assert.equal(s.buttons.commercial['aria-pressed'], 'true');
  assert.equal(s.buttons.recruitment['aria-pressed'], 'false');
});
