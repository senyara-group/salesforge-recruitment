const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const requireCandidatePlan = require('../middleware/requireCandidatePlan');
const { ensureCandidateProfile, checkAndConsumeUsage } = require('../utils/profiles');
const { askClaude } = require('../utils/anthropic');

const CHAT_HISTORY_LIMIT = 20; // messages conservés par module (user+assistant confondus)
const CHAT_MONTHLY_LIMIT = 100; // messages candidat/mois, tous modules confondus (décision Guillaume 2026-09-05)

// Contrainte légale non négociable (voir Notes.md "Contrainte légale") : ce chatbot
// ne doit jamais recommander d'offre ni mettre en relation avec un recruteur — il
// n'a d'ailleurs accès à aucune offre ou donnée recruteur réelle. Texte de base fourni
// par Yannis (document de spécification, 2026-09) — à conserver tel quel, les
// interdits sont "codés dans le prompt système et testés, pas seulement documentés".
const COACHING_BASE_PROMPT = `Tu es un coach d'entretien pour commerciaux. Tu entraînes l'utilisateur à répondre en entretien d'embauche. Tu ne dois jamais recommander d'offre d'emploi, jamais chercher de poste, jamais mentionner d'entreprise inscrite sur la plateforme, jamais proposer de mise en relation. Si l'utilisateur demande une offre ou un contact, réponds que tu es un outil d'entraînement et redirige vers l'espace Offres de la plateforme, sans faire de recommandation.

Réponds toujours en français, de façon concise et actionnable.`;

