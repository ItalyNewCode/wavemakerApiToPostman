// merge-postman.js
// npm i openapi-to-postmanv2 node-fetch@2 fs-extra glob

const fs = require("fs-extra");
const fetch = require("node-fetch");
const glob = require("glob");
const path = require("path");
const converter = require("openapi-to-postmanv2");

const POSTMAN_API_KEY = process.env.POSTMAN_API_KEY || "PMAK-68a42e078e550b00019bb415-626f30c6be94948189aaef916d380a733c";
const TARGET_UID = process.env.POSTMAN_TARGET_UID || "47589424-a346fa52-6109-4b70-8e92-1b7818778c28";
const PRUNE = String(process.env.POSTMAN_PRUNE || "true").toLowerCase() === "true"; // true => deletions propagate
const COLLECTION_NAME = process.env.POSTMAN_COLLECTION_NAME || "IMAGELINE_MIDDLEWARE";
const POSTMAN_BASE = "https://api.getpostman.com";

if (!POSTMAN_API_KEY || !TARGET_UID || POSTMAN_API_KEY === "REPLACE_ME" || TARGET_UID === "REPLACE_ME") {
  console.error("❌ Missing POSTMAN_API_KEY or POSTMAN_TARGET_UID");
  process.exit(1);
}

/* -------------------------- Helpers (pure JSON) -------------------------- */
const norm = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/_+/g, "")
    .replace(/-+/g, "")
    .replace(/controller$/g, "");

function canonRawUrl(u) {
  if (!u) return "";
  if (typeof u === "string") return u;
  if (u.raw) return u.raw;
  const proto = u.protocol ? `${u.protocol}://` : "";
  const host = Array.isArray(u.host) ? u.host.join(".") : (u.host || "");
  const pth = Array.isArray(u.path) ? `/${u.path.join("/")}` : (u.path ? `/${u.path}` : "");
  return `${proto}${host}${pth}`;
}

function requestKey(item) {
  if (!item || !item.request) return null;
  const method = item.request.method || "GET";
  const nameOrUrl = item.name && item.name.trim() ? item.name : canonRawUrl(item.request.url);
  return `${method}::${norm(nameOrUrl)}`;
}
const folderKey = (name) => `FOLDER::${norm(name || "")}`;

