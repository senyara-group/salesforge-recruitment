const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const aiRateLimit = require('../middleware/aiRateLimit');
const supabase = require('../supabase');
const { ensureCandidateProfile } = require('../utils/profiles');
const { callAi, isAiConfigured, safeText } = require('../utils/aiProvider');
const { assertAiAccess, configuredPlans, getAiPlan } = require('../utils/aiAccess');
const { publicAiError } = require('../utils/aiErrors');
const { aiLogMetadata } = require('../utils/aiLogMetadata');
const { cvRequestFingerprint } = require('../utils/cvRequestFingerprint');
const { owned, ownedById, ownedConversationMessages, withOwner } = require('../utils/ownership');
const { CV_MAX_TOKENS, CV_MIN_SOURCE_CHARS, cvAnalysisPrompt, normalizeCvAnalysis } = require('../utils/cvAnalysis');
const { buildCvFacts } = require('../utils/cvFacts');
const { selectCoachHistory } = require('../utils/coachContext');
const { AI_SAFETY_FALLBACK, inspectAssistantOutput } = require('../utils/aiSafety');
const { COACH_MODES, COACH_MODE_LABELS, normalizeCoachReply, formatCoachReply, coachSystemPrompt, isObjectionMode, resolveSimulationType, simulationLabel } = require('../utils/coachReply');
const { usageFor, reserveUsage, releaseUsage, finalizeUsage } = require('../utils/aiUsage');

const MODES = COACH_MODES;
const MODE_LABELS = COACH_MODE_LABELS;

function publicConversation(conversation) {
  const simulation_type = isObjectionMode(conversation.mode)
    ? resolveSimulationType(conversation.context_data?.simulation_type, { strict: false })
    : undefined;
  return {
    id: conversation.id,
    mode: conversation.mode,
    title: conversation.title,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    ...(simulation_type ? { simulation_type } : {}),
  };
}

function publicError(res, error) {
  const response = publicAiError(error);
  const logPayload = aiLogMetadata(error, response.code);

  console.error('[assistant]', response.code, logPayload);
  return res.status(response.status).json({
    error: response.message,
    code: response.code,
    ...(response.details ? response.details : {}),
  });
}

router.get('/config', authMiddleware, async (req, res) => {
  try {
    await ensureCandidateProfile(req.user.id);
    const plan = await getAiPlan(req.user.id);

    const cvPlans = configuredPlans('cv');
    const coachPlans = configuredPlans('coach');

    res.json({
      configured: isAiConfigured(),
      cv_access_policy: cvPlans ? [...cvPlans] : ['all'],
      coach_access_policy: coachPlans ? [...coachPlans] : ['all'],
      plan,
      access: {
        cv: cvPlans?.has(plan) ?? true,
        coach: coachPlans?.has(plan) ?? true,
      },
      usage: await usageFor(req.user.id, plan),
    });
  } catch (error) {
    publicError(res, error);
  }
});

router.get('/cv-analyses', authMiddleware, async (req, res) => {
  try {
    await assertAiAccess(req.user.id, 'cv');

    const { data, error } = await owned(
      supabase
        .from('ai_cv_analyses')
        .select('id,target_role,analysis,improved_text,created_at,updated_at,source_text,offer_text,experience_years,sector'),
      req.user.id,
    )
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    res.json((data || []).map(row => ({
      id: row.id, target_role: row.target_role, analysis: row.analysis,
      improved_text: row.improved_text, created_at: row.created_at, updated_at: row.updated_at,
      request_fingerprint: cvRequestFingerprint(row),
    })));
  } catch (error) {
    publicError(res, error);
  }
});

