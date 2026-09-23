import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_PATH = new URL("../data/showtimes.json", import.meta.url);
const STATE_PATH = new URL("../data/notification-state.json", import.meta.url);
const SITE_URL = "https://2ez4jz.github.io/cinewatch/";
const DEFAULT_EMAIL_TO = "museycyk@gmail.com";

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return fallback; }
}

export function collectTheatreDates(data) {
  const dates = {};
  for (const theatre of data.theatres || []) dates[String(theatre.id)] = (theatre.days || []).map(day => day.date);
  return dates;
}

export function mergeSeenDates(state, data) {
  const merged = {};
  const current = collectTheatreDates(data);
  for (const theatreId of new Set([...Object.keys(state?.seenDates || {}), ...Object.keys(current)])) {
    merged[theatreId] = [...new Set([...(state?.seenDates?.[theatreId] || []), ...(current[theatreId] || [])])].sort();
  }
  return merged;
}

export function findNewDates(data, state) {
  const seen = state?.seenDates || {};
  const notifications = [];
  for (const theatre of data.theatres || []) {
    const known = new Set(seen[String(theatre.id)] || []);
    for (const day of theatre.days || []) if (!known.has(day.date)) notifications.push({ theatre, day });
  }
  return notifications;
}

function sessionKey(theatre, session) {
  return `${theatre.id}:${session.id}`;
}

export function collectRearSeatSnapshots(data) {
  const snapshots = {};
  for (const theatre of data.theatres || []) {
    for (const day of theatre.days || []) {
      for (const movie of day.movies || []) {
        for (const session of movie.sessions || []) {
          const layout = theatre.auditoriums?.[session.layoutKey];
          if (!layout || !session.seats?.length) continue;
          const firstRearRow = Math.floor(session.seats.length / 2);
          const rows = {};
          for (let rowIndex = firstRearRow; rowIndex < session.seats.length; rowIndex++) {
            const label = layout.rowLabels?.[rowIndex] || String(rowIndex + 1);
            rows[label] = {
              status: session.seats[rowIndex],
              types: layout.seatTypes?.[rowIndex] || "",
            };
          }
          snapshots[sessionKey(theatre, session)] = { rows };
        }
      }
    }
  }
  return snapshots;
}

export function mergeSeatSnapshots(state, data) {
  return { ...(state?.seatSnapshots || {}), ...collectRearSeatSnapshots(data) };
}

function newRefundRuns(currentRow, previousRow) {
  const pairs = [];
  const length = Math.min(currentRow.status.length, previousRow.status.length);
  const canUse = index => currentRow.status[index] === "A" && !["W", "C"].includes(currentRow.types[index]);
  for (let index = 0; index < length - 1; index++) {
    if (!canUse(index) || !canUse(index + 1)) continue;
    const wasPair = previousRow.status[index] === "A" && previousRow.status[index + 1] === "A";
    const includesRefund = previousRow.status[index] === "O" || previousRow.status[index + 1] === "O";
    if (!wasPair && includesRefund) pairs.push({ start: index, end: index + 1 });
  }
  const runs = [];
  for (const pair of pairs) {
    const previous = runs.at(-1);
    if (previous && pair.start <= previous.end) previous.end = Math.max(previous.end, pair.end);
    else runs.push({ ...pair });
  }
  return runs;
}

export function findRearSeatAlerts(data, state) {
  if (!state?.seatSnapshots) return [];
  const current = collectRearSeatSnapshots(data);
  const alerts = [];
  for (const theatre of data.theatres || []) {
    for (const day of theatre.days || []) {
      for (const movie of day.movies || []) {
        for (const session of movie.sessions || []) {
          const key = sessionKey(theatre, session);
          const currentSession = current[key];
          const previousSession = state.seatSnapshots[key];
          if (!currentSession || !previousSession) continue;
          for (const [row, currentRow] of Object.entries(currentSession.rows)) {
            const previousRow = previousSession.rows?.[row];
            if (!previousRow) continue;
            for (const run of newRefundRuns(currentRow, previousRow)) {
              alerts.push({
                theatre, day, movie, session, row,
                startColumn: run.start + 1,
                endColumn: run.end + 1,
                seatCount: run.end - run.start + 1,
              });
            }
          }
        }
      }
    }
  }
  return alerts;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function dateLabel(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/Toronto", month: "long", day: "numeric", weekday: "long",
  }).format(new Date(`${date}T12:00:00-04:00`));
}

export function emailSubject(dateNotifications, seatAlerts = []) {
  if (seatAlerts.length && !dateNotifications.length) {
    const first = seatAlerts[0];
    return seatAlerts.length === 1
      ? `CineWatch 后区退票：${first.theatre.shortName || first.theatre.name} ${first.day.date} ${first.session.time}`
      : `CineWatch 发现 ${seatAlerts.length} 组后区连座退票`;
  }
  if (dateNotifications.length === 1 && !seatAlerts.length) {
    const { theatre, day } = dateNotifications[0];
    return `CineWatch 新日期：${theatre.shortName || theatre.name} ${day.date}`;
  }
  if (!seatAlerts.length) return `CineWatch 发现 ${dateNotifications.length} 个 IMAX 70mm 新日期`;
  return `CineWatch：${dateNotifications.length} 个新日期 · ${seatAlerts.length} 组后区连座`;
}

