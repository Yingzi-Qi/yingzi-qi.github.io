import { runSanity, validateInput } from './sanity.js';
import { sanitiseRunInput } from './sanitise-run-input.js';
import { nowIso, randomId } from './http.js';
const STALE_MS = 90_000;
export async function createRun(env, body) {
  const input = sanitiseRunInput(validateInput(body));
  const runId = randomId('run_');
  const t = nowIso();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sanity_runs (run_id, batch_id, mode, status, input_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').bind(runId, input.batchId, input.mode, 'queued', JSON.stringify(input), t, t),
    env.DB.prepare('INSERT INTO batches (batch_id, created_at, state, receipt_count) VALUES (?,?,?,?) ON CONFLICT(batch_id) DO UPDATE SET state=excluded.state, receipt_count=excluded.receipt_count').bind(input.batchId, t, input.mode === 'round1' ? 'Reading & Sanity' : 'Round 2 Look-up', input.receipts.length),
  ]);
  return { runId, batchId: input.batchId, status: 'queued', pollAfterMs: 1500 };
}
export async function processRun(env, runId, deps) {
  const claimed = await env.DB.prepare(`UPDATE sanity_runs SET status='running', updated_at=? WHERE run_id=? AND (status='queued' OR (status='running' AND updated_at < ?)) RETURNING input_json`)
    .bind(nowIso(), runId, new Date(Date.now() - STALE_MS).toISOString()).first();
  if (!claimed) return;
  const input = JSON.parse(claimed.input_json);
  try {
    const { result, audit } = await runSanity(env, input, deps);
    const t = nowIso();
    await env.DB.batch([
      env.DB.prepare(`UPDATE sanity_runs SET status='completed', result_json=?, audit_json=?, updated_at=? WHERE run_id=?`).bind(JSON.stringify(result), JSON.stringify(audit), t, runId),
      env.DB.prepare('UPDATE batches SET state=? WHERE batch_id=?').bind(input.mode === 'round1' ? 'Internal Review' : 'Internal Review (Round 2)', input.batchId),
      env.DB.prepare('INSERT INTO reading_history (created_at, kind, batch_id, summary, detail_json) VALUES (?,?,?,?,?)').bind(t, 'sanity-run', input.batchId,
        `${input.mode}: ${result.agreedRows.length} rows, ${result.readingErrors.length} reading errors, ${result.lookupUncertainties.length} look-up flags, ${result.excludedZeroCount} zero-price lines excluded`,
        JSON.stringify({ runId, mode: input.mode, rows: result.agreedRows.length, excludedZeroCount: result.excludedZeroCount, lookupsPaused: Boolean(result.lookupsPaused) })),
    ]);
  } catch (e) {
    await env.DB.prepare(`UPDATE sanity_runs SET status='failed', error=?, updated_at=? WHERE run_id=?`).bind(String(e.message || e).slice(0, 500), nowIso(), runId).run();
  }
}
export async function getRun(env, runId, waitUntil) {
  const row = await env.DB.prepare('SELECT run_id, batch_id, mode, status, result_json, error, updated_at FROM sanity_runs WHERE run_id=?').bind(runId).first();
  if (!row) return null;
  const base = { runId: row.run_id, batchId: row.batch_id, mode: row.mode, status: row.status };
  if (row.status === 'completed') return { ...base, ...JSON.parse(row.result_json) }; // final agreed version only
  if (row.status === 'failed') return { ...base, error: row.error };
  if (Date.parse(row.updated_at) < Date.now() - STALE_MS || row.status === 'queued') waitUntil(processRun(env, runId));
  return { ...base, pollAfterMs: 2000 };
}
