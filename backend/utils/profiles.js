const supabase = require('../supabase');
const { trackBrevoEvent } = require('./brevoEvents');

async function getUserRole(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data?.role || null;
}

async function getUserEmail(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('email')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data?.email || null;
}

// Plan candidat actif ('freemium' par défaut) — pour déblocage de contenu
// "développement de carrière" uniquement. Ne JAMAIS s'en servir dans une logique
// de matching/ranking/droits de candidature (contrainte légale, voir Notes.md).
async function getCandidatePlan(userId) {
  const { data, error } = await supabase
    .from('abonnements')
    .select('plan, statut')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) throw error;
  const abonnement = data?.[0];
  return abonnement?.statut === 'actif' ? (abonnement.plan || 'freemium') : 'freemium';
}

function assertRoleMatches(role, expectedRole) {
  if (role && role !== expectedRole) {
    const error = new Error(`Acces reserve aux profils ${expectedRole}s`);
    error.status = 403;
    throw error;
  }
}

// knownRole : passer le role si deja recupere plus haut dans la meme requete, pour eviter une requete redondante
async function assertRole(userId, expectedRole, knownRole) {
  const role = knownRole !== undefined ? knownRole : await getUserRole(userId);
  assertRoleMatches(role, expectedRole);
  return role;
}

async function getProfileByUser(table, userId) {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('user_id', userId)
    .limit(1);

  if (error) throw error;
  return data[0] || null;
}

async function ensureCandidateProfile(userId, knownRole) {
  const [role, existing] = await Promise.all([
    knownRole !== undefined ? Promise.resolve(knownRole) : getUserRole(userId),
    getProfileByUser('candidats', userId),
  ]);
  assertRoleMatches(role, 'candidat');

  if (existing) return existing;

  const { data, error } = await supabase
    .from('candidats')
    .insert({
      user_id: userId,
      axes: {},
      swipes_meta: {},  // ← ajouter ça
    })
    .select('*')
    .single();

  if (error) throw error;

  // Scénario 01 : point de création réel de la fiche candidat — couvre l'inscription
  // email/mot de passe ET le retour OAuth (Google), qui passent tous deux par cette fonction.
  getUserEmail(userId).then((email) => {
    trackBrevoEvent(email, 'compte_candidat_cree').catch(() => {});
  }).catch(() => {});

  return data;
}

async function ensureRecruiterProfile(userId, knownRole) {
  const [role, existing] = await Promise.all([
    knownRole !== undefined ? Promise.resolve(knownRole) : getUserRole(userId),
    getProfileByUser('recruteurs', userId),
  ]);
  assertRoleMatches(role, 'recruteur');

  if (existing) return existing;

  const { data, error } = await supabase
    .from('recruteurs')
    .insert({
      user_id: userId,
      plan: 'starter',
    })
    .select('*')
    .single();

  if (error) throw error;

  // Scénario 02 : point de création réel de la fiche recruteur — couvre l'inscription
  // email/mot de passe ET le retour OAuth (Google), qui passent tous deux par cette fonction.
  getUserEmail(userId).then((email) => {
    trackBrevoEvent(email, 'compte_recruteur_active').catch(() => {});
  }).catch(() => {});

  return data;
}

// role est deja connu par l'appelant (ex: juste lu/ecrit sur users) -> on le propage pour eviter une requete redondante
async function ensureRoleProfile(userId, role) {
  return role === 'recruteur'
    ? ensureRecruiterProfile(userId, role)
    : ensureCandidateProfile(userId, role);
}

module.exports = {
  getUserRole,
  getUserEmail,
  assertRole,
  ensureCandidateProfile,
  ensureRecruiterProfile,
  ensureRoleProfile,
};