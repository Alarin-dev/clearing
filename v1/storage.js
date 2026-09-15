/*
  Storage layer -- IndexedDB, entirely client-side.

  Mirrors storage.py's guarantees:
  - raw_text is written once and never modified by any function here.
  - passages carry raw_text + section metadata; only 'section' ever
    changes after creation.
  - composition is a separate, single record per session, fully
    disposable and regenerated freely.
  - kept phrases are separate again: things the user explicitly chose
    to preserve from a composition, protected the same way raw
    streams are.

  Everything is scoped by sessionId so multiple sessions can coexist
  and be archived without deleting anything.
*/

const DB_NAME = "reflective-thinking";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains("streams")) {
        const store = db.createObjectStore("streams", { keyPath: "id" });
        store.createIndex("sessionId", "sessionId");
      }
      if (!db.objectStoreNames.contains("passages")) {
        const store = db.createObjectStore("passages", { keyPath: "id" });
        store.createIndex("sessionId", "sessionId");
      }
      if (!db.objectStoreNames.contains("kept")) {
        const store = db.createObjectStore("kept", { keyPath: "id" });
        store.createIndex("sessionId", "sessionId");
      }
      if (!db.objectStoreNames.contains("composition")) {
        db.createObjectStore("composition", { keyPath: "sessionId" });
      }
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeNames, mode = "readonly") {
  return db.transaction(storeNames, mode);
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function newId() {
  return crypto.randomUUID().slice(0, 8);
}

const Storage = {
  async currentSessionId() {
    let id = localStorage.getItem("rt_current_session");
    if (!id) {
      id = newId();
      localStorage.setItem("rt_current_session", id);
      const db = await openDB();
      const t = tx(db, ["sessions"], "readwrite");
      t.objectStore("sessions").put({ id, createdAt: new Date().toISOString(), archived: false });
    }
    return id;
  },

  async saveRawStream(text) {
    const db = await openDB();
    const sessionId = await this.currentSessionId();
    const record = {
      id: newId(),
      sessionId,
      raw_text: text,
      timestamp: new Date().toISOString(),
    };
    const t = tx(db, ["streams"], "readwrite");
    t.objectStore("streams").put(record);
    return promisify(t.objectStore("streams").get(record.id)).then(() => record);
  },

  async loadRawStreams(sessionId) {
    const db = await openDB();
    const t = tx(db, ["streams"]);
    const index = t.objectStore("streams").index("sessionId");
    const results = await promisify(index.getAll(sessionId));
    return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  },

  async addPassage(raw_text, section) {
    const db = await openDB();
    const sessionId = await this.currentSessionId();
    const passage = {
      id: newId(),
      sessionId,
      raw_text,
      section,
      timestamp: new Date().toISOString(),
    };
    const t = tx(db, ["passages"], "readwrite");
    t.objectStore("passages").put(passage);
    return passage;
  },

  async loadPassages(sessionId) {
    const db = await openDB();
    const t = tx(db, ["passages"]);
    const index = t.objectStore("passages").index("sessionId");
    const results = await promisify(index.getAll(sessionId));
    return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  },

  async updatePassageSection(passageId, newSection) {
    const db = await openDB();
    const t = tx(db, ["passages"], "readwrite");
    const store = t.objectStore("passages");
    const passage = await promisify(store.get(passageId));
    if (!passage) return false;
    passage.section = newSection;
    store.put(passage);
    return true;
  },

  async deleteLastPassage(sessionId) {
    const passages = await this.loadPassages(sessionId);
    if (passages.length === 0) return null;
    const last = passages[passages.length - 1];
    const db = await openDB();
    const t = tx(db, ["passages"], "readwrite");
    t.objectStore("passages").delete(last.id);
    return last;
  },

  async existingSectionNames(sessionId) {
    const passages = await this.loadPassages(sessionId);
    const seen = [];
    for (const p of passages) {
      if (!seen.includes(p.section)) seen.push(p.section);
    }
    return seen;
  },

  async saveComposition(sessionId, text) {
    const db = await openDB();
    const t = tx(db, ["composition"], "readwrite");
    const store = t.objectStore("composition");
    const existing = await promisify(store.get(sessionId));
    if (existing) {
      // keep exactly one backup, never more -- disposable layer, no need for full history
      existing.previous = existing.text;
      existing.text = text;
      store.put(existing);
    } else {
      store.put({ sessionId, text, previous: null });
    }
  },

  async loadComposition(sessionId) {
    const db = await openDB();
    const t = tx(db, ["composition"]);
    const record = await promisify(t.objectStore("composition").get(sessionId));
    return record ? record.text : null;
  },

  async addKept(sessionId, text, source) {
    const db = await openDB();
    const record = {
      id: newId(),
      sessionId,
      text,
      source, // "composition" -- where it was pulled from, for provenance
      timestamp: new Date().toISOString(),
    };
    const t = tx(db, ["kept"], "readwrite");
    t.objectStore("kept").put(record);
    return record;
  },

  async loadKept(sessionId) {
    const db = await openDB();
    const t = tx(db, ["kept"]);
    const index = t.objectStore("kept").index("sessionId");
    const results = await promisify(index.getAll(sessionId));
    return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  },

  async removeKept(keptId) {
    const db = await openDB();
    const t = tx(db, ["kept"], "readwrite");
    t.objectStore("kept").delete(keptId);
  },

  async startNewSession() {
    const db = await openDB();
    const oldId = await this.currentSessionId();

    const t = tx(db, ["sessions"], "readwrite");
    const store = t.objectStore("sessions");
    const record = await promisify(store.get(oldId));
    if (record) {
      record.archived = true;
      record.archivedAt = new Date().toISOString();
      store.put(record);
    }

    const newIdValue = newId();
    localStorage.setItem("rt_current_session", newIdValue);
    const t2 = tx(db, ["sessions"], "readwrite");
    t2.objectStore("sessions").put({ id: newIdValue, createdAt: new Date().toISOString(), archived: false });

    return { archivedSessionId: oldId, newSessionId: newIdValue };
  },

  async listSessions() {
    const db = await openDB();
    const t = tx(db, ["sessions"]);
    const results = await promisify(t.objectStore("sessions").getAll());
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  renderDocument(passages) {
    if (!passages || passages.length === 0) {
      return "# Emerging thoughts\n\n*No thoughts streamed yet.*\n";
    }

    const sections = {};
    const order = [];
    for (const p of passages) {
      if (!(p.section in sections)) {
        sections[p.section] = [];
        order.push(p.section);
      }
      sections[p.section].push(p);
    }

    let doc = "# Emerging thoughts\n\n";
    for (const name of order) {
      doc += `## ${name}\n\n`;
      const items = [...sections[name]].reverse(); // newest first
      for (const item of items) {
        const quoted = item.raw_text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        doc += `${quoted}\n\n`;
      }
    }
    return doc;
  },
};