router.post(
  '/cv-analyses',
  authMiddleware,
  aiRateLimit({ max: 4, windowMs: 60000 }),
  async (req, res) => {
    let reservation;
    // Repere de diagnostic uniquement (aucun contenu candidat) : permet de savoir
    // a quelle etape une erreur "Erreur serveur" cote frontend s'est produite,
    // notamment pour distinguer un depassement du delai IA (route_stage:'ai_call'
    // avec un elapsed_ms proche des 55s configures) d'un autre point de la chaine.
    const cvAnalysisStartedAt = Date.now();
    let cvAnalysisStage = 'validate';
    try {
      const access = await assertAiAccess(req.user.id, 'cv');

      for (const [field, limit, label] of [['source_text', 30000, 'Le CV'], ['offer_text', 20000, 'L’offre ciblée']]) {
        const length = String(req.body?.[field] || '').replace(/\u0000/g, '').trim().length;
        if (length > limit) return res.status(400).json({
          code: 'AI_INVALID_REQUEST',
          error: `${label} contient ${length} caractères ; la limite est de ${limit}. Modifiez ou collez un texte plus concis. Le document original est conservé.`,
        });
      }

      const sourceText = safeText(
        req.body?.source_text,
        30000,
        'Texte du CV',
      );

      const targetRole = safeText(
        req.body?.target_role,
        160,
        'Poste vise',
      );

      const offerText = safeText(
        req.body?.offer_text,
        20000,
        'Offre cible',
      );
      const sector = safeText(req.body?.sector, 120, 'Secteur');
      const experienceYears = req.body?.experience_years === '' || req.body?.experience_years == null
        ? null
        : Number(req.body.experience_years);

      if (experienceYears !== null && (!Number.isFinite(experienceYears) || experienceYears < 0 || experienceYears > 80)) {
        return res.status(400).json({ error: 'Années d’expérience invalides' });
      }

      if (sourceText.length < CV_MIN_SOURCE_CHARS) {
        return res.status(400).json({
          error: 'Le texte extrait est insuffisant pour une analyse fiable. Collez manuellement au moins 200 caractères du CV.',
        });
      }

      const factualContext = buildCvFacts({ sourceText, experienceYears, targetRole, sector, offerText });

      cvAnalysisStage = 'reserve_usage';
      reservation = await reserveUsage(req.user.id, access.plan, 'cv');

      cvAnalysisStage = 'ai_call';
      const aiResult = await callAi({
        json: true,
        returnMeta: true,

        // JSON CV : génération plus longue que le coach ;
        // 55s / 0 retry évite le triple timeout SDK (~90s).
        maxTokens: CV_MAX_TOKENS,
        timeoutMs: 55000,
        maxRetries: 0,

        messages: [
          {
            role: 'system',
            content: cvAnalysisPrompt(sourceText.length),
          },
          {
            role: 'user',
            content: JSON.stringify({
              SOURCE_CV: sourceText,
              DONNEES_UTILISATEUR: {
                poste_vise: targetRole || null,
                offre_cible: offerText || null,
                annees_experience: experienceYears,
                secteur: sector || null,
              },
              FACTS_CALCULES: factualContext,
            }),
          },
        ],
      });

      cvAnalysisStage = 'safety_check';
      const safety = inspectAssistantOutput(aiResult.value);
      if (!safety.safe) {
        console.warn('[ai-safety]', { feature: 'cv', incidentType: safety.incidentType });
        const safetyError = new Error(AI_SAFETY_FALLBACK);
        safetyError.code = 'AI_SAFETY_BLOCKED';
        safetyError.status = 422;
        throw safetyError;
      }

      cvAnalysisStage = 'normalize';
      const normalized = normalizeCvAnalysis(aiResult.value, sourceText, { experienceYears });

      cvAnalysisStage = 'db_insert';
      const { data, error } = await supabase
        .from('ai_cv_analyses')
        .insert(
          withOwner(
            {
              source_text: sourceText,
              target_role: targetRole,
              offer_text: offerText,
              experience_years: experienceYears,
              sector,
              analysis: normalized,
              improved_text: normalized.improved_cv,
            },
            req.user.id,
          ),
        )
        .select(
          'id,target_role,analysis,improved_text,created_at,updated_at',
        )
        .single();

      if (error) throw error;

      cvAnalysisStage = 'finalize_usage';
      await finalizeUsage(
        reservation,
        aiResult.meta,
        'cv_analysis',
        data.id,
      );
      reservation = null;

      res.status(201).json(data);
    } catch (error) {
      await releaseUsage(reservation);
      if (cvAnalysisStage === 'db_insert' || cvAnalysisStage === 'finalize_usage') {
        error.code = 'AI_STORAGE_UNAVAILABLE';
        error.status = 503;
      }
      error.diagnostics = {
        route_stage: cvAnalysisStage,
        elapsed_ms: Date.now() - cvAnalysisStartedAt,
        ...(error.diagnostics || {}),
      };
      publicError(res, error);
    }
  },
);

router.put('/cv-analyses/:id', authMiddleware, async (req, res) => {
  try {
    await assertAiAccess(req.user.id, 'cv');

    const improvedText = safeText(
      req.body?.improved_text,
      40000,
      'CV ameliore',
    );

    if (!improvedText) {
      return res.status(400).json({
        error: 'Le CV ameliore ne peut pas etre vide',
      });
    }

    const { data, error } = await ownedById(
      supabase
        .from('ai_cv_analyses')
        .update({
          improved_text: improvedText,
          updated_at: new Date().toISOString(),
        }),
      req.user.id,
      req.params.id,
    )
      .select(
        'id,target_role,analysis,improved_text,created_at,updated_at',
      )
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        error: 'Analyse introuvable',
      });
    }

    res.json(data);
  } catch (error) {
    publicError(res, error);
  }
});

