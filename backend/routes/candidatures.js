const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const requireRecruiterPlan = require('../middleware/requireRecruiterPlan');
const { ensureCandidateProfile, ensureRecruiterProfile } = require('../utils/profiles');
const { STATUS_LABELS, assertTransition, canWithdraw } = require('../utils/applicationWorkflow');

function initials(text = '') {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'SF';
}

function formatCandidateRow(row) {
  const offre = row.offres || {};
  const entreprise = offre.recruteurs?.entreprise || 'Entreprise';
  const statut = row.statut || 'envoyee';
  return {
    id: row.id,
    co: initials(entreprise),
    bg: '#1340E0',
    title: offre.titre || 'Offre',
    sub: `${entreprise} · ${offre.type || ''} · ${offre.lieu || ''}`.replace(/\s+·\s+$/g, ''),
    statut,
    sl: STATUS_LABELS[statut] || statut,
    can_withdraw: canWithdraw(statut),
    auto: row.lettre_type === 'auto',
    date: row.created_at ? new Date(row.created_at).toLocaleDateString('fr-FR') : '',
  };
}

function formatRecruiterRow(row) {
  const snapshotProfile = row.snapshot?.profile || {};
  const candidat = Object.keys(snapshotProfile).length ? snapshotProfile : (row.candidats || {});
  const score = candidat.score_adn || 0;
  const tags = Object.keys(candidat.axes || {}).filter((key) => typeof candidat.axes[key] === 'number').slice(0, 3);
  const name = [candidat.prenom, candidat.nom ? `${candidat.nom.slice(0, 1)}.` : ''].filter(Boolean).join(' ') || 'Candidat';

  return {
    id: row.id,
    offre_id: row.offre_id,
    offre_title: row.offres?.titre || 'Offre',
    statut: row.statut || 'envoyee',
    statut_label: STATUS_LABELS[row.statut || 'envoyee'],
    snapshot: row.snapshot || {},
    candidat_id: candidat.id,
    av: `${candidat.prenom?.[0] || ''}${candidat.nom?.[0] || ''}`.toUpperCase() || 'SF',
    bg: '#1340E0',
    name,
    titre: candidat.titre || 'Commercial',
    score,
    hot: score >= 85,
    badge: row.lettre_type === 'auto' ? 'Auto' : score >= 85 ? 'Chaud' : '',
    badgeBg: score >= 85 ? 'var(--rs)' : 'var(--gs)',
    badgeColor: score >= 85 ? 'var(--r)' : 'var(--g)',
    tags: tags.length ? tags : ['Profil'],
  };
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const limit = Number(req.query.limit || 100);
    const { data, error } = await supabase
      .from('candidatures')
      .select('id, statut, lettre_type, created_at, offres(id, titre, type, lieu, recruteurs(entreprise))')
      .eq('candidat_id', candidat.id)
      .or('lettre_type.is.null,lettre_type.neq.recruteur_like')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return res.status(400).json({ error });
    res.json(data.map(formatCandidateRow));
  } catch (error) {
    res.status(400).json({ error });
  }
});

router.get('/recues', authMiddleware, requireRecruiterPlan, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { data: offres, error: offresError } = await supabase
      .from('offres')
      .select('id')
      .eq('recruteur_id', recruteur.id);
    if (offresError) return res.status(400).json({ error: offresError });

    const offreIds = offres.map((offre) => offre.id);
    const limit = Number(req.query.limit || 100);
    const { data, error } = offreIds.length
      ? await supabase
        .from('candidatures')
        .select('id, offre_id, statut, lettre_type, snapshot, created_at, offres(id,titre), candidats(id, nom, prenom, titre, score_adn, axes)')
        .in('offre_id', offreIds)
        .or('lettre_type.is.null,lettre_type.neq.recruteur_like')
        .order('created_at', { ascending: false })
        .limit(limit)
      : { data: [], error: null };

    if (error) return res.status(400).json({ error });
    res.json(data.map(formatRecruiterRow));
  } catch (error) {
    res.status(400).json({ error });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const { data: candidature, error } = await supabase.from('candidatures').select('id,statut')
      .eq('id', req.params.id).eq('candidat_id', candidat.id).maybeSingle();
    if (error) throw error;
    if (!candidature) return res.status(404).json({ error: 'Candidature introuvable' });
    if (!canWithdraw(candidature.statut)) return res.status(409).json({ error: 'Cette candidature ne peut plus être retirée après prise de contact' });
    const { data, error: updateError } = await supabase.from('candidatures')
      .update({ statut: 'retiree', withdrawn_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', candidature.id).eq('candidat_id', candidat.id).select('id,statut,withdrawn_at').single();
    if (updateError) throw updateError;
    res.json({ ...data, statut_label: STATUS_LABELS.retiree });
  } catch (error) { res.status(error.status || 400).json({ error: error.message || error }); }
});

router.put('/:id/status', authMiddleware, requireRecruiterPlan, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { data: candidature, error } = await supabase.from('candidatures')
      .select('id,statut,offres(recruteur_id)').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!candidature) return res.status(404).json({ error: 'Candidature introuvable' });
    if (String(candidature.offres?.recruteur_id) !== String(recruteur.id)) return res.status(403).json({ error: 'Candidature non autorisée' });
    const nextStatus = String(req.body?.statut || '');
    assertTransition(candidature.statut || 'envoyee', nextStatus);
    const { data, error: updateError } = await supabase.from('candidatures')
      .update({ statut: nextStatus, updated_at: new Date().toISOString() })
      .eq('id', candidature.id).select('id,statut,updated_at').single();
    if (updateError) throw updateError;
    res.json({ ...data, statut_label: STATUS_LABELS[nextStatus] });
  } catch (error) { res.status(error.status || 400).json({ error: error.message || error, code: error.code }); }
});

router.put('/:id/note', authMiddleware, requireRecruiterPlan, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const note = String(req.body?.note || '').trim();
    if (note.length > 4000) return res.status(400).json({ error: 'Note interne trop longue' });
    const { data: candidature, error } = await supabase.from('candidatures')
      .select('id,offres(recruteur_id)').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!candidature) return res.status(404).json({ error: 'Candidature introuvable' });
    if (String(candidature.offres?.recruteur_id) !== String(recruteur.id)) return res.status(403).json({ error: 'Candidature non autorisée' });
    const { data, error: updateError } = await supabase.from('candidatures').update({ internal_note: note, updated_at: new Date().toISOString() })
      .eq('id', candidature.id).select('id,internal_note,updated_at').single();
    if (updateError) throw updateError;
    res.json(data);
  } catch (error) { res.status(error.status || 400).json({ error: error.message || error }); }
});

module.exports = router;
