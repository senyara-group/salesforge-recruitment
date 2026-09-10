const express = require('express');
const authMiddleware = require('../middleware/auth');
const requireCandidatePlan = require('../middleware/requireCandidatePlan');
const supabase = require('../supabase');
const { getCandidatePlan } = require('../utils/profiles');
const {
  QUESTIONNAIRE_VERSION,
  SCORING_VERSION,
  createPresentation,
  publicQuestionnaire,
  validateAnswer,
  scoreAnswers,
} = require('../utils/deepAdnQuestionnaire');

const RETAKE_COOLDOWN_MS = 6 * 30 * 24 * 60 * 60 * 1000;

function publicAssessment(row, includeQuestionnaire = false, answers = []) {
  const response = {
    id: row.id,
    status: row.status,
    questionnaire_version: row.questionnaire_version,
    scoring_version: row.scoring_version,
    started_at: row.started_at,
    completed_at: row.completed_at,
    result: row.status === 'completed' ? row.result : null,
  };
  if (includeQuestionnaire) {
    response.questionnaire = publicQuestionnaire(row.presentation || []);
    response.answers = answers.map(({ question_id, option_id }) => ({ question_id, option_id }));
  }
  return response;
}

function routeError(res, error) {
  const publicCodes = new Set(['UNKNOWN_QUESTION', 'UNKNOWN_OPTION', 'DUPLICATE_ANSWER', 'INCOMPLETE_ASSESSMENT']);
  const known = publicCodes.has(error.code);
  const status = known ? 400 : 500;
  if (!known) console.error('[deep-adn] erreur', String(error?.message || error).slice(0, 300));
  res.status(status).json({ error: known ? error.code : 'DEEP_ADN_ERROR', message: known ? error.message : 'L’évaluation est momentanément indisponible.' });
}

