# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Session startup

At the start of every session in this repo, invoke the `ponytail:ponytail` and `caveman:caveman` skills
(default intensity for each) before doing any other work, so lazy/minimal-diff code review and terse
responses are active for the whole session without needing to be asked.

## What this is

A mobile-friendly asset condition inspection tool for a smelter operation (6 sites), in Bahasa Indonesia. A
field inspector picks an asset from a fixed catalog (or registers one that isn't in the catalog), fills in a
condition inspection, saves it, and downloads a QR label (sized for a Niimbot printer) that anyone can scan
later to view that inspection read-only. An admin page manages the write token, lists/edits/deletes saved
inspections, and exports everything to Excel.

No framework, no bundler, no `package.json`. Four files loaded directly by the browser:

- `index.html` — the inspector-facing form, and the read-only result view (same page, switched by JS
  depending on whether the URL has a `?tag=` param).
- `admin.html` — GitHub token setup, a table of saved inspections with per-row edit / QR-label download /
  delete, and "export everything to Excel."
- `js/github-store.js` — shared module both pages load; the only place that talks to the GitHub API, plus
  shared constants/helpers (Kondisi/Keputusan option lists, `computeOverallDecision`, image compression,
  the straight-to-device image-download helper, and the QR label renderer `generateLabelPNG` used by both
  pages).
- `assets/logo-lapi-itb.png` — company logo, drawn onto the generated QR label via canvas `drawImage()`.

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
- No headless browser is available in this environment either. Canvas-heavy changes (the QR label
  generator) have been validated by reproducing the same coordinates in a local Python/Pillow mockup before
  shipping, rather than by rendering the real page — a reasonable fallback, but not a substitute for
  actually opening the deployed page once a change lands.

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
  it's stored in that browser's `localStorage` only, never in a file or commit. The banner in `index.html`
  hides itself entirely once a token is set on that device — `admin.html` is where it's changed later.
- **Inspection data lives on a separate `data` branch, not `main`.** `main` is what GitHub Pages serves
  (the app itself); `data` holds every `data/inspections/<tag>.json` + `data/inspections/photos/<tag>.jpg`
  committed at runtime by the app. Keeping them apart means routine inspection saves don't trigger Pages
  rebuilds. `GithubStore.ensureDataBranch()` creates the `data` branch off `main` automatically the first
  time anyone ever saves.
- **A Tag No. can only ever be created once**, from the field-save flow. `createFile()` never passes a
  `sha`, so GitHub's Contents API rejects the write if that path already exists — this is the actual
  duplicate-prevention mechanism, not just a client-side check (the client also checks
  `listInspectionTags()` first, mainly to give a better error message and to drive the auto-suggested next
  tag letter, but the server-side rejection is the real guarantee against a race between two inspectors). If
  a save hits this, `index.html` offers to load whatever's actually saved under that tag instead of just
  blocking — it may be the inspector's own earlier save that succeeded on GitHub but never confirmed back to
  the client (this happened for real during a GitHub outage).
- **Admin can still overwrite or delete an existing record** via `getFileMeta()` (fetches a file's current
  `sha`), `updateFile()` (PUT with that `sha` — the create-only guarantee above is specific to
  `createFile()`), and `deleteFile()`. These back `admin.html`'s per-row Edit/Hapus and are deliberately
  separate from the field save path. Admin's Edit modal can also rename a Tag No. outright — that reuses
  `createFile()`'s same create-only guarantee for the new path (see "Admin data management" below).
- **`raw.githubusercontent.com` can serve a stale pre-write snapshot for a few minutes after a commit**,
  and a browser's own image cache is a second, independent staleness source specifically for `<img src>`
  loads. `admin.html` works around the JSON case with a short-lived `recentEdits`/`applyRecentEdits()`
  override (~5 min, keyed by Tag No.); photo re-display right after an edit instead uses
  `GithubStore.rawUrlFresh()` (same as `rawUrl()` but with a `?_=<timestamp>` cache-buster) rather than the
  plain `rawUrl()` used everywhere else — without it, a photo that actually saved correctly can appear to
  have silently failed (this shipped once and was diagnosed by checking the commit history directly, not
  by finding a bug in the write path — there wasn't one).
- **Tag No. format** is `ACRONYM-PBSNUMBER-LETTER` (e.g. `RBT-1.4.1-A`), where ACRONYM comes from the
  smelter name's parenthetical, e.g. `"Refined Bangka Tin (RBT)"` → `RBT` (`smelterCode()` in `index.html`,
  with a trailing-word fallback for a manually-typed location that doesn't follow that format).
  PBSNUMBER is the catalog `nomorPBS` used verbatim, dots included (`pbsCode()` — just strips
  whitespace); it is not zero-padded or stripped of dots. The letter
  is auto-suggested by `nextTagSuffix()`, which lists all existing tags for that prefix (via the recursive
  Git Trees API, not the Contents API, since the latter caps directory listings at 1000 entries) and picks
  the next unused letter — skipped in manual-asset mode, where there's no catalog prefix to suggest from.
- `GithubStore` also holds the single source of truth for `GH_OWNER`, `GH_REPO`, `GH_DATA_BRANCH`,
  `SITE_BASE_URL`, and the Kondisi/Keputusan option lists — both HTML pages reference these via
  `GithubStore.*` rather than hardcoding their own copies, so they can't drift out of sync.

## Cache-busting the shared script

`index.html` and `admin.html` load the shared module as `js/github-store.js?v=N`. **Bump `N` in both HTML
files whenever `js/github-store.js` changes** — without it, browsers can keep serving a stale cached copy
after a deploy (this has actually happened: a fix was pushed and a tester kept hitting the old bug until
hard-refreshing).

## Data model

- `data/master-catalog.json` — the fixed catalog (Nomor PBS, Subsistem, Nama Aset, Nama Smelter/Lokasi,
  and the list of sub-component names for that asset). Committed on `main`, part of the site. This is
  reference data an inspector picks from, not something the app writes to. **The same asset is replicated
  across all 6 smelters** — one row per smelter, same Nomor PBS/Subsistem/sub-components — that's what lets
  the picker offer a choice of smelters for one asset name. `lokasi` values follow `"Company Name
  (ACRONYM)"`, since the acronym is what the Tag No. prefix is derived from. Nomor PBS is `SYSTEM.MID.LEAF`;
  systems 1–16 exist (7–16 — gas handling, cooling, hydrant, genset, buildings — were folded in later from
  field registrations). **Leaf numbers are NOT always contiguous and NOT safe to string-sort** (`1.10.1`
  sorts before `1.2.1` lexically); nothing in the app sorts inspections by PBS, but keep this in mind if
  adding anything that does. **Regenerated from `PBS_MASTER_CANONICAL.xlsx`** (the reviewed clean PBS tree,
  4-column `Kode PBS | Level | Jenis | Komponen`) via `python3 scripts/import-pbs-master.py
  PBS_MASTER_CANONICAL.xlsx` — edit the xlsx and re-run rather than hand-editing the JSON.
- `data/pbs-subsistem.csv` — flat `nomorPBS,subsistem,namaAset` reference, one row per distinct catalog
  PBS, generated from `master-catalog.json`. Not read by the app; regenerate if the catalog changes.
- `data/pbs-crosswalk.csv` — one row per distinct `(recorded nomorPBS, recorded namaAset)` seen in the
  inspection records, mapping to `pbsCanonical / subsistemCanonical / namaAsetCanonical / unitLabel`. The
  input to the canonical-PBS backfill (below); regenerate with `scripts/build-canonical-pbs.py` if the
  recorded data or the merge/typo rules in that script change.
- `data/inspections/<tagNo>.json` — one committed record per finalized inspection, written by the app to
  the `data` branch. Includes the technical spec, condition, and decision per sub-component (all filled in
  at inspection time, not part of the catalog), plus an `overallDecision` computed by worst-case precedence
  across components (`No Go` > `Hold` > `Conditional Go` > `Go` — `GithubStore.computeOverallDecision`).
  Also carries `createdAt` (ISO timestamp, set once in `index.html`'s `buildRecord()` and never touched
  again) — added later, so inspections saved before that shipped don't have it; admin.html's sort falls
  back to Tag No. for those. `qrPrinted` (bool) is admin-only: unset/false until admin.html's per-row
  "QR Dicetak" checkbox is ticked (by hand, or automatically the first time that row's "QR" button is
  clicked).
- **Canonical PBS fields** (`pbsCanonical`, `subsistemCanonical`, `namaAsetCanonical`, `unitLabel`) —
  backfilled onto every existing record by `scripts/backfill-canonical-pbs.py` from `pbs-crosswalk.csv`.
  They carry the *cleaned* classification (wrong PBS branch fixed, duplicate codes merged, per-unit/typo
  name variants collapsed with the unit detail in `unitLabel`) while the raw `nomorPBS`/`subsistem`/
  `namaAset` and the Tag No. are left untouched — so QR codes and file paths never move. The QR scan view
  ignores these fields; the admin Excel export and `scripts/build-pbs-report.py` read them with a
  `pbsCanonical || nomorPBS` fallback (new inspections saved after the backfill don't have them, since
  `index.html` doesn't write them — the fallback covers that). `scripts/build-pbs-report.py` emits
  `PBS_STRUKTUR_CANONICAL.xlsx`, the tidy 3-level reporting list (one row per canonical PBS + a
  `Jumlah Unit` count).
- `data/inspections/photos/<tagNo>.jpg` — the one photo per inspection, resized/compressed client-side
  (`GithubStore.compressImage`, max ~1600px, JPEG quality ~0.7) before upload, since these accumulate in
  the repo indefinitely.

## Bulk-imported records (rubric workbooks)

Each smelter has a legacy "Rubrik Penilaian" Excel asset register (one sheet per asset, embedded photos).
These were bulk-imported into the `data` branch as inspection records via throwaway scripts kept in
`scratch_data/` (gitignored — `curated_map_*.py` build a name→catalog crosswalk CSV, `import_sbs.py` writes
the JSON + photos). Done for **SBS, VIP, SIP, TIN**; RBT/MCM already had enough real field data. Things to
know about these records:

- **`nomorPBS`/`subsistem` come from a hand-curated crosswalk** (workbook asset name → nearest catalog PBS);
  **`namaAset` is kept verbatim from the workbook** (more specific, e.g. `"Exhaust Fan Tanur A"`). So a
  multi-unit group's records do NOT string-match their catalog row on `namaAset` — matching is by PBS only.
  Multiple workbook sheets can collapse onto one catalog PBS (`TIN-2.1.1-A..I` = 9 ketels).
- **Some records have a `fotoPath` pointing at a file that doesn't exist** (the workbook sheet had no
  photo). QR label, admin list and Excel export all handle this; only the read-only scan view shows a
  missing image.
- **A few records have an empty `subsistem`** (workbook asset with no catalog equivalent — e.g. `*-6.3.1-A`
  "Fertilizer"); these keep their workbook PBS.
- **Imports were gap-only** — any catalog PBS the field team had already started entering by hand was
  skipped, so a later hand-entry under one of the imported PBS will land as a new letter alongside the
  bulk rows, not a conflict.

## Picker flow and manual asset entry (index.html)

Selecting an asset is a cascade, not a single search box: Nama Aset (custom-rendered suggestion dropdown,
not a native `<datalist>` — datalist suggestions don't reliably show while typing on mobile Safari) → Nama
Smelter/Lokasi (options filtered to that Nama Aset). Subsistem is **not** picked — it's derived from the
resolved catalog row and shown read-only. If Nama Aset + Lokasi still match more than one catalog row (a
handful of asset names sit under two subsistems), a Subsistem/Nomor PBS `<select>` disambiguates
(`pbsDisambigSelect`, option text `"<Subsistem> — <Nomor PBS>"`, value = Nomor PBS). Only once a single
catalog row resolves does `resolveAsset()` populate the sub-component fields and kick off the async Tag No.
suggestion.

**Sub-components are always filled in by hand**, catalog pick or not — `master-catalog.json` carries only
sub-component *names* (often none), no real spec/condition data, so `resolveAsset()` calls
`renderComponents(row, true)` and the inspector adds/removes rows with `addComponentCard()` / the "+ Tambah
Sub Komponen" button. Only Nomor PBS/Subsistem/Lokasi stay locked to the catalog row.

An inspector can bypass the catalog entirely via **manual asset mode** (`enterManualAssetMode()`), for an
asset that isn't in the catalog: Nomor PBS/Subsistem/Lokasi become plain editable inputs too. Either way,
`validateForm()`/`buildRecord()` never trust `currentAsset.subKomponen` as the source of truth — they read
whatever `.comp-card` elements are actually rendered in `componentsArea` at save time
(`readComponentCards()`), which works the same regardless of how the cards got there.

## QR label generation (`js/github-store.js`, `GithubStore.generateLabelPNG`)

Lives in the shared module, not per-page, so `index.html`'s post-save "Unduh QR Label" button and
`admin.html`'s per-row "QR" button render the exact same label. Takes a saved inspection record; the QR
container is a detached `<div>` (no `#qrHidden` DOM element).

Renders a 50x30mm label at 12px/mm (600x360px canvas — higher than the 8px/mm a typical 203 DPI thermal
printer needs, so it downsamples instead of upsamples when printed, which is what keeps edges crisp).
Layout: QR fills the left column (drawn oversized from a 560px QRCode.js render, then scaled down to 280px,
for a cleaner downscale); the right column stacks the actual logo image (drawn via `drawImage()` at its
native aspect ratio — not recreated as text, and not squeezed small enough to visibly pixelate), then Tag
No. (`bold 26px monospace`), a divider, Nama Aset (`bold 34px sans-serif`), and Lokasi (`25px sans-serif`,
both wrapped to max 2 lines via `wrapText()`, which returns its line count so Lokasi's baseline follows a
1- or 2-line asset name). No mini-labels or scan caption — unreadable at the printed size, so the three
real values just get bigger instead. Font sizes were tuned by hand on real prints; change them only on
request. (An auto-shrink-to-fit for Tag No. was tried and reverted — canvas `measureText()` metrics vary
enough across real devices/browsers that a runtime-computed size was less reliable than a fixed, hand-tuned
one; Tag No. is a single `ctx.font`/`fillText()` call, so it's always uniform across the whole string even
though the acronym/letters can look visually "bigger" than the digits/dots in a monospace font — that's the
font's glyph shapes, not a per-segment size difference.)

Two non-obvious gotchas baked into this code:

- **Read the QRCode.js canvas, never the `<img>`.** The library paints the QR onto an internal `<canvas>`
  synchronously, then separately converts that canvas to a hidden/shown `<img>` for display. Reading the
  `<img>` back out races its `data:` URL decode — this actually shipped once and produced labels with the
  text but a blank QR on some Android browsers. The canvas has no such race.
- **Image download is platform-split in `GithubStore.saveOrShareImage()`** (used by the label download and
  the "download result as image" button). **Android / desktop:** silent `<a download>` on a `blob:` URL
  (not the raw `data:` URL — a large `data:` URL is what iOS Safari refuses to save, and it's flakier on
  Android too); no OS share sheet, because inspectors didn't want to hunt for "save to gallery" every time.
  Lands in the gallery-indexed Downloads on Android. **iOS** (`IS_IOS` UA/`MacIntel`+touch check): `<a
  download>` on iOS can only reach Files → Downloads, never the Photos app — Apple blocks any silent write
  to the photo library — so iOS goes through `navigator.share({files})` and the inspector taps "Save Image"
  to land it in the gallery. That's the one platform where the share sheet is unavoidable; don't "simplify"
  it back to a plain download.

## Admin data management (admin.html)

"Muat Data Tersimpan" lists every saved inspection (fetched with bounded concurrency via
`mapWithConcurrency()` — sequential one-row-at-a-time fetching doesn't scale to the ~2000 inspections this
is sized for), one row per inspection including its PIC/Inspector. Rows are newest-first by `createdAt`
(records without it, i.e. saved before that field existed, sort after all dated ones, tied among
themselves by Tag No.) — the full sorted set is kept in `allRows`, separate from whatever subset
`renderDataTableRows()` currently has on screen. Three dropdowns filter that subset client-side (no extra
fetch): "Filter Nama Smelter" (`populateLokasiFilter()`, distinct `lokasi`), "Filter Subsistem"
(`populateSubsistemFilter()`, distinct `subsistem`), and "Filter Keputusan" (`decisionFilter`, the 4
`GithubStore.KEPUTUSAN_OPTIONS` values, options built in JS so they can't drift from what `index.html`
writes into `overallDecision`). All three **AND-combine** via the `filteredRows()` helper — a row shows
only if it matches every set one. **The Keputusan filter only applies while a single smelter is selected**
— `syncDecisionFilter()` disables and clears it whenever "Filter Nama Smelter" is "Semua Lokasi", and
`filteredRows()` ignores its value in that state regardless.

Above the table sits a **decision dashboard** (`renderDashboard()`, `#decisionDashboard`): 4 count tiles
(Go / Conditional Go / Hold / No Go) tallied by `record.overallDecision`, plus a `"<n> aset · <m> tanpa
keputusan"` caption so a blank `overallDecision` (older stubs) still reconciles against the row count. The
tiles reflect **only the smelter + subsistem filters** (`dashboardRows()`, deliberately *not* the Keputusan
filter — otherwise picking one decision would zero the other three tiles). While the Keputusan filter is
enabled, clicking a tile sets it to that decision.

Every render path (all three `change` handlers, initial load, post-edit re-render) goes through
`refreshDataViews()` = `syncDecisionFilter()` + `renderDashboard(dashboardRows())` +
`renderDataTableRows(filteredRows())`, except the Keputusan filter's own `change`, which re-renders just
the table (the dashboard doesn't depend on it).

On page open, if a token is already saved, `loadDataTable()` runs automatically (guarded by its own
`loadDataBtn` disable) so the dashboard + table populate without clicking "Muat Data Tersimpan"; the button
stays as the manual reload path. No token = no auto-load.

Each row has a "QR Dicetak" checkbox (`qrPrinted`) plus three actions: **Edit** opens a modal covering
everything about the record — Tag No., Nomor PBS/Subsistem/Lokasi, PIC/Tanggal, foto, and per-component
Kondisi/Keputusan/Catatan — none of it locked anymore. Sub-component rows can be renamed, added
(`+ Tambah Sub Komponen`), or removed, mirroring index.html's manual-asset component editing
(`addEditComponentCard`, validated the same way as `index.html`'s `validateForm()`: at least one component,
nama/spesifikasiTeknis/kondisiTeknis/keputusanTeknis required per row, plus Tag No./Nomor PBS/Subsistem/
Lokasi all required non-empty).

- **Photo replace** reuses `index.html`'s camera/gallery-input + `GithubStore.compressImage()` pattern; if
  no new photo is picked, the existing one is left untouched (no photo write happens at all).
- **Tag No. rename** actually moves the record: `data/inspections/<tag>.json` and
  `data/inspections/photos/<tag>.jpg` move to new paths keyed by the new tag. Implemented as
  create-new-then-delete-old (`createFile()` for the new JSON/photo, then `deleteInspectionFiles()` for the
  old ones) so a failure partway leaves the old record intact — a stray duplicate the admin is told to clean
  up manually — rather than losing data. `createFile()`'s create-only guarantee doubles as a second check
  (on top of an explicit `listInspectionTags()` lookup) that the new Tag No. isn't already taken.
  Inspection ID is regenerated to match the new tag. If no new photo was picked during a rename, the
  existing photo bytes are copied to the new path unchanged (not recompressed) via
  `GithubStore.fetchFileAsBase64()`. Because a printed QR label encodes the Tag No. in its URL, renaming a
  record whose `qrPrinted` is already checked triggers a `confirm()` warning that the old physical label
  will stop resolving — the admin can still proceed past it.

Save re-renders through `populateLokasiFilter()` + `populateSubsistemFilter()` + `refreshDataViews()` —
the same filter-aware path used everywhere else in this file — instead of patching individual table cells;
needed now that Tag No./Subsistem/Lokasi can all change from this modal, and it resolves "row's lokasi/
subsistem no longer matches the active filter" (and the dashboard counts) for free. **QR** re-generates and downloads that inspection's label from the cached record via
`GithubStore.generateLabelPNG()`, then auto-ticks "QR Dicetak" if it wasn't already (best-effort — a
download isn't proof of an actual print — via the same `setQrPrinted()` the checkbox itself uses, which
never blocks or fails the download on a write error). **Hapus** removes both the JSON and photo. Edit and
Hapus patch the in-memory row/table (and `allRows`) directly instead of reloading the whole list, since a
full reload at ~2000 rows is slow. "Hapus Semua Data Tersimpan" bulk-deletes, sharing the per-tag delete
logic.

The Excel export reuses the same concurrency helper, and re-compresses each photo down to thumbnail size
before embedding it — the sheet only ever displays it at 110x110px, so embedding the full ~1600px capture
would make the exported file unnecessarily large at that row count. Its `Nomor PBS` / `Subsistem` /
`Nama Aset` columns show the **canonical** values (`record.pbsCanonical || record.nomorPBS`, etc.) plus a
`Unit` column from `unitLabel` — see "Canonical PBS fields" in the data model. The Tag No. column and the
embedded photo/QR are unchanged; only the two `addImage` `col:` indices shifted (+1) for the new column.
