const Anthropic = require('@anthropic-ai/sdk');

// Alias sans date : Anthropic le résout vers le dernier snapshot Sonnet 4.5 stable.
// Changer via la variable d'env si un modèle plus récent/moins cher est préféré.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

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
  });
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

module.exports = { askClaude, MODEL };