function contextSnapshot(body, profile, { simulationType } = {}) {
  const useProfile = body?.use_profile === true;
  const useCv = body?.use_cv === true;

  return {
    use_profile: useProfile,
    use_cv: useCv,
    ...(simulationType ? { simulation_type: simulationType } : {}),

    profile: useProfile
      ? {
          title: safeText(profile?.titre, 200),
          city: safeText(profile?.axes?.meta?.ville, 120),
          skills: Object.keys(
            profile?.axes?.meta?.competences || {},
          ).slice(0, 30),
        }
      : null,

    cv_text: useCv
      ? safeText(body?.cv_text, 30000, 'Texte du CV')
      : '',

    offer_text: safeText(
      body?.offer_text,
      20000,
      'Offre cible',
    ),
  };
}

router.get('/conversations', authMiddleware, async (req, res) => {
  try {
    await assertAiAccess(req.user.id, 'coach');

    const { data, error } = await supabase
      .from('ai_conversations')
      .select('id,mode,title,created_at,updated_at')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false })
      .limit(30);

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    publicError(res, error);
  }
});

router.post('/conversations', authMiddleware, async (req, res) => {
  try {
    await assertAiAccess(req.user.id, 'coach');

    const mode = String(req.body?.mode || '');

    if (!MODES.has(mode)) {
      return res.status(400).json({
        error: 'Mode de coaching invalide',
      });
    }

    let simulationType;
    if (isObjectionMode(mode)) {
      // Absent → recruitment (legacy). Present but invalid → 400.
      simulationType = Object.prototype.hasOwnProperty.call(req.body || {}, 'simulation_type')
        ? resolveSimulationType(req.body.simulation_type)
        : 'recruitment';
    }

    const profile = await ensureCandidateProfile(req.user.id);

    const defaultTitle = isObjectionMode(mode)
      ? simulationLabel(simulationType)
      : MODE_LABELS[mode];

    const title = safeText(
      req.body?.title || defaultTitle,
      120,
      'Titre',
    );

    const { data, error } = await supabase
      .from('ai_conversations')
      .insert(
        withOwner(
          {
            mode,
            title,
            context_data: contextSnapshot(req.body, profile, { simulationType }),
          },
          req.user.id,
        ),
      )
      .select('id,mode,title,created_at,updated_at,context_data')
      .single();

    if (error) throw error;

    res.status(201).json({
      ...publicConversation(data),
      messages: [],
    });
  } catch (error) {
    publicError(res, error);
  }
});

async function ownedConversation(userId, id) {
  const { data, error } = await ownedById(
    supabase
      .from('ai_conversations')
      .select('*'),
    userId,
    id,
  ).maybeSingle();

  if (error) throw error;

  if (!data) {
    const notFound = new Error('Conversation introuvable');
    notFound.status = 404;
    throw notFound;
  }

  return data;
}

router.get('/conversations/:id', authMiddleware, async (req, res) => {
  try {
    await assertAiAccess(req.user.id, 'coach');

    const conversation = await ownedConversation(
      req.user.id,
      req.params.id,
    );

    const { data, error } = await ownedConversationMessages(
      supabase
        .from('ai_conversation_messages')
        .select('id,role,phase,content,created_at'),
      req.user.id,
      conversation.id,
    ).order('created_at', { ascending: true });

    if (error) throw error;

    res.json({
      ...publicConversation(conversation),
      messages: data || [],
    });
  } catch (error) {
    publicError(res, error);
  }
});

router.patch('/conversations/:id', authMiddleware, async (req, res) => {
  try {
    await assertAiAccess(req.user.id, 'coach');
    const mode = String(req.body?.mode || '');
    if (!MODES.has(mode)) return res.status(400).json({ error: 'Mode de coaching invalide' });
    const { data, error } = await ownedById(
      supabase.from('ai_conversations').update({ mode, updated_at: new Date().toISOString() }),
      req.user.id,
      req.params.id,
    ).select('id,mode,title,created_at,updated_at').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Conversation introuvable' });
    res.json(data);
  } catch (error) {
    publicError(res, error);
  }
});

router.post('/conversations/:id/reset', authMiddleware, async (req, res) => {
  try {
    await assertAiAccess(req.user.id, 'coach');
    const conversation = await ownedConversation(req.user.id, req.params.id);
    const { error } = await ownedConversationMessages(
      supabase.from('ai_conversation_messages').delete(),
      req.user.id,
      conversation.id,
    );
    if (error) throw error;
    res.json({ id: conversation.id, mode: conversation.mode, title: conversation.title, messages: [] });
  } catch (error) {
    publicError(res, error);
  }
});

function coachSystem(conversation) {
  const context = conversation.context_data || {};
  const simulationType = isObjectionMode(conversation.mode)
    ? resolveSimulationType(context.simulation_type, { strict: false })
    : 'recruitment';
  return coachSystemPrompt(conversation.mode, JSON.stringify({
    profil: context.profile || {},
    cv: context.cv_text || 'Non partagé',
    offre: context.offer_text || 'Non partagée',
    simulation_type: isObjectionMode(conversation.mode) ? simulationType : undefined,
  }), simulationType);
}