export function emailHtml(dateNotifications, seatAlerts = []) {
  const dateCards = [...dateNotifications]
    .sort((a, b) => a.day.date.localeCompare(b.day.date) || String(a.theatre.id).localeCompare(String(b.theatre.id)))
    .map(({ theatre, day }) => {
      const movies = (day.movies || []).map(movie => {
        const sessions = (movie.sessions || []).map(session => escapeHtml(session.time)).join("、");
        return `<p style="margin:12px 0 0"><strong>${escapeHtml(movie.title)}</strong><br><span style="color:#555">${sessions}</span></p>`;
      }).join("");
      return `<div style="margin:0 0 16px;padding:18px;border:1px solid #ddd;border-radius:8px"><div style="font-size:18px;font-weight:700">${escapeHtml(theatre.shortName || theatre.name)}</div><div style="margin-top:4px;color:#b51f24">${escapeHtml(dateLabel(day.date))} · ${escapeHtml(day.date)}</div>${movies}</div>`;
    }).join("");
  const seatCards = seatAlerts.map(alert =>
    `<div style="margin:0 0 16px;padding:18px;border:1px solid #ddd;border-radius:8px"><div style="font-size:18px;font-weight:700">${escapeHtml(alert.theatre.shortName || alert.theatre.name)} · ${escapeHtml(alert.movie.title)}</div><div style="margin-top:4px;color:#b51f24">${escapeHtml(dateLabel(alert.day.date))} · ${escapeHtml(alert.session.time)}</div><p style="margin:12px 0 0"><strong>后区 ${escapeHtml(alert.row)} 排出现 ${alert.seatCount} 个连座</strong><br><span style="color:#555">座位图第 ${alert.startColumn}–${alert.endColumn} 列</span></p></div>`
  ).join("");
  const dateSection = dateCards ? `<h2 style="margin:24px 0 12px;font-size:18px">新放映日期</h2>${dateCards}` : "";
  const seatSection = seatCards ? `<h2 style="margin:24px 0 12px;font-size:18px">后区退票连座</h2>${seatCards}` : "";
  return `<!doctype html><html><body style="margin:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#161616"><div style="max-width:620px;margin:auto;padding:28px 16px"><h1 style="margin:0 0 8px;font-size:24px">CineWatch 提醒</h1><p style="margin:0 0 8px;color:#666">发现新的 IMAX 70mm 日期或后区连座。</p>${dateSection}${seatSection}<a href="${SITE_URL}" style="display:block;padding:14px 18px;background:#d8232a;color:white;text-align:center;text-decoration:none;border-radius:6px;font-weight:700">立即查看座位与购票</a><p style="margin:20px 0 0;color:#888;font-size:12px">新日期只提醒一次；退票连座按座位状态变化提醒 · CineWatch</p></div></body></html>`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function sendGmail(dateNotifications, seatAlerts, username, appPassword, recipient) {
  const subject = Buffer.from(emailSubject(dateNotifications, seatAlerts)).toString("base64");
  const message = [
    `From: CineWatch <${username}>`, `To: ${recipient}`, `Subject: =?UTF-8?B?${subject}?=`,
    "MIME-Version: 1.0", 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "",
    emailHtml(dateNotifications, seatAlerts),
  ].join("\r\n");
  const directory = await mkdtemp(join(tmpdir(), "cinewatch-mail-"));
  const messagePath = join(directory, "message.eml");
  try {
    await writeFile(messagePath, message, { mode: 0o600 });
    await run("curl", [
      "--fail-with-body", "--silent", "--show-error", "--url", "smtps://smtp.gmail.com:465", "--ssl-reqd",
      "--mail-from", username, "--mail-rcpt", recipient, "--user", `${username}:${appPassword}`, "--upload-file", messagePath,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const data = await readJson(DATA_PATH, null);
  if (!data) throw new Error("No showtime data found");
  const state = await readJson(STATE_PATH, null);
  if (!state) {
    await writeFile(STATE_PATH, `${JSON.stringify({ version: 3, seenDates: collectTheatreDates(data), seatSnapshots: collectRearSeatSnapshots(data) }, null, 2)}\n`);
    console.log("Notification state initialized; no historical dates announced.");
    return;
  }
  const dateNotifications = findNewDates(data, state);
  const seatAlerts = findRearSeatAlerts(data, state);
  const nextState = {
    version: 3,
    updatedAt: new Date().toISOString(),
    seenDates: mergeSeenDates(state, data),
    seatSnapshots: mergeSeatSnapshots(state, data),
  };
  if (!dateNotifications.length && !seatAlerts.length) {
    console.log("No new IMAX 70mm dates or rear-seat refunds.");
    await writeFile(STATE_PATH, `${JSON.stringify(nextState, null, 2)}\n`);
    return;
  }
  const recipient = process.env.EMAIL_TO?.trim() || DEFAULT_EMAIL_TO;
  const username = process.env.GMAIL_USERNAME?.trim() || DEFAULT_EMAIL_TO;
  const appPassword = process.env.GMAIL_APP_PASSWORD?.replaceAll(" ", "").trim();
  if (!appPassword) {
    console.warn(`Found ${dateNotifications.length} new date(s) and ${seatAlerts.length} rear-seat alert(s), but GMAIL_APP_PASSWORD is not configured; will retry next run.`);
    return;
  }
  await sendGmail(dateNotifications, seatAlerts, username, appPassword, recipient);
  console.log(`Emailed ${dateNotifications.length} new date(s) and ${seatAlerts.length} rear-seat alert(s) to ${recipient}.`);
  await writeFile(STATE_PATH, `${JSON.stringify(nextState, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
