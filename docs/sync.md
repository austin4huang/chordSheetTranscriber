# Multi-device sync — options and trade-offs

**Status: not built.** This is a design note so the thinking isn't re-derived
later. Nothing here is implemented; the app is still single-device with manual
backup/restore.

## The problem

The library lives in IndexedDB (`storage.ts`), which is scoped per browser and
per origin. A MacBook and an iPhone therefore hold two unrelated libraries,
and so do `localhost:5173`, a LAN IP, and the deployed Worker — a frequent
source of "where did my songs go?" when testing.

## What exists today

- **Settings → Storage → Backup / Restore.** Downloads the whole library
  (songs *and* sets) as one JSON, and restores from it. `restoreBackup`
  **replaces** the library rather than merging, so restoring onto a device
  that has its own songs loses them.
- **Settings → Storage → Link folder.** Mirrors the library to a local folder
  on every write, debounced 600ms. Uses the File System Access API, so it is
  **Chrome/Edge desktop only** — Safari doesn't implement it, which rules it
  out for iPhone.
- On iOS, tell users to **Add to Home Screen**. Safari evicts site storage for
  origins untouched for ~7 days; home-screen sites are exempt. For an app
  opened on Sundays this is the difference between the charts being there and
  not.

Manual backup → AirDrop → restore is the current answer for moving a library
to a phone. It works and takes about a minute, but it's one-way and one-off.

---

## Option A — a private GitHub repo as the store

Good fit for a single technical user. Free, private, and you get real version
history over your charts: diffs per edit, rollback when you mangle a song, and
the ability to fix a `.json` on github.com in a pinch.

### Store one file per song, never one big JSON

This is the decision the whole design rests on. Use `songs/<id>.json` and
`sets/<id>.json`.

With a single `library.json`, every edit on either device touches the same
file, so any out-of-sync write is a conflict needing manual resolution. With
one file per song, edits to *different* songs never conflict — git merges them
without noticing. Only the same song edited on two devices within one sync
window collides, which for one person is rare.

GitHub's contents API gives optimistic concurrency for free:

- `GET /repos/{owner}/{repo}/contents/{path}` → base64 content plus a `sha`
- `PUT` the same path with that `sha` → 409 if it moved underneath you

So a stale write fails loudly instead of silently clobbering.

### Pushing on edit is already wired

`persist.ts:284` registers a debounced write hook that the folder mirror uses:

```ts
onStoreWrite((s) => { /* debounced 600ms, mirrors to the linked folder */ });
```

A GitHub push hangs off the same hook — edit a chart, and it commits a few
seconds later with no button to press. Raise the debounce (~10s) so you get one
commit per editing session rather than per keystroke batch.

**Caveat:** `onStoreWrite` (`storage.ts:202`) is a single-slot callback, already
claimed by the folder mirror. It needs to become a subscriber set first.

### The token is the hard part

A PAT cannot ship in the bundle.

- **Client-side token (recommended for one user).** The user pastes a
  fine-grained PAT — one repo, contents read/write — once per device; store it
  in the existing `kv` IndexedDB store. Call `api.github.com` directly. No
  backend, no auth system. The token sits in browser storage, which is a real
  but modest risk: first-party origin, strict CSP, scoped to one private repo.
- **Worker-proxied token.** `wrangler secret put GITHUB_TOKEN` and proxy
  through the Worker. But then the Worker route itself needs authentication or
  it's a public read/write handle on the repo. That moves the secret rather
  than removing it, and now there's an auth system to build.

Either way, add `https://api.github.com` to `connect-src` in **both**
`src/worker/index.ts` and `public/_headers` — they mirror each other.

### Edge cases that will bite

- **Deletes.** Removing a song must delete the file, not just drop it locally,
  or the next pull resurrects it. Needs a tombstone or a reconciling pull that
  treats the remote file list as authoritative.
- **First run on a fresh device.** Pull everything before the first push, or an
  empty local library will happily delete the whole repo.
- **Offline.** IndexedDB stays the source of truth; GitHub is the mirror. Queue
  pushes and retry.
- **Commit noise.** Every session is a commit. Fine for a sync log; don't
  expect a tidy history.

Rate limits are a non-issue (5,000 req/hr authenticated).

**Effort: about a day** — pull-on-open, push-on-write, 409 handling, a Settings
panel for repo + token, and a one-time migration writing the current library
out as individual files.

---

## Option B — if other people use the app

Option A is a non-starter for distribution. "Create a GitHub account, make a
private repo, generate a fine-grained PAT, paste it into Settings" will lose
every non-developer, and worship musicians are the target users.

The shape then is a real backend on the Worker that already exists:

- **Storage:** D1 for per-song rows (lets you sync a single changed song rather
  than the whole library), or KV for whole-library blobs if simpler wins.
- **Auth:** the actual work. Cheapest credible option is email magic links;
  OAuth via Google is more familiar to users but more setup. Either way you now
  own accounts, sessions, and password-reset-shaped problems.
- **Sync model:** the same per-song granularity and `updatedAt` comparison as
  Option A, so the client logic is largely shared. Keeping the sync layer
  storage-agnostic from the start means Option A's work isn't wasted if you
  later move to Option B.
- **Cost:** within Workers' free tier at this scale; D1 likewise.

**Effort: several days**, most of it auth and account management, plus the
ongoing duty of holding other people's data.

---

## Recommendation

Stay on backup/restore until one of these is true:

1. **You're tired of manual transfer** → build Option A. One day, no accounts,
   and you get version history as a bonus.
2. **Someone else actually asks to use it** → skip straight to Option B.
   Don't build A first and try to retrofit it; the auth model is the design,
   and it's easier to start there than to bolt it on.

If Option A gets built, keep the GitHub specifics behind a small interface
(`pull()`, `push(changed)`, `resolve(conflict)`) so Option B can replace the
backend without touching the app.
