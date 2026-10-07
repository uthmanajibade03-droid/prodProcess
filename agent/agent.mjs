// prodProcess PC agent: watches the relay for new jobs from the phone, downloads the
// footage at full quality, runs a Claude edit on it, and sends the result back.
//
// Run: node agent/agent.mjs        (config in agent/config.json — see config.example.json)

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, statfs, writeFile } from "node:fs/promises";
import { join, dirname, extname, basename, relative, sep } from "node:path";
import { homedir } from "node:os";
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

async function upload(jobId, path, name, role = "output") {
  const { size } = await stat(path);
  const type = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".txt": "text/plain", ".md": "text/plain", ".jpg": "image/jpeg" }[extname(name).toLowerCase()] || "application/octet-stream";
  const meta = await post(`/api/jobs/${jobId}/files`, { name, size, type, role });
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
  return meta;
}

// "See what Claude sees": any image Claude writes in the job folder during a run
// (frames it grabs to check its work) gets shrunk and posted into the live feed.
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_FRAMES_PER_RUN = 80;

function watchFrames(dir, jobId, feed, since) {
  const sizes = new Map(); // path -> size last scan (wait for it to stop growing)
  const sent = new Set();
  let busy = false;
  let count = 0;
  const thumbDir = join(dir, ".thumbs");

  const scan = async () => {
    if (busy || count >= MAX_FRAMES_PER_RUN) return;
    busy = true;
    try {
      const all = await readdir(dir, { recursive: true });
      for (const rel of all) {
        if (count >= MAX_FRAMES_PER_RUN) break;
        if (rel.startsWith("in" + sep) || rel.startsWith(".thumbs")) continue;
        if (!IMAGE_EXT.has(extname(rel).toLowerCase())) continue;
        const path = join(dir, rel);
        if (sent.has(path)) continue;
        const st = await stat(path).catch(() => null);
        if (!st || st.mtimeMs < since || st.size === 0) continue;
        if (sizes.get(path) !== st.size) { sizes.set(path, st.size); continue; } // still being written
        sent.add(path);
        await mkdir(thumbDir, { recursive: true });
        const thumb = join(thumbDir, `${count}_${basename(rel, extname(rel))}.jpg`);
        const ok = await new Promise((res) => {
          const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", path,
            "-vf", "scale='min(720,iw)':-2", "-q:v", "5", "-frames:v", "1", thumb], { windowsHide: true });
          ff.on("error", () => res(false));
          ff.on("close", (c) => res(c === 0));
        });
        if (!ok) continue;
        const meta = await upload(jobId, thumb, basename(rel), "frame");
        feed.add("img", `${meta.id}|${relative(dir, path).split(sep).join("/")}`);
        count++;
      }
    } catch (e) {
      log("frames:", e.message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(scan, 3000);
  return {
    stop: async () => {
      clearInterval(timer);
      while (busy) await new Promise((r) => setTimeout(r, 200));
      await scan(); // pick up anything written in the last seconds
      await scan();
    },
  };
}

// Claude Code keeps conversations per folder; reuse it for revisions so Claude remembers the first edit.
function hasClaudeSession(dir) {
  const folder = join(homedir(), ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
  try {
    return readdirSync(folder).some((n) => n.endsWith(".jsonl"));
  } catch {
    return false;
  }
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
function runClaude(cwd, prompt, logPath, onTick, onStep, extraArgs = []) {
  return new Promise((resolve) => {
    const out = createWriteStream(logPath, { flags: "a" });
    out.write(`\n===== ${new Date().toISOString()} ${extraArgs.join(" ")} =====\n`);
    const child = spawn(
      CLAUDE,
      [...extraArgs, "-p", "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep,Skill,TodoWrite", "--output-format", "stream-json", "--verbose"],
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
function liveFeed(jobId, runLabel) {
  let pending = [];
  let first = true;
  let chain = Promise.resolve();
  const flush = () => {
    if (!pending.length && !first) return chain;
    const entries = pending;
    const newRun = first;
    pending = [];
    first = false;
    chain = chain.then(() => post(`/api/jobs/${jobId}/activity`, { entries, newRun, runLabel }).catch((e) => log("feed:", e.message)));
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
- Whenever you grab still frames to check your work, save them as .jpg in ./frames (e.g. ffmpeg -ss 12 -i out/x.mp4 -frames:v 1 frames/12s-title.jpg). They appear live on Uthman's phone, so he sees what you see. Name them so the name says what you were checking.
- Last, write ./out/NOTES.txt: 3–6 short plain lines on what you made and any choices you had to guess. That text is shown on the phone.

Job: "${job.title}"`;
}

const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

function revisionMarkdown(rev, round) {
  return `# Changes for round ${round}\n\nWatched: ${rev.video || "the latest video in ./out"}\n\n` +
    (rev.notes.length ? `## At specific moments\n${rev.notes.map((n) => `- **${clock(n.t)}** — ${n.text}`).join("\n")}\n\n` : "") +
    (rev.general ? `## Overall\n${rev.general}\n` : "");
}

function revisionPrompt(job, round, file, previous) {
  return `Revision round ${round} of a video already edited in this folder. Nobody is watching this run, so do not ask questions — make sensible choices and finish.

- Uthman watched ${previous || "the latest video in ./out"} and wants changes. They are in ${file}. Timestamps (m:ss) refer to that video.
- The original request is still in NOTE.md and the raw footage in ./in. Reuse your earlier work and scripts in this folder where it helps.
- Save the new version as a NEW file in ./out ending in _v${round}.mp4 (H.264 + AAC). Do not delete or overwrite earlier versions. Never touch ./in.
- Save any frames you grab to check the changes as .jpg in ./frames — they show live on his phone.
- Last, rewrite ./out/NOTES.txt: 3–6 short plain lines on what you changed this round, one per note he left.

Job: "${job.title}"`;
}

// Footage still to download, plus room for Claude's working files and the export
// (about the size of the footage again). Fails early with a plain message instead of mid-edit.
async function checkSpace(inputs, inDir) {
  let missing = 0;
  for (const f of inputs) {
    const p = join(inDir, f.name);
    if (!(existsSync(p) && (await stat(p)).size === f.size)) missing += f.size;
  }
  const total = inputs.reduce((a, f) => a + f.size, 0);
  const need = missing + total + 2 * 1024 ** 3;
  const fs = await statfs(JOBS_DIR);
  const free = fs.bavail * fs.bsize;
  if (free < need) {
    const gb = (n) => (n / 1024 ** 3).toFixed(1);
    throw new Error(`Not enough space on the PC drive for this job (${JOBS_DIR}): needs about ${gb(need)} GB, ${gb(free)} GB free. Free some space, then tap Try again.`);
  }
}

function jobDir(job) {
  const day = new Date(job.created).toISOString().slice(0, 10);
  return join(JOBS_DIR, `${day}_${slug(job.title)}_${job.id.slice(-4)}`);
}

// Local file name for each input. Two clips can share a name (IMG_0001.MOV from
// different days); keep both. Order is by upload time, so names stay stable.
function localNames(inputs) {
  const seen = new Map();
  return inputs.map((f) => {
    const n = (seen.get(f.name) || 0) + 1;
    seen.set(f.name, n);
    return n > 1 ? f.name.replace(/(\.[^.]*)?$/, `_${n}$1`) : f.name;
  });
}

// While the phone is still sending, pull down every clip that has fully arrived,
// so by the time the last one lands the PC is nearly ready to edit.
async function prefetch() {
  const { jobs } = await getJson("/api/jobs?status=uploading");
  for (const job of jobs.sort((a, b) => a.created - b.created)) {
    const full = await getJson(`/api/jobs/${job.id}`);
    const inputs = full.files.filter((f) => f.role === "input");
    const names = localNames(inputs);
    const inDir = join(jobDir(job), "in");
    for (const [i, f] of inputs.entries()) {
      if (!f.done) continue;
      const dest = join(inDir, names[i]);
      if (existsSync(dest) && (await stat(dest)).size === f.size) continue;
      await mkdir(inDir, { recursive: true });
      log(`prefetch "${job.title}": ${f.name} (${(f.size / 1048576).toFixed(0)} MB)`);
      await download(job.id, f, dest);
      return true; // one file per pass, then re-check for jobs that became ready
    }
  }
  return false;
}

async function processJob(job) {
  const full = await getJson(`/api/jobs/${job.id}`);
  // Keep every input (done or not) in the naming so names match what prefetch used.
  const allInputs = full.files.filter((f) => f.role === "input");
  const names = localNames(allInputs);
  const inputs = allInputs.filter((f) => f.done);
  const dir = jobDir(job);
  const inDir = join(dir, "in");
  const outDir = join(dir, "out");
  await mkdir(inDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  log(`job "${job.title}" -> ${dir}`);

  await checkSpace(inputs, inDir);
  await setStatus(job.id, "downloading", `${inputs.length} files`);
  for (const [i, f] of allInputs.entries()) {
    if (!f.done) continue;
    await setStatus(job.id, "downloading", `File ${i + 1} of ${allInputs.length}: ${f.name}`);
    await download(job.id, f, join(inDir, names[i])); // skips files prefetch already pulled
  }

  await writeFile(
    join(dir, "NOTE.md"),
    `# ${job.title}\n\n${job.note || "(no note — make a clean, well-paced edit of the footage)"}\n\n## Files\n${inputs.map((f) => `- ${f.name} (${(f.size / 1048576).toFixed(1)} MB)`).join("\n")}\n`,
  );

  // A job with change requests is a revision: Claude continues its earlier session on the latest round.
  const rev = (full.revisions || []).at(-1);
  const round = rev ? rev.n + 1 : 1;
  let prompt = editPrompt(job);
  let extraArgs = [];
  if (rev) {
    const file = `REVISION-${round}.md`;
    await writeFile(join(dir, file), revisionMarkdown(rev, round));
    prompt = revisionPrompt(job, round, file, rev.video);
    if (hasClaudeSession(dir)) extraArgs = ["--continue"];
  }

  const videosNow = async () => {
    const m = new Map();
    for (const n of await readdir(outDir)) {
      if (VIDEO_EXT.has(extname(n).toLowerCase())) m.set(n, (await stat(join(outDir, n))).mtimeMs);
    }
    return m;
  };
  const before = await videosNow();
  const runStart = Date.now();

  await setStatus(job.id, "editing", rev ? `Round ${round}: making your changes` : "Started");
  const feed = liveFeed(job.id, rev ? `Round ${round} — your changes` : "Edit");
  feed.add("sys", rev
    ? `Round ${round}: ${rev.notes.length} timed note${rev.notes.length === 1 ? "" : "s"}${rev.general ? " + overall note" : ""}. ${extraArgs.length ? "Claude picks up where it left off." : "Starting Claude."}`
    : `Footage on the PC (${inputs.length} files). Starting Claude.`);
  const frames = watchFrames(dir, job.id, feed, runStart);
  const { code } = await runClaude(
    dir,
    prompt,
    join(dir, "claude.log"),
    (min) => setStatus(job.id, "editing", `${rev ? `Round ${round} · ` : ""}${min} min in`).catch(() => {}),
    feed.add,
    extraArgs,
  );
  await frames.stop();
  feed.add("sys", code === 0 ? "Claude finished." : `Claude stopped (exit ${code}).`);
  await feed.close();

  // Only send back videos that are new or changed in this run.
  const after = await videosNow();
  const outFiles = [...after].filter(([n, t]) => !before.has(n) || t > before.get(n)).map(([n]) => n);
  if (!outFiles.length) {
    throw new Error(`Claude finished (exit ${code}) but made no new video in out/. See claude.log in ${dir}`);
  }

  await setStatus(job.id, "sending", `${outFiles.length} video${outFiles.length > 1 ? "s" : ""}`);
  for (const name of outFiles) await upload(job.id, join(outDir, name), name);
  const notes = existsSync(join(outDir, "NOTES.txt")) ? (await readFile(join(outDir, "NOTES.txt"), "utf8")).trim() : "";
  await setStatus(job.id, "done", notes || "Edit finished.");
  log(`job "${job.title}" done`);
}

async function main() {
  log(`prodProcess agent — ${SERVER} — jobs in ${JOBS_DIR}`);
  // The jobs folder can live on an external drive (the T7); wait for it rather than crash.
  for (;;) {
    try { await mkdir(JOBS_DIR, { recursive: true }); break; } catch (e) {
      log(`can't reach ${JOBS_DIR} (${e.code}) — is the drive plugged in? retrying in 30s`);
      await new Promise((r) => setTimeout(r, 30000));
    }
  }

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
      if (await prefetch()) continue;
    } catch (e) {
      log("poll error:", e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
