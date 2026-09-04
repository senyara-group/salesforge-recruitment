const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const requireCandidatePlan = require('../middleware/requireCandidatePlan');
const { ensureCandidateProfile } = require('../utils/profiles');
const { askClaude } = require('../utils/anthropic');

const CHAT_HISTORY_LIMIT = 20; // messages conservés (user+assistant confondus)

// Contrainte légale non négociable (voir Notes.md "Contrainte légale") : ce chatbot
// ne doit jamais recommander d'offre ni mettre en relation avec un recruteur — il
// n'a d'ailleurs accès à aucune offre ou donnée recruteur réelle, seulement à ce
// prompt système et à l'historique de la conversation en cours.
const COACHING_SYSTEM_PROMPT = `Tu es le coach IA de SwipSales, une plateforme de recrutement commercial pour candidats (SDR, Account Executive, Key Account Manager, commerciaux terrain...).

Ton rôle : aider le candidat à s'entraîner — simulations d'entretien, gestion d'objections, structuration d'un pitch commercial, préparation d'une négociation salariale ou d'un plan de commissionnement, plan des 90 premiers jours.

Règles strictes, non négociables :
- Tu ne recommandes JAMAIS d'offre d'emploi précise, ni ne suggères de candidater à une offre en particulier.
- Tu ne mets JAMAIS en relation avec un recruteur ni ne prétends en avoir la capacité.
- Tu n'as accès à aucune offre, recruteur ou candidature réelle — n'invente jamais d'informations sur ce sujet.
- Ton rôle se limite à l'entraînement et au conseil de carrière général.
- Si on te demande de recommander une offre ou un recruteur, décline clairement et invite la personne à consulter la page "Offres" de l'application elle-même.

Réponds en français, de façon concise et actionnable.`;

router.get('/dashboard', authMiddleware, async (req, res) => {
  const candidat = await ensureCandidateProfile(req.user.id);
  const axes = candidat.axes?.resultat?.axes || [];
  res.json({
    streak: candidat.axes?.meta?.streak || 0,
    module_tag: 'Module du jour',
    module_title: 'SalesTech — CRM Avance',
    module_text: 'Module recommande depuis votre profil ADN.',
    cert_title: candidat.score_adn ? 'Certifie Swip Sales' : 'Certification a debloquer',
    cert_sub: candidat.score_adn ? `Score ADN ${candidat.score_adn}/100` : 'Passez le test ADN',
    skills: (Array.isArray(axes) ? axes : []).map((axis) => ({
      l: axis.l,
      s: axis.v,
      fill: 'var(--bs)',
      ic: 'var(--b)',
      n: 1,
      weak: axis.v < 80,
    })),
  });
});

router.post('/start-module', authMiddleware, async (_req, res) => {
  res.json({ success: true });
});

// Historique de la conversation en cours (palier Carrière Coaching).
router.get('/chat', authMiddleware, requireCandidatePlan('carriere_coaching'), async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    res.json({ messages: candidat.axes?.meta?.coaching_chat || [] });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

router.post('/chat', authMiddleware, requireCandidatePlan('carriere_coaching'), async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message requis' });
    if (message.length > 2000) return res.status(400).json({ error: 'Message trop long (2000 caractères max)' });

    const history = (candidat.axes?.meta?.coaching_chat || []).slice(-CHAT_HISTORY_LIMIT);
    const anthropicMessages = [...history, { role: 'user', content: message }]
      .map(({ role, content }) => ({ role, content }));

    const reply = await askClaude({ system: COACHING_SYSTEM_PROMPT, messages: anthropicMessages, maxTokens: 800 });

    const nextHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }]
      .slice(-CHAT_HISTORY_LIMIT);

    const nextAxes = {
      ...(candidat.axes || {}),
      meta: { ...(candidat.axes?.meta || {}), coaching_chat: nextHistory },
    };
    const { error } = await supabase.from('candidats').update({ axes: nextAxes }).eq('user_id', req.user.id);
    if (error) return res.status(400).json({ error });

    res.json({ reply });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

// Efface l'historique de conversation (repartir de zéro).
router.delete('/chat', authMiddleware, requireCandidatePlan('carriere_coaching'), async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const nextAxes = { ...(candidat.axes || {}), meta: { ...(candidat.axes?.meta || {}), coaching_chat: [] } };
    const { error } = await supabase.from('candidats').update({ axes: nextAxes }).eq('user_id', req.user.id);
    if (error) return res.status(400).json({ error });
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

module.exports = router;
