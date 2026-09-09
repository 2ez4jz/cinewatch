import test from "node:test";
import assert from "node:assert/strict";
import { compactAvailability, compactLayout, extractMovies, isImax70mm } from "../scripts/scrape.mjs";

test("requires both IMAX and 70mm tags", () => {
  assert.equal(isImax70mm(["IMAX", "70mm"]), true);
  assert.equal(isImax70mm(["IMAX"]), false);
  assert.equal(isImax70mm(["UltraAVX", "70mm"]), false);
});

test("keeps only target sessions", () => {
  const payload = [{ theatreId: 7408, dates: [{ startDate: "2026-09-19", movies: [{ name: "The Odyssey", experiences: [
    { experienceTypes: ["IMAX", "70mm"], sessions: [{ vistaSessionId: "A1", showStartDateTime: "2026-09-19T15:00:00", isReservedSeating: true }] },
    { experienceTypes: ["IMAX"], sessions: [{ vistaSessionId: "B1", showStartDateTime: "2026-09-19T18:00:00" }] }
  ] }] }] }];
  const movies = extractMovies(payload, 7408, "2026-09-19");
  assert.equal(movies.length, 1);
  assert.equal(movies[0].sessions.length, 1);
  assert.equal(movies[0].sessions[0].id, "A1");
});

test("compacts layout and availability", () => {
  const layout = { totalColumns: 4, standardSeats: { rows: [{ number: 0, label: "A", seats: [
    { id: "a1", column: 0, type: "Standard" }, { id: "a3", column: 2, type: "Wheelchair" }
  ] }] } };
  assert.deepEqual(compactLayout(layout), { totalRows: 1, totalColumns: 4, rowLabels: ["A"], seatTypes: ["S.W."] });
  assert.deepEqual(compactAvailability(layout, { a1: "Available", a3: "Occupied" }), ["A.O."]);
});
