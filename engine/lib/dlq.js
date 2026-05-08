const dlq = [];

function add(entry) {
  const item = {
    id: entry.id,
    originalRequest: {
      model: entry.req && entry.req.body ? entry.req.body.model : undefined,
      messages: entry.req && entry.req.body ? entry.req.body.messages : undefined,
      max_tokens: entry.req && entry.req.body ? entry.req.body.max_tokens : undefined,
      priority: entry.priority,
    },
    errorHistory: Array.isArray(entry.errors) ? [...entry.errors] : [],
    retryCount: Number.isFinite(entry.attempts) ? entry.attempts : 0,
    reason: entry.reason || 'Unknown error',
    enqueuedAt: entry.enqueuedAt,
    dlqAt: new Date().toISOString(),
  };
  dlq.push(item);
  return item;
}

function getAll() {
  return [...dlq];
}

function getCount() {
  return dlq.length;
}

function findById(id) {
  return dlq.find((item) => item.id === id) || null;
}

function removeById(id) {
  const idx = dlq.findIndex((item) => item.id === id);
  if (idx < 0) return null;
  const removed = dlq.splice(idx, 1);
  return removed[0] || null;
}

function clear() {
  dlq.length = 0;
}

module.exports = {
  add,
  getAll,
  getCount,
  findById,
  removeById,
  clear,
};
