const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_CHARS = 60000;

function aiConfiguration() {
  const requestedTimeout = Number(process.env.AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return {
    apiKey: String(process.env.AI_API_KEY || '').trim(),
    apiUrl: String(process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions').trim(),
    model: String(process.env.AI_MODEL || '').trim(),
    timeoutMs: Number.isFinite(requestedTimeout) ? Math.max(5000, Math.min(60000, requestedTimeout)) : DEFAULT_TIMEOUT_MS,
  };
}

function isAiConfigured() {
  const config = aiConfiguration();
  return Boolean(config.apiKey && config.model && /^https:\/\//i.test(config.apiUrl));
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
  try {
    return JSON.parse(text);
  } catch (_error) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('Reponse IA invalide');
  }
}

async function callAi({ messages, json = false, temperature = 0.25, maxTokens = 1800 }) {
  const config = aiConfiguration();
  if (!isAiConfigured()) {
    const error = new Error('Service IA non configure');
    error.status = 503;
    error.code = 'AI_NOT_CONFIGURED';
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(response.status === 429 ? 'Service IA temporairement limite' : 'Service IA indisponible');
      error.status = response.status === 429 ? 429 : 502;
      error.code = 'AI_PROVIDER_ERROR';
      throw error;
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Reponse IA vide');
    if (!json) return content.slice(0, MAX_RESPONSE_CHARS).trim();
    try { return parseJsonResponse(content); }
    catch (_error) {
      const invalidError = new Error('Le service IA a renvoye une reponse invalide');
      invalidError.status = 502;
      invalidError.code = 'AI_INVALID_RESPONSE';
      throw invalidError;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Le service IA a depasse le delai autorise');
      timeoutError.status = 504;
      timeoutError.code = 'AI_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { aiConfiguration, isAiConfigured, safeText, parseJsonResponse, callAi };
