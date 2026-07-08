const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureCandidateProfile, ensureRecruiterProfile } = require('../utils/profiles');

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
    sl: ({ envoyee: 'Envoyee', nouveau: 'En attente', vu: 'Profil vu', repondu: 'A repondu', entretien: 'Entretien' }[statut] || statut),
    auto: row.lettre_type === 'auto',
    date: row.created_at ? new Date(row.created_at).toLocaleDateString('fr-FR') : '',
  };
}

function formatRecruiterRow(row) {
  const candidat = row.candidats || {};
  const score = candidat.score_adn || 0;
  const tags = Object.keys(candidat.axes || {}).filter((key) => typeof candidat.axes[key] === 'number').slice(0, 3);
  const name = [candidat.prenom, candidat.nom ? `${candidat.nom.slice(0, 1)}.` : ''].filter(Boolean).join(' ') || 'Candidat';

  return {
    id: row.id,
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

router.get('/recues', authMiddleware, async (req, res) => {
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
        .select('id, statut, lettre_type, created_at, candidats(id, nom, prenom, titre, score_adn, axes)')
        .in('offre_id', offreIds)
        .order('created_at', { ascending: false })
        .limit(limit)
      : { data: [], error: null };

    if (error) return res.status(400).json({ error });
    res.json(data.map(formatRecruiterRow));
  } catch (error) {
    res.status(400).json({ error });
  }
});

module.exports = router;
