const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureCandidateProfile, ensureRecruiterProfile, getUserEmail } = require('../utils/profiles');
const requireRecruiterPlan = require('../middleware/requireRecruiterPlan');
const { trackBrevoEvent } = require('../utils/brevoEvents');
const {
  parseOfferDeckQuery,
  encodeCursor,
  applySupabaseDeckFilters,
  applySupabaseCursor,
} = require('../utils/offerDeckQuery');
const { normalizeOfferStructuredFields } = require('../utils/offerWrite');

const AVATAR_BUCKET = process.env.AVATAR_BUCKET || 'profile-photos';
const DECK_SELECT = 'id, titre, type, contract_type, lieu, salaire, description, tags, statut, auto_candidature, created_at, job_type, remote_mode, salary_fixed_min, salary_fixed_max, has_variable, variable_note, sales_styles, sector, customer_types, experience_min, experience_max, city_code, latitude, longitude, recruteur_id, recruteurs(entreprise, secteur, avatar_meta)';

// Le logo recruteur n'est pas une simple colonne : c'est un chemin de stockage
// (avatar_meta) qui doit etre transforme en URL signee via l'API Supabase Storage.
// On groupe cette conversion par chemin unique (un seul recruteur peut avoir
// plusieurs offres) plutot que de refaire l'appel pour chaque offre.
async function attachRecruiterLogos(offres) {
  const uniquePaths = new Map(); // path -> bucket
  offres.forEach((o) => {
    const path = o.recruteurs?.avatar_meta?.avatar_path;
    if (path && !uniquePaths.has(path)) {
      uniquePaths.set(path, o.recruteurs?.avatar_meta?.avatar_bucket || AVATAR_BUCKET);
    }
  });

  if (!uniquePaths.size) return offres;

  const urlByPath = {};
  await Promise.all([...uniquePaths.entries()].map(async ([path, bucket]) => {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60 * 24);
    if (!error && data?.signedUrl) urlByPath[path] = data.signedUrl;
  }));

  return offres.map((o) => {
    const path = o.recruteurs?.avatar_meta?.avatar_path;
    return path && urlByPath[path]
      ? { ...o, recruteurs: { ...o.recruteurs, avatar_url: urlByPath[path] } }
      : o;
  });
}

function uniqueValues(values = []) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function publicError(res, error) {
  return res.status(error.status || 400).json({
    error: error.code || error.message || error,
    message: error.message || undefined,
  });
}

function validateOfferPayload(body = {}) {
  const { titre, type, lieu, salaire } = body;
  if (!String(titre || '').trim()) {
    const error = new Error('Titre requis');
    error.status = 400;
    throw error;
  }
  if (String(titre).length > 80) {
    const error = new Error('Titre trop long (80 caracteres max)');
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
  if (String(lieu).length > 100) {
    const error = new Error('Lieu trop long (100 caracteres max)');
    error.status = 400;
    throw error;
  }
  const salaireValue = String(salaire || '').trim().toLowerCase();
  if (salaireValue && !isPlausibleSalaire(salaireValue)) {
    const error = new Error('Format de remuneration invalide ou montant irrealiste (ex: 45K€, 40-50K€, a negocier)');
    error.status = 400;
    throw error;
  }
  return normalizeOfferStructuredFields(body);
}

function isPlausibleSalaire(s) {
  if (/negoci|négoci/.test(s)) return true;
  if (/\d\s*k\s*€?/i.test(s)) return true;
  if (!/€/.test(s)) return false;
  const nombres = (s.match(/\d+([.,]\d+)?/g) || []).map((n) => parseFloat(n.replace(',', '.')));
  if (!nombres.length) return false;
  const estTarifFreelance = /tjm|\/\s*j(our)?\b|par\s*jour|\/\s*sem(aine)?\b|par\s*semaine/i.test(s);
  if (estTarifFreelance) return nombres.some((n) => n >= 100);
  return nombres.some((n) => n >= 15000);
}

const OFFER_LIMITS = { solo: 1, starter: 3 };

// excludeOfferId : à passer lors d'une mise à jour, pour ne pas compter l'offre déjà active qu'on modifie
async function assertOfferLimitNotReached(recruteurId, plan, excludeOfferId) {
  const limit = OFFER_LIMITS[plan];
  if (!limit) return; // plan sans limite (pro, enterprise, ou plan inconnu géré ailleurs)

  let query = supabase
    .from('offres')
    .select('id')
    .eq('recruteur_id', recruteurId)
    .eq('statut', 'active');

  if (excludeOfferId) query = query.neq('id', excludeOfferId);

  const { data: offresActives, error: countError } = await query;
  if (countError) {
    const error = new Error(countError.message || countError);
    error.status = 400;
    throw error;
  }

  if (offresActives.length >= limit) {
    const error = new Error(`Limite de ${limit} offre${limit > 1 ? 's' : ''} active${limit > 1 ? 's' : ''} atteinte — passez a un plan superieur pour publier plus d'offres`);
    error.status = 403;
    error.code = 'OFFER_LIMIT_REACHED';
    throw error;
  }
}

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('offres')
    .select('*, recruteurs(entreprise, secteur, avatar_meta)')
    .or('statut.eq.active,statut.is.null');

  if (error) return res.status(400).json({ error });
  res.json(await attachRecruiterLogos(data || []));
});

