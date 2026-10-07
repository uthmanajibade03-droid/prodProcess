// prodProcess PC agent: watches the relay for new jobs from the phone, downloads the
// footage at full quality, runs a Claude edit on it, and sends the result back.
//
// Run: node agent/agent.mjs        (config in agent/config.json — see config.example.json)

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8").replace(/^﻿/, "")); // Notepad/PowerShell may add a BOM
const SERVER = cfg.server.replace(/\/$/, "");
const JOBS_DIR = cfg.jobsDir || join(HERE, "..", "jobs");
const POLL_MS = (cfg.pollSeconds || 15) * 1000;
const CLAUDE = cfg.claudeCommand || "claude";
const PART = 50 * 1024 * 1024; // same part size as the phone app
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v"]);

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

async function api(path, opts = {}) {
  const res = await fetch(SERVER + path, {
    ...opts,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      ...(typeof opts.body === "string" ? { "content-type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${res.status} ${await res.text().catch(() => "")}`);
  return res;
}
const getJson = async (path) => (await api(path)).json();
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
const setStatus = (id, status, message = "") => post(`/api/jobs/${id}/status`, { status, message });

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "job";
}

async function download(jobId, file, dest) {
  if (existsSync(dest) && (await stat(dest)).size === file.size) return; // already have it
  const res = await api(`/api/jobs/${jobId}/files/${file.id}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const got = (await stat(dest)).size;
  if (got !== file.size) throw new Error(`${file.name}: got ${got} bytes, expected ${file.size}`);
}

async function upload(jobId, path, name) {
  const { size } = await stat(path);
  const type = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".txt": "text/plain", ".md": "text/plain" }[extname(name).toLowerCase()] || "application/octet-stream";
  const meta = await post(`/api/jobs/${jobId}/files`, { name, size, type, role: "output" });
  const fh = await open(path, "r");
  const parts = [];
  try {
    const count = Math.max(1, Math.ceil(size / PART));
    for (let n = 1; n <= count; n++) {
      const len = Math.min(PART, size - (n - 1) * PART);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, (n - 1) * PART);
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await api(`/api/jobs/${jobId}/files/${meta.id}/parts/${n}`, { method: "PUT", body: buf });
          parts.push(await res.json());
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
    }
  } finally {
    await fh.close();
  }
  await post(`/api/jobs/${jobId}/files/${meta.id}/complete`, { parts });
}

// Turn one tool call from Claude into a short plain-English line for the live feed.
function describeTool(name, input = {}) {
  const file = (p) => String(p || "").split(/[\\/]/).pop();
  switch (name) {
    case "Bash": return input.description || String(input.command || "").split("\n")[0].slice(0, 120);
    case "Skill": return `Using the ${input.skill || input.name || ""} skill`;
    case "Read": return `Reading ${file(input.file_path)}`;
    case "Write": return `Writing ${file(input.file_path)}`;
    case "Edit": return `Editing ${file(input.file_path)}`;
    case "Glob": case "Grep": return "Looking through the files";
    case "TodoWrite": {
      const doing = (input.todos || []).find((t) => t.status === "in_progress");
      return doing ? `Plan: ${doing.activeForm || doing.content}` : "Updating the plan";
    }
    default: return name;
  }
}

// Runs Claude in the job folder. Steps stream into the live feed (onStep) and claude.log.
function runClaude(cwd, prompt, logPath, onTick, onStep) {
  return new Promise((resolve) => {
    const out = createWriteStream(logPath, { flags: "a" });
    out.write(`\n===== ${new Date().toISOString()} =====\n`);
    const child = spawn(
      CLAUDE,
      ["-p", "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep,Skill,TodoWrite", "--output-format", "stream-json", "--verbose"],
      { cwd, windowsHide: true },
    );
    child.stdin.end(prompt);
    let buf = "";
    let result = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { out.write(line + "\n"); continue; }
        if (ev.type === "assistant") {
          for (const c of ev.message?.content || []) {
            if (c.type === "text" && c.text.trim()) { onStep("say", c.text.trim()); out.write(`\n${c.text.trim()}\n`); }
            if (c.type === "tool_use") { const x = describeTool(c.name, c.input); onStep("do", x); out.write(`  > ${x}\n`); }
          }
        } else if (ev.type === "result") {
          result = ev.result || "";
          out.write(`\n----- result -----\n${result}\n`);
        }
      }
    });
    child.stderr.pipe(out, { end: false });
    const started = Date.now();
    const tick = setInterval(() => onTick(Math.round((Date.now() - started) / 60000)), 60000);
    child.on("error", (err) => out.write(`\nspawn error: ${err.message}\n`));
    child.on("close", (code) => {
      clearInterval(tick);
      out.end(`\n===== exit ${code} =====\n`);
      resolve({ code, result });
    });
  });
}

// Batches live-feed lines and sends them every few seconds, in order.
function liveFeed(jobId) {
  let pending = [];
  let first = true;
  let chain = Promise.resolve();
  const flush = () => {
    if (!pending.length && !first) return chain;
    const entries = pending;
    const newRun = first;
    pending = [];
    first = false;
    chain = chain.then(() => post(`/api/jobs/${jobId}/activity`, { entries, newRun }).catch((e) => log("feed:", e.message)));
    return chain;
  };
  const timer = setInterval(flush, 3000);
  return {
    add: (k, x) => pending.push({ k, x, t: Date.now() }),
    close: async () => { clearInterval(timer); await flush(); },
  };
}

function editPrompt(job) {
  return `You are editing a video job sent from Uthman's phone. Nobody is watching this run, so do not ask questions — make sensible choices and finish.

- The request is in NOTE.md. The raw footage, voice memos and photos are in ./in.
- If one of your video-editing skills fits the request (for example editor-vlog, editor-tayst, editor-arabiccompanion), use it. Otherwise edit with ffmpeg.
- Work only inside this folder. Never delete or modify anything in ./in.
- Put the finished video in ./out as an .mp4 (H.264 + AAC, so it plays on an iPhone). Keep the source resolution unless the note says otherwise.
- Last, write ./out/NOTES.txt: 3–6 short plain lines on what you made and any choices you had to guess. That text is shown on the phone.

Job: "${job.title}"`;
}

async function processJob(job) {
  const full = await getJson(`/api/jobs/${job.id}`);
  const inputs = full.files.filter((f) => f.role === "input" && f.done);
  const day = new Date(job.created).toISOString().slice(0, 10);
  const dir = join(JOBS_DIR, `${day}_${slug(job.title)}_${job.id.slice(-4)}`);
  const inDir = join(dir, "in");
  const outDir = join(dir, "out");
  await mkdir(inDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  log(`job "${job.title}" -> ${dir}`);

  await setStatus(job.id, "downloading", `${inputs.length} files`);
  const seen = new Map();
  for (const [i, f] of inputs.entries()) {
    // Two clips can share a name (IMG_0001.MOV from different days); keep both.
    let name = f.name;
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n > 1) name = name.replace(/(\.[^.]*)?$/, `_${n}$1`);
    await setStatus(job.id, "downloading", `File ${i + 1} of ${inputs.length}: ${f.name}`);
    await download(job.id, f, join(inDir, name));
  }

  await writeFile(
    join(dir, "NOTE.md"),
    `# ${job.title}\n\n${job.note || "(no note — make a clean, well-paced edit of the footage)"}\n\n## Files\n${inputs.map((f) => `- ${f.name} (${(f.size / 1048576).toFixed(1)} MB)`).join("\n")}\n`,
  );

  await setStatus(job.id, "editing", "Started");
  const feed = liveFeed(job.id);
  feed.add("sys", `Footage on the PC (${inputs.length} files). Starting Claude.`);
  const { code } = await runClaude(
    dir,
    editPrompt(job),
    join(dir, "claude.log"),
    (min) => setStatus(job.id, "editing", `${min} min in`).catch(() => {}),
    feed.add,
  );
  feed.add("sys", code === 0 ? "Claude finished." : `Claude stopped (exit ${code}).`);
  await feed.close();

  const outFiles = (await readdir(outDir)).filter((n) => VIDEO_EXT.has(extname(n).toLowerCase()));
  if (!outFiles.length) {
    throw new Error(`Claude finished (exit ${code}) but no video in out/. See claude.log in ${dir}`);
  }

  await setStatus(job.id, "sending", `${outFiles.length} video${outFiles.length > 1 ? "s" : ""}`);
  for (const name of outFiles) await upload(job.id, join(outDir, name), name);
  const notes = existsSync(join(outDir, "NOTES.txt")) ? (await readFile(join(outDir, "NOTES.txt"), "utf8")).trim() : "";
  await setStatus(job.id, "done", notes || "Edit finished.");
  log(`job "${job.title}" done`);
}

async function main() {
  log(`prodProcess agent — ${SERVER} — jobs in ${JOBS_DIR}`);
  await mkdir(JOBS_DIR, { recursive: true });

  // Anything left mid-way by a previous run (PC restarted, agent closed) goes back in the queue.
  try {
    const { jobs } = await getJson("/api/jobs?status=downloading,editing,sending");
    for (const j of jobs) {
      log(`requeue interrupted job "${j.title}"`);
      await setStatus(j.id, "ready", "Restarted after the PC agent stopped");
    }
  } catch (e) {
    log("startup check failed:", e.message);
  }

  for (;;) {
    try {
      const { jobs } = await getJson("/api/jobs?status=ready");
      const next = jobs.sort((a, b) => a.created - b.created)[0];
      if (next) {
        try {
          await processJob(next);
        } catch (e) {
          log(`job "${next.title}" failed:`, e.message);
          await setStatus(next.id, "failed", e.message).catch(() => {});
        }
        continue;
      }
    } catch (e) {
      log("poll error:", e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
