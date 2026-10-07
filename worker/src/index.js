// prodProcess relay: phone uploads footage here, the PC agent picks jobs up and sends results back.
//
// Storage layout (R2):
//   jobs/<id>/job.json          job record (status, note, timestamps)
//   jobs/<id>/meta/<fid>.json   one record per file (name, size, role, done)
//   jobs/<id>/files/<fid>       the file itself
//
// Large files go up in fixed-size parts through R2 multipart uploads, so the
// Worker's per-request body limit never applies to the whole video.

import APP_HTML from "./app.html";
import ICON_PNG from "./icon.png";

const STATUSES = ["uploading", "ready", "downloading", "editing", "sending", "done", "failed"];
const COOKIE = "pp";

export default {
  async fetch(request, env) {
    env = { ...env, TOKEN: (env.TOKEN || "").trim() }; // secrets piped in from a shell can carry a trailing newline
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
      return new Response(APP_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    if (path === "/manifest.json") return json(manifest());
    if (path === "/icon.png") {
      return new Response(ICON_PNG, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
    }

    if (path === "/api/login" && request.method === "POST") {
      const { token } = await request.json().catch(() => ({}));
      // Forgiving on the phone: any capitals, with or without the dash or spaces.
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!env.TOKEN || !safeEqual(norm(token), norm(env.TOKEN))) return json({ error: "Wrong code" }, 401);
      return json({ ok: true }, 200, {
        "set-cookie": `${COOKIE}=${env.TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`,
      });
    }

    if (!path.startsWith("/api/")) return new Response("Not found", { status: 404 });
    if (!authed(request, env)) return json({ error: "Not signed in" }, 401);

    try {
      return await api(request, env, url);
    } catch (err) {
      return json({ error: err.message || String(err) }, err.status || 500);
    }
  },
};

async function api(request, env, url) {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
  const method = request.method;
  const B = env.MEDIA;

  if (parts[0] === "me") return json({ ok: true });

  // GET /api/jobs?status=ready
  if (parts[0] === "jobs" && parts.length === 1 && method === "GET") {
    const want = url.searchParams.get("status");
    const ids = await listJobIds(B);
    const jobs = (await Promise.all(ids.slice(0, 60).map((id) => getJson(B, jobKey(id))))).filter(Boolean);
    return json({ jobs: want ? jobs.filter((j) => want.split(",").includes(j.status)) : jobs });
  }

  // POST /api/jobs  {title, note}
  if (parts[0] === "jobs" && parts.length === 1 && method === "POST") {
    const body = await request.json();
    const now = Date.now();
    const id = newId(now);
    const job = {
      id,
      title: String(body.title || "").trim().slice(0, 120) || "Untitled",
      note: String(body.note || "").slice(0, 10000),
      status: "uploading",
      message: "",
      created: now,
      updated: now,
    };
    await putJson(B, jobKey(id), job);
    return json(job, 201);
  }

  if (parts[0] !== "jobs" || !parts[1]) throw httpError(404, "Not found");
  const id = cleanId(parts[1]);
  const job = await getJson(B, jobKey(id));
  if (!job) throw httpError(404, "Job not found");

  // GET /api/jobs/:id
  if (parts.length === 2 && method === "GET") {
    return json({ ...job, files: await listFiles(B, id) });
  }

  // DELETE /api/jobs/:id
  if (parts.length === 2 && method === "DELETE") {
    let cursor;
    do {
      const page = await B.list({ prefix: `jobs/${id}/`, cursor });
      if (page.objects.length) await B.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json({ ok: true });
  }

  // POST /api/jobs/:id/status  {status, message}
  if (parts[2] === "status" && method === "POST") {
    const body = await request.json();
    if (!STATUSES.includes(body.status)) throw httpError(400, "Bad status");
    job.status = body.status;
    job.message = String(body.message || "").slice(0, 4000);
    job.updated = Date.now();
    await putJson(B, jobKey(id), job);
    return json(job);
  }

  // POST /api/jobs/:id/revise  {notes:[{t, text}], general}  — changes requested on the finished video
  if (parts[2] === "revise" && method === "POST") {
    if (!["done", "failed"].includes(job.status)) throw httpError(409, "Wait until the current edit finishes");
    const body = await request.json();
    const notes = (Array.isArray(body.notes) ? body.notes : [])
      .slice(0, 60)
      .map((n) => ({ t: Math.max(0, Number(n.t) || 0), text: String(n.text || "").trim().slice(0, 1000) }))
      .filter((n) => n.text)
      .sort((a, b) => a.t - b.t);
    const general = String(body.general || "").trim().slice(0, 4000);
    if (!notes.length && !general) throw httpError(400, "Add at least one note");
    job.revisions = job.revisions || [];
    job.revisions.push({ n: job.revisions.length + 1, at: Date.now(), video: String(body.video || "").slice(0, 200), notes, general });
    job.status = "ready";
    job.message = `Changes requested (round ${job.revisions.length + 1})`;
    job.updated = Date.now();
    await putJson(B, jobKey(id), job);
    return json(job);
  }

  // POST /api/jobs/:id/activity  {entries:[{k, x}], newRun?}  — live feed of what Claude is doing
  if (parts[2] === "activity" && method === "POST") {
    const body = await request.json();
    const feed = (await getJson(B, activityKey(id))) || { seq: 0, entries: [] };
    const now = Date.now();
    const incoming = [
      ...(body.newRun ? [{ k: "run", x: String(body.runLabel || "New run") }] : []),
      ...(Array.isArray(body.entries) ? body.entries : []),
    ];
    for (const e of incoming) {
      feed.entries.push({ s: ++feed.seq, t: e.t || now, k: String(e.k || "say").slice(0, 10), x: String(e.x || "").slice(0, 600) });
    }
    feed.entries = feed.entries.slice(-400);
    await putJson(B, activityKey(id), feed);
    return json({ seq: feed.seq });
  }

  // GET /api/jobs/:id/activity?after=<seq>
  if (parts[2] === "activity" && method === "GET") {
    const feed = (await getJson(B, activityKey(id))) || { seq: 0, entries: [] };
    const after = Number(url.searchParams.get("after")) || 0;
    return json({ seq: feed.seq, entries: feed.entries.filter((e) => e.s > after) });
  }

  // POST /api/jobs/:id/files  {name, size, type, role} -> start a multipart upload
  if (parts[2] === "files" && parts.length === 3 && method === "POST") {
    const body = await request.json();
    const fid = newId(Date.now());
    const key = `jobs/${id}/files/${fid}`;
    const name = String(body.name || "file").replace(/[\\/]/g, "_").slice(0, 200);
    const type = String(body.type || "application/octet-stream");
    const mp = await B.createMultipartUpload(key, { httpMetadata: { contentType: type } });
    const meta = {
      id: fid,
      name,
      size: Number(body.size) || 0,
      type,
      role: ["output", "frame"].includes(body.role) ? body.role : "input",
      uploadId: mp.uploadId,
      done: false,
      created: Date.now(),
    };
    await putJson(B, metaKey(id, fid), meta);
    return json(meta, 201);
  }

  const fid = parts[3] && cleanId(parts[3]);
  const fileKey = `jobs/${id}/files/${fid}`;

  // PUT /api/jobs/:id/files/:fid/parts/:n   (raw bytes)
  if (parts[2] === "files" && parts[4] === "parts" && method === "PUT") {
    const meta = await getJson(B, metaKey(id, fid));
    if (!meta) throw httpError(404, "File not found");
    const n = Number(parts[5]);
    if (!Number.isInteger(n) || n < 1 || n > 10000) throw httpError(400, "Bad part number");
    const mp = B.resumeMultipartUpload(fileKey, meta.uploadId);
    const part = await mp.uploadPart(n, request.body);
    return json(part);
  }

  // POST /api/jobs/:id/files/:fid/complete  {parts:[{partNumber, etag}]}
  if (parts[2] === "files" && parts[4] === "complete" && method === "POST") {
    const meta = await getJson(B, metaKey(id, fid));
    if (!meta) throw httpError(404, "File not found");
    const body = await request.json();
    const mp = B.resumeMultipartUpload(fileKey, meta.uploadId);
    const obj = await mp.complete(body.parts);
    meta.done = true;
    meta.size = obj.size;
    delete meta.uploadId;
    await putJson(B, metaKey(id, fid), meta);
    return json(meta);
  }

  // GET /api/jobs/:id/files/:fid   (supports Range so videos play/seek on the phone)
  if (parts[2] === "files" && parts.length === 4 && method === "GET") {
    const meta = await getJson(B, metaKey(id, fid));
    if (!meta) throw httpError(404, "File not found");
    const obj = await B.get(fileKey, { range: request.headers });
    if (!obj) throw httpError(404, "File not found");
    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set("etag", obj.httpEtag);
    h.set("accept-ranges", "bytes");
    const disp = url.searchParams.has("download") ? "attachment" : "inline";
    h.set("content-disposition", `${disp}; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
    if (obj.range && request.headers.has("range")) {
      const start = obj.range.offset ?? 0;
      const len = obj.range.length ?? obj.size - start;
      h.set("content-range", `bytes ${start}-${start + len - 1}/${obj.size}`);
      h.set("content-length", String(len));
      return new Response(obj.body, { status: 206, headers: h });
    }
    h.set("content-length", String(obj.size));
    return new Response(obj.body, { headers: h });
  }

  throw httpError(404, "Not found");
}

// ---------- helpers ----------

function authed(request, env) {
  if (!env.TOKEN) return false;
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ") && safeEqual(auth.slice(7).trim(), env.TOKEN)) return true;
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return !!m && safeEqual(m[1], env.TOKEN);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Time-sortable ids: newest sorts last as a string.
function newId(now) {
  const rand = crypto.getRandomValues(new Uint8Array(4));
  return now.toString(36).padStart(9, "0") + "-" + [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanId(s) {
  if (!/^[a-z0-9-]{6,40}$/.test(s)) throw httpError(400, "Bad id");
  return s;
}

const jobKey = (id) => `jobs/${id}/job.json`;
const metaKey = (id, fid) => `jobs/${id}/meta/${fid}.json`;
const activityKey = (id) => `jobs/${id}/activity.json`;

async function listJobIds(B) {
  const ids = [];
  let cursor;
  do {
    const page = await B.list({ prefix: "jobs/", delimiter: "/", cursor });
    for (const p of page.delimitedPrefixes) ids.push(p.slice(5, -1));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return ids.sort().reverse();
}

async function listFiles(B, id) {
  const page = await B.list({ prefix: `jobs/${id}/meta/` });
  const files = await Promise.all(page.objects.map((o) => getJson(B, o.key)));
  return files.filter(Boolean).sort((a, b) => a.created - b.created);
}

async function getJson(B, key) {
  const obj = await B.get(key);
  return obj ? obj.json() : null;
}

function putJson(B, key, value) {
  return B.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function manifest() {
  return {
    name: "prodProcess",
    short_name: "Studio",
    start_url: "/",
    display: "standalone",
    background_color: "#0e0e10",
    theme_color: "#0e0e10",
    icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png" }],
  };
}