router.get('/deck', authMiddleware, async (req, res) => {
  try {
    const filters = parseOfferDeckQuery(req.query || {});
    const candidat = await ensureCandidateProfile(req.user.id);
    const seenFromProfile = candidat.swipes_meta?.swiped_offer_ids || [];

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

    // Filtrage SQL + cursor + limit(+1) AVANT enrichissement (signed URLs).
    let query = supabase.from('offres').select(DECK_SELECT);
    query = applySupabaseDeckFilters(query, filters);
    if (seenOfferIds.length) {
      query = query.not('id', 'in', `(${seenOfferIds.join(',')})`);
    }
    query = applySupabaseCursor(query, filters.cursor);
    query = query
      .order('created_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .limit(filters.limit + 1);

    const { data, error } = await query;
    if (error) return res.status(400).json({ error });

    const rows = data || [];
    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;
    const withLogos = await attachRecruiterLogos(page);
    const last = page[page.length - 1];

    res.json({
      offers: withLogos,
      next_cursor: hasMore && last ? encodeCursor(last) : null,
      has_more: hasMore,
    });
  } catch (error) {
    if (error.status) return publicError(res, error);
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
    .select('*, recruteurs(entreprise, secteur, avatar_meta)')
    .eq('id', req.params.id)
    .or('statut.eq.active,statut.is.null')
    .single();

  if (error) return res.status(400).json({ error });
  const [withLogo] = await attachRecruiterLogos([data]);
  res.json(withLogo);
});

router.patch('/:id/status', authMiddleware, requireRecruiterPlan, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const statut = String(req.body?.statut || '').toLowerCase();
    if (!['active', 'paused', 'closed'].includes(statut)) return res.status(400).json({ error: 'Statut offre invalide' });
    const { data: existing, error: existingError } = await supabase.from('offres').select('*')
      .eq('id', req.params.id).eq('recruteur_id', recruteur.id).maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return res.status(404).json({ error: 'Offre introuvable' });
    if (statut === 'active' && existing.statut !== 'active') await assertOfferLimitNotReached(recruteur.id, req.recruiterPlan, existing.id);
    const { data, error } = await supabase.from('offres').update({ statut })
      .eq('id', existing.id).eq('recruteur_id', recruteur.id).select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (error) { publicError(res, error); }
});

router.post('/', authMiddleware, requireRecruiterPlan, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { titre, type, lieu, salaire, description, statut, auto_candidature } = req.body;
    const structured = validateOfferPayload(req.body);

    // Vérification limite offres actives selon le plan
    await assertOfferLimitNotReached(recruteur.id, req.recruiterPlan);

    const { data, error } = await supabase
      .from('offres')
      .insert({
        titre, type, lieu, salaire, description, statut, auto_candidature,
        tags: structured.tags,
        contract_type: structured.contract_type,
        remote_mode: structured.remote_mode,
        salary_fixed_min: structured.salary_fixed_min,
        salary_fixed_max: structured.salary_fixed_max,
        job_type: structured.job_type,
        sector: structured.sector,
        recruteur_id: recruteur.id,
      })
      .select('*')
      .single();

    if (error) return res.status(400).json({ error });
    res.json(data);

    // Scénario 02 : sortie de la relance "aucune offre publiée".
    if (data.statut === 'active') {
      getUserEmail(req.user.id).then((email) => {
        trackBrevoEvent(email, 'offre_publiee', { poste: data.titre }, {
          OFFRE_PUBLIEE: true,
        }).catch(() => {});
      }).catch(() => {});
    }
  } catch (error) {
    publicError(res, error);
  }
});

