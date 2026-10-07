// Studio Desk: the PC's own interface, served by the agent at http://localhost:4747.
//
//   /             the Desk (desk.html): storage + drives, agent status, jobs, new job from PC footage
//   /app          the phone app's page, used by the Desk to show a job (ideas, drafts, live view)
//   /api/*        proxied to the relay with the agent's token, so the PC never needs to sign in
//   /local/*      things only the PC can do: browse drives, change the jobs folder, copy footage in
//
// Only answers on localhost, and refuses requests that come from any other web page.

import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, statfs } from "node:fs/promises";
import { join, dirname, basename, extname, resolve, parse as parsePath } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MEDIA_EXT = new Set([".mp4", ".mov", ".m4v", ".mts", ".mxf", ".avi", ".mkv", ".m4a", ".mp3", ".wav", ".aac", ".jpg", ".jpeg", ".png", ".heic"]);

export async function startDesk(o) {
  const { port, here, server, api, getJson, post, log, jobDir, agentState, getJobsDir, setJobsDir } = o;
  const copies = new Map(); // jobId -> {title, total, done, file, error}
  let appHtml = null;

  const send = (res, code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const body = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  };

  const srv = createServer(async (req, res) => {
    try {
      // Localhost only; and a page on some other site must not be able to drive the Desk.
      const host = (req.headers.host || "").toLowerCase();
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return send(res, 403, { error: "Desk is local only" });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) return send(res, 403, { error: "Not from the Desk" });
      if (req.method !== "GET" && req.method !== "HEAD" && !origin && !req.headers["x-desk"]) return send(res, 403, { error: "Not from the Desk" });

      const url = new URL(req.url, `http://${host}`);
      const p = url.pathname;

      if (p === "/" || p === "/index.html") return send(res, 200, await readFile(join(here, "desk.html")), "text/html; charset=utf-8");
      if (p === "/app") {
        if (!appHtml || url.searchParams.has("fresh")) appHtml = await (await fetch(server + "/")).text();
        return send(res, 200, appHtml, "text/html; charset=utf-8");
      }
      if (p === "/manifest.json" || p === "/icon.png") return proxy(req, res, server + p);
      if (p.startsWith("/api/")) {
        if (p === "/api/login") return send(res, 200, { ok: true });
        return proxy(req, res, server + p + url.search);
      }

      if (p === "/local/state" && req.method === "GET") {
        return send(res, 200, {
          jobsDir: getJobsDir(),
          agent: agentState,
          drives: await drives(),
          copies: Object.fromEntries(copies),
        });
      }
      if (p === "/local/browse" && req.method === "GET") return send(res, 200, await browse(url.searchParams.get("path")));
      if (p === "/local/jobs-dir" && req.method === "POST") {
        const { path } = await body(req);
        if (!path || !/^[a-zA-Z]:\\/.test(path)) return send(res, 400, { error: "Pick a folder on a drive" });
        await setJobsDir(resolve(path));
        return send(res, 200, { jobsDir: getJobsDir() });
      }
      if (p === "/local/open" && req.method === "POST") {
        const { jobId } = await body(req);
        let dir = getJobsDir();
        if (jobId) {
          const job = await getJson(`/api/jobs/${encodeURIComponent(jobId)}`);
          dir = jobDir(job);
          if (!existsSync(dir)) return send(res, 404, { error: "This job has no folder on the PC yet" });
        }
        spawn("explorer.exe", [dir], { detached: true, windowsHide: false }).unref();
        return send(res, 200, { ok: true });
      }
      if (p === "/local/new-job" && req.method === "POST") return send(res, 200, await newJob(await body(req)));
      return send(res, 404, { error: "Not found" });
    } catch (e) {
      log("desk:", e.message);
      if (!res.headersSent) send(res, 500, { error: e.message });
      else res.end();
    }
  });

  // Relay requests with the agent's token. Streams both ways, keeps Range so videos seek.
  async function proxy(req, res, target) {
    const headers = {};
    for (const h of ["content-type", "range", "if-none-match"]) if (req.headers[h]) headers[h] = req.headers[h];
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const r = await api(target.slice(server.length), {
      method: req.method,
      headers,
      ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}),
    }).catch((e) => e);
    if (r instanceof Error) {
      const m = r.message.match(/-> (\d{3}) ([\s\S]*)$/);
      return send(res, m ? Number(m[1]) : 502, m?.[2] || JSON.stringify({ error: r.message }));
    }
    const out = { "cache-control": r.headers.get("cache-control") || "no-store" };
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition", "etag"]) {
      const v = r.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(r.status, out);
    if (!r.body || req.method === "HEAD") return res.end();
    await pipeline(Readable.fromWeb(r.body), res).catch(() => {});
  }

  // Drives with free space (labels come from Windows; cached briefly — it's slow to ask).
  let driveCache = { at: 0, list: [] };
  async function drives() {
    if (Date.now() - driveCache.at < 20000) return driveCache.list;
    const labels = await new Promise((res) => {
      execFile("powershell", ["-NoProfile", "-Command",
        "Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter,FileSystemLabel,DriveType | ConvertTo-Json -Compress"],
      { windowsHide: true, timeout: 15000 }, (err, out) => {
        try { const v = JSON.parse(out); res(Array.isArray(v) ? v : [v]); } catch { res([]); }
      });
    });
    const list = [];
    for (const l of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${l}:\\`;
      const fs = await statfs(root).catch(() => null);
      if (!fs) continue;
      const info = labels.find((v) => v.DriveLetter === l) || {};
      list.push({
        root, letter: l,
        label: info.FileSystemLabel || (l === "C" ? "This PC" : ""),
        type: info.DriveType || "",
        size: fs.blocks * fs.bsize,
        free: fs.bavail * fs.bsize,
      });
    }
    driveCache = { at: Date.now(), list };
    return list;
  }

  async function browse(path) {
    if (!path) return { path: "", parent: null, drives: await drives(), dirs: [], files: [] };
    const dir = resolve(path);
    const entries = await readdir(dir, { withFileTypes: true });
    const dirs = [], files = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("$") || e.name === "System Volume Information") continue;
      if (e.isDirectory()) dirs.push(e.name);
      else if (e.isFile() && MEDIA_EXT.has(extname(e.name).toLowerCase())) {
        const st = await stat(join(dir, e.name)).catch(() => null);
        if (st) files.push({ name: e.name, path: join(dir, e.name), size: st.size, mtime: st.mtimeMs });
      }
    }
    dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const root = parsePath(dir).root;
    return { path: dir, parent: dir === root ? "" : dirname(dir), dirs, files };
  }

  // A job whose footage is already on this PC (or an SD card): copy it into the job folder, then queue it.
  async function newJob({ title, note, paths }) {
    if (!Array.isArray(paths) || !paths.length) throw new Error("Pick at least one clip");
    const files = [];
    for (const p of paths) {
      const st = await stat(p).catch(() => null);
      if (!st?.isFile()) throw new Error(`Can't read ${p}`);
      files.push({ path: p, name: basename(p), size: st.size });
    }
    const total = files.reduce((a, f) => a + f.size, 0);
    const fs = await statfs(getJobsDir());
    const free = fs.bavail * fs.bsize;
    const gb = (n) => (n / 1024 ** 3).toFixed(1);
    if (free < total * 2 + 2 * 1024 ** 3) {
      throw new Error(`Not enough space in ${getJobsDir()}: this needs about ${gb(total * 2 + 2 * 1024 ** 3)} GB, ${gb(free)} GB free. Change where jobs are saved, or free some space.`);
    }

    const job = await post("/api/jobs", { title, note, local: true });
    const inDir = join(jobDir(job), "in");
    await mkdir(inDir, { recursive: true });
    const seen = new Map();
    for (const f of files) { // two cards can both have C0001.MP4 — keep both
      const n = (seen.get(f.name.toLowerCase()) || 0) + 1;
      seen.set(f.name.toLowerCase(), n);
      if (n > 1) f.name = f.name.replace(/(\.[^.]*)?$/, `_${n}$1`);
    }
    await post(`/api/jobs/${job.id}/local-files`, { files: files.map(({ name, size }) => ({ name, size })) });
    const c = { title: job.title, total, done: 0, file: "", error: "" };
    copies.set(job.id, c);
    (async () => {
      try {
        await post(`/api/jobs/${job.id}/status`, { status: "uploading", message: "Copying footage on the PC" });
        for (const f of files) {
          c.file = f.name;
          const count = new Transform({ transform(chunk, _e, cb) { c.done += chunk.length; cb(null, chunk); } });
          await pipeline(createReadStream(f.path, { highWaterMark: 4 * 1024 * 1024 }), count, createWriteStream(join(inDir, f.name)));
        }
        c.file = "";
        await post(`/api/jobs/${job.id}/status`, { status: "ready", message: "" });
        log(`desk: "${job.title}" copied (${gb(total)} GB), queued`);
        setTimeout(() => copies.delete(job.id), 60000);
      } catch (e) {
        c.error = e.message;
        log(`desk: copy for "${job.title}" failed:`, e.message);
        await post(`/api/jobs/${job.id}/status`, { status: "failed", message: `Copying footage failed: ${e.message}` }).catch(() => {});
      }
    })();
    return { id: job.id };
  }

  await new Promise((res, rej) => {
    srv.once("error", rej);
    srv.listen(port, "127.0.0.1", res);
  }).catch((e) => log(`Studio Desk couldn't start on port ${port}: ${e.message}`));
  log(`Studio Desk: http://localhost:${port}`);
}
