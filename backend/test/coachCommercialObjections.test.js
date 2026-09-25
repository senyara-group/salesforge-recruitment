const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  coachSystemPrompt,
  resolveSimulationType,
  parseSimulationTypeInput,
  resolveStoredSimulationType,
  isObjectionMode,
  SHARED_INTERDICTIONS,
  SIMULATION_TYPES,
  normalizeCoachReply,
  formatCoachReply,
} = require('../utils/coachReply');
const { inspectAssistantOutput } = require('../utils/aiSafety');

const assistantSource = fs.readFileSync(path.join(__dirname, '../routes/assistant.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../../frontend/_spaces/candidat.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../../frontend/app-professional.css'), 'utf8');

test('1. simulation legacy sans subtype → recruitment', () => {
  assert.equal(parseSimulationTypeInput({}), 'recruitment');
  assert.equal(parseSimulationTypeInput({ mode: 'simulation' }), 'recruitment');
  assert.equal(resolveStoredSimulationType(undefined), 'recruitment');
  const prompt = coachSystemPrompt('simulation', '{}');
  assert.match(prompt, /recruteur sceptique/i);
  assert.doesNotMatch(prompt, /prospect ou un client/i);
});

test('2. simulation_type=recruitment → prompt recrutement', () => {
  const prompt = coachSystemPrompt('simulation', '{}', 'recruitment');
  assert.match(prompt, /recruteur sceptique/i);
  assert.match(prompt, /manque d'expérience|trou dans le CV|salaire/i);
});

test('3. simulation_type=commercial → prompt commercial', () => {
  const prompt = coachSystemPrompt('simulation', '{}', 'commercial');
  assert.match(prompt, /prospect ou un client/i);
  assert.match(prompt, /prix\/budget|concurrence|closing/i);
  assert.match(prompt, /UNE objection/i);
});

test('4. valeur inconnue ou type invalide → refus validation strict', () => {
  assert.throws(() => parseSimulationTypeInput({ simulation_type: 'sales' }), { code: 'INVALID_SIMULATION_TYPE', status: 400 });
  assert.throws(() => parseSimulationTypeInput({ simulation_type: 'RECRUITMENT' }), { code: 'INVALID_SIMULATION_TYPE' });
  assert.throws(() => parseSimulationTypeInput({ simulation_type: null }), { code: 'INVALID_SIMULATION_TYPE' });
  assert.throws(() => parseSimulationTypeInput({ simulation_type: '' }), { code: 'INVALID_SIMULATION_TYPE' });
  assert.throws(() => parseSimulationTypeInput({ simulation_type: ['commercial'] }), { code: 'INVALID_SIMULATION_TYPE' });
  assert.equal(resolveStoredSimulationType('sales'), 'recruitment');
  assert.equal(resolveSimulationType(undefined), 'recruitment');
});

test('5. commercial prompt ne contient pas de rôle recruteur', () => {
  const prompt = coachSystemPrompt('simulation', '{}', 'commercial');
  assert.doesNotMatch(prompt, /Joue un recruteur/i);
  assert.doesNotMatch(prompt, /recruteur sceptique/i);
});

test('6. recruitment conserve le comportement recruteur', () => {
  const prompt = coachSystemPrompt('objections', '{}', 'recruitment');
  assert.match(prompt, /recruteur sceptique/i);
  assert.equal(normalizeCoachReply({ next: { type: 'question', content: 'x' } }, 'simulation').next.type, 'objection');
});

test('7. garde-fous communs présents dans les deux', () => {
  for (const type of SIMULATION_TYPES) {
    const prompt = coachSystemPrompt('simulation', '{}', type);
    assert.match(prompt, /ne recommande aucune offre/i);
    assert.match(prompt, /mise en relation/i);
    assert.match(prompt, /n'invente jamais/i);
    assert.match(prompt, /matching|score ADN|visibilité/i);
    assert.ok(prompt.includes(SHARED_INTERDICTIONS.split(':')[0]));
  }
});

test('8. commercial ne peut pas recommander offres / entreprises / intros (filtre sortie)', () => {
  for (const content of [
    'Je vous recommande cette offre SwipSales.',
    'Je peux vous mettre en relation avec un recruteur.',
    'Cette entreprise inscrite sur SwipSales recherche votre profil.',
  ]) {
    assert.equal(inspectAssistantOutput(content).safe, false, content);
  }
  assert.equal(inspectAssistantOutput(formatCoachReply(normalizeCoachReply({
    feedback: { works: 'Bonne reformulation', missing: 'Demandez le budget', rewrite: 'Quel budget avez-vous prévu ?' },
    next: { type: 'objection', content: 'C’est trop cher par rapport à notre concurrent.' },
  }, 'simulation'))).safe, true);
});

test('9–10. quota et plan Coaching inchangés (contrat route)', () => {
  assert.match(assistantSource, /assertAiAccess\(req\.user\.id, 'coach'\)/);
  assert.match(assistantSource, /reserveUsage\([\s\S]*'coach'/);
  assert.match(assistantSource, /finalizeUsage/);
  assert.doesNotMatch(assistantSource, /quota:\s*200|1000/);
});

test('11–12. context_data / simulation_type persistés côté create + lecture publique', () => {
  assert.match(assistantSource, /simulation_type/);
  assert.match(assistantSource, /contextSnapshot\(req\.body, profile, \{ simulationType \}\)/);
  assert.match(assistantSource, /function publicConversation/);
  assert.match(assistantSource, /select\('id,mode,title,created_at,updated_at,context_data'\)/);
  assert.match(assistantSource, /\.\.\.publicConversation\(/);
});

test('13. changement subtype = nouvelle conversation (PATCH mode/subtype immuables)', () => {
  const patch = assistantSource.slice(assistantSource.indexOf("router.patch('/conversations/:id'"), assistantSource.indexOf("router.post('/conversations/:id/reset'"));
  assert.match(patch, /CONVERSATION_MODE_IMMUTABLE/);
  assert.match(patch, /CONVERSATION_CONTEXT_IMMUTABLE/);
  assert.match(html, /showCoachSetup\(\)/);
  assert.match(html, /restartCoachConversation/);
});

test('14. output filter toujours appliqué sur le Coach', () => {
  assert.match(assistantSource, /inspectAssistantOutput/);
  assert.match(assistantSource, /AI_SAFETY_FALLBACK/);
});

test('comportement commercial : une objection, feedback, familles clés', () => {
  const prompt = coachSystemPrompt('simulation', '{"profil":{}}', 'commercial');
  for (const needle of ['prix', 'concurrence', 'prospection', 'timing', 'décideur', 'ROI', 'closing', 'Progression']) {
    assert.match(prompt, new RegExp(needle, 'i'));
  }
  assert.match(prompt, /une seule/i);
  assert.match(prompt, /n'invente|sans inventer|n'invente jamais/i);
});

test('frontend : choix commercial/recrutement et context_data', () => {
  assert.match(html, /coach-simulation-types/);
  assert.match(html, /selectSimulationType\(this,'commercial'\)/);
  assert.match(html, /selectSimulationType\(this,'recruitment'\)/);
  assert.match(html, /aria-pressed/);
  assert.match(html, /payload\.simulation_type/);
  assert.match(html, /COACH_SIMULATION_TYPE/);
  assert.match(html, /Objections commerciales/);
  assert.match(html, /Objections recrutement/);
  assert.match(css, /coach-simulation-type-grid/);
  assert.match(html, /conversation\.simulation_type/);
});

test('isObjectionMode couvre simulation et objections legacy', () => {
  assert.equal(isObjectionMode('simulation'), true);
  assert.equal(isObjectionMode('objections'), true);
  assert.equal(isObjectionMode('interview'), false);
});
