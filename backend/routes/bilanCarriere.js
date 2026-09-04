const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const requireCandidatePlan = require('../middleware/requireCandidatePlan');
const { ensureCandidateProfile } = require('../utils/profiles');
const { askClaude } = require('../utils/anthropic');

// Questionnaire ADN approfondi (74 items, palier Carrière) — spécification fournie
// par Yannis, document "SwipSales_Questionnaire_ADN_et_Coaching", 2026-09.
// Table dédiée backend/supabase_bilan_carriere.sql, isolée du matching (voir Notes.md).

const BLOCK_TITLES = {
  b1: 'Profil chasseur ou éleveur',
  b2: 'Résistance au refus',
  b3: 'Style de closing',
  b4: 'Motivation au variable',
  b5: 'Méthode et pilotage',
  b6: 'Écoute et relation',
};

// item id -> inversé (true = une réponse 5 vaut 1 point)
const SCORING_CONFIG = {
  b1: { '03': false, '04': true, '05': false, '06': true, '07': false, '08': true, '09': false, '10': true, '11': false, '12': true, '13': false, '14': true },
  b2: { '15': false, '16': true, '17': false, '18': true, '19': false, '20': true, '21': false, '22': true, '23': false, '24': true, '25': false, '26': true },
  b3: { '27': false, '28': true, '29': false, '30': true, '31': false, '32': true, '33': false, '34': true, '35': false, '36': true, '37': false, '38': true },
  b4: { '39': false, '40': true, '41': false, '42': false, '43': true, '44': false, '45': false, '46': false, '47': false, '48': true },
  b5: { '49': false, '50': true, '51': false, '52': false, '53': true, '54': false, '55': false, '56': true, '57': false, '58': false },
  b6: { '59': false, '60': true, '61': false, '62': false, '63': true, '64': false, '65': false, '66': true, '67': false, '68': false },
};

function computeBlockScore(answers = {}, config) {
  const values = [];
  for (const [itemId, inverse] of Object.entries(config)) {
    const raw = Number(answers[itemId]);
    if (!Number.isFinite(raw) || raw < 1 || raw > 5) return null;
    values.push(inverse ? 6 - raw : raw);
  }
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round((avg / 5) * 100);
}

function computeScores(reponses = {}) {
  const scores = {};
  for (const [bloc, config] of Object.entries(SCORING_CONFIG)) {
    const s = computeBlockScore(reponses[bloc] || {}, config);
    if (s === null) {
      const error = new Error(`Bloc ${bloc} incomplet`);
      error.status = 400;
      throw error;
    }
    scores[bloc] = s;
  }

  // Détection de réponses automatiques (même valeur sur les 66 items scorés) —
  // "un candidat qui répond 5 partout obtient un profil incohérent, à signaler".
  const allRaw = Object.keys(SCORING_CONFIG).flatMap((bloc) => Object.keys(SCORING_CONFIG[bloc]).map((id) => Number(reponses[bloc]?.[id])));
  const incoherent = new Set(allRaw).size === 1;

  return { scores, incoherent };
}

function axeChasseurEleveur(scoreB1) {
  if (scoreB1 >= 60) return 'chasseur';
  if (scoreB1 <= 40) return 'éleveur';
  return 'cycle complet';
}

const RESTITUTION_SYSTEM_PROMPT = `Tu rédiges la restitution d'un bilan professionnel commercial pour SwipSales, à partir de scores déjà calculés (0 à 100) sur 6 dimensions. Règle de rédaction stricte, non négociable : aucune formule de jugement de valeur. On écrit "vous récupérez lentement après un refus", jamais "vous manquez de résilience". On écrit "votre style de closing est consultatif", jamais "vous ne savez pas conclure". Le candidat doit pouvoir montrer ce document sans gêne. Aucun sous-score n'est bon ou mauvais dans l'absolu.

Réponds UNIQUEMENT avec un objet JSON valide (pas de texte avant/après, pas de bloc markdown), avec exactement ces clés :
{
  "identite": "une phrase qui résume le profil commercial",
  "axe_chasseur_eleveur": "un paragraphe de 2-3 phrases décrivant le positionnement sur l'axe chasseur/éleveur/cycle complet, sans jugement de valeur",
  "closing_style_nom": "closing direct" | "closing consultatif" | "closing d'accompagnement",
  "closing_description": "un paragraphe de 2-3 phrases décrivant ce style et dans quel contexte de vente il performe le mieux",
  "variable_description": "un paragraphe de 2-3 phrases sur le rapport à la rémunération variable et ses implications pour le choix de poste",
  "axes_progression": ["action concrète 1", "action concrète 2", "action concrète 3"],
  "actions_semaine": ["action très concrète à faire cette semaine 1", "action 2", "action 3"]
}`;

