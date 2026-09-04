const buckets = new Map();

function aiRateLimit({ windowMs = 60000, max = 8 } = {}) {
  return (req, res, next) => {
    const key = req.user?.id;
    if (!key) return next();
    const now = Date.now();
    const current = buckets.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) return res.status(429).json({ error: 'Trop de demandes IA. Reessayez dans quelques instants.' });
    next();
  };
}

module.exports = aiRateLimit;
