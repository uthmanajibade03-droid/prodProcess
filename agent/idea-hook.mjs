// Claude Code hook (PostToolUse) used during an edit: hands Claude any ideas Uthman sent
// from the phone or the Studio Desk since its last step.
//
//   <job>/.live/ideas.json      [{id, text, t}]  written by the agent as ideas arrive
//   <job>/.live/delivered.json  [id, ...]        written here once Claude has been told
//
// Usage (set up by agent.mjs via --settings): node idea-hook.mjs "<job folder>"

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.argv[2] || process.cwd(), ".live");
const read = (f, d) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return d; } };

// The hook gets the event on stdin; drain it so Claude Code never blocks writing to us.
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", run);
setTimeout(run, 1500); // in case stdin never closes

let done = false;
function run() {
  if (done) return;
  done = true;
  const ideas = read("ideas.json", []);
  const delivered = new Set(read("delivered.json", []));
  const fresh = ideas.filter((i) => !delivered.has(i.id));
  if (!fresh.length) process.exit(0);

  for (const i of fresh) delivered.add(i.id);
  writeFileSync(join(dir, "delivered.json"), JSON.stringify([...delivered]));
  const list = fresh.map((i) => `- ${i.text}`).join("\n");
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        `[prodProcess idea hook — the channel described in your job instructions]\n` +
        `New ideas Uthman sent while you were working:\n${list}\n\n` +
        "Fold them into the edit. If one conflicts with NOTE.md, the newer idea wins. " +
        "Mention in ./out/NOTES.txt how you handled each one.",
    },
  }));
  process.exit(0);
}
