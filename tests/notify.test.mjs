import test from "node:test";
import assert from "node:assert/strict";
import {
  collectRearSeatSnapshots,
  collectTheatreDates,
  emailHtml,
  emailSubject,
  findNewDates,
  findRearSeatAlerts,
  mergeSeenDates,
} from "../scripts/notify.mjs";

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

function seatData(rows) {
  return {
    theatres: [{
      id: 7408,
      shortName: "Vaughan",
      auditoriums: { s1: { totalColumns: 4, rowLabels: ["A", "B", "C", "D"], seatTypes: ["SSSS", "SSSS", "SSSS", "SSSS"] } },
      days: [{
        date: "2026-09-25",
        movies: [{ title: "The Odyssey", sessions: [{ id: "s1", time: "19:00", layoutKey: "s1", seats: rows }] }],
      }],
    }],
  };
}

test("detects a newly refunded adjacent pair only in the rear half", () => {
  const previous = seatData(["OOOO", "OOOO", "OOOO", "OOOO"]);
  const current = seatData(["OAAO", "OOOO", "OAAO", "OOOO"]);
  const state = { seatSnapshots: collectRearSeatSnapshots(previous) };
  const alerts = findRearSeatAlerts(current, state);
  assert.equal(alerts.length, 1);
  assert.deepEqual(
    { row: alerts[0].row, start: alerts[0].startColumn, end: alerts[0].endColumn, count: alerts[0].seatCount },
    { row: "C", start: 2, end: 3, count: 2 },
  );
});

test("does not repeat an adjacent pair that was already available", () => {
  const previous = seatData(["OOOO", "OOOO", "OAAO", "OOOO"]);
  const current = seatData(["OOOO", "OOOO", "OAAO", "OOOO"]);
  const state = { seatSnapshots: collectRearSeatSnapshots(previous) };
  assert.deepEqual(findRearSeatAlerts(current, state), []);
});

test("seat alert email includes showtime and rear row", () => {
  const previous = seatData(["OOOO", "OOOO", "OOOO", "OOOO"]);
  const current = seatData(["OOOO", "OOOO", "OAAO", "OOOO"]);
  const alerts = findRearSeatAlerts(current, { seatSnapshots: collectRearSeatSnapshots(previous) });
  assert.match(emailSubject([], alerts), /后区退票/);
  assert.match(emailHtml([], alerts), /C 排/);
  assert.match(emailHtml([], alerts), /19:00/);
});
