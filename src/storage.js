// Storage for contacts, the provider setting and the attempt log.
//
// A store has three parts, all async:
//   contacts: list(), get(slug), save(contact), delete(slug)
//   provider: get(), save({ provider, config, secrets }), delete()
//   log:      append(entry), list(limit), purge(days)
// Hosts may bring their own (LCYT keeps its SQL one). This package ships an in-memory store
// for tests and a JSON file store that is encrypted as a whole.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const DAY_MS = 86_400_000;
const MAX_LOG = 2000;

function emptyDoc() {
  return { contacts: [], provider: null, log: [] };
}

const clone = (v) => (v == null ? v : structuredClone(v));

/** Operations on a document held by `load`/`persist`. Shared by both stores. */
function createStore({ load, persist, now = Date.now }) {
  // Writers run one after another, so two saves never overwrite each other's change.
  let chain = Promise.resolve();
  const mutate = (fn) => {
    const run = chain.then(async () => {
      const doc = await load();
      const result = fn(doc);
      await persist(doc);
      return result;
    });
    chain = run.catch(() => {});
    return run;
  };
  const read = async () => (await chain.catch(() => {}), load());

  return {
    contacts: {
      async list() {
        return clone((await read()).contacts).sort((a, b) => a.slug.localeCompare(b.slug));
      },
      async get(slug) {
        return clone((await read()).contacts.find((c) => c.slug === slug) ?? null);
      },
      save: (contact) => mutate((doc) => {
        const i = doc.contacts.findIndex((c) => c.slug === contact.slug);
        const row = { ...clone(contact), updatedAt: now() };
        if (i >= 0) doc.contacts[i] = { ...row, createdAt: doc.contacts[i].createdAt ?? row.updatedAt };
        else doc.contacts.push({ ...row, createdAt: row.updatedAt });
        return clone(doc.contacts.find((c) => c.slug === contact.slug));
      }),
      delete: (slug) => mutate((doc) => {
        const before = doc.contacts.length;
        doc.contacts = doc.contacts.filter((c) => c.slug !== slug);
        return doc.contacts.length < before;
      }),
    },
    provider: {
      async get() {
        return clone((await read()).provider);
      },
      save: (rec) => mutate((doc) => {
        doc.provider = { provider: rec.provider, config: clone(rec.config ?? {}), secrets: clone(rec.secrets ?? {}), updatedAt: now() };
        return clone(doc.provider);
      }),
      delete: () => mutate((doc) => {
        const had = doc.provider !== null;
        doc.provider = null;
        return had;
      }),
    },
    log: {
      append: (entry) => mutate((doc) => {
        doc.log.push({ at: now(), ...clone(entry) });
        if (doc.log.length > MAX_LOG) doc.log.splice(0, doc.log.length - MAX_LOG);
      }),
      async list(limit = 100) {
        return clone((await read()).log.slice(-limit).reverse());
      },
      purge: (days = 90) => mutate((doc) => {
        const cutoff = now() - days * DAY_MS;
        const before = doc.log.length;
        doc.log = doc.log.filter((e) => e.at >= cutoff);
        return before - doc.log.length;
      }),
    },
  };
}

/** In-memory store for tests and short-lived hosts. */
export function createMemoryStore({ now } = {}) {
  let doc = emptyDoc();
  return createStore({ load: async () => doc, persist: async (d) => { doc = d; }, now });
}

/**
 * JSON file, encrypted as a whole with a secret box (see secret-box.js). The file is written
 * to a temporary name with mode 0600 and renamed over the old one, so a crash never leaves a
 * half-written file. A missing file is an empty store; a file that cannot be decrypted is an
 * error (it is never replaced silently).
 * @param {{ path: string, secretBox: { encrypt: Function, decrypt: Function }, now?: () => number }} opts
 */
export function createJsonFileStore({ path, secretBox, now }) {
  if (!path) throw new Error('json file store needs a path');
  if (!secretBox) throw new Error('json file store needs a secret box (data is always encrypted at rest)');
  const AAD = 'notify-core:store:v1';

  async function load() {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return emptyDoc();
      throw err;
    }
    return { ...emptyDoc(), ...JSON.parse(secretBox.decrypt(text.trim(), AAD)) };
  }

  async function persist(doc) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, secretBox.encrypt(JSON.stringify(doc), AAD), { mode: 0o600 });
    await rename(tmp, path);
  }

  return createStore({ load, persist, now });
}

/**
 * Contacts that come from the host's environment (for example the superuser). They are listed
 * and readable but cannot be saved over or deleted through the store, and a stored contact
 * cannot use their slug.
 * @param {ReturnType<typeof createStore>['contacts']} contacts
 * @param {Array<object>} fixed contacts as validateContact returns them
 */
export function withFixedContacts(contacts, fixed) {
  const bySlug = new Map(fixed.map((c) => [c.slug, { ...c, fixed: true }]));
  const refuse = (slug) => {
    throw new Error(`contact "${slug}" is set by the environment and cannot be changed here`);
  };
  return {
    async list() {
      const stored = (await contacts.list()).filter((c) => !bySlug.has(c.slug));
      return [...bySlug.values(), ...stored].sort((a, b) => a.slug.localeCompare(b.slug));
    },
    async get(slug) {
      return bySlug.get(slug) ? { ...bySlug.get(slug) } : contacts.get(slug);
    },
    async save(contact) {
      if (bySlug.has(contact.slug)) refuse(contact.slug);
      return contacts.save(contact);
    },
    async delete(slug) {
      if (bySlug.has(slug)) refuse(slug);
      return contacts.delete(slug);
    },
  };
}
