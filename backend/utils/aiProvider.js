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

function parseJsonResponse(value) {
  const text = stripCodeFence(value);
  if (text.length > MAX_RESPONSE_CHARS) throw new Error('Reponse IA trop volumineuse');
  try { return JSON.parse(text); }
  catch (_error) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('Reponse IA invalide');
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

async function callAi({
  messages,
  json = false,
  maxTokens = 1800,
  timeoutMs,
  maxRetries = 0,
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
  try {
    const content = await providerCall({ ...formatted, maxTokens, timeoutMs, maxRetries });
    if (typeof content !== 'string' || !content.trim()) {
      const invalid = new Error('Reponse IA vide');
      invalid.status = 502;
      invalid.code = 'AI_INVALID_RESPONSE';
      throw invalid;
    }
    if (!json) return content.slice(0, MAX_RESPONSE_CHARS).trim();
    try { return parseJsonResponse(content); }
    catch (_error) {
      const invalid = new Error('Le service IA a renvoye une reponse invalide');
      invalid.status = 502;
      invalid.code = 'AI_INVALID_RESPONSE';
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
  parseJsonResponse,
  anthropicMessages,
  isAiTimeoutError,
  callAi,
};
