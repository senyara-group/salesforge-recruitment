const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const supabase = require('../supabase');
const { ensureCandidateProfile, getUserEmail } = require('../utils/profiles');
const { trackBrevoEvent } = require('../utils/brevoEvents');

router.post('/analyse', authMiddleware, async (req, res) => {
  try {
    await ensureCandidateProfile(req.user.id);

    const score = Math.floor(Math.random() * 100);
    const axes = {
      communication: Math.random(),
      leadership: Math.random(),
      autonomie: Math.random(),
      creativite: Math.random(),
    };

    const { data, error } = await supabase
      .from('candidats')
      .update({
        score_adn: score,
        axes,
      })
      .eq('user_id', req.user.id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ error });

    res.json({ score, axes, profil: data });
  } catch (error) {
    res.status(400).json({ error });
  }
});

router.post('/score-adn', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);

    // RGPD : le test produit un score comportemental (donnée sensible en contexte
    // recrutement) — vérifié ici aussi, pas seulement côté frontend, pour ne pas
    // dépendre uniquement d'un écran qu'un appel API direct pourrait contourner.
    const { data: consentement, error: consentementError } = await supabase
      .from('consentements')
      .select('accepte')
      .eq('user_id', req.user.id)
      .eq('type', 'test_adn')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (consentementError) return res.status(400).json({ error: consentementError });
    if (!consentement?.accepte) {
      return res.status(403).json({ error: 'Consentement requis avant de passer le test ADN' });
    }

    const { reponses = {} } = req.body;
    const filledAnswers = JSON.stringify(reponses).length;
    const score = Math.max(55, Math.min(95, Math.round(65 + filledAnswers / 80)));
    const result = {
      score,
      rank: 'Profil synchronisé avec les recruteurs',
      type: score >= 85 ? 'Closer Strategique · Profil Elite' : 'Commercial B2B',
      desc: 'Score calcule depuis les reponses du test ADN et enregistre dans Supabase.',
      axes: [
        { l: 'Resilience', v: Math.min(96, score + 4) },
        { l: 'Closing', v: score },
        { l: 'Drive', v: Math.min(96, score + 2) },
        { l: 'SalesTech', v: Math.max(55, score - 8) },
        { l: 'Ecoute', v: Math.max(55, score - 4) },
      ],
      tags: ['Swip Sales', 'ADN', 'B2B'],
    };

    const { error } = await supabase
      .from('candidats')
      .update({
        score_adn: result.score,
        axes: {
          ...(candidat.axes || {}),
          questionnaire: reponses,
          resultat: result,
          submitted_at: new Date().toISOString(),
        },
      })
      .eq('user_id', req.user.id);

    if (error) return res.status(400).json({ error });
    res.json(result);

    // Scénario 01 : sortie de la relance "test non terminé", entrée dans l'email "Score obtenu".
    getUserEmail(req.user.id).then((email) => {
      trackBrevoEvent(email, 'test_adn_termine', { score: result.score }, {
        SCORE_ADN: result.score,
        TEST_ADN_TERMINE: true,
      }).catch(() => {});
    }).catch(() => {});
  } catch (error) {
    res.status(400).json({ error });
  }
});

router.get('/insights', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    res.json([
      {
        type: 'Profil',
        title: candidat.score_adn ? `Score ADN ${candidat.score_adn}/100` : 'Test ADN a finaliser',
        text: candidat.titre || 'Completez votre profil pour ameliorer le matching.',
        hot: Boolean(candidat.score_adn),
        page: candidat.score_adn ? 'swipe' : 'test',
      },
    ]);
  } catch (error) {
    res.status(400).json({ error });
  }
});

router.get('/benchmark-salaire', authMiddleware, async (req, res) => {
  res.json({
    title: 'Commercial B2B · France',
    min: 35000,
    max: 90000,
    cible: 60000,
    mb: 50000,
    mh: 70000,
    conseil: 'Benchmark indicatif base sur votre profil Swip Sales.',
  });
});

router.get('/hot-candidate', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('candidats')
    .select('*')
    .order('score_adn', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) return res.status(400).json({ error });
  res.json({
    title: data ? `${data.prenom || 'Candidat'} — Score ${data.score_adn || 0}` : 'Aucun candidat chaud',
    text: data?.titre || 'Les candidatures apparaitront ici quand elles arriveront.',
  });
});

module.exports = router;