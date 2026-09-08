const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const requireCandidatePlan = require('../middleware/requireCandidatePlan');
const { ensureCandidateProfile } = require('../utils/profiles');

// Route legacy : conserve l'accès aux anciens modules et historiques stockés dans
// candidats.axes. Toute nouvelle génération passe exclusivement par /api/assistant.

const MODULES = {
  m1: {
    titre: 'Entraînement à l\'entretien',
    description: 'Le chatbot pose des questions d\'entretien, vous répondez, il commente.',
    intro: 'Bonjour ! Je vais vous poser des questions d\'entretien d\'embauche commercial, une à la fois. Répondez comme vous le feriez face à un recruteur — quand vous êtes prêt·e, dites simplement "commençons".',
  },
  m2: {
    titre: 'Objections de recruteur',
    description: 'Le chatbot joue le recruteur sceptique, vous répondez à ses objections.',
    intro: 'Je vais jouer le rôle d\'un recruteur sceptique et vous soumettre des objections, une à la fois. Répondez comme vous le feriez en entretien — dites "commençons" quand vous êtes prêt·e.',
  },
  m3: {
    titre: 'Pitch de résultats chiffrés',
    description: 'Construisez un discours de preuve à partir de vos résultats commerciaux.',
    intro: 'Je vais vous aider à construire un pitch de résultats chiffrés, solide et vérifiable. Je vais vous poser quelques questions pour collecter vos chiffres, puis on les mettra en forme ensemble — dites "commençons" quand vous êtes prêt·e.',
  },
};

function moduleParam(req, res) {
  const id = String(req.query?.module || req.body?.module || '').trim();
  if (!MODULES[id]) {
    res.status(400).json({ error: 'Module invalide. Valeurs possibles : m1, m2, m3' });
    return null;
  }
  return id;
}

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

// Liste des 3 modules de coaching (palier Carrière Coaching).
router.get('/modules', authMiddleware, requireCandidatePlan('carriere_coaching'), async (req, res) => {
  res.json({
    modules: Object.entries(MODULES).map(([id, m]) => ({ id, titre: m.titre, description: m.description, intro: m.intro })),
  });
});

// Historique de la conversation en cours pour un module donné.
router.get('/chat', authMiddleware, requireCandidatePlan('carriere_coaching'), async (req, res) => {
  try {
    const moduleId = moduleParam(req, res);
    if (!moduleId) return;
    const candidat = await ensureCandidateProfile(req.user.id);
    res.json({ messages: candidat.axes?.meta?.coaching_chat?.[moduleId] || [] });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

router.post('/chat', authMiddleware, requireCandidatePlan('carriere_coaching'), async (req, res) => {
  res.set('Deprecation', 'true');
  res.status(410).json({
    code: 'COACH_ROUTE_DEPRECATED',
    message: 'Cette ancienne route de coaching ne génère plus de réponse. Utilisez le Coach commercial de votre espace candidat.',
  });
});

// Efface l'historique de conversation d'un module (repartir de zéro).
router.delete('/chat', authMiddleware, requireCandidatePlan('carriere_coaching'), async (req, res) => {
  try {
    const moduleId = moduleParam(req, res);
    if (!moduleId) return;
    const candidat = await ensureCandidateProfile(req.user.id);
    const allHistory = candidat.axes?.meta?.coaching_chat || {};
    const nextAxes = {
      ...(candidat.axes || {}),
      meta: { ...(candidat.axes?.meta || {}), coaching_chat: { ...allHistory, [moduleId]: [] } },
    };
    const { error } = await supabase.from('candidats').update({ axes: nextAxes }).eq('user_id', req.user.id);
    if (error) return res.status(400).json({ error });
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

module.exports = router;
