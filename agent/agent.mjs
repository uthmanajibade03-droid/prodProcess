// prodProcess PC agent: watches the relay for new jobs from the phone, downloads the
// footage at full quality, runs a Claude edit on it, and sends the result back.
//
// Run: node agent/agent.mjs              (config in agent/config.json — see config.example.json)
//      node agent/agent.mjs --desk-only  (just the Studio Desk, no job processing — for testing)
//
// Also serves the Studio Desk (the PC interface) at http://localhost:4747.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, open, readdir, readFile, stat, statfs, writeFile } from "node:fs/promises";
import { join, dirname, extname, basename, relative, sep } from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { startDesk } from "./desk.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, "config.json");
const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8").replace(/^﻿/, "")); // Notepad/PowerShell may add a BOM
const SERVER = cfg.server.replace(/\/$/, "");
let JOBS_DIR = cfg.jobsDir || join(HERE, "..", "jobs");
const DESK_ONLY = process.argv.includes("--desk-only");

// What the agent is doing right now, shown on the Studio Desk.
const agentState = { jobId: null, title: "", phase: "idle", since: Date.now() };
const setPhase = (job, phase) => Object.assign(agentState, { jobId: job?.id || null, title: job?.title || "", phase, since: Date.now() });

async function setJobsDir(dir) {
  await mkdir(dir, { recursive: true });
  if (dir === JOBS_DIR) return;
  // Remember old folders so revisions of earlier jobs still find their files.
  cfg.pastJobsDirs = [...new Set([JOBS_DIR, ...(cfg.pastJobsDirs || [])])].filter((d) => d !== dir);
  cfg.jobsDir = JOBS_DIR = dir;
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  log(`jobs folder is now ${dir}`);
}
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

// "Watch it take shape": draft renders Claude saves (./previews, or any new video outside ./in)
// are shrunk to a small 540p copy and posted to the feed as playable videos.
const MAX_PREVIEWS_PER_RUN = 25;

