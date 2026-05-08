const STARVATION_THRESHOLD_MS = 30000;

const queues = {
  HIGH: [],
  MEDIUM: [],
  LOW: [],
};

function enqueue(entry) {
  const priority = entry.priority || 'MEDIUM';
  if (!queues[priority]) {
    queues.MEDIUM.push(entry);
    return;
  }
  queues[priority].push(entry);
}

function promoteStarved() {
  const now = Date.now();
  queues.LOW = queues.LOW.filter((entry) => {
    if (now - entry.enqueuedAt > STARVATION_THRESHOLD_MS) {
      entry.priority = 'MEDIUM';
      queues.MEDIUM.push(entry);
      return false;
    }
    return true;
  });
}

function pickQueueRef() {
  if (queues.HIGH.length > 0) return queues.HIGH;
  if (queues.MEDIUM.length > 0) return queues.MEDIUM;
  if (queues.LOW.length > 0) return queues.LOW;
  return null;
}

function peek() {
  promoteStarved();
  const q = pickQueueRef();
  return q ? q[0] : null;
}

function dequeue() {
  promoteStarved();
  const q = pickQueueRef();
  return q ? q.shift() : null;
}

function remove(id) {
  for (const key of Object.keys(queues)) {
    const idx = queues[key].findIndex((entry) => entry.id === id);
    if (idx >= 0) {
      const removed = queues[key].splice(idx, 1);
      return removed[0] || null;
    }
  }
  return null;
}

function getDepth() {
  return {
    HIGH: queues.HIGH.length,
    MEDIUM: queues.MEDIUM.length,
    LOW: queues.LOW.length,
    total: queues.HIGH.length + queues.MEDIUM.length + queues.LOW.length,
  };
}

module.exports = {
  STARVATION_THRESHOLD_MS,
  enqueue,
  peek,
  dequeue,
  remove,
  getDepth,
};
