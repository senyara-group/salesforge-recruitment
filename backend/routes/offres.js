const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureCandidateProfile, ensureRecruiterProfile } = require('../utils/profiles');
const requireRecruiterPlan = require('../middleware/requireRecruiterPlan');

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

router.get('/mine', authMiddleware, requireRecruiterPlan, async (req, res) => {
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

router.post('/', authMiddleware, requireRecruiterPlan, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { titre, type, lieu, salaire, tags, statut, auto_candidature } = req.body;
    validateOfferPayload({ titre, type, lieu });

    // Vérification limite offres selon le plan
    if (req.recruiterPlan === 'starter') {
      const { data: offresActives, error: countError } = await supabase
        .from('offres')
        .select('id')
        .eq('recruteur_id', recruteur.id)
        .eq('statut', 'active');

      if (countError) return res.status(400).json({ error: countError });

      if (offresActives.length >= 3) {
        return res.status(403).json({
          error: 'OFFER_LIMIT_REACHED',
          message: 'Limite de 3 offres actives atteinte — passez au plan Pro pour publier plus d\'offres'
        });
      }
    }

    const { data, error } = await supabase
      .from('offres')
      .insert({
        titre, type, lieu, salaire, tags, statut, auto_candidature,
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

router.put('/:id', authMiddleware, requireRecruiterPlan, async (req, res) => {
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

router.delete('/:id', authMiddleware, requireRecruiterPlan, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
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
