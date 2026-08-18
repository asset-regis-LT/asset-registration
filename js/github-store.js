// Shared GitHub-as-database helper, used by both index.html and admin.html.
// Reads/writes live on a dedicated "data" branch so pure data commits never
// trigger a Pages rebuild, and read-only QR scans can fetch committed JSON
// straight from raw.githubusercontent.com with no token and no API call.
// NOTE: index.html/admin.html load this via "js/github-store.js?v=N" — bump
// that N whenever this file changes, or browsers may keep serving a stale
// cached copy after a deploy.
const GithubStore = (() => {
  const GH_OWNER = "asset-regis-lt";
  const GH_REPO = "asset-registration";
  const GH_DATA_BRANCH = "data";
  const GH_SOURCE_BRANCH = "main";
  const TOKEN_KEY = "gh_pat_token";
  // Published GitHub Pages URL for this app. The QR label and the Excel
  // export both encode SITE_BASE_URL + "?tag=<TagNo>" so a scan opens
  // straight into the read-only result view.
  const SITE_BASE_URL = "https://asset-regis-lt.github.io/asset-registration/";

  // Shared between index.html (the inspection form) and admin.html (the
  // edit-existing-record form), so the two never drift apart on what
  // options an inspection's Kondisi/Keputusan fields can hold.
  const KONDISI_OPTIONS = [
    "Siap Operasi (100%)",
    "Minor Repair (80 - 100%)",
    "Repair (50 - 80%)",
    "Major Repair (20 - 50%)",
    "Scrap / Tidak Ada (Hilang) (< 20%)"
  ];
  const KEPUTUSAN_OPTIONS = [
    { value: "Go", cls: "go" },
    { value: "Conditional Go", cls: "cgo" },
    { value: "Hold", cls: "hold" },
    { value: "No Go", cls: "nogo" }
  ];
  const DECISION_PRECEDENCE = ["No Go", "Hold", "Conditional Go", "Go"];
  function computeOverallDecision(komponenData) {
    for (const level of DECISION_PRECEDENCE) {
      if (komponenData.some(k => k.keputusanTeknis === level)) return level;
    }
    return "";
  }

  function getToken() {
    return (localStorage.getItem(TOKEN_KEY) || "").trim();
  }
  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, (token || "").trim());
  }
  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  }
  function hasToken() {
    return !!getToken();
  }

  async function apiFetch(path, options = {}) {
    const token = getToken();
    const headers = { "Accept": "application/vnd.github+json", ...(options.headers || {}) };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    try {
      return await fetch(`https://api.github.com${path}`, { ...options, headers });
    } catch (err) {
      throw new Error(
        "Tidak bisa terhubung ke api.github.com. Periksa koneksi internet perangkat ini, " +
        "dan jika berada di jaringan kantor/lokasi kerja, pastikan domain api.github.com " +
        "tidak diblokir oleh firewall/proxy."
      );
    }
  }

  function rawUrl(path) {
    return `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_DATA_BRANCH}/${path}`;
  }

  // Creates the "data" branch off main the first time this app is ever used.
  async function ensureDataBranch() {
    const check = await apiFetch(`/repos/${GH_OWNER}/${GH_REPO}/branches/${GH_DATA_BRANCH}`);
    if (check.ok) return;
    if (check.status !== 404) throw new Error(`Gagal memeriksa branch data (HTTP ${check.status}).`);

    const mainRef = await apiFetch(`/repos/${GH_OWNER}/${GH_REPO}/git/ref/heads/${GH_SOURCE_BRANCH}`);
    if (!mainRef.ok) throw new Error("Gagal membaca branch main untuk membuat branch data.");
    const mainData = await mainRef.json();

    const create = await apiFetch(`/repos/${GH_OWNER}/${GH_REPO}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${GH_DATA_BRANCH}`, sha: mainData.object.sha })
    });
    if (!create.ok && create.status !== 422) {
      throw new Error(`Gagal membuat branch data (HTTP ${create.status}).`);
    }
  }

  // Creates a new file on the data branch. Fails loudly if the path already
  // exists (no `sha` is passed, which GitHub requires for overwrites) so a
  // duplicate Tag No. can never silently overwrite a prior inspection.
  async function createFile(path, base64Content, message) {
    const res = await apiFetch(`/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: base64Content, branch: GH_DATA_BRANCH })
    });
    if (res.status === 422 || res.status === 409) {
      const err = new Error(`Path "${path}" sudah ada di branch data.`);
      err.code = "DUPLICATE";
      throw err;
    }
    if (!res.ok) {
      throw new Error(`Gagal menyimpan ke GitHub (HTTP ${res.status}): ${await res.text()}`);
    }
    return res.json();
  }

  // These three are the admin-only counterparts to createFile: they allow
  // overwriting/removing an already-committed inspection (for correcting a
  // data-entry mistake or removing a bad record), which the field save flow
  // deliberately never does — createFile() only ever creates.
  async function getFileMeta(path) {
    const res = await apiFetch(`/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_DATA_BRANCH}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Gagal membaca ${path} (HTTP ${res.status}).`);
    return res.json(); // includes .sha, needed to update/delete this exact file
  }

  async function updateFile(path, base64Content, message, sha) {
    const res = await apiFetch(`/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: base64Content, branch: GH_DATA_BRANCH, sha })
    });
    if (!res.ok) throw new Error(`Gagal memperbarui ${path} (HTTP ${res.status}): ${await res.text()}`);
    return res.json();
  }

  async function deleteFile(path, message, sha) {
    const res = await apiFetch(`/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`, {
      method: "DELETE",
      body: JSON.stringify({ message, sha, branch: GH_DATA_BRANCH })
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Gagal menghapus ${path} (HTTP ${res.status}): ${await res.text()}`);
    }
  }

  // Full list of already-committed inspection Tag No.s, via the Git Trees
  // API (recursive) rather than the Contents API, which caps directory
  // listings at 1000 entries.
  async function listInspectionTags() {
    const refRes = await apiFetch(`/repos/${GH_OWNER}/${GH_REPO}/git/ref/heads/${GH_DATA_BRANCH}`);
    // 404 genuinely means the data branch doesn't exist yet (no inspection has
    // ever been saved) — that's the only case where "no tags" is correct. Any
    // other failure (bad token, rate limit, GitHub downtime, ...) must throw,
    // not be silently treated as "zero inspections" — that previously made
    // the duplicate-tag check and the Excel export both go quietly blind
    // during any API hiccup instead of surfacing the real problem.
    if (refRes.status === 404) return [];
    if (!refRes.ok) throw new Error(`Gagal membaca daftar inspeksi (HTTP ${refRes.status}).`);
    const refData = await refRes.json();

    const treeRes = await apiFetch(`/repos/${GH_OWNER}/${GH_REPO}/git/trees/${refData.object.sha}?recursive=1`);
    if (!treeRes.ok) throw new Error(`Gagal membaca daftar inspeksi (HTTP ${treeRes.status}).`);
    const treeData = await treeRes.json();

    return (treeData.tree || [])
      .filter(item => item.type === "blob" && /^data\/inspections\/[^/]+\.json$/.test(item.path))
      .map(item => item.path.replace(/^data\/inspections\//, "").replace(/\.json$/, ""));
  }

  // Given existing tags and a "SMELTER-PBSDIGITS" prefix, suggests the next
  // unused trailing letter (A, B, C, ...).
  function nextTagSuffix(existingTags, prefix) {
    const used = existingTags
      .filter(t => t.startsWith(prefix + "-"))
      .map(t => t.slice(prefix.length + 1))
      .filter(s => /^[A-Z]$/.test(s));
    if (!used.length) return "A";
    const maxCode = Math.max(...used.map(s => s.charCodeAt(0)));
    return String.fromCharCode(maxCode + 1);
  }

  function toBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  // Resizes/compresses a photo File client-side before it gets committed,
  // so the repo stays lean over years of inspections.
  function compressImage(file, maxDim = 1600, quality = 0.7) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Gagal membaca file foto."));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Gagal memuat foto."));
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          resolve({ dataUrl, base64: dataUrl.split(",")[1] });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Saves/shares a data: URL image from a phone browser. The classic
  // `<a download>` click trick is unreliable on mobile — iOS Safari in
  // particular often just navigates to the data: URL instead of saving it.
  // The Web Share API (share a real file to Photos/Files/etc.) works far
  // more consistently on phones, so it's tried first; desktop browsers
  // (where the Share API is usually unavailable) fall back to the classic
  // download link, which works fine there.
  async function saveOrShareImage(dataUrl, filename, mimeType) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], filename, { type: mimeType });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return; // user cancelled the share sheet
      // fall through to the link-based download below
    }
    const link = document.createElement("a");
    link.download = filename;
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  return {
    GH_OWNER, GH_REPO, GH_DATA_BRANCH, SITE_BASE_URL,
    KONDISI_OPTIONS, KEPUTUSAN_OPTIONS, DECISION_PRECEDENCE, computeOverallDecision,
    getToken, setToken, clearToken, hasToken,
    rawUrl, ensureDataBranch, createFile, listInspectionTags, nextTagSuffix,
    getFileMeta, updateFile, deleteFile,
    saveOrShareImage,
    toBase64, compressImage
  };
})();
