const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = require('../supabase');
const authMiddleware = require('../middleware/auth');
const { ensureRoleProfile } = require('../utils/profiles');

const authClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const oauthProviders = {
  google: 'google',
};

function definedOnly(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

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

function cleanNamePart(value = '') {
  return String(value).trim().replace(/\s+/g, ' ');
}

function splitFullName(value = '') {
  const parts = cleanNamePart(value).split(' ').filter(Boolean);
  if (!parts.length) return {};
  return {
    prenom: parts[0],
    nom: parts.slice(1).join(' '),
  };
}

function namesFromAuthUser(user = {}) {
  const meta = user.user_metadata || {};
  const fromFullName = splitFullName(meta.full_name || meta.name);
  return {
    prenom: cleanNamePart(meta.given_name || meta.first_name || fromFullName.prenom),
    nom: cleanNamePart(meta.family_name || meta.last_name || fromFullName.nom),
  };
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

  // Rien n'a change depuis la derniere fois : pas besoin de reecrire en base
  if (existing && existing.role === role && existing.email === user.email) {
    return existing;
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

async function applyOAuthNames(profile, user) {
  if (!profile?.role) return profile;
  const { prenom, nom } = namesFromAuthUser(user);
  const patch = {};

  if (prenom && !profile.prenom) patch.prenom = prenom;
  if (nom && !profile.nom) patch.nom = nom;
  if (!Object.keys(patch).length) return profile;

  const table = profile.role === 'recruteur' ? 'recruteurs' : 'candidats';
  const { data, error } = await supabase
    .from(table)
    .update(patch)
    .eq('user_id', profile.id)
    .select('*')
    .maybeSingle();

  if (error) {
    if (/column|schema cache|could not find/i.test(error.message || '')) return profile;
    throw error;
  }

  return data ? { ...profile, ...data, id: profile.id, user_id: profile.id } : { ...profile, ...patch };
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
      emailRedirectTo: `${getSiteUrl(req)}/salesforge_app.html?confirmed=1`,
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

    if (normalizedRole === 'recruteur' && (entreprise || secteur || prenom || nom)) {
      const { data: updatedProfile, error: updateError } = await supabase
        .from('recruteurs')
        .update(definedOnly({ entreprise, secteur, prenom, nom }))
        .eq('user_id', data.user.id)
        .select('*')
        .single();

      if (updateError) throw updateError;
      roleProfile = updatedProfile;
    }

    if (normalizedRole === 'candidat' && (prenom || nom)) {
      const { data: updatedProfile, error: updateError } = await supabase
        .from('candidats')
        .update(definedOnly({ prenom, nom }))
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
    const { error } = await authClient.auth.resetPasswordForEmail(email, { redirectTo });

    // Supabase ne renvoie pas d'erreur si l'email n'existe pas (comportement voulu, anti-enumeration)
    if (error) throw error;

    res.json({ message: 'Si un compte existe, un email de réinitialisation à été envoyé' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Email impossible a envoyer' });
  }
});

router.post('/reset-password', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.body.access_token;
  const password = String(req.body.password || '');

  if (!token) return res.status(401).json({ error: 'Token requis' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caracteres minimum' });

  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: 'Lien invalide ou expire' });
  }

  const { error } = await supabase.auth.admin.updateUserById(userData.user.id, { password });
  if (error) return res.status(400).json({ error: error.message || error });

  res.json({ message: 'Mot de passe mis a jour' });
});

router.post('/exchange-code', async (req, res) => {
  const code = String(req.body.code || '').trim();

  if (!code) return res.status(400).json({ error: 'Code de confirmation requis' });

  try {
    const { data, error } = await authClient.auth.exchangeCodeForSession(code);
    if (error) return res.status(400).json({ error: error.message || error });
    if (!data.session?.access_token) return res.status(400).json({ error: 'Session Supabase introuvable' });

    let profile = await ensureUserProfile(data.user, req.body.role || null);
    profile = await hydrateRoleProfile(profile);
    profile = await applyOAuthNames(profile, data.user);

    res.json({ token: data.session.access_token, user: data.user, profile });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || error });
  }
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
    profile = await ensureUserProfile(data.user, null);
    profile = await hydrateRoleProfile(profile);
    profile = await applyOAuthNames(profile, data.user);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message || 'Connexion impossible' });
  }

  res.json({ token: data.session.access_token, user: data.user, profile });
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    let data = await hydrateRoleProfile(await ensureUserProfile(req.user, req.query.role || req.headers['x-sf-role']));
    data = await applyOAuthNames(data, req.user);
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