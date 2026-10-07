# prodProcess

Send footage from your phone, from anywhere. The PC picks it up, Claude edits it, and the finished video comes back to your phone.

```
iPhone app  ──upload──▶  Cloudflare (Worker + R2)  ◀──polls──  PC agent ──▶ Claude edit
     ▲                                                              │
     └──────────────── finished video + notes ◀─────────────────────┘
```

## Pieces

| Folder | What it is |
|---|---|
| `worker/` | Cloudflare Worker: serves the phone app and stores files in the R2 bucket `prodprocess-media`. Live at https://prodprocess.uthmanajibade03.workers.dev |
| `agent/` | Node program for the PC. Checks for new jobs every 15 s, downloads the original files, runs `claude -p` in the job folder, uploads whatever lands in `out/`. |
| `start-agent.cmd` | Double-click to start the agent. |

Job folders land in `%USERPROFILE%\Videos\prodProcess-jobs\<date>_<name>_<id>\` with `in/` (originals, untouched), `out/` (finished), `NOTE.md` (your request) and `claude.log`.

## Phone setup (once)

1. Open https://prodprocess.uthmanajibade03.workers.dev in Safari.
2. Enter the access code (it's the `token` in `agent/config.json`).
3. Share → **Add to Home Screen**.

Voice memos: in Voice Memos, Share → **Save to Files** first, then they show up under "Add clips & audio" → Browse.

## Job statuses

Sending → Queued → To PC → Editing → Returning → Done (or Failed, with a Try again button).

## Notes

- The PC must be on and the agent running for jobs to start. If the agent stops mid-job, it puts that job back in the queue next time it starts.
- Keep the app open while sending; iOS pauses uploads when the screen locks. If it stops, tap Send again — finished files don't resend.
- Files go up in 50 MB parts, so there's no size cap per clip beyond R2's (5 TB).
- Claude runs with Bash/file tools allowed, inside the job folder, so it can use ffmpeg and the editing skills without asking.

## Deploy changes

```
cd worker
npx wrangler deploy
```

Change the access code: `npx wrangler secret put TOKEN`, then update `agent/config.json` and sign in again on the phone.
