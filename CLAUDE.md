# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A mobile-friendly asset condition inspection tool for a smelter operation, in Bahasa Indonesia. A field
inspector picks an asset from a fixed catalog, fills in a condition inspection, saves it, and downloads a
QR label (sized for a Niimbot printer) that anyone can scan later to view that inspection read-only.

No framework, no bundler, no `package.json`. Three plain files loaded directly by the browser:

- `index.html` — the inspector-facing form, and the read-only result view (same page, switched by JS
  depending on whether the URL has a `?tag=` param).
- `admin.html` — GitHub token setup + "export everything to Excel."
- `js/github-store.js` — shared module both pages load; the only place that talks to the GitHub API.

Third-party libs (QRCode.js, html2canvas, ExcelJS) are pulled from cdnjs via `<script>` tags — no npm.

## Commands

There is no build, lint, or test step. To develop:

- **Don't open the HTML files as `file://` URLs** — `fetch()` calls to `./data/master-catalog.json` and
  to the GitHub API will fail under the `file://` origin. Serve the directory over local HTTP instead,
  e.g. `python3 -m http.server 8000` from the repo root, then visit `http://localhost:8000/index.html`.
- There's no automated test suite. Verify changes by hand: fill out a real inspection end-to-end against
  the live GitHub Pages deployment (a local server can't fully exercise the save flow, since that needs a
  real fine-grained PAT and hits the real GitHub API — see "The GitHub-as-database design" below).
- Quick JS syntax check without Node installed (not present in this environment):
  `python3 -c "import esprima; esprima.parseScript(open('js/github-store.js').read())"` (`pip3 install
  esprima` if missing). Note esprima doesn't understand `?.`/`??`, which this codebase does use — that's
  a parser limitation, not a real error; ignore syntax errors that point at those tokens specifically.

## The GitHub-as-database design

This is the load-bearing architectural decision in the whole app — GitHub Pages can only serve static
files, so the repo itself doubles as the write-side datastore, via `js/github-store.js`:

- **Reads (viewing a saved inspection) never touch the GitHub API and never need a token.** A QR code
  encodes `SITE_BASE_URL + "?tag=<TagNo>"`; loading `index.html` with that param fetches
  `data/inspections/<tag>.json` straight from `raw.githubusercontent.com` as a plain public GET. This is
  deliberate: a printed QR label has to keep resolving correctly for years, long after any write token has
  expired or been rotated.
- **Writes (saving a new inspection) go through the GitHub Contents/Trees API**, authenticated with a
  fine-grained PAT that each inspector pastes into the token banner in `index.html` (or `admin.html`);
  it's stored in that browser's `localStorage` only, never in a file or commit.
- **Inspection data lives on a separate `data` branch, not `main`.** `main` is what GitHub Pages serves
  (the app itself); `data` holds every `data/inspections/<tag>.json` + `data/inspections/photos/<tag>.jpg`
  committed at runtime by the app. Keeping them apart means routine inspection saves don't trigger Pages
  rebuilds. `GithubStore.ensureDataBranch()` creates the `data` branch off `main` automatically the first
  time anyone ever saves.
- **A Tag No. can only ever be saved once.** `createFile()` never passes a `sha`, so GitHub's Contents API
  rejects the write if that path already exists — this is the actual duplicate-prevention mechanism, not
  just a client-side check (the client also checks `listInspectionTags()` first, mainly to give a better
  error message and to drive the auto-suggested next tag letter, but the server-side rejection is the real
  guarantee against a race between two inspectors).
- **Tag No. format** is `SMELTER-PBSDIGITS-LETTER` (e.g. `A-001-A`). The trailing letter is auto-suggested
  by `nextTagSuffix()`, which lists all existing tags for that smelter+PBS prefix (via the recursive Git
  Trees API, not the Contents API, since the latter caps directory listings at 1000 entries) and picks the
  next unused letter.
- `GithubStore` also holds the single source of truth for `GH_OWNER`, `GH_REPO`, `GH_DATA_BRANCH`, and
  `SITE_BASE_URL` — both HTML pages reference these via `GithubStore.*` rather than hardcoding their own
  copies, so they can't drift out of sync.

## Cache-busting the shared script

`index.html` and `admin.html` load the shared module as `js/github-store.js?v=N`. **Bump `N` in both HTML
files whenever `js/github-store.js` changes** — without it, browsers can keep serving a stale cached copy
after a deploy (this has actually happened: a fix was pushed and a tester kept hitting the old bug until
hard-refreshing).

## Data model

- `data/master-catalog.json` — the fixed catalog (Nomor PBS, Subsistem, Nama Aset, Nama Smelter/Lokasi,
  and the list of sub-component names for that asset). Committed on `main`, part of the site. This is
  reference data an inspector picks from, not something the app writes to.
- `data/inspections/<tagNo>.json` — one committed record per finalized inspection, written by the app to
  the `data` branch. Includes the technical spec, condition, and decision per sub-component (all filled in
  at inspection time, not part of the catalog), plus an `overallDecision` computed client-side by worst-case
  precedence across components (`No Go` > `Hold` > `Conditional Go` > `Go`).
- `data/inspections/photos/<tagNo>.jpg` — the one photo per inspection, resized/compressed client-side
  (`GithubStore.compressImage`, max ~1600px, JPEG quality ~0.7) before upload, since these accumulate in
  the repo indefinitely.

## Picker flow in index.html

Selecting an asset is a three-step cascade, not a single search box: Nama Aset (typeahead against a
`<datalist>`) → Subsistem (options filtered to that Nama Aset) → Nama Smelter/Lokasi (filtered further).
If more than one catalog row still matches after all three, a fourth Nomor PBS `<select>` disambiguates.
Only once a single catalog row resolves does `resolveAsset()` populate the sub-component fields and kick
off the async Tag No. suggestion.
