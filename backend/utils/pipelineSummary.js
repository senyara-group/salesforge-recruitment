const { STATUS_LABELS, TRANSITIONS } = require('./applicationWorkflow');
const { PIPELINE_STAGES, stageForStatut } = require('./pipelineQuery');

function applicationMoves(status) {
  return [...(TRANSITIONS[status || 'envoyee'] || [])].map((statut) => ({
    statut, stage: stageForStatut(statut), label: STATUS_LABELS[statut],
  }));
}

// Exact counts are not subject to the PostgREST row limit. No candidate data
// leaves this aggregate; use the same ownership and exclusion as the pipeline.
async function pipelineSummary(db, recruiterId, now = Date.now()) {
  const applications = () => db.from('candidatures')
    .select('id,offres!inner(recruteur_id)', { count: 'exact', head: true })
    .eq('offres.recruteur_id', recruiterId)
    .or('lettre_type.is.null,lettre_type.neq.recruteur_like');
  const count = async (query) => {
    const result = await query;
    if (result.error) throw result.error;
    if (!Number.isInteger(result.count)) throw new Error('Comptage du pipeline indisponible');
    return result.count;
  };
  const statuses = Object.keys(STATUS_LABELS);
  const [total, recent, offers, ...byStatus] = await Promise.all([
    count(applications()),
    count(applications().gte('created_at', new Date(now - 7 * 86400000).toISOString())),
    count(db.from('offres').select('id', { count: 'exact', head: true })
      .eq('recruteur_id', recruiterId).eq('statut', 'active')),
    ...statuses.map((status) => count(status === 'envoyee'
      ? applications().or('statut.eq.envoyee,statut.is.null')
      : applications().eq('statut', status))),
  ]);
  const stages = Object.fromEntries(PIPELINE_STAGES.map((key) => [key, 0]));
  statuses.forEach((status, i) => { stages[stageForStatut(status)] += byStatus[i]; });
  // Preserve the existing unknown-status fallback, without inventing aliases.
  stages.termine += Math.max(0, total - byStatus.reduce((a, b) => a + b, 0));
  return { recues: total, recues_new: recent, pipeline: total, offres: offers,
    chauds: byStatus[statuses.indexOf('repondu')] + stages.entretien, stages };
}

module.exports = { applicationMoves, pipelineSummary };
