const Anthropic = require('@anthropic-ai/sdk');

// Alias sans date : Anthropic le résout vers le dernier snapshot Sonnet 4.5 stable.
// Changer via la variable d'env si un modèle plus récent/moins cher est préféré.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const DEFAULT_TIMEOUT_MS = 30000;

function anthropicTimeout() {
  const value = Number(process.env.ANTHROPIC_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
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

async function askClaude({ system, messages, maxTokens = 1024 }) {
  const anthropic = getClient();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages,
  }, { timeout: anthropicTimeout() });
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

module.exports = { askClaude, MODEL, anthropicTimeout };
