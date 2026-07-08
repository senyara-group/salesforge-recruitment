const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureCandidateProfile, ensureRecruiterProfile } = require('../utils/profiles');

function uniqueValues(values = []) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function publicError(res, error) {
  return res.status(error.status || 400).json({ error: error.message || error });
}

function validateOfferPayload({ titre, type, lieu }) {
  if (!String(titre || '').trim()) {
    const error = new Error('Titre requis');
    error.status = 400;
    throw error;
  }
  if (!String(type || '').trim()) {
    const error = new Error('Type de contrat requis');
    error.status = 400;
    throw error;
  }
  if (!String(lieu || '').trim()) {
    const error = new Error('Lieu requis');
    error.status = 400;
    throw error;
  }
}

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('offres')
    .select('*, recruteurs(entreprise, secteur)');

  if (error) return res.status(400).json({ error });
  res.json(data);
});

router.get('/deck', authMiddleware, async (req, res) => {
  try {
    const candidat = await ensureCandidateProfile(req.user.id);
    const seenFromProfile = candidat.axes?.meta?.swiped_offer_ids || [];

    const [candidatures, matchs] = await Promise.all([
      supabase.from('candidatures').select('offre_id').eq('candidat_id', candidat.id),
      supabase.from('matchs').select('offre_id').eq('candidat_id', candidat.id),
    ]);

    if (candidatures.error) return res.status(400).json({ error: candidatures.error });
    if (matchs.error) return res.status(400).json({ error: matchs.error });

    const seenOfferIds = uniqueValues([
      ...seenFromProfile,
      ...(candidatures.data || []).map((row) => row.offre_id),
      ...(matchs.data || []).map((row) => row.offre_id),
    ]);

    const { data, error } = await supabase
      .from('offres')
      .select('*, recruteurs(entreprise, secteur)');

    if (error) return res.status(400).json({ error });
    res.json((data || []).filter((offre) => !seenOfferIds.includes(String(offre.id))));
  } catch (error) {
    res.status(400).json({ error: error.message || error });
  }
});

router.get('/mine', authMiddleware, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { data, error } = await supabase
      .from('offres')
      .select('*')
      .eq('recruteur_id', recruteur.id);

    if (error) return res.status(400).json({ error });
    res.json(data || []);
  } catch (error) {
    publicError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('offres')
    .select('*, recruteurs(entreprise, secteur)')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(400).json({ error });
  res.json(data);
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { titre, type, lieu, salaire, tags, statut, auto_candidature } = req.body;
    validateOfferPayload({ titre, type, lieu });

    const { data, error } = await supabase
      .from('offres')
      .insert({
        titre,
        type,
        lieu,
        salaire,
        tags,
        statut,
        auto_candidature,
        recruteur_id: recruteur.id,
      })
      .select('*')
      .single();

    if (error) return res.status(400).json({ error });
    res.json(data);
  } catch (error) {
    publicError(res, error);
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { titre, type, lieu, salaire, tags, statut, auto_candidature } = req.body;
    validateOfferPayload({ titre, type, lieu });

    const { data, error } = await supabase
      .from('offres')
      .update({ titre, type, lieu, salaire, tags, statut, auto_candidature })
      .eq('id', req.params.id)
      .eq('recruteur_id', recruteur.id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ error });
    res.json(data);
  } catch (error) {
    publicError(res, error);
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { data: offre, error: offerError } = await supabase
      .from('offres')
      .select('id')
      .eq('id', req.params.id)
      .eq('recruteur_id', recruteur.id)
      .maybeSingle();

    if (offerError) return res.status(400).json({ error: offerError });
    if (!offre) return res.status(404).json({ error: 'Offre introuvable' });

    const { data: matchs, error: matchsError } = await supabase
      .from('matchs')
      .select('id')
      .eq('offre_id', req.params.id);
    if (matchsError) return res.status(400).json({ error: matchsError });

    const matchIds = (matchs || []).map((match) => match.id);
    if (matchIds.length) {
      const { error: messagesError } = await supabase
        .from('messages')
        .delete()
        .in('match_id', matchIds);
      if (messagesError) return res.status(400).json({ error: messagesError });

      const { error: deleteMatchesError } = await supabase
        .from('matchs')
        .delete()
        .in('id', matchIds);
      if (deleteMatchesError) return res.status(400).json({ error: deleteMatchesError });
    }

    const { error: candidaturesError } = await supabase
      .from('candidatures')
      .delete()
      .eq('offre_id', req.params.id);
    if (candidaturesError) return res.status(400).json({ error: candidaturesError });

    const { error } = await supabase
      .from('offres')
      .delete()
      .eq('id', req.params.id)
      .eq('recruteur_id', recruteur.id);

    if (error) return res.status(400).json({ error });
    res.json({ message: 'Offre supprimee' });
  } catch (error) {
    publicError(res, error);
  }
});

module.exports = router;