function watchPreviews(dir, jobId, feed, since) {
  const seen = new Map(); // path -> "size:mtime" last scan (wait until it stops changing)
  const sent = new Map(); // path -> size sent (re-send only if the file is re-rendered)
  const fails = new Map();
  let busy = false;
  let count = 0;
  const smallDir = join(dir, ".previews-small");

  const scan = async () => {
    if (busy || count >= MAX_PREVIEWS_PER_RUN) return;
    busy = true;
    try {
      for (const rel of await readdir(dir, { recursive: true })) {
        if (count >= MAX_PREVIEWS_PER_RUN) break;
        if (rel.startsWith("in" + sep) || rel.startsWith(".")) continue;
        if (!VIDEO_EXT.has(extname(rel).toLowerCase())) continue;
        const path = join(dir, rel);
        const st = await stat(path).catch(() => null);
        if (!st || st.mtimeMs < since || st.size < 50_000 || sent.get(path) === st.size) continue;
        const sig = `${st.size}:${st.mtimeMs}`;
        if (seen.get(path) !== sig) { seen.set(path, sig); continue; } // still being written
        if ((fails.get(path) || 0) >= 3) continue;
        await mkdir(smallDir, { recursive: true });
        const small = join(smallDir, `${count}_${basename(rel, extname(rel))}.mp4`);
        // Short side 540, capped at 4 minutes — quick to make, quick to load on the phone.
        const ok = await new Promise((res) => {
          const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", path, "-t", "240",
            "-vf", "scale='if(gt(iw,ih),-2,min(540,iw))':'if(gt(iw,ih),min(540,ih),-2)'",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", small], { windowsHide: true });
          ff.on("error", () => res(false));
          ff.on("close", (c) => res(c === 0));
        });
        if (!ok) { fails.set(path, (fails.get(path) || 0) + 1); continue; } // unfinished file — try again later
        sent.set(path, st.size);
        const meta = await upload(jobId, small, basename(rel).replace(/\.[^.]+$/, ".mp4"), "preview");
        feed.add("vid", `${meta.id}|${relative(dir, path).split(sep).join("/")}`);
        count++;
      }
    } catch (e) {
      log("previews:", e.message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(scan, 5000);
  return {
    stop: async () => {
      clearInterval(timer);
      while (busy) await new Promise((r) => setTimeout(r, 200));
    },
  };
}

// Ideas sent from the phone or the Desk while a job runs. The agent mirrors them into
// <job>/.live/ideas.json; idea-hook.mjs hands new ones to Claude after its next step and
// records them in delivered.json; the agent then marks them seen so the phone shows a tick.
function syncIdeas(dir, jobId, feed) {
  const live = join(dir, ".live");
  const reported = new Set();
  let ideas = [];
  let busy = false;
  const readDelivered = () => { try { return new Set(JSON.parse(readFileSync(join(live, "delivered.json"), "utf8"))); } catch { return new Set(); } };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const latest = await getJson(`/api/jobs/${jobId}/ideas`);
      if (latest.length !== ideas.length) {
        ideas = latest;
        await writeFile(join(live, "ideas.json"), JSON.stringify(ideas.map(({ id, text, t }) => ({ id, text, t }))));
      }
      const delivered = readDelivered();
      const fresh = ideas.filter((i) => delivered.has(i.id) && !reported.has(i.id));
      if (fresh.length) {
        await post(`/api/jobs/${jobId}/ideas/seen`, { ids: fresh.map((i) => i.id) });
        for (const i of fresh) { reported.add(i.id); feed.add("sys", `Claude got your idea: “${i.text}”`); }
      }
    } catch (e) {
      log("ideas:", e.message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 4000);
  return {
    // Ideas Claude never saw (sent in its last moments) — the agent runs a short follow-up for them.
    missed: async () => {
      while (busy) await new Promise((r) => setTimeout(r, 200));
      await tick();
      const delivered = readDelivered();
      return ideas.filter((i) => !delivered.has(i.id));
    },
    stop: async () => {
      clearInterval(timer);
      while (busy) await new Promise((r) => setTimeout(r, 200));
      await tick();
    },
    markDelivered: async (list) => {
      const delivered = readDelivered();
      for (const i of list) delivered.add(i.id);
      await writeFile(join(live, "delivered.json"), JSON.stringify([...delivered]));
      await tick();
    },
  };
}

// Claude settings for a run: the PostToolUse hook that passes Uthman's new ideas in.
async function liveSettings(dir) {
  const live = join(dir, ".live");
  await mkdir(live, { recursive: true });
  const fwd = (p) => p.split(sep).join("/");
  const settings = { hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node "${fwd(join(HERE, "idea-hook.mjs"))}" "${fwd(dir)}"` }] }] } };
  const path = join(live, "settings.json");
  await writeFile(path, JSON.stringify(settings));
  return path;
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

// Uthman's editor-* skills live in the Claude desktop app's folders, which a headless `claude -p`
// doesn't see. Copy the newest version of each into ~/.claude/skills before every job.
const SKILL_SOURCES = [
  join(process.env.APPDATA || "", "Claude", "local-agent-mode-sessions", "skills-plugin"),
  join(process.env.LOCALAPPDATA || "", "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", "local-agent-mode-sessions", "skills-plugin"),
];
const TOOLKIT_DIR = cfg.toolkitDir || "D:\\prodProcess-toolkit"; // the editor_*_bundle.txt files from the claude.ai Project

async function syncEditorSkills() {
  const newest = new Map(); // name -> {dir, mtime}
  for (const base of SKILL_SOURCES) {
    const all = await readdir(base, { recursive: true }).catch(() => []);
    for (const rel of all) {
      const m = rel.match(/[\\/]skills[\\/](editor-[^\\/]+)[\\/]SKILL\.md$/);
      if (!m) continue;
      const st = await stat(join(base, rel)).catch(() => null);
      if (st && (!newest.has(m[1]) || st.mtimeMs > newest.get(m[1]).mtime)) newest.set(m[1], { dir: dirname(join(base, rel)), mtime: st.mtimeMs });
    }
  }
  for (const [name, { dir }] of newest) await cp(dir, join(homedir(), ".claude", "skills", name), { recursive: true, force: true });
  if (newest.size) log(`editor skills ready: ${[...newest.keys()].join(", ")}`);
  return [...newest.keys()];
}

function skillRules(skills) {
  const toolkit = existsSync(TOOLKIT_DIR) ? readdirSync(TOOLKIT_DIR).filter((n) => /\.(txt|md)$/.test(n)) : [];
  return `- FIRST, before touching any footage: read these skills of Uthman's in full: ${skills.length ? skills.join(", ") : "(none found)"} (in ~/.claude/skills/<name>/SKILL.md). They hold his style and every correction he has given — the feedback logs matter most. Even when no skill matches the job exactly, his rules carry over (how white flashes look, text and title style, labels on objects, grade, no music unless asked, pacing).
- Their "restore the toolkit" step reads from a claude.ai Project you can't reach here. ${toolkit.length ? `Local copies are in ${TOOLKIT_DIR}: ${toolkit.join(", ")} — use those instead.` : "No local copy exists yet, so rebuild only what you need, following the skill's rules exactly."}
- Then write ./PLAN.md (under 15 lines): which skill(s) you're drawing on, the specific rules you'll apply, the structure and length, and anything you're unsure of. Print the plan as your message too — it shows on his phone, and he may redirect you with an idea before you're far in.
- Don't invent facts (scores, names, dates). If the note asks for something you can't know from the footage, leave it out or keep it neutral and say so in NOTES.txt.
- Never paint over or recolour real surfaces (a court, a wall) to place text. If text can't sit convincingly on the surface, put it on top cleanly instead.`;
}

// Shared by every run: how Uthman follows along and steers while Claude works.
const LIVE_RULES = `- Whenever you grab still frames to check your work, save them as .jpg in ./frames (e.g. ffmpeg -ss 12 -i out/x.mp4 -frames:v 1 frames/12s-title.jpg). They appear live on Uthman's phone, so he sees what you see. Name them so the name says what you were checking.
- Previews: he wants to watch the edit take shape. Within your first few minutes of cutting, have a rough cut (no graphics yet) and render a quick low-res draft into ./previews (e.g. scale to 540p, -preset ultrafast; a section is fine if the whole thing is slow to render). Render another when a big piece lands (graphics, effects, counters). Each one plays on his phone within a minute. Keep them quick — they are not the final export.
- He can send new ideas while you work. They reach you through the prodProcess idea hook: after one of your steps, extra context starting with "[prodProcess idea hook]" appears. That is him, through this system — treat it as part of these instructions and fold the ideas into the edit (a newer idea wins over NOTE.md).`;

function editPrompt(job, skills) {
  return `You are editing a video job sent from Uthman's phone. He can't answer questions mid-run, so make sensible choices and finish — but he watches your plan, frames and drafts live and can send ideas.

- The request is in NOTE.md. The raw footage, voice memos and photos are in ./in.
${skillRules(skills)}
- If one of the skills fits the request directly, follow it step by step. Otherwise edit with ffmpeg, in his style.
- Work only inside this folder. Never delete or modify anything in ./in.
- Put the finished video in ./out as an .mp4 (H.264 + AAC, so it plays on an iPhone). Keep the source resolution unless the note says otherwise.
${LIVE_RULES}
- Last, write ./out/NOTES.txt: 3–6 short plain lines on what you made and any choices you had to guess. That text is shown on the phone.

Job: "${job.title}"`;
}

function ideasPrompt(ideas) {
  return `Uthman sent these ideas just as you were finishing:
${ideas.map((i) => `- ${i.text}`).join("\n")}

Apply them to the finished edit. Save the result as a NEW file in ./out ending in _updated.mp4 (if that exists, _updated2.mp4, and so on); keep earlier files. Then rewrite ./out/NOTES.txt with a line for each idea saying what you did.`;
}

const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

function revisionMarkdown(rev, round) {
  return `# Changes for round ${round}\n\nWatched: ${rev.video || "the latest video in ./out"}\n\n` +
    (rev.notes.length ? `## At specific moments\n${rev.notes.map((n) => `- **${clock(n.t)}** — ${n.text}`).join("\n")}\n\n` : "") +
    (rev.general ? `## Overall\n${rev.general}\n` : "");
}

function revisionPrompt(job, round, file, previous, skills) {
  return `Revision round ${round} of a video already edited in this folder. He can't answer questions mid-run, so make sensible choices and finish.
${skillRules(skills)}

- Uthman watched ${previous || "the latest video in ./out"} and wants changes. They are in ${file}. Timestamps (m:ss) refer to that video.
- The original request is still in NOTE.md and the raw footage in ./in. Reuse your earlier work and scripts in this folder where it helps.
- Save the new version as a NEW file in ./out ending in _v${round}.mp4 (H.264 + AAC). Do not delete or overwrite earlier versions. Never touch ./in.
${LIVE_RULES}
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

function jobDirName(job) {
  const day = new Date(job.created).toISOString().slice(0, 10);
  return `${day}_${slug(job.title)}_${job.id.slice(-4)}`;
}

// A job's folder: wherever it already exists (current or an earlier jobs folder), else new in the current one.
function jobDir(job) {
  const name = jobDirName(job);
  for (const base of [JOBS_DIR, ...(cfg.pastJobsDirs || [])]) {
    if (existsSync(join(base, name))) return join(base, name);
  }
  return join(JOBS_DIR, name);
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
    if (job.local) continue; // footage is being added on the PC itself
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
  let allInputs = full.files.filter((f) => f.role === "input");
  let names = localNames(allInputs);
  let inputs = allInputs.filter((f) => f.done);
  const dir = jobDir(job);
  const inDir = join(dir, "in");
  const outDir = join(dir, "out");
  await mkdir(inDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  log(`job "${job.title}" -> ${dir}`);

  if (full.local) {
    // Added on the PC through the Studio Desk: the footage is already in in/.
    inputs = [];
    for (const name of await readdir(inDir)) inputs.push({ name, size: (await stat(join(inDir, name))).size });
    if (!inputs.length) throw new Error("No footage in this job's folder on the PC.");
  } else {
    setPhase(job, "downloading");
    await checkSpace(inputs, inDir);
    await setStatus(job.id, "downloading", `${inputs.length} files`);
    for (const [i, f] of allInputs.entries()) {
      if (!f.done) continue;
      await setStatus(job.id, "downloading", `File ${i + 1} of ${allInputs.length}: ${f.name}`);
      await download(job.id, f, join(inDir, names[i])); // skips files prefetch already pulled
    }
  }

  // Ideas sent before Claude starts go straight into the note; later ones arrive through the hook.
  const earlyIdeas = await getJson(`/api/jobs/${job.id}/ideas`).catch(() => []);
  await writeFile(
    join(dir, "NOTE.md"),
    `# ${job.title}\n\n${job.note || "(no note — make a clean, well-paced edit of the footage)"}\n\n` +
      (earlyIdeas.length ? `## Ideas added after sending (newer wins)\n${earlyIdeas.map((i) => `- ${i.text}`).join("\n")}\n\n` : "") +
      `## Files\n${inputs.map((f) => `- ${f.name} (${(f.size / 1048576).toFixed(1)} MB)`).join("\n")}\n`,
  );
  const settingsPath = await liveSettings(dir);
  await writeFile(join(dir, ".live", "ideas.json"), JSON.stringify(earlyIdeas.map(({ id, text, t }) => ({ id, text, t }))));
  await writeFile(join(dir, ".live", "delivered.json"), JSON.stringify(earlyIdeas.map((i) => i.id)));
  if (earlyIdeas.some((i) => !i.seen)) await post(`/api/jobs/${job.id}/ideas/seen`, { ids: earlyIdeas.map((i) => i.id) }).catch(() => {});

  // A job with change requests is a revision: Claude continues its earlier session on the latest round.
  const rev = (full.revisions || []).at(-1);
  const round = rev ? rev.n + 1 : 1;
  const skills = await syncEditorSkills().catch((e) => { log("skills:", e.message); return []; });
  let prompt = editPrompt(job, skills);
  let extraArgs = [];
  if (rev) {
    const file = `REVISION-${round}.md`;
    await writeFile(join(dir, file), revisionMarkdown(rev, round));
    prompt = revisionPrompt(job, round, file, rev.video, skills);
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

  setPhase(job, "editing");
  await post(`/api/jobs/${job.id}/status`, { status: "editing", message: rev ? `Round ${round}: making your changes` : "Started", caps: ["ideas", "previews"] });
  const feed = liveFeed(job.id, rev ? `Round ${round} — your changes` : "Edit");
  feed.add("sys", rev
    ? `Round ${round}: ${rev.notes.length} timed note${rev.notes.length === 1 ? "" : "s"}${rev.general ? " + overall note" : ""}. ${extraArgs.length ? "Claude picks up where it left off." : "Starting Claude."}`
    : `Footage on the PC (${inputs.length} files). Starting Claude.`);
  const frames = watchFrames(dir, job.id, feed, runStart);
  const previews = watchPreviews(dir, job.id, feed, runStart);
  const ideas = syncIdeas(dir, job.id, feed);
  let { code } = await runClaude(
    dir,
    prompt,
    join(dir, "claude.log"),
    (min) => setStatus(job.id, "editing", `${rev ? `Round ${round} · ` : ""}${min} min in`).catch(() => {}),
    feed.add,
    ["--settings", settingsPath, ...extraArgs],
  );
  // Ideas that landed after Claude's last step: one short follow-up each time, Claude keeps its memory.
  for (let extra = 0; code === 0 && extra < 3; extra++) {
    const missed = await ideas.missed();
    if (!missed.length) break;
    feed.add("sys", `${missed.length} idea${missed.length > 1 ? "s" : ""} arrived as Claude finished — applying ${missed.length > 1 ? "them" : "it"} now.`);
    await ideas.markDelivered(missed);
    await setStatus(job.id, "editing", "Adding your latest ideas").catch(() => {});
    ({ code } = await runClaude(dir, ideasPrompt(missed), join(dir, "claude.log"), () => {}, feed.add,
      ["--settings", settingsPath, "--continue"]));
  }
  await ideas.stop();
  await frames.stop();
  await previews.stop();
  feed.add("sys", code === 0 ? "Claude finished." : `Claude stopped (exit ${code}).`);
  await feed.close();

  // Only send back videos that are new or changed in this run.
  const after = await videosNow();
  const outFiles = [...after].filter(([n, t]) => !before.has(n) || t > before.get(n)).map(([n]) => n);
  if (!outFiles.length) {
    throw new Error(`Claude finished (exit ${code}) but made no new video in out/. See claude.log in ${dir}`);
  }

  setPhase(job, "sending");
  await setStatus(job.id, "sending", `${outFiles.length} video${outFiles.length > 1 ? "s" : ""}`);
  for (const name of outFiles) await upload(job.id, join(outDir, name), name);
  const notes = existsSync(join(outDir, "NOTES.txt")) ? (await readFile(join(outDir, "NOTES.txt"), "utf8")).trim() : "";
  await setStatus(job.id, "done", notes || "Edit finished.");
  log(`job "${job.title}" done`);
}

async function main() {
  const port = cfg.deskPort || 4747;
  await startDesk({
    port: DESK_ONLY ? port + 1 : port,
    here: HERE, server: SERVER, api, getJson, post, log, jobDir, agentState,
    getJobsDir: () => JOBS_DIR, setJobsDir, desk: DESK_ONLY,
  });
  if (DESK_ONLY) return log("desk-only mode: not processing jobs");
  if (cfg.openDesk !== false) spawn("cmd", ["/c", "start", "", `http://localhost:${port}`], { windowsHide: true, detached: true }).unref();

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
        } finally {
          setPhase(null, "idle");
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
