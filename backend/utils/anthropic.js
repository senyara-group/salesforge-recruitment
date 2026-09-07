const Anthropic = require('@anthropic-ai/sdk');

// Alias sans date : Anthropic le résout vers le dernier snapshot Sonnet 4.5 stable.
// Changer via la variable d'env si un modèle plus récent/moins cher est préféré.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const DEFAULT_TIMEOUT_MS = 30000;

function anthropicTimeout(overrideMs) {
  const value = Number(overrideMs == null ? process.env.ANTHROPIC_TIMEOUT_MS || DEFAULT_TIMEOUT_MS : overrideMs);
  return Number.isFinite(value) ? Math.max(5000, Math.min(60000, value)) : DEFAULT_TIMEOUT_MS;
}

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const error = new Error('ANTHROPIC_API_KEY manquante');
    error.status = 503;
    throw error;
  }
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function extractText(response) {
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function responseMeta(response, text) {
  return {
    stop_reason: response.stop_reason || null,
    input_tokens: response.usage?.input_tokens ?? null,
    output_tokens: response.usage?.output_tokens ?? null,
    response_chars: text.length,
    has_open_brace: text.includes('{'),
    has_close_brace: text.includes('}'),
    has_markdown_fence: /```/.test(text),
  };
}

async function askClaude({ system, messages, maxTokens = 1024, timeoutMs, maxRetries = 0, returnMeta = false }) {
  const anthropic = getClient();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages,
  }, {
    timeout: anthropicTimeout(timeoutMs),
    // Les retries SDK (défaut 2) multiplient les timeouts (~90s) sans améliorer
    // une génération trop longue ; on laisse l'appelant décider.
    maxRetries,
  });
  const text = extractText(response);
  if (returnMeta) return { text, meta: responseMeta(response, text) };
  return text;
}

module.exports = { askClaude, MODEL, anthropicTimeout };
