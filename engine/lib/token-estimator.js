const TOKENS_PER_WORD = 1.3;

function estimate(messages, maxTokens) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const text = safeMessages.map((m) => (m && m.content) || '').join(' ');
  const inputTokens = Math.ceil(text.split(' ').length * TOKENS_PER_WORD);
  const outputTokens = maxTokens || 200;
  return {
    inputTokens,
    outputTokens,
    total: inputTokens + outputTokens,
  };
}

module.exports = {
  estimate,
};
