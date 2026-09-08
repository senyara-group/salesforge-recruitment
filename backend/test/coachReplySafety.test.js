const test = require('node:test');
const assert = require('node:assert/strict');
const { AI_SAFETY_FALLBACK, inspectAssistantOutput } = require('../utils/aiSafety');
const { COACH_MODES, normalizeCoachReply, formatCoachReply, coachSystemPrompt } = require('../utils/coachReply');

test('modes Yannis restent compatibles avec simulation exposé comme Objections', () => {
  for (const mode of ['interview','objections','pitch','simulation']) assert.equal(COACH_MODES.has(mode), true);
  assert.match(coachSystemPrompt('interview', '{}'), /une seule question/i);
  assert.match(coachSystemPrompt('objections', '{}'), /une seule objection/i);
  assert.match(coachSystemPrompt('pitch', '{}'), /une seule question/i);
  assert.match(coachSystemPrompt('simulation', '{}'), /une seule objection/i);
});

test('réponse Coach devient un feedback structuré suivi d’une seule question', () => {
  const reply = normalizeCoachReply({ feedback:{ works:'Clair', missing:'Un exemple', rewrite:'Version factuelle' }, next:{ type:'question', content:'Quel résultat précis ?' } }, 'interview');
  const text = formatCoachReply(reply);
  assert.match(text, /Ce qui fonctionne/); assert.match(text, /Ce qui manque/); assert.match(text, /Reformulation possible/); assert.match(text, /Question suivante/);
  assert.equal((text.match(/Question suivante/g) || []).length, 1);
});

test('mode Objections impose une objection suivante', () => {
  const reply = normalizeCoachReply({ feedback:{}, next:{ type:'question', content:'Pourquoi ?' } }, 'objections');
  assert.equal(reply.next.type, 'objection');
  assert.match(formatCoachReply(reply), /Objection suivante/);
  assert.equal(normalizeCoachReply({ next:{ type:'question', content:'Pourquoi ?' } }, 'simulation').next.type, 'objection');
});

test('prompt Coach interdit note, comparaison, placement et invention', () => {
  const prompt = coachSystemPrompt('pitch', '{}');
  assert.match(prompt, /aucune note chiffrée/i); assert.match(prompt, /compare jamais/i); assert.match(prompt, /ne recommande aucune offre/i); assert.match(prompt, /n'invente jamais chiffre/i);
});

test('filtre ciblé bloque les sorties plateforme interdites', () => {
  const cases = [
    ['Je vous recommande cette offre.', 'offer_recommendation'],
    ['Cette offre vous correspond parfaitement.', 'offer_recommendation'],
    ['Postulez à cette offre dès maintenant.', 'specific_application'],
    ['Je peux vous mettre en relation avec un recruteur.', 'connection'],
    ['Cette entreprise inscrite sur SwipSales recherche votre profil.', 'platform_company'],
  ];
  for (const [content, incidentType] of cases) {
    const blocked = inspectAssistantOutput(content);
    assert.equal(blocked.safe, false, content);
    assert.equal(blocked.incidentType, incidentType, content);
  }
  assert.doesNotMatch(AI_SAFETY_FALLBACK, /Anthropic|Claude|token|coût/i);
  assert.equal(inspectAssistantOutput('Je vous donne une note de 8/10.').safe, false);
  assert.equal(inspectAssistantOutput('Vous êtes meilleur que les autres candidats.').safe, false);
});

test('filtre ciblé ne bloque pas les formulations génériques utiles', () => {
  for (const content of [
    'Une entreprise SaaS peut attendre un pitch concis.',
    'Un recruteur peut attendre un exemple vérifiable.',
    'Dans une entreprise de votre secteur, adaptez le vocabulaire.',
    'Vous pouvez expliquer comment vous avez traité une objection.',
  ]) assert.equal(inspectAssistantOutput(content).safe, true, content);
});
