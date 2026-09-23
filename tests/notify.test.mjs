import test from "node:test";
import assert from "node:assert/strict";
import { collectTheatreDates, emailHtml, emailSubject, findNewDates, mergeSeenDates } from "../scripts/notify.mjs";

const data = {
  theatres: [{
    id: 7408,
    shortName: "Vaughan",
    days: [
      { date: "2026-09-18", movies: [{ title: "The Odyssey", sessions: [{ time: "15:00" }, { time: "19:00" }] }] },
      { date: "2026-09-19", movies: [{ title: "The Odyssey", sessions: [{ time: "11:00" }] }] },
    ],
  }],
};

test("findNewDates only returns unseen theatre dates", () => {
  const state = { seenDates: { "7408": ["2026-09-18"] } };
  assert.deepEqual(findNewDates(data, state).map(item => item.day.date), ["2026-09-19"]);
});

test("collectTheatreDates creates persistent state", () => {
  assert.deepEqual(collectTheatreDates(data), { "7408": ["2026-09-18", "2026-09-19"] });
});

test("mergeSeenDates never forgets dates missing from a partial scrape", () => {
  const state = { seenDates: { "7408": ["2026-09-17", "2026-09-18"] } };
  assert.deepEqual(mergeSeenDates(state, data), { "7408": ["2026-09-17", "2026-09-18", "2026-09-19"] });
});

test("email includes the useful booking details", () => {
  const notifications = findNewDates(data, { seenDates: { "7408": ["2026-09-18"] } });
  const message = emailHtml(notifications);
  assert.match(message, /Vaughan/);
  assert.match(message, /2026-09-19/);
  assert.match(message, /The Odyssey/);
  assert.match(message, /11:00/);
  assert.match(message, /cinewatch/);
});

test("multiple new dates are combined into one email", () => {
  const notifications = findNewDates(data, { seenDates: {} });
  const message = emailHtml(notifications);
  assert.match(emailSubject(notifications), /2 个 IMAX 70mm 新日期/);
  assert.match(message, /2026-09-18/);
  assert.match(message, /2026-09-19/);
});
