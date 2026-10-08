const express = require('express');
const router = express.Router();
const db = require('../supabase');
const auth = require('../middleware/auth');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVITY_PRECISION_MS = 3600000;

router.use(auth);
router.use((req, res, next) => {
  if (process.env.BREVO_OUTBOX_ENABLED !== 'true') return res.status(503).json({ error: 'Automations non activees' });
  next();
});
router.post('/activity', async (req, res, next) => {
  try {
    // Hourly precision is enough for 7/14/30 day reminders, and each write queues a
    // Brevo contact update: skip pings that would not change the stored hour.
    const current = await db.from('automation_activity').select('last_active_at').eq('user_id', req.user.id).maybeSingle();
    if (current.error) throw current.error;
    if (current.data && Date.now() - Date.parse(current.data.last_active_at) < ACTIVITY_PRECISION_MS) return res.sendStatus(204);
    const { error } = await db.from('automation_activity').upsert({ user_id: req.user.id, last_active_at: new Date().toISOString() });
    if (error) throw error;
    res.sendStatus(204);
  } catch (error) { next(error); }
});
router.post('/adn-started', async (req, res, next) => {
  try {
    const profile = await db.from('candidats').select('id').eq('user_id', req.user.id).maybeSingle();
    if (profile.error) throw profile.error;
    if (!profile.data) return res.sendStatus(403);
    const consent = await db.from('consentements').select('accepte').eq('user_id', req.user.id).eq('type', 'test_adn')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (consent.error) throw consent.error;
    if (!consent.data?.accepte) return res.sendStatus(403);
    const { error } = await db.rpc('enqueue_brevo_event', {
      recipient: req.user.id, event: 'adn_started', payload: {},
      event_key: `adn_started:${req.user.id}:${new Date().toISOString().slice(0, 10)}`,
    });
    if (error) throw error;
    res.sendStatus(204);
  } catch (error) { next(error); }
});
router.get('/preferences', async (req, res, next) => {
  try {
    const { data, error } = await db.from('automation_preferences').select('marketing_enabled').eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    res.json({ marketing_enabled: data?.marketing_enabled === true });
  } catch (error) { next(error); }
});
router.put('/preferences', async (req, res, next) => {
  try {
    if (typeof req.body?.marketing_enabled !== 'boolean') return res.status(400).json({ error: 'Choix requis' });
    const { error } = await db.from('automation_preferences').upsert({
      user_id: req.user.id, marketing_enabled: req.body.marketing_enabled, updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    res.json({ marketing_enabled: req.body.marketing_enabled });
  } catch (error) { next(error); }
});
router.post('/offers/:id/:kind', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id) || !['viewed', 'application_started', 'saved', 'unsaved', 'dismissed'].includes(req.params.kind)) {
      return res.status(400).json({ error: 'Interaction invalide' });
    }
    const profile = await db.from('candidats').select('id').eq('user_id', req.user.id).maybeSingle();
    if (profile.error) throw profile.error;
    if (!profile.data) return res.sendStatus(403);
    const offer = await db.from('offres').select('id,statut,expires_at').eq('id', req.params.id).maybeSingle();
    if (offer.error) throw offer.error;
    if (!offer.data || (offer.data.statut && offer.data.statut !== 'active')
      || (offer.data.expires_at && Date.parse(offer.data.expires_at) <= Date.now())) return res.sendStatus(404);
    const { error } = await db.rpc('record_offer_interaction', {
      p_user_id: req.user.id, p_offre_id: req.params.id, p_kind: req.params.kind,
    });
    if (error) throw error;
    res.sendStatus(204);
  } catch (error) { next(error); }
});
router.get('/saved', async (req, res, next) => {
  try {
    const { data, error } = await db.from('offer_interactions').select('offre_id').eq('user_id', req.user.id).not('saved_at', 'is', null);
    if (error) throw error;
    res.json(data || []);
  } catch (error) { next(error); }
});
module.exports = router;