function createRouter({ client = supabase, planForUser = getCandidatePlan } = {}) {
  const router = express.Router();

  router.post('/start', authMiddleware, requireCandidatePlan('carriere'), async (req, res) => {
    try {
      const { data: active, error: activeError } = await client.from('deep_adn_assessments').select('*')
        .eq('user_id', req.user.id).eq('status', 'in_progress').order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (activeError) throw activeError;
      if (active) {
        const { data: answers, error: answersError } = await client.from('deep_adn_answers').select('question_id,option_id')
          .eq('assessment_id', active.id).eq('user_id', req.user.id);
        if (answersError) throw answersError;
        return res.json(publicAssessment(active, true, answers || []));
      }

      const { data: last, error: lastError } = await client.from('deep_adn_assessments').select('*')
        .eq('user_id', req.user.id).eq('status', 'completed').order('completed_at', { ascending: false }).limit(1).maybeSingle();
      if (lastError) throw lastError;
      if (last) {
        const plan = req.candidatePlan || await planForUser(req.user.id);
        if (plan !== 'carriere_coaching') {
          return res.status(403).json({ error: 'DEEP_ADN_ALREADY_COMPLETED', message: 'Votre ADN approfondi est déjà complété.' });
        }
        const eligibleAt = new Date(new Date(last.completed_at).getTime() + RETAKE_COOLDOWN_MS);
        if (eligibleAt.getTime() > Date.now()) {
          return res.status(403).json({ error: 'RETAKE_TOO_SOON', message: `Prochaine évaluation disponible le ${eligibleAt.toLocaleDateString('fr-FR')}`, next_eligible_at: eligibleAt.toISOString() });
        }
      }

      const presentation = createPresentation();
      const { data, error } = await client.from('deep_adn_assessments').insert({
        user_id: req.user.id,
        questionnaire_version: QUESTIONNAIRE_VERSION,
        scoring_version: SCORING_VERSION,
        presentation,
      }).select('*').single();
      if (error) throw error;
      res.status(201).json(publicAssessment(data, true, []));
    } catch (error) { routeError(res, error); }
  });

  router.put('/:id/progress', authMiddleware, requireCandidatePlan('carriere'), async (req, res) => {
    try {
      const { data: assessment, error } = await client.from('deep_adn_assessments').select('id,user_id,status,presentation')
        .eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
      if (error) throw error;
      if (!assessment) return res.status(404).json({ error: 'DEEP_ADN_NOT_FOUND', message: 'Évaluation introuvable.' });
      if (assessment.status !== 'in_progress') return res.status(409).json({ error: 'DEEP_ADN_COMPLETED', message: 'Cette évaluation est déjà terminée.' });
      const { question_id: questionId, option_id: optionId } = req.body || {};
      validateAnswer(questionId, optionId);
      const presented = assessment.presentation?.find((item) => item.question_id === questionId);
      if (!presented?.option_ids?.includes(optionId)) return res.status(400).json({ error: 'UNKNOWN_OPTION', message: 'Option absente de cette tentative.' });
      const { error: answerError } = await client.from('deep_adn_answers').upsert({
        assessment_id: assessment.id,
        user_id: req.user.id,
        question_id: questionId,
        option_id: optionId,
        answered_at: new Date().toISOString(),
      }, { onConflict: 'assessment_id,question_id' });
      if (answerError) throw answerError;
      const { count, error: countError } = await client.from('deep_adn_answers').select('question_id', { count: 'exact', head: true })
        .eq('assessment_id', assessment.id).eq('user_id', req.user.id);
      if (countError) throw countError;
      res.json({ id: assessment.id, status: 'in_progress', answered: count || 0, total: 48 });
    } catch (error) { routeError(res, error); }
  });

  router.post('/:id/finalize', authMiddleware, requireCandidatePlan('carriere'), async (req, res) => {
    try {
      const { data: assessment, error } = await client.from('deep_adn_assessments').select('*')
        .eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
      if (error) throw error;
      if (!assessment) return res.status(404).json({ error: 'DEEP_ADN_NOT_FOUND', message: 'Évaluation introuvable.' });
      if (assessment.status === 'completed') return res.json(publicAssessment(assessment));
      const { data: answers, error: answersError } = await client.from('deep_adn_answers').select('question_id,option_id')
        .eq('assessment_id', assessment.id).eq('user_id', req.user.id);
      if (answersError) throw answersError;
      const result = scoreAnswers(answers || [], assessment.presentation || []);
      const completedAt = new Date().toISOString();
      const { data: completed, error: updateError } = await client.from('deep_adn_assessments').update({
        status: 'completed', result, consistency_flags: result.consistency.flags, completed_at: completedAt,
      }).eq('id', assessment.id).eq('user_id', req.user.id).eq('status', 'in_progress').select('*').maybeSingle();
      if (updateError) throw updateError;
      if (completed) return res.json(publicAssessment(completed));
      const { data: concurrent, error: concurrentError } = await client.from('deep_adn_assessments').select('*')
        .eq('id', assessment.id).eq('user_id', req.user.id).eq('status', 'completed').maybeSingle();
      if (concurrentError) throw concurrentError;
      if (!concurrent) throw new Error('Finalisation impossible');
      res.json(publicAssessment(concurrent));
    } catch (error) { routeError(res, error); }
  });

  router.get('/current', authMiddleware, requireCandidatePlan('carriere'), async (req, res) => {
    try {
      const { data, error } = await client.from('deep_adn_assessments').select('*').eq('user_id', req.user.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      if (!data) return res.json(null);
      let answers = [];
      if (data.status === 'in_progress') {
        const answerResult = await client.from('deep_adn_answers').select('question_id,option_id')
          .eq('assessment_id', data.id).eq('user_id', req.user.id);
        if (answerResult.error) throw answerResult.error;
        answers = answerResult.data || [];
      }
      res.json(publicAssessment(data, data.status === 'in_progress', answers));
    } catch (error) { routeError(res, error); }
  });

  router.get('/history', authMiddleware, requireCandidatePlan('carriere_coaching'), async (req, res) => {
    try {
      const { data, error } = await client.from('deep_adn_assessments').select('id,status,questionnaire_version,scoring_version,result,started_at,completed_at')
        .eq('user_id', req.user.id).eq('status', 'completed').order('completed_at', { ascending: false });
      if (error) throw error;
      res.json({ assessments: (data || []).map((row) => publicAssessment(row)) });
    } catch (error) { routeError(res, error); }
  });

  return router;
}

const router = createRouter();
router._test = { createRouter, publicAssessment, RETAKE_COOLDOWN_MS };
module.exports = router;