async function generateRestitution({ scores, axe, closingStyleHint, b7 }) {
  const input = {
    scores_hors_axe_chasseur_eleveur: {
      resistance_au_refus: scores.b2,
      style_de_closing: scores.b3,
      motivation_au_variable: scores.b4,
      methode_et_pilotage: scores.b5,
      ecoute_et_relation: scores.b6,
    },
    positionnement_chasseur_eleveur: axe,
    score_closing_brut: scores.b3,
    reponses_libres_candidat: {
      etape_moins_confortable: b7?.['69'] || null,
      competence_prioritaire: b7?.['70'] || null,
      type_accompagnement_souhaite: b7?.['71'] || null,
      frequence_recul_sur_echecs: b7?.['72'] || null,
      deja_forme: b7?.['73'] || null,
      ce_qui_ferait_progresser: b7?.['74'] || null,
    },
  };

  const raw = await askClaude({
    system: RESTITUTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(input) }],
    maxTokens: 1200,
  });

  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    // Restitution générique de secours si le JSON n'est pas exploitable — ne doit
    // jamais faire échouer la soumission du questionnaire.
    return {
      identite: 'Profil commercial en cours d\'analyse.',
      axe_chasseur_eleveur: `Positionnement : ${axe}.`,
      closing_style_nom: closingStyleHint,
      closing_description: 'Restitution détaillée indisponible pour le moment — réessayez plus tard depuis votre profil.',
      variable_description: 'Restitution détaillée indisponible pour le moment.',
      axes_progression: [],
      actions_semaine: [],
    };
  }
}