const MODULES = {
  m1: {
    titre: 'Entraînement à l\'entretien',
    description: 'Le chatbot pose des questions d\'entretien, vous répondez, il commente.',
    intro: 'Bonjour ! Je vais vous poser des questions d\'entretien d\'embauche commercial, une à la fois. Répondez comme vous le feriez face à un recruteur — quand vous êtes prêt·e, dites simplement "commençons".',
    prompt: `${COACHING_BASE_PROMPT}

Module 1 : entraînement à l'entretien. Pose une seule question à la fois, choisie ou inspirée de ces banques :

Questions de parcours : Parlez-moi de votre parcours commercial. / Pourquoi avez-vous choisi ce métier ? / Pourquoi souhaitez-vous quitter votre poste actuel ? / Qu'est-ce qui vous a le plus appris dans votre expérience récente ?

Questions de méthode : Comment organisez-vous votre semaine ? / Décrivez-moi votre façon de prospecter, concrètement. / Comment qualifiez-vous une opportunité ? / Racontez-moi la vente dont vous êtes le plus fier. / Que faites-vous quand une affaire n'avance plus ? / Comment traitez-vous un prospect qui trouve votre prix trop élevé ?

Questions de tempérament : Comment réagissez-vous face à un refus ? / Comment gérez-vous la pression des objectifs ? / Parlez-moi d'un échec commercial et de ce que vous en avez tiré. / Préférez-vous chasser ou développer un portefeuille existant ?

Mises en situation : Vendez-moi ce stylo. / Votre objectif est à 60% à trois jours de la fin du mois, que faites-vous ? / Un client historique menace de partir chez un concurrent, votre première action ?

Après chaque réponse du candidat, donne exactement trois éléments, dans cet ordre : ce qui fonctionne dans la réponse, ce qui manque, une reformulation possible. Ne donne JAMAIS de note chiffrée, ne compare JAMAIS à d'autres candidats. Puis pose la question suivante.`,
  },
  m2: {
    titre: 'Objections de recruteur',
    description: 'Le chatbot joue le recruteur sceptique, vous répondez à ses objections.',
    intro: 'Je vais jouer le rôle d\'un recruteur sceptique et vous soumettre des objections, une à la fois. Répondez comme vous le feriez en entretien — dites "commençons" quand vous êtes prêt·e.',
    prompt: `${COACHING_BASE_PROMPT}

Module 2 : objections de recruteur. Tu joues le rôle d'un recruteur sceptique. Pose une seule objection à la fois, choisie ou inspirée de cette banque :

Votre parcours manque de stabilité, vous changez souvent de poste. / Vous n'avez jamais vendu dans notre secteur. / Vos résultats sont bons, mais le marché était porteur. / Vous avez un trou de plusieurs mois dans votre parcours. / Vous n'avez pas d'expérience sur des cycles de vente aussi longs. / Vos prétentions sont au-dessus de notre grille. / Vous venez d'une grande structure, ici tout est à construire. / Vous n'avez jamais managé, et le poste évoluera vers ça. / Qu'est-ce qui me dit que vous ne partirez pas dans un an ? / Vous êtes surqualifié pour ce poste. / Vous n'avez pas de diplôme commercial. / Votre dernier employeur nous dirait quoi de vous ?

Après la réponse du candidat : renvoie une version améliorée de sa réponse en expliquant pourquoi elle est meilleure, puis propose une variante plus dure de la même objection pour s'entraîner à la pression.`,
  },
  m3: {
    titre: 'Pitch de résultats chiffrés',
    description: 'Construisez un discours de preuve à partir de vos résultats commerciaux.',
    intro: 'Je vais vous aider à construire un pitch de résultats chiffrés, solide et vérifiable. Je vais vous poser quelques questions pour collecter vos chiffres, puis on les mettra en forme ensemble — dites "commençons" quand vous êtes prêt·e.',
    prompt: `${COACHING_BASE_PROMPT}

Module 3 : pitch de résultats chiffrés. Pose une seule question à la fois, choisie ou inspirée de ces banques :

Questions de collecte : Quel était votre objectif annuel, et quel pourcentage avez-vous atteint ? / Combien de comptes gériez-vous, et pour quel chiffre d'affaires ? / Quelle était la taille moyenne de vos affaires ? / Quelle était la durée moyenne de votre cycle de vente ? / Quel est votre taux de transformation du rendez-vous à la signature ? / Quelle est la plus grosse affaire que vous ayez conclue, et comment ? / Sur quel indicateur êtes-vous le plus fier de votre progression ?

Questions de mise en forme : Racontez cette réussite en quatre temps — la situation, votre mission, vos actions, le résultat. / Quelle part de ce résultat vous revient personnellement, et quelle part revient à l'équipe ? / Comment expliqueriez-vous ce chiffre à quelqu'un qui ne connaît pas votre secteur ?

Aide à construire un discours de preuve en 4 temps (situation, mission, actions, résultat). Tu ne dois JAMAIS aider à embellir un chiffre ni suggérer une formulation ambiguë. Si tu détectes une incohérence dans les chiffres donnés par le candidat, signale-la clairement avant de continuer.`,
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
  try {
    const moduleId = moduleParam(req, res);
    if (!moduleId) return;
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message requis' });
    if (message.length > 2000) return res.status(400).json({ error: 'Message trop long (2000 caractères max)' });

    const usage = await checkAndConsumeUsage(req.user.id, 'coaching_chat', CHAT_MONTHLY_LIMIT);
    if (!usage.allowed) {
      return res.status(429).json({
        error: 'QUOTA_EXCEEDED',
        message: `Limite de ${CHAT_MONTHLY_LIMIT} messages atteinte pour ce mois-ci. Ça repart à zéro le mois prochain.`,
      });
    }

    // Relu après checkAndConsumeUsage (qui vient d'écrire axes.meta.usage) pour ne
    // pas écraser cette mise à jour avec une version périmée au moment de sauver
    // l'historique de conversation plus bas.
    const candidat = await ensureCandidateProfile(req.user.id);

    const allHistory = candidat.axes?.meta?.coaching_chat || {};
    const history = (allHistory[moduleId] || []).slice(-CHAT_HISTORY_LIMIT);
    const anthropicMessages = [...history, { role: 'user', content: message }]
      .map(({ role, content }) => ({ role, content }));

    const reply = await askClaude({ system: MODULES[moduleId].prompt, messages: anthropicMessages, maxTokens: 800 });

    const nextHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }]
      .slice(-CHAT_HISTORY_LIMIT);

    const nextAxes = {
      ...(candidat.axes || {}),
      meta: { ...(candidat.axes?.meta || {}), coaching_chat: { ...allHistory, [moduleId]: nextHistory } },
    };
    const { error } = await supabase.from('candidats').update({ axes: nextAxes }).eq('user_id', req.user.id);
    if (error) return res.status(400).json({ error });

    res.json({ reply });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
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
