const DEFAULT_COACH_HISTORY_MAX_CHARS = 24000;
const MIN_COACH_HISTORY_MAX_CHARS = 4000;

function coachHistoryMaxChars() {
  const configured = Number(process.env.AI_COACH_HISTORY_MAX_CHARS);
  if (!Number.isInteger(configured) || configured < MIN_COACH_HISTORY_MAX_CHARS) {
    return DEFAULT_COACH_HISTORY_MAX_CHARS;
  }
  return configured;
}

// Supabase returns newest first. Keep a contiguous recent window and always
// retain the current user message (the first row), even if configuration is low.
function selectCoachHistory(history = [], maxChars = coachHistoryMaxChars(), currentContent) {
  const currentIndex = currentContent === undefined
    ? 0
    : history.findIndex((message) => message?.role === 'user' && message?.content === currentContent);
  const newestFirst = currentIndex > 0
    ? [history[currentIndex], ...history.slice(0, currentIndex), ...history.slice(currentIndex + 1)]
    : currentIndex < 0 && currentContent !== undefined
      ? [{ role: 'user', content: currentContent }, ...history]
      : history;
  const selected = [];
  let characters = 0;

  for (const [index, message] of newestFirst.entries()) {
    const content = String(message?.content || '');
    if (index > 0 && characters + content.length > maxChars) break;
    selected.push({ role: message.role, content });
    characters += content.length;
  }

  return selected.reverse();
}

module.exports = {
  DEFAULT_COACH_HISTORY_MAX_CHARS,
  MIN_COACH_HISTORY_MAX_CHARS,
  coachHistoryMaxChars,
  selectCoachHistory,
};