router.put('/:id', authMiddleware, requireRecruiterPlan, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { titre, type, lieu, salaire, description, statut, auto_candidature } = req.body;
    const structured = validateOfferPayload(req.body);

    let wasActive = false;
    if (statut === 'active') {
      const { data: existingOffer, error: existingError } = await supabase
        .from('offres')
        .select('statut')
        .eq('id', req.params.id)
        .eq('recruteur_id', recruteur.id)
        .maybeSingle();

      if (existingError) return res.status(400).json({ error: existingError });
      wasActive = Boolean(existingOffer && existingOffer.statut === 'active');

      // On ne revérifie la limite que si l'offre n'était pas déjà active (réactivation, pas simple édition)
      if (!wasActive) {
        await assertOfferLimitNotReached(recruteur.id, req.recruiterPlan, req.params.id);
      }
    }

    const { data, error } = await supabase
      .from('offres')
      .update({
        titre, type, lieu, salaire, description, statut, auto_candidature,
        tags: structured.tags,
        contract_type: structured.contract_type,
        remote_mode: structured.remote_mode,
        salary_fixed_min: structured.salary_fixed_min,
        salary_fixed_max: structured.salary_fixed_max,
        job_type: structured.job_type,
        sector: structured.sector,
      })
      .eq('id', req.params.id)
      .eq('recruteur_id', recruteur.id)
      .select('*')
      .single();

    if (error) return res.status(400).json({ error });
    res.json(data);

    // Scénario 02 : même événement que la création, seulement lors du passage à "active".
    if (statut === 'active' && !wasActive) {
      getUserEmail(req.user.id).then((email) => {
        trackBrevoEvent(email, 'offre_publiee', { poste: data.titre }, {
          OFFRE_PUBLIEE: true,
        }).catch(() => {});
      }).catch(() => {});
    }
  } catch (error) {
    publicError(res, error);
  }
});

router.delete('/:id', authMiddleware, requireRecruiterPlan, async (req, res) => {
  try {
    const recruteur = await ensureRecruiterProfile(req.user.id);
    const { data: offre, error: offerError } = await supabase
      .from('offres')
      .select('id, statut')
      .eq('id', req.params.id)
      .eq('recruteur_id', recruteur.id)
      .maybeSingle();

    if (offerError) return res.status(400).json({ error: offerError });
    if (!offre) return res.status(404).json({ error: 'Offre introuvable' });

    const [candidatureCheck, matchCheck] = await Promise.all([
      supabase.from('candidatures').select('id', { count: 'exact', head: true }).eq('offre_id', req.params.id),
      supabase.from('matchs').select('id', { count: 'exact', head: true }).eq('offre_id', req.params.id),
    ]);
    if (candidatureCheck.error) throw candidatureCheck.error;
    if (matchCheck.error) throw matchCheck.error;
    const candidatureCount = candidatureCheck.count;
    const matchCount = matchCheck.count;
    if (candidatureCount || matchCount || offre.statut === 'active') {
      const { data, error } = await supabase.from('offres').update({ statut: 'closed' })
        .eq('id', req.params.id).eq('recruteur_id', recruteur.id).select('*').single();
      if (error) throw error;
      return res.json({ message: 'Offre cloturee; historique conserve', action: 'closed', offre: data });
    }

    const { error } = await supabase
      .from('offres')
      .delete()
      .eq('id', req.params.id)
      .eq('recruteur_id', recruteur.id);

    if (error) return res.status(400).json({ error });
    res.json({ message: 'Brouillon supprime', action: 'deleted' });
  } catch (error) {
    publicError(res, error);
  }
});

module.exports = router;
