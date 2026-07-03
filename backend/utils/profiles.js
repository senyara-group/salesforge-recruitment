const supabase = require('../supabase');

async function getUserRole(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data?.role || null;
}

async function assertRole(userId, expectedRole) {
  const role = await getUserRole(userId);
  if (role && role !== expectedRole) {
    const error = new Error(`Acces reserve aux profils ${expectedRole}s`);
    error.status = 403;
    throw error;
  }
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

async function ensureCandidateProfile(userId) {
  await assertRole(userId, 'candidat');

  const existing = await getProfileByUser('candidats', userId);
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
  return data;
}

async function ensureRecruiterProfile(userId) {
  await assertRole(userId, 'recruteur');

  const existing = await getProfileByUser('recruteurs', userId);
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
  return data;
}

async function ensureRoleProfile(userId, role) {
  return role === 'recruteur'
    ? ensureRecruiterProfile(userId)
    : ensureCandidateProfile(userId);
}

module.exports = {
  getUserRole,
  ensureCandidateProfile,
  ensureRecruiterProfile,
  ensureRoleProfile,
};
