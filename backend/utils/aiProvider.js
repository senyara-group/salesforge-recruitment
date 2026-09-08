const { APIConnectionTimeoutError } = require('@anthropic-ai/sdk');
const { askClaude, MODEL, anthropicTimeout } = require('./anthropic');

const MAX_RESPONSE_CHARS = 60000;

function aiConfiguration() {
  return { provider: 'anthropic', model: process.env.ANTHROPIC_MODEL || MODEL, timeoutMs: anthropicTimeout() };
}

function isAiConfigured() {
  return Boolean(String(process.env.ANTHROPIC_API_KEY || '').trim());
}

function safeText(value, maxLength, label = 'Texte') {
  const text = String(value || '').replace(/\u0000/g, '').trim();
  if (text.length > maxLength) {
    const error = new Error(`${label} trop long (${maxLength} caracteres maximum)`);
    error.status = 400;
    throw error;
  }
  return text;
}

function stripCodeFence(value = '') {
  return String(value).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function jsonShapeHints(value = '') {
  const text = String(value);
  return {
    response_chars: text.length,
    has_open_brace: text.includes('{'),
    has_close_brace: text.includes('}'),
    has_markdown_fence: /```/.test(text),
  };
}

function parseJsonResponse(value) {
  const text = stripCodeFence(value);
  if (text.length > MAX_RESPONSE_CHARS) {
    const error = new Error('Reponse IA trop volumineuse');
    error.diagnostics = { stage: 'json_parse', parse_error: error.message, ...jsonShapeHints(text) };
    throw error;
  }
  try { return JSON.parse(text); }
  catch (firstError) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); }
      catch (sliceError) {
        const error = new Error('Reponse IA invalide');
        error.diagnostics = {
          stage: 'json_parse',
          parse_error: String(sliceError.message || firstError.message || 'JSON.parse failed').slice(0, 200),
          ...jsonShapeHints(text),
        };
        throw error;
      }
    }
    const error = new Error('Reponse IA invalide');
    error.diagnostics = {
      stage: 'json_parse',
      parse_error: String(firstError.message || 'JSON.parse failed').slice(0, 200),
      ...jsonShapeHints(text),
    };
    throw error;
  }
}

function anthropicMessages(messages = []) {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const conversation = messages.filter((message) => message.role !== 'system').map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message.content || ''),
  }));
  return { system, messages: conversation };
}

function isAiTimeoutError(error) {
  if (!error) return false;
  // Le SDK Anthropic pose error.name = "Error" ; constructor.name / instanceof restent fiables.
  if (typeof APIConnectionTimeoutError === 'function' && error instanceof APIConnectionTimeoutError) return true;
  if (error.constructor && error.constructor.name === 'APIConnectionTimeoutError') return true;
  return /timed out|timeout/i.test(String(error.message || ''));
}

function normalizeProviderResult(raw) {
  if (raw && typeof raw === 'object' && typeof raw.text === 'string') {
    return { content: raw.text, meta: raw.meta || null };
  }
  return { content: typeof raw === 'string' ? raw : '', meta: null };
}

async function callAi({
  messages,
  json = false,
  maxTokens = 1800,
  timeoutMs,
  maxRetries = 0,
  returnMeta = false,
  providerCall = askClaude,
}) {
  if (!isAiConfigured() && providerCall === askClaude) {
    const error = new Error('Service IA non configure');
    error.status = 503;
    error.code = 'AI_NOT_CONFIGURED';
    throw error;
  }
  const formatted = anthropicMessages(messages);
  if (json) formatted.system = `${formatted.system}\n\nRéponds uniquement avec un objet JSON valide, sans balise Markdown.`.trim();
  let providerMeta = null;
  try {
    // DIAG_CV_JSON: demande les métadonnées Anthropic uniquement pour le chemin JSON.
    const raw = await providerCall({
      ...formatted,
      maxTokens,
      timeoutMs,
      maxRetries,
      returnMeta: (json || returnMeta) && providerCall === askClaude,
    });
    const normalized = normalizeProviderResult(raw);
    const content = normalized.content;
    providerMeta = normalized.meta;
    if (typeof content !== 'string' || !content.trim()) {
      const invalid = new Error('Reponse IA vide');
      invalid.status = 502;
      invalid.code = 'AI_INVALID_RESPONSE';
      invalid.diagnostics = {
        stage: 'empty_response',
        parse_error: null,
        schema_stage: null,
        stop_reason: providerMeta?.stop_reason ?? null,
        input_tokens: providerMeta?.input_tokens ?? null,
        output_tokens: providerMeta?.output_tokens ?? null,
        ...jsonShapeHints(content || ''),
      };
      throw invalid;
    }
    if (!json) {
      const value = content.slice(0, MAX_RESPONSE_CHARS).trim();
      return returnMeta ? { value, meta: providerMeta } : value;
    }
    if (providerMeta?.stop_reason === 'max_tokens') {
      const invalid = new Error('Le service IA a atteint sa limite avant de confirmer une réponse complète');
      invalid.status = 502;
      invalid.code = 'AI_INVALID_RESPONSE';
      invalid.diagnostics = {
        stage: 'json_parse',
        schema_stage: null,
        stop_reason: 'max_tokens',
        input_tokens: providerMeta?.input_tokens ?? null,
        output_tokens: providerMeta?.output_tokens ?? null,
        parse_error: 'Generation stopped at max_tokens before completion',
        ...jsonShapeHints(content),
      };
      throw invalid;
    }
    try {
      const value = parseJsonResponse(content);
      return returnMeta ? { value, meta: providerMeta } : value;
    }
    catch (parseError) {
      const invalid = new Error('Le service IA a renvoye une reponse invalide');
      invalid.status = 502;
      invalid.code = 'AI_INVALID_RESPONSE';
      invalid.diagnostics = {
        stage: 'json_parse',
        schema_stage: null,
        stop_reason: providerMeta?.stop_reason ?? null,
        input_tokens: providerMeta?.input_tokens ?? null,
        output_tokens: providerMeta?.output_tokens ?? null,
        parse_error: String(parseError.diagnostics?.parse_error || parseError.message || 'JSON.parse failed').slice(0, 200),
        response_chars: parseError.diagnostics?.response_chars ?? content.length,
        has_open_brace: parseError.diagnostics?.has_open_brace ?? content.includes('{'),
        has_close_brace: parseError.diagnostics?.has_close_brace ?? content.includes('}'),
        has_markdown_fence: parseError.diagnostics?.has_markdown_fence ?? /```/.test(content),
      };
      throw invalid;
    }
  } catch (error) {
    if (error.code) throw error;
    if (isAiTimeoutError(error)) {
      const timeoutError = new Error('Le service IA a depasse le delai autorise');
      timeoutError.status = 504;
      timeoutError.code = 'AI_TIMEOUT';
      throw timeoutError;
    }
    const providerError = new Error('Service IA indisponible');
    providerError.status = error.status === 429 ? 429 : 502;
    providerError.code = 'AI_PROVIDER_ERROR';
    throw providerError;
  }
}

module.exports = {
  aiConfiguration,
  isAiConfigured,
  safeText,
  stripCodeFence,
  parseJsonResponse,
  anthropicMessages,
  isAiTimeoutError,
  callAi,
};
