const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureRoleProfile } = require('../utils/profiles');
const { sendPasswordResetEmail } = require('../utils/brevo');

const authClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const oauthProviders = {
  google: 'google',
};

function getSiteUrl(req) {
  return process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
}

function inferRoleFromEmail(email = '') {
  return email.toLowerCase().includes('recruteur') ? 'recruteur' : 'candidat';
}

function normalizeRole(role, email = '') {
  if (role === 'recruteur' || role === 'recruteurs') return 'recruteur';
  if (role === 'candidat' || role === 'candidats') return 'candidat';
  return inferRoleFromEmail(email);
}

async function findUserProfile(user) {
  const byId = await supabase
    .from('users')
    .select('*')
    .eq('id', user.id)
    .limit(1);

  if (byId.error) throw byId.error;
  if (byId.data.length) return byId.data[0];

  if (!user.email) return null;

  const byEmail = await supabase
    .from('users')
    .select('*')
    .eq('email', user.email)
    .order('created_at', { ascending: false })
    .limit(1);

  if (byEmail.error) throw byEmail.error;
  return byEmail.data[0] || null;
}

function normalizeRequestedRole(role) {
  return role === 'recruteur' ? 'recruteur' : role === 'candidat' ? 'candidat' : null;
}

async function ensureUserProfile(user, requestedRole = null) {
  const existing = await findUserProfile(user);
  const requested = normalizeRequestedRole(requestedRole);

  if (!existing && !requested) {
    const error = new Error('ROLE_REQUIRED');
    error.status = 409;
    throw error;
  }

  const role = requested || normalizeRole(existing?.role, user.email);

  const { data, error } = await supabase
    .from('users')
    .upsert({
      id: user.id,
      email: user.email,
      role,
    })
    .select('*')
    .limit(1);

  if (error) throw error;

  return data[0] || { id: user.id, email: user.email, role };
}

async function setUserRole(user, requestedRole) {
  const role = normalizeRequestedRole(requestedRole);
  if (!role) {
    const error = new Error('Role invalide');
    error.status = 400;
    throw error;
  }

  const { data, error } = await supabase
    .from('users')
    .upsert({
      id: user.id,
      email: user.email,
      role,
    })
    .select('*')
    .limit(1);

  if (error) throw error;
  return data[0] || { id: user.id, email: user.email, role };
}

async function hydrateRoleProfile(profile) {
  if (!profile?.id) return profile;

  const roleProfile = await ensureRoleProfile(profile.id, profile.role);
  return { ...profile, ...(roleProfile || {}), id: profile.id, user_id: profile.id };
}

router.get('/oauth/:provider', async (req, res) => {
  try {
    const provider = oauthProviders[req.params.provider];

    if (!provider) {
      return res.status(400).json({ error: 'Provider OAuth invalide' });
    }

    const role = normalizeRequestedRole(req.query.role);
    const redirectTo = new URL(process.env.OAUTH_REDIRECT_URL || `${getSiteUrl(req)}/salesforge_app.html`);
    if (role) redirectTo.searchParams.set('role', role);

    const { data, error } = await authClient.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: redirectTo.toString(),
      },
    });

    if (error) return res.status(400).json({ error: error.message });
    res.redirect(data.url);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

async function signup(req, res) {
  const { email, password, role, entreprise, secteur, prenom, nom } = req.body;
  const normalizedRole = role === 'recruteur' ? 'recruteur' : 'candidat';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe sont requis' });
  }

  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Mot de passe : 8 caracteres minimum' });
  }

  const { data, error } = await authClient.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${getSiteUrl(req)}/salesforge_app.html?login=1`,
    },
  });
  if (error) return res.status(400).json({ error });

  const { error: userProfileError } = await supabase.from('users').upsert({
    id: data.user.id,
    email,
    role: normalizedRole,
  });

  let roleProfile = null;
  let roleProfileError = null;
  try {
    roleProfile = await ensureRoleProfile(data.user.id, normalizedRole);

    if (normalizedRole === 'recruteur' && (entreprise || secteur)) {
      const { data: updatedProfile, error: updateError } = await supabase
        .from('recruteurs')
        .update({ entreprise, secteur })
        .eq('user_id', data.user.id)
        .select('*')
        .single();

      if (updateError) throw updateError;
      roleProfile = updatedProfile;
    }

    if (normalizedRole === 'candidat' && (prenom || nom)) {
      const { data: updatedProfile, error: updateError } = await supabase
        .from('candidats')
        .update({ prenom, nom })
        .eq('user_id', data.user.id)
        .select('*')
        .single();

      if (updateError) throw updateError;
      roleProfile = updatedProfile;
    }
  } catch (error) {
    roleProfileError = error;
  }

  res.json({
    message: 'Utilisateur cree',
    token: data.session?.access_token || null,
    user: data.user,
    profile: { id: data.user.id, email, role: normalizedRole, ...(roleProfile || {}) },
    userProfileCreated: !userProfileError,
    roleProfileCreated: !roleProfileError,
    roleProfile,
  });
}

router.post('/signup', signup);
router.post('/register', signup);

router.post('/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ error: 'Email requis' });
  }

  try {
    const redirectTo = process.env.PASSWORD_RESET_REDIRECT_URL || `${getSiteUrl(req)}/salesforge_reset.html`;
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo },
    });

    if (error) {
      if (/not found|does not exist/i.test(error.message || '')) {
        return res.json({ message: 'Si un compte existe, un email de reinitialisation a ete envoye' });
      }
      throw error;
    }

    const resetUrl = data?.properties?.action_link || data?.action_link;
    if (!resetUrl) throw new Error('Lien de reinitialisation introuvable');

    await sendPasswordResetEmail({ to: email, resetUrl });
    res.json({ message: 'Email de reinitialisation envoye' });
  } catch (error) {
    res.status(500).json({ error: error.publicMessage || error.message || 'Email impossible a envoyer' });
  }
});

router.post('/reset-password', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.body.access_token;
  const password = String(req.body.password || '');

  if (!token) return res.status(401).json({ error: 'Token requis' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caracteres minimum' });

  const resetClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  const { error } = await resetClient.auth.updateUser({ password });
  if (error) return res.status(400).json({ error: error.message || error });

  res.json({ message: 'Mot de passe mis a jour' });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe sont requis' });
  }

  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error });

  let profile = null;
  try {
    profile = await ensureUserProfile(data.user, inferRoleFromEmail(data.user.email));
    profile = await hydrateRoleProfile(profile);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message || 'Connexion impossible' });
  }

  res.json({ token: data.session.access_token, user: data.user, profile });
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const data = await hydrateRoleProfile(await ensureUserProfile(req.user, req.query.role || req.headers['x-sf-role']));
    res.json(data);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message || error });
  }
});

router.post('/role', authMiddleware, async (req, res) => {
  try {
    const data = await setUserRole(req.user, req.body.role);
    res.json(data);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message || error });
  }
});

router.post('/logout', async (req, res) => {
  const { error } = await authClient.auth.signOut();
  if (error) return res.status(400).json({ error });

  res.json({ message: 'Deconnecte' });
});

module.exports = router;
