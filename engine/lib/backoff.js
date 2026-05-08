function fullJitter(attempt, options = {}) {
  const baseMs = options.baseMs || 1000;
  const capMs = options.capMs || 30000;
  const exponential = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * exponential);
}

function decorrelated(previousDelay, options = {}) {
  const baseMs = options.baseMs || 1000;
  const capMs = options.capMs || 30000;
  const prev = Math.max(baseMs, previousDelay || baseMs);
  const upper = Math.max(baseMs, prev * 3);
  const delay = baseMs + Math.random() * (upper - baseMs);
  return Math.floor(Math.min(capMs, delay));
}

module.exports = {
  fullJitter,
  decorrelated,
};
