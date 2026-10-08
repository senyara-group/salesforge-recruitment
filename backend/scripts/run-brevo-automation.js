require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { runWorker } = require('../utils/brevoWorker');

async function main() {
  if (process.env.BREVO_AUTOMATION_ENABLED !== 'true' || process.env.BREVO_OUTBOX_ENABLED !== 'true') {
    console.log('Brevo automation disabled. No events sent.');
    return;
  }
  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }) },
  });
  if (process.env.BREVO_SCHEDULER_ENABLED === 'true') {
    console.log(await require('../utils/automationScheduler').runScheduler(db));
  }
  const batches = Math.max(1, Math.min(100, Number(process.env.BREVO_WORKER_BATCHES) || 20));
  let claimed = 0; let delivered = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const result = await runWorker({ db });
    claimed += result.claimed; delivered += result.delivered;
    if (!result.claimed) break;
  }
  console.log({ claimed, delivered });
}

if (require.main === module) main().catch((error) => {
  console.error('[brevo worker]', error.code || error.message);
  process.exitCode = 1;
});
module.exports = { main };
