// Never copy free-form exception/provider text into diagnostics, including JSON.parse messages.
const ROUTES = new Set(['validate', 'reserve_usage', 'ai_call', 'safety_check', 'normalize', 'db_insert', 'finalize_usage']);
const STAGES = new Set(['json_parse', 'empty_response', 'schema', 'provider_call']);
const PARSE = new Set(['INVALID_JSON', 'RESPONSE_TOO_LARGE', 'GENERATION_INCOMPLETE']);
const STOPS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal']);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function aiLogMetadata(error = {}, publicCode) {
  const d = error.diagnostics || {};
  return {
    technicalCode: publicCode,
    diagnostics: {
      route_stage: ROUTES.has(d.route_stage) ? d.route_stage : null,
      elapsed_ms: number(d.elapsed_ms),
      stage: STAGES.has(d.stage) ? d.stage : null,
      stop_reason: STOPS.has(d.stop_reason) ? d.stop_reason : null,
      response_chars: number(d.response_chars),
      parse_error: PARSE.has(d.parse_error) ? d.parse_error : null,
    },
  };
}
module.exports = { aiLogMetadata };