// Consentement spécifique (distinct de "test_adn") : finalité déclarée "bilan
// professionnel personnel", propre au questionnaire approfondi.
router.get('/consentement', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('consentements')
      .select('type, version, accepte, created_at')
      .eq('user_id', req.user.id)
      .eq('type', 'bilan_carriere')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return res.status(400).json({ error });
    res.json(data || { type: 'bilan_carriere', accepte: false });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

router.get('/', authMiddleware, requireCandidatePlan('carriere'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bilans_carriere')
      .select('scores, restitution, type_poste, style_vente, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return res.status(400).json({ error });
    res.json(data || null);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

router.post('/', authMiddleware, requireCandidatePlan('carriere'), async (req, res) => {
  try {
    // RGPD : consentement explicite requis, indépendant du consentement au test
    // ADN court (finalité déclarée différente : bilan professionnel personnel).
    const { data: consentement, error: consentementError } = await supabase
      .from('consentements')
      .select('accepte')
      .eq('user_id', req.user.id)
      .eq('type', 'bilan_carriere')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (consentementError) return res.status(400).json({ error: consentementError });
    if (!consentement?.accepte) {
      return res.status(403).json({ error: 'Consentement requis avant de passer le questionnaire approfondi' });
    }

    const reponses = req.body?.reponses || {};
    const typePoste = reponses.b0?.poste || null;
    const styleVente = reponses.b0?.style || null;

    const { scores, incoherent } = computeScores(reponses);
    const axe = axeChasseurEleveur(scores.b1);
    const closingHint = scores.b3 >= 60 ? 'closing direct' : scores.b3 <= 40 ? 'closing d\'accompagnement' : 'closing consultatif';

    const restitution = await generateRestitution({ scores, axe, closingStyleHint: closingHint, b7: reponses.b7 });
    if (incoherent) {
      restitution.alerte_incoherence = 'Vos réponses suivent un schéma répétitif (mêmes valeurs sur l\'ensemble des items) — ce résultat est probablement peu fiable. N\'hésitez pas à repasser le questionnaire avec plus d\'attention à chaque item.';
    }

    const { data, error } = await supabase
      .from('bilans_carriere')
      .insert({
        user_id: req.user.id,
        type_poste: typePoste,
        style_vente: styleVente,
        reponses,
        scores: { ...scores, axe_chasseur_eleveur: axe, incoherent },
        restitution,
      })
      .select('scores, restitution, type_poste, style_vente, created_at')
      .single();
    if (error) return res.status(400).json({ error });

    res.json(data);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

// Benchmark anonymisé par typologie de poste sur le questionnaire approfondi —
// même principe de seuil k>=5 que GET /candidats/benchmark.
const BENCHMARK_MIN_SAMPLE = 5;
router.get('/benchmark', authMiddleware, requireCandidatePlan('carriere_coaching'), async (req, res) => {
  try {
    const { data: mine, error: mineError } = await supabase
      .from('bilans_carriere')
      .select('scores, type_poste')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (mineError) return res.status(400).json({ error: mineError });
    if (!mine?.type_poste) {
      return res.status(400).json({ error: 'Passez le questionnaire approfondi pour connaître votre typologie de poste' });
    }

    const { data, error } = await supabase
      .from('bilans_carriere')
      .select('scores')
      .eq('type_poste', mine.type_poste);
    if (error) return res.status(400).json({ error });

    if (data.length < BENCHMARK_MIN_SAMPLE) {
      return res.json({
        type_poste: mine.type_poste,
        assez_de_donnees: false,
        echantillon: data.length,
        message: 'Pas encore assez de bilans sur cette typologie de poste pour un benchmark anonyme et fiable.',
      });
    }

    const blocs = Object.keys(BLOCK_TITLES);
    const moyennes = {};
    blocs.forEach((b) => {
      const vals = data.map((d) => Number(d.scores?.[b])).filter((v) => Number.isFinite(v));
      moyennes[b] = vals.length ? Math.round(vals.reduce((a, c) => a + c, 0) / vals.length) : null;
    });

    res.json({
      type_poste: mine.type_poste,
      assez_de_donnees: true,
      echantillon: data.length,
      moyennes,
      vos_scores: mine.scores,
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

router.get('/export-pdf', authMiddleware, requireCandidatePlan('carriere'), async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const { data: bilan, error } = await supabase
      .from('bilans_carriere')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return res.status(400).json({ error });
    if (!bilan) return res.status(400).json({ error: 'Aucun bilan à exporter — passez le questionnaire d\'abord' });

    const s = bilan.scores;
    const r = bilan.restitution;
    const nom = [candidat.prenom, candidat.nom].filter(Boolean).join(' ') || 'Candidat';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="swipsales-bilan-carriere.pdf"');

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    // Page 1 — identité + axe chasseur-éleveur
    doc.fontSize(22).text('SwipSales — Bilan de carrière commercial');
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor('#555').text(nom + ' — Généré le ' + new Date(bilan.created_at).toLocaleDateString('fr-FR'));
    doc.moveDown(1.5);
    doc.fillColor('#000').fontSize(15).text(r.identite || '');
    doc.moveDown();
    doc.fontSize(13).text('Positionnement : ' + (s.axe_chasseur_eleveur || ''));
    doc.fontSize(11).fillColor('#333').text(r.axe_chasseur_eleveur || '', { width: 480 });
    if (r.alerte_incoherence) {
      doc.moveDown();
      doc.fontSize(10).fillColor('#B45309').text(r.alerte_incoherence, { width: 480 });
    }

    // Page 2 — cinq sous-scores
    doc.addPage();
    doc.fillColor('#000').fontSize(16).text('Vos cinq axes');
    doc.moveDown();
    Object.entries(BLOCK_TITLES).filter(([b]) => b !== 'b1').forEach(([b, titre]) => {
      doc.fontSize(12).text(`${titre} : ${s[b]} / 100`);
      doc.moveDown(0.4);
    });

    // Page 3 — style de closing
    doc.addPage();
    doc.fillColor('#000').fontSize(16).text('Votre style de closing');
    doc.moveDown();
    doc.fontSize(13).text(r.closing_style_nom || '');
    doc.fontSize(11).fillColor('#333').text(r.closing_description || '', { width: 480 });

    // Page 4 — rapport au variable
    doc.addPage();
    doc.fillColor('#000').fontSize(16).text('Votre rapport au variable');
    doc.moveDown();
    doc.fontSize(11).fillColor('#333').text(r.variable_description || '', { width: 480 });

    // Page 5 — axes de progression
    doc.addPage();
    doc.fillColor('#000').fontSize(16).text('Vos axes de progression');
    doc.moveDown();
    (r.axes_progression || []).forEach((a) => { doc.fontSize(11).fillColor('#333').text('•  ' + a, { width: 480 }); doc.moveDown(0.4); });

    // Page 6 — actions de la semaine
    doc.addPage();
    doc.fillColor('#000').fontSize(16).text('À faire dès cette semaine');
    doc.moveDown();
    (r.actions_semaine || []).forEach((a) => { doc.fontSize(11).fillColor('#333').text('•  ' + a, { width: 480 }); doc.moveDown(0.4); });

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#999').text(
      'Ce bilan est un outil de développement personnel indicatif. Il n\'est jamais utilisé pour le matching ou visible des recruteurs.',
      { width: 480 }
    );

    doc.end();
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
});

module.exports = router;
