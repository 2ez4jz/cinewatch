import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { advance, deliver, emptyState } from "./lib/core.mjs";
import { cardBatch, cinemaBatch } from "./lib/adapters.mjs";
import { atomicJson, fileSink, readJson, withWorkspace } from "./lib/storage.mjs";
import { fetchReferences } from "./lib/scryfall.mjs";
import { demoFrame, times } from "./fixtures/demo.mjs";

const root = fileURLToPath(new URL("./", import.meta.url));

export async function scan(input, workspace, now) {
  const batch = input.theatres ? cinemaBatch(input) : cardBatch(input, now);
  const result = advance(workspace.state, batch, now);
  await workspace.save(result.state); // durable outbox before delivery
  const next = await deliver(result.state, batch.source, fileSink(workspace.path), now);
  await workspace.save(next);
  const report = { source: batch.source, observedAt: batch.observedAt, baseline: result.baseline,
    simulation: batch.simulation, newEventIds: result.created,
    assessments: batch.records.map(({ message, fingerprint, ...assessment }) => assessment),
    notifications: Object.values(next.outbox).filter(e => e.source === batch.source).map(({ message, ...event }) => event) };
  await atomicJson(join(workspace.path, "latest-report.json"), report);
  return report;
}

export async function demo(directory) {
  return withWorkspace(async workspace => {
    // Demo has its own directory/state and can be rerun deterministically.
    let state = emptyState();
    const results = [];
    for (let index = 0; index < times.length; index++) {
      const input = demoFrame(index), batch = cardBatch(input, times[index]);
      const step = advance(state, batch, times[index]);
      state = step.state;
      await workspace.save(state);
      state = await deliver(state, batch.source, index === 1 ? async () => { throw new Error("Simulated sink failure"); } : fileSink(workspace.path), times[index]);
      await workspace.save(state);
      results.push({ step: index, at: times[index], baseline: step.baseline, created: step.created.length,
        eligible: batch.records.filter(r => r.eligible).length,
        pending: Object.values(state.outbox).filter(e => e.status === "pending").length,
        delivered: Object.values(state.outbox).filter(e => e.status === "delivered").length,
        assessments: batch.records.map(({ message, fingerprint, ...r }) => r) });
    }
    const before = JSON.stringify(state);
    let incompleteRejected = false;
    try { advance(state, { ...cardBatch(demoFrame(5), times[5]), complete: false }, times[5]); }
    catch { incompleteRejected = JSON.stringify(state) === before; }
    const summary = { simulation: true, realTransactions: 0, finalEvents: Object.keys(state.outbox).length,
      delivered: Object.values(state.outbox).filter(e => e.status === "delivered").length,
      incompleteRejectedWithoutStateLoss: incompleteRejected, results };
    await atomicJson(join(workspace.path, "demo-report.json"), summary);
    return summary;
  }, directory || join(root, ".local", "demo"));
}

async function main() {
  const [command, inputPath] = process.argv.slice(2);
  if (command === "demo") {
    const report = await demo();
    console.log(JSON.stringify({ simulation: true, realTransactions: 0, events: report.finalEvents,
      delivered: report.delivered, incompleteRejected: report.incompleteRejectedWithoutStateLoss,
      report: join(root, ".local/demo/demo-report.json") }, null, 2));
  } else if (command === "scan" || command === "cinema") {
    if (!inputPath) throw new Error("Supply a JSON input path; production files are read-only");
    const input = await readJson(inputPath);
    if (command === "cinema" && !input.theatres) throw new Error("Expected CineWatch snapshot");
    const report = await withWorkspace(workspace => scan(input, workspace, new Date().toISOString()), join(root, ".local", command));
    console.log(JSON.stringify({ source: report.source, baseline: report.baseline,
      eligibleRecords: report.assessments.filter(r => r.eligible).length, newEvents: report.newEventIds.length,
      pending: report.notifications.filter(e => e.status === "pending").length,
      delivery: "local notification files only; no email sent" }, null, 2));
  } else if (command === "reference") {
    const list = await readJson(inputPath || join(root, "fixtures/watchlist.json"));
    const result = await withWorkspace(async workspace => {
      const evidence = await fetchReferences(list, join(workspace.path, "cache"));
      await atomicJson(join(workspace.path, "references.json"), evidence);
      return evidence;
    }, join(root, ".local/reference"));
    console.log(JSON.stringify({ cards: result.cards.length, httpRequests: result.requests,
      executableOpportunities: 0, report: join(root, ".local/reference/references.json") }, null, 2));
  } else throw new Error("Usage: node experiments/opportunity-agent/run.mjs demo | reference [watchlist.json] | scan quotes.json | cinema data/showtimes.json");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