function phaseFromContent(content, fallback = 'coaching') {
  if (/\[D[ÉE]BRIEF\]/i.test(content)) {
    return 'debrief';
  }

  if (/\[MISE EN SITUATION\]/i.test(content)) {
    return 'simulation';
  }

  return fallback;
}

async function generateCoachReply(
  userId,
  conversation,
  userContent,
  saveUser = true,
  reservation,
) {
  if (saveUser) {
    const { error } = await supabase
      .from('ai_conversation_messages')
      .insert(
        withOwner(
          {
            conversation_id: conversation.id,
            role: 'user',
            content: userContent,
            phase:
              conversation.mode === 'simulation'
                ? 'simulation'
                : 'coaching',
          },
          userId,
        ),
      );

    if (error) throw error;
  }

  const { data: history, error: historyError } = await supabase
    .from('ai_conversation_messages')
    .select('role,content')
    .eq('conversation_id', conversation.id)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (historyError) throw historyError;

  const aiResult = await callAi({
    json: true,
    returnMeta: true,
    maxTokens: 1200,

    messages: [
      {
        role: 'system',
        content: coachSystem(conversation),
      },

      ...selectCoachHistory(history || [], undefined, userContent),
    ],
  });
  const structuredReply = normalizeCoachReply(aiResult.value, conversation.mode);
  const rawContent = formatCoachReply(structuredReply);
  const safety = inspectAssistantOutput(rawContent);
  const content = safety.safe ? rawContent : AI_SAFETY_FALLBACK;
  if (!safety.safe) console.warn('[ai-safety]', { feature: 'coach', incidentType: safety.incidentType });

  const { data, error } = await supabase
    .from('ai_conversation_messages')
    .insert(
      withOwner(
        {
          conversation_id: conversation.id,
          role: 'assistant',
          content,
          phase: phaseFromContent(
            content,
            conversation.mode === 'simulation'
              ? 'simulation'
              : 'coaching',
          ),
        },
        userId,
      ),
    )
    .select('id,role,phase,content,created_at')
    .single();

  if (error) throw error;

  await finalizeUsage(
    reservation,
    aiResult.meta,
    'conversation_message',
    data.id,
  );

  await supabase
    .from('ai_conversations')
    .update({
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
    .eq('user_id', userId);

  return data;
}

router.post(
  '/conversations/:id/messages',
  authMiddleware,
  aiRateLimit({ max: 10, windowMs: 60000 }),
  async (req, res) => {
    let reservation;
    try {
      const access = await assertAiAccess(req.user.id, 'coach');

      const conversation = await ownedConversation(
        req.user.id,
        req.params.id,
      );

      const content = safeText(
        req.body?.content,
        4000,
        'Message',
      );

      if (!content) {
        return res.status(400).json({
          error: 'Message vide',
        });
      }

      reservation = await reserveUsage(
        req.user.id,
        access.plan,
        'coach',
      );

      const reply = await generateCoachReply(
        req.user.id,
        conversation,
        content,
        true,
        reservation,
      );
      reservation = null;
      res.status(201).json(reply);
    } catch (error) {
      await releaseUsage(reservation);
      publicError(res, error);
    }
  },
);

router.post(
  '/conversations/:id/retry',
  authMiddleware,
  aiRateLimit({ max: 10, windowMs: 60000 }),
  async (req, res) => {
    let reservation;
    try {
      const access = await assertAiAccess(req.user.id, 'coach');

      const conversation = await ownedConversation(
        req.user.id,
        req.params.id,
      );

      const { data, error } = await supabase
        .from('ai_conversation_messages')
        .select('role,content')
        .eq('conversation_id', conversation.id)
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      if (!data || data.role !== 'user') {
        return res.status(409).json({
          error: 'Aucun message en attente de reponse',
        });
      }

      reservation = await reserveUsage(
        req.user.id,
        access.plan,
        'coach',
      );

      const reply = await generateCoachReply(
        req.user.id,
        conversation,
        data.content,
        false,
        reservation,
      );
      reservation = null;
      res.status(201).json(reply);
    } catch (error) {
      await releaseUsage(reservation);
      publicError(res, error);
    }
  },
);

router.delete('/conversations/:id', authMiddleware, async (req, res) => {
  try {
    await assertAiAccess(req.user.id, 'coach');

    await ownedConversation(
      req.user.id,
      req.params.id,
    );

    const { error } = await ownedById(
      supabase
        .from('ai_conversations')
        .delete(),
      req.user.id,
      req.params.id,
    );

    if (error) throw error;

    res.json({
      success: true,
    });
  } catch (error) {
    publicError(res, error);
  }
});

module.exports = router;
