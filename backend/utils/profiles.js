const supabase = require('../supabase');

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
  const existing = await getProfileByUser('candidats', userId);
  if (existing) return existing;

  const { data, error } = await supabase
    .from('candidats')
    .insert({
      user_id: userId,
      axes: {},
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function ensureRecruiterProfile(userId) {
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
  ensureCandidateProfile,
  ensureRecruiterProfile,
  ensureRoleProfile,
};