function ensureJsonCollection(coll, name = COLLECTION_NAME) {
  if (coll && Array.isArray(coll.item)) return coll;
  return {
    info: {
      name,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [],
  };
}

/* ---------------------- Build incoming from Swagger ---------------------- */
function normalizeSpec(raw, file) {
  if (raw.swagger) {
    console.log(`⚠️  ${file}: replacing swagger:2.0 → openapi:3.0.0`);
    delete raw.swagger;
    raw.openapi = "3.0.0";
  }
  if (!raw.openapi) raw.openapi = "3.0.0";
  if (!raw.info) raw.info = {};
  if (!raw.info.version || !/^\d+\.\d+\.\d+$/.test(raw.info.version)) {
    console.log(`⚠️  ${file}: fixing info.version → 1.0.0`);
    raw.info.version = "1.0.0";
  }
  if (!raw.info.title) raw.info.title = path.basename(file);
  return raw;
}

function convertSwagger(specObj) {
  return new Promise((resolve, reject) => {
    converter.convert({ type: "json", data: JSON.stringify(specObj) }, {}, (err, res) => {
      if (err) return reject(err);
      if (!res.result) return reject(res.reason);
      resolve(res.output[0].data); // Postman collection JSON
    });
  });
}

async function buildIncomingFromFiles(pattern = "services/**/designtime/*_API.json") {
  console.log("🔍 Searching for swagger files...");
  const files = glob.sync(pattern);
  console.log(`Found ${files.length} files`);
  const incoming = ensureJsonCollection(null, COLLECTION_NAME);

  for (const file of files) {
    console.log(`⚙️ Converting ${file}`);
    const raw = normalizeSpec(JSON.parse(fs.readFileSync(file, "utf8")), file);
    const newColl = await convertSwagger(raw);
    const service = path.basename(path.dirname(path.dirname(file))); // services/<service>/designtime
    incoming.item.push({ name: service, item: newColl.item || [] });
  }
  return incoming;
}

/* ------------------------------ Merge (JSON) ------------------------------ */
function findOrCreateFolder(dstItems, name) {
  const fk = folderKey(name);
  let f = dstItems.find((x) => !x.request && folderKey(x.name) === fk);
  if (!f) {
    f = { name, item: [] };
    dstItems.push(f);
    console.log(`📁 Adding folder: ${name}`);
  }
  if (!Array.isArray(f.item)) f.item = [];
  return f;
}

function hasRequest(dstItems, req) {
  const key = requestKey(req);
  if (!key) return false;
  for (const x of dstItems) {
    if (x.request && requestKey(x) === key) return true;
  }
  return false;
}

function mergeJsonItems(dstItems, srcItems, parentName = "<root>") {
  for (const s of srcItems || []) {
    if (s.request) {
      if (!hasRequest(dstItems, s)) {
        dstItems.push(s);
        console.log(`➕ Adding request: ${s.name || requestKey(s)} under ${parentName}`);
      } else {
        console.log(`✔️ Skipping duplicate request: ${s.name || requestKey(s)} under ${parentName}`);
      }
    } else if (s.item) {
      const folder = findOrCreateFolder(dstItems, s.name || "Untitled");
      mergeJsonItems(folder.item, s.item, folder.name);
    }
  }
}

function mergeCollections(existing, incoming) {
  const dst = ensureJsonCollection(existing, COLLECTION_NAME);
  mergeJsonItems(dst.item, incoming.item || [], dst.info?.name || "<root>");
  return dst; // plain JSON
}

/* -------------------------- Diff (detect removals) ------------------------ */
function collectKeys(items, out = { requests: new Set(), folders: new Set() }) {
  for (const it of items || []) {
    if (it.request) out.requests.add(requestKey(it));
    else if (it.item) {
      out.folders.add(folderKey(it.name || "Untitled"));
      collectKeys(it.item, out);
    }
  }
  return out;
}

function diffCollections(existingJson, incomingJson) {
  const ex = collectKeys(existingJson.item);
  const inc = collectKeys(incomingJson.item);
  const removedRequests = [...ex.requests].filter((k) => !inc.requests.has(k));
  const removedFolders = [...ex.folders].filter((k) => !inc.folders.has(k));
  return { removedRequests, removedFolders };
}

/* --------------------------------- Main ---------------------------------- */
(async () => {
  try {
    console.log("📥 Fetching existing collection...");
    let getRes = await fetch(`${POSTMAN_BASE}/collections/${TARGET_UID}`, {
      headers: { "X-Api-Key": POSTMAN_API_KEY },
    });

    let existingData;
    if (getRes.status === 404) {
      console.log("ℹ️ Collection not found (404). Will create new.");
      existingData = { collection: ensureJsonCollection(null, COLLECTION_NAME) };
    } else if (!getRes.ok) {
      throw new Error(`Fetch failed: ${getRes.status} ${getRes.statusText}`);
    } else {
      existingData = await getRes.json();
    }

    // Build incoming from files
    const incoming = await buildIncomingFromFiles();

    // Diff
    const existing = ensureJsonCollection(existingData.collection, COLLECTION_NAME);
    const { removedRequests, removedFolders } = diffCollections(existing, incoming);
    if (removedRequests.length || removedFolders.length) {
      console.log("🧹 Detected removals vs Postman:");
      removedFolders.forEach((f) => console.log("  - folder:", f));
      removedRequests.forEach((r) => console.log("  - request:", r));
    } else {
      console.log("✅ No removals detected.");
    }

    // Choose payload (PRUNE => replace; else merge)
    const payload = PRUNE ? incoming : mergeCollections(existing, incoming);

    // Create or Update
    if (getRes.status === 404) {
      console.log("🆕 Creating new collection in Postman...");
      const createRes = await fetch(`${POSTMAN_BASE}/collections`, {
        method: "POST",
        headers: {
          "X-Api-Key": POSTMAN_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ collection: payload }),
      });
      if (!createRes.ok) {
        const err = await createRes.text();
        throw new Error(`POST failed: ${createRes.status} ${err}`);
      }
      console.log("✅ Collection created successfully!");
    } else {
      console.log("📤 Updating collection in Postman...");
      const updateRes = await fetch(`${POSTMAN_BASE}/collections/${TARGET_UID}`, {
        method: "PUT",
        headers: {
          "X-Api-Key": POSTMAN_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ collection: payload }),
      });
      if (!updateRes.ok) {
        const err = await updateRes.text();
        throw new Error(`PUT failed: ${updateRes.status} ${err}`);
      }
      console.log("✅ Collection updated successfully!");
    }
  } catch (err) {
    console.error("❌ Error:", err.message || err);
    process.exit(1);
  }
})();
