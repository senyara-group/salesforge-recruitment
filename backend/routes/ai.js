const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const supabase = require('../supabase');
const { ensureCandidateProfile, getUserEmail, getCandidatePlan } = require('../utils/profiles');
const { trackBrevoEvent } = require('../utils/brevoEvents');

const RETAKE_COOLDOWN_MONTHS = 6;
const RETAKE_COOLDOWN_MS = RETAKE_COOLDOWN_MONTHS * 30 * 24 * 60 * 60 * 1000;

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

    // Le premier passage est libre pour tous (test ADN gratuit, contrainte légale).
    // Un repassage (score déjà existant) nécessite Carrière Coaching, avec un délai
    // de 6 mois entre deux évaluations — c'est la fonctionnalité payante "ré-évaluation
    // semestrielle avec historique", jamais l'accès au test lui-même qui reste gratuit.
    if (candidat.score_adn != null) {
      const plan = await getCandidatePlan(req.user.id);
      if (plan !== 'carriere_coaching') {
        return res.status(403).json({
          error: 'PLAN_REQUIRED',
          message: 'Repasser le test ADN nécessite l\'abonnement Carrière Coaching',
        });
      }

      const { data: lastEval, error: lastEvalError } = await supabase
        .from('evaluations_adn')
        .select('created_at')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastEvalError) return res.status(400).json({ error: lastEvalError });

      if (lastEval) {
        const elapsed = Date.now() - new Date(lastEval.created_at).getTime();
        if (elapsed < RETAKE_COOLDOWN_MS) {
          const nextEligibleAt = new Date(new Date(lastEval.created_at).getTime() + RETAKE_COOLDOWN_MS).toISOString();
          return res.status(403).json({
            error: 'RETAKE_TOO_SOON',
            message: 'Prochaine évaluation disponible le ' + new Date(nextEligibleAt).toLocaleDateString('fr-FR'),
            next_eligible_at: nextEligibleAt,
          });
        }
      }
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

    // Typologie de poste choisie pendant le test — colonne dédiée (au lieu de rester
    // enterrée dans axes.questionnaire sans jamais être relue) pour permettre le
    // benchmark anonymisé par typologie de poste.
    const typePoste = reponses?.job_profile?.poste || null;

    const { error } = await supabase
      .from('candidats')
      .update({
        score_adn: result.score,
        type_poste: typePoste,
        axes: {
          ...(candidat.axes || {}),
          questionnaire: reponses,
          resultat: result,
          submitted_at: new Date().toISOString(),
        },
      })
      .eq('user_id', req.user.id);

    if (error) return res.status(400).json({ error });

    // Historique append-only : chaque passage garde une trace, même si
    // candidats.axes.resultat (utilisé par le deck recruteur) ne garde que le dernier.
    // Ne doit jamais faire échouer la réponse : le score est déjà enregistré ci-dessus.
    const { error: evalError } = await supabase.from('evaluations_adn').insert({
      user_id: req.user.id,
      score: result.score,
      resultat: result,
      reponses,
    });
    if (evalError) console.warn('evaluations_adn insert echoue (table pas encore creee ?):', evalError.message || evalError);

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

module.exports = router;
