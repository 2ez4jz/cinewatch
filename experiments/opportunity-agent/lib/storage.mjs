import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyState } from "./core.mjs";

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}

export async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

// All mutable outputs must stay in this ignored experiment directory. No access
// to production data paths, repository secrets, network mail or active workflows.
export async function withWorkspace(callback, directory = fileURLToPath(new URL("../.local/", import.meta.url))) {
  const allowed = fileURLToPath(new URL("../.local/", import.meta.url));
  const path = resolve(directory), rel = relative(resolve(allowed), path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Workspace must be inside experiments/opportunity-agent/.local");
  await mkdir(path, { recursive: true });
  const lockPath = join(path, "scan.lock");
  const lock = await open(lockPath, "wx");
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const statePath = join(path, "state.json");
    const state = await readJson(statePath, emptyState());
    return await callback({ path, state, save: next => atomicJson(statePath, next) });
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

export function fileSink(workspace) {
  return async event => {
    const directory = join(workspace, "notifications");
    await mkdir(directory, { recursive: true });
    const subject = Buffer.from(event.message.subject).toString("base64");
    const contentType = event.message.html ? "text/html" : "text/plain";
    const eml = [`X-Opportunity-Event-ID: ${event.id}`, `Subject: =?UTF-8?B?${subject}?=`,
      "MIME-Version: 1.0", `Content-Type: ${contentType}; charset=UTF-8`, "Content-Transfer-Encoding: 8bit", "",
      event.message.html || event.message.text].join("\r\n");
    // Same ID always addresses the same files, including a crash after write
    // but before the state receipt is committed. No external email is sent.
    await writeFile(join(directory, `${event.id}.eml`), eml, { mode: 0o600 });
    await atomicJson(join(directory, `${event.id}.json`), event);
  };
}
