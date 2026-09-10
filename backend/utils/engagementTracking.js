// Tracking d'engagement manquant côté produit, nécessaire aux scénarios 03 et 04
// de marketing automation (likes reçus, consultations de profil, dernière connexion).
// Nécessite la migration backend/marketing_automation_tracking_migration.sql.

const supabase = require('../supabase');

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Enregistre un like recruteur -> candidat (idempotent : un like par recruteur/candidat).
// Ne fait pas planter l'appelant si la migration n'a pas encore été appliquée.
async function recordCandidateLike(candidatId, recruteurId) {
  if (!candidatId || !recruteurId) return;
  const { error } = await supabase
    .from('candidat_likes')
    .upsert({ candidat_id: candidatId, recruteur_id: recruteurId }, { onConflict: 'candidat_id,recruteur_id' });
  if (error) console.warn('recordCandidateLike:', error.message || error);
}

// Nombre de likes reçus par un candidat sur les `days` derniers jours.
async function countRecentLikes(candidatId, days = 7) {
  if (!candidatId) return 0;
  const { count, error } = await supabase
    .from('candidat_likes')
    .select('id', { count: 'exact', head: true })
    .eq('candidat_id', candidatId)
    .gte('created_at', daysAgoIso(days));
  if (error) { console.warn('countRecentLikes:', error.message || error); return 0; }
  return count || 0;
}

// Enregistre une consultation de profil candidat par un recruteur.
// Volontairement non-unique (chaque consultation compte, contrairement aux likes).
async function recordProfileView(candidatId, recruteurId) {
  if (!candidatId || !recruteurId) return;
  const { error } = await supabase
    .from('candidat_profile_views')
    .insert({ candidat_id: candidatId, recruteur_id: recruteurId });
  if (error) console.warn('recordProfileView:', error.message || error);
}

// Nombre de consultations de profil sur les `days` derniers jours.
async function countRecentProfileViews(candidatId, days = 7) {
  if (!candidatId) return 0;
  const { count, error } = await supabase
    .from('candidat_profile_views')
    .select('id', { count: 'exact', head: true })
    .eq('candidat_id', candidatId)
    .gte('created_at', daysAgoIso(days));
  if (error) { console.warn('countRecentProfileViews:', error.message || error); return 0; }
  return count || 0;
}

// Met à jour la dernière connexion d'un candidat ou d'un recruteur.
async function touchLastLogin(table, userId) {
  const { data: row, error: findError } = await supabase
    .from(table)
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();
  if (findError || !row) return;

  const { error } = await supabase
    .from(table)
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', row.id);
  if (error) console.warn('touchLastLogin:', error.message || error);
}

module.exports = {
  recordCandidateLike,
  countRecentLikes,
  recordProfileView,
  countRecentProfileViews,
  touchLastLogin,
};
