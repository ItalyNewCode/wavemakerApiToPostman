// merge-postman.js
// npm i openapi-to-postmanv2 node-fetch@2 fs-extra glob dotenv

const fs = require("fs-extra");
const fetch = require("node-fetch");
const glob = require("glob");
const path = require("path");
const converter = require("openapi-to-postmanv2");

const POSTMAN_API_KEY = process.env.POSTMAN_API_KEY;
const TARGET_UID = process.env.POSTMAN_TARGET_UID;
const PRUNE = String(process.env.POSTMAN_PRUNE || "true").toLowerCase() === "true"; // true => deletions propagate
const COLLECTION_NAME = process.env.POSTMAN_COLLECTION_NAME;
const POSTMAN_BASE = "https://api.getpostman.com";

if (!POSTMAN_API_KEY || !TARGET_UID || !COLLECTION_NAME) {
  console.error("Missing POSTMAN_API_KEY or POSTMAN_TARGET_UID or COLLECTION_NAME");
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
    console.log(`${file}: replacing swagger:2.0 → openapi:3.0.0`);
    delete raw.swagger;
    raw.openapi = "3.0.0";
  }
  if (!raw.openapi) raw.openapi = "3.0.0";
  if (!raw.info) raw.info = {};
  if (!raw.info.version || !/^\d+\.\d+\.\d+$/.test(raw.info.version)) {
    console.log(`${file}: fixing info.version → 1.0.0`);
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
  console.log("Searching for swagger files...");
  const files = glob.sync(pattern);
  console.log(`Found ${files.length} files`);
  const incoming = ensureJsonCollection(null, COLLECTION_NAME);

  for (const file of files) {
    console.log(`Converting ${file}`);
    const raw = normalizeSpec(JSON.parse(fs.readFileSync(file, "utf8")), file);
    const newColl = await convertSwagger(raw);
    const service = path.basename(path.dirname(path.dirname(file))); // services/<service>/designtime
    incoming.item.push({ name: service, item: newColl.item || [] });
  }
  return incoming;
}

/* ------------------------- Metadata merge helpers ------------------------ */
const isNonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : v && Object.keys(v || {}).length > 0);

function eventKey(ev) {
  const listen = ev?.listen || "";
  const id = ev?.script?.id || "";
  const type = ev?.script?.type || "";
  const exec = Array.isArray(ev?.script?.exec) ? ev.script.exec.join("\n") : "";
  // Prefer id, fallback a type+hash(exec)
  const content = id || `${type}:${hash(exec)}`;
  return `${listen}:${content}`;
}

function hash(str) {
  // semplice hash non-critico
  let h = 0;
  for (let i = 0; i < (str || "").length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return h.toString(16);
}

function mergeEvents(dstArr, srcArr) {
  const out = Array.isArray(dstArr) ? [...dstArr] : [];
  const seen = new Set(out.map(eventKey));
  for (const ev of srcArr || []) {
    const k = eventKey(ev);
    if (!seen.has(k)) {
      out.push(ev);
      seen.add(k);
    }
  }
  return out;
}

function mergeVariables(dstArr, srcArr) {
  const byKey = new Map();
  for (const v of dstArr || []) byKey.set(v?.key, v);
  for (const v of srcArr || []) {
    const k = v?.key;
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, v); // aggiungi solo se mancante
    // Se esiste già, manteniamo quello esistente (priorità all'esistente)
  }
  return Array.from(byKey.values());
}

function mergeAuth(dstAuth, srcAuth) {
  // Regola: mantieni auth esistente se presente; altrimenti usa quella in arrivo
  if (isNonEmpty(dstAuth)) return dstAuth;
  if (isNonEmpty(srcAuth)) return srcAuth;
  return dstAuth || srcAuth || undefined;
}

/* -------------------- Walk & merge (collection structure) ----------------- */
function indexExisting(existing) {
  const map = {
    collection: existing,
    folders: new Map(), // key -> node
    requests: new Map(), // key -> item
  };

  function walk(items) {
    for (const it of items || []) {
      if (it.request) {
        const rk = requestKey(it);
        if (rk) map.requests.set(rk, it);
      } else if (it.item) {
        const fk = folderKey(it.name || "Untitled");
        map.folders.set(fk, it);
        walk(it.item);
      }
    }
  }

  walk(existing.item || []);
  return map;
}

