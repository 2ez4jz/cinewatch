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

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function dateLabel(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/Toronto", month: "long", day: "numeric", weekday: "long",
  }).format(new Date(`${date}T12:00:00-04:00`));
}

export function emailSubject(notifications) {
  if (notifications.length === 1) {
    const { theatre, day } = notifications[0];
    return `CineWatch 新日期：${theatre.shortName || theatre.name} ${day.date}`;
  }
  return `CineWatch 发现 ${notifications.length} 个 IMAX 70mm 新日期`;
}

export function emailHtml(notifications) {
  const cards = [...notifications]
    .sort((a, b) => a.day.date.localeCompare(b.day.date) || String(a.theatre.id).localeCompare(String(b.theatre.id)))
    .map(({ theatre, day }) => {
      const movies = (day.movies || []).map(movie => {
        const sessions = (movie.sessions || []).map(session => escapeHtml(session.time)).join("、");
        return `<p style="margin:12px 0 0"><strong>${escapeHtml(movie.title)}</strong><br><span style="color:#555">${sessions}</span></p>`;
      }).join("");
      return `<div style="margin:0 0 16px;padding:18px;border:1px solid #ddd;border-radius:8px"><div style="font-size:18px;font-weight:700">${escapeHtml(theatre.shortName || theatre.name)}</div><div style="margin-top:4px;color:#b51f24">${escapeHtml(dateLabel(day.date))} · ${escapeHtml(day.date)}</div>${movies}</div>`;
    }).join("");
  return `<!doctype html><html><body style="margin:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#161616"><div style="max-width:620px;margin:auto;padding:28px 16px"><h1 style="margin:0 0 8px;font-size:24px">发现新的 IMAX 70mm 日期</h1><p style="margin:0 0 22px;color:#666">Cineplex 已开放以下日期。座位数据会继续自动刷新。</p>${cards}<a href="${SITE_URL}" style="display:block;padding:14px 18px;background:#d8232a;color:white;text-align:center;text-decoration:none;border-radius:6px;font-weight:700">查看座位与购票</a><p style="margin:20px 0 0;color:#888;font-size:12px">同一影院同一天只提醒一次 · CineWatch</p></div></body></html>`;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function sendGmail(notifications, username, appPassword, recipient) {
  const subject = Buffer.from(emailSubject(notifications)).toString("base64");
  const message = [
    `From: CineWatch <${username}>`, `To: ${recipient}`, `Subject: =?UTF-8?B?${subject}?=`,
    "MIME-Version: 1.0", 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "",
    emailHtml(notifications),
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
    await writeFile(STATE_PATH, `${JSON.stringify({ version: 2, seenDates: collectTheatreDates(data) }, null, 2)}\n`);
    console.log("Notification state initialized; no historical dates announced.");
    return;
  }
  const notifications = findNewDates(data, state);
  if (!notifications.length) {
    console.log("No new IMAX 70mm dates.");
    return;
  }
  const recipient = process.env.EMAIL_TO?.trim() || DEFAULT_EMAIL_TO;
  const username = process.env.GMAIL_USERNAME?.trim() || DEFAULT_EMAIL_TO;
  const appPassword = process.env.GMAIL_APP_PASSWORD?.replaceAll(" ", "").trim();
  if (!appPassword) {
    console.warn(`Found ${notifications.length} new date(s), but GMAIL_APP_PASSWORD is not configured; will retry next run.`);
    return;
  }
  await sendGmail(notifications, username, appPassword, recipient);
  console.log(`Emailed ${notifications.length} new theatre-date(s) to ${recipient}.`);
  await writeFile(STATE_PATH, `${JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), seenDates: mergeSeenDates(state, data) }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
