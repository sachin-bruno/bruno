const EARLY_BATCH_COUNT = 4;
const EARLY_BATCH_INTERVAL_MS = 50;
const BATCH_INTERVAL_MS = 250;

const createBatchSender = (send) => {
  let pending = [];
  let timer = null;
  let lastSentAt = -Infinity;
  let sentCount = 0;

  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (pending.length > 0) {
      send(pending);
      pending = [];
      lastSentAt = Date.now();
      sentCount += 1;
    }
  };

  const batchInterval = () => (sentCount < EARLY_BATCH_COUNT ? EARLY_BATCH_INTERVAL_MS : BATCH_INTERVAL_MS);

  const add = (collection) => {
    pending.push(collection);
    if (timer === null) {
      timer = setTimeout(flush, Math.max(0, batchInterval() - (Date.now() - lastSentAt)));
    }
  };

  return { add, flush };
};

module.exports = {
  createBatchSender
};