// Applica il merge dei metadati dall'esistente all'incoming (senza alterare le request payload)
function preserveMetadata(existing, incoming) {
  // collection-level
  incoming.auth = mergeAuth(incoming.auth, existing.auth);
  incoming.event = mergeEvents(existing.event, incoming.event);
  incoming.variable = mergeVariables(existing.variable, incoming.variable);

  const exIdx = indexExisting(existing);

  function walkPair(exNode, inNode) {
    // merge metadati su folder-level
    if (!inNode) return;

    // Folder-level variable/event (solo se il nodo è un gruppo)
    if (inNode.item && !inNode.request) {
      const exFolder =
        exNode && exNode.item && !exNode.request ? exNode : exIdx.folders.get(folderKey(inNode.name || "Untitled"));
      if (exFolder) {
        inNode.event = mergeEvents(exFolder.event, inNode.event);
        inNode.variable = mergeVariables(exFolder.variable, inNode.variable);
        inNode.auth = mergeAuth(inNode.auth, exFolder.auth);
      }
      // Ricorsione sui figli
      const inChildren = inNode.item || [];
      const exChildren = (exFolder && exFolder.item) || [];
      // per velocità, indicizza i figli esistenti per key
      const exChildReqs = new Map();
      const exChildFolders = new Map();
      for (const c of exChildren) {
        if (c.request) exChildReqs.set(requestKey(c), c);
        else exChildFolders.set(folderKey(c.name || "Untitled"), c);
      }
      for (const c of inChildren) {
        if (c.request) {
          const exReq = exChildReqs.get(requestKey(c));
          if (exReq) {
            // Request-level merge metadati
            c.event = mergeEvents(exReq.event, c.event);
            c.request.auth = mergeAuth(c.request.auth, exReq.request?.auth);
          }
        } else if (c.item) {
          const exFold = exChildFolders.get(folderKey(c.name || "Untitled"));
          walkPair(exFold, c);
        }
      }
    }

    // Se è una request singola (caso raro chiamato direttamente)
    if (inNode.request) {
      const exReq = exIdx.requests.get(requestKey(inNode));
      if (exReq) {
        inNode.event = mergeEvents(exReq.event, inNode.event);
        inNode.request.auth = mergeAuth(inNode.request.auth, exReq.request?.auth);
      }
    }
  }

  // Avvia dal root
  for (const child of incoming.item || []) {
    if (child.request) {
      const exReq = exIdx.requests.get(requestKey(child));
      if (exReq) {
        child.event = mergeEvents(exReq.event, child.event);
        child.request.auth = mergeAuth(child.request.auth, exReq.request?.auth);
      }
    } else if (child.item) {
      const exFold = exIdx.folders.get(folderKey(child.name || "Untitled"));
      walkPair(exFold, child);
    }
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
    console.log(`Adding folder: ${name}`);
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
        console.log(`Adding request: ${s.name || requestKey(s)} under ${parentName}`);
      } else {
        // Se la request esiste, facciamo almeno il merge dei metadati (auth/event)
        const idx = dstItems.findIndex((x) => x.request && requestKey(x) === requestKey(s));
        if (idx >= 0) {
          const dstIt = dstItems[idx];
          dstIt.event = mergeEvents(dstIt.event, s.event);
          dstIt.request.auth = mergeAuth(dstIt.request?.auth, s.request?.auth);
          console.log(`Merged metadata into existing request: ${s.name || requestKey(s)} under ${parentName}`);
        } else {
          console.log(`Skipping duplicate request: ${s.name || requestKey(s)} under ${parentName}`);
        }
      }
    } else if (s.item) {
      const folder = findOrCreateFolder(dstItems, s.name || "Untitled");
      // merge metadati di folder
      folder.event = mergeEvents(folder.event, s.event);
      folder.variable = mergeVariables(folder.variable, s.variable);
      folder.auth = mergeAuth(folder.auth, s.auth);
      mergeJsonItems(folder.item, s.item, folder.name);
    }
  }
}

function mergeCollections(existing, incoming) {
  const dst = ensureJsonCollection(existing, COLLECTION_NAME);

  // merge metadati a livello collection PRIMA degli item
  dst.event = mergeEvents(dst.event, incoming.event);
  dst.variable = mergeVariables(dst.variable, incoming.variable);
  dst.auth = mergeAuth(dst.auth, incoming.auth);

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
    console.log("Fetching existing collection...");
    const getRes = await fetch(`${POSTMAN_BASE}/collections/${TARGET_UID}`, {
      headers: { "X-Api-Key": POSTMAN_API_KEY },
    });
    const getJson = await getRes.json().catch(() => ({}));

    let existingData;
    if (getRes.status === 404) {
      console.log("Collection not found (404). Will create new.");
      existingData = { collection: ensureJsonCollection(null, COLLECTION_NAME) };
    } else if (!getRes.ok) {
      throw new Error(`Fetch failed: ${getRes.status} ${getRes.statusText}`);
    } else {
      existingData = getJson;
    }

    // Build incoming from files (pura struttura dagli swagger)
    const incomingRaw = await buildIncomingFromFiles();

    // Prendiamo l'esistente (normalizzato)
    const existing = ensureJsonCollection(existingData.collection, COLLECTION_NAME);

    // Diff per log
    const { removedRequests, removedFolders } = diffCollections(existing, incomingRaw);
    if (removedRequests.length || removedFolders.length) {
      console.log("Detected removals vs Postman:");
      removedFolders.forEach((f) => console.log("  - folder:", f));
      removedRequests.forEach((r) => console.log("  - request:", r));
    } else {
      console.log("No removals detected.");
    }

    // 1) Prima preserviamo i METADATI dell’esistente dentro l’incoming (auth/event/variable)
    //    Così anche con PRUNE=true non perdiamo setup.
    const incomingWithMeta = preserveMetadata(existing, JSON.parse(JSON.stringify(incomingRaw)));

    // 2) Scegliamo il payload finale:
    //    - PRUNE=true: usiamo la struttura incoming (con metadati preservati)
    //    - PRUNE=false: merge strutturale + metadati
    const payload = PRUNE
      ? incomingWithMeta
      : mergeCollections(existing, incomingWithMeta);

    // Create or Update
    if (getRes.status === 404) {
      console.log("Creating new collection in Postman...");
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
      console.log("Collection created successfully!");
    } else {
      console.log("Updating collection in Postman...");
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
      console.log("Collection updated successfully!");
    }
  } catch (err) {
    console.error("Error:", err.message || err);
    process.exit(1);
  }
})();
