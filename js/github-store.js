// Shared GitHub-as-database helper, used by both index.html and admin.html.
// Reads/writes live on a dedicated "data" branch so pure data commits never
// trigger a Pages rebuild, and read-only QR scans can fetch committed JSON
// straight from raw.githubusercontent.com with no token and no API call.
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

  // Full list of already-committed inspection Tag No.s, via the Git Trees
  // API (recursive) rather than the Contents API, which caps directory
  // listings at 1000 entries.
  async function listInspectionTags() {
    const refRes = await apiFetch(`/repos/${GH_OWNER}/${GH_REPO}/git/ref/heads/${GH_DATA_BRANCH}`);
    if (!refRes.ok) return [];
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

  return {
    GH_OWNER, GH_REPO, GH_DATA_BRANCH, SITE_BASE_URL,
    getToken, setToken, clearToken, hasToken,
    rawUrl, ensureDataBranch, createFile, listInspectionTags, nextTagSuffix,
    toBase64, compressImage
  };
})();
