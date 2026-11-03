import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createMemoryStore, createJsonFileStore, withFixedContacts } from '../src/storage.js';
import { createSecretBox } from '../src/secret-box.js';

const contact = (slug, extra = {}) => ({
  slug, name: null, email: `${slug}@example.test`, smsNumber: '+358401234567',
  consentEmail: true, consentSms: true, active: true, ...extra,
});

async function withFileStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'notify-core-'));
  const path = join(dir, 'data', 'notify.enc');
  const box = createSecretBox(randomBytes(32));
  try {
    await fn({ path, box, make: (now) => createJsonFileStore({ path, secretBox: box, now }) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function contract(store, now) {
  // contacts
  assert.deepEqual(await store.contacts.list(), []);
  await store.contacts.save(contact('bob'));
  await store.contacts.save(contact('alice'));
  assert.deepEqual((await store.contacts.list()).map((c) => c.slug), ['alice', 'bob']);
  const t0 = (await store.contacts.get('bob')).createdAt;
  now.t += 1000;
  await store.contacts.save(contact('bob', { name: 'Bob' }));
  const bob = await store.contacts.get('bob');
  assert.equal(bob.name, 'Bob');
  assert.equal(bob.createdAt, t0);
  assert.equal(bob.updatedAt, t0 + 1000);
  assert.equal(await store.contacts.get('nobody'), null);
  assert.equal(await store.contacts.delete('bob'), true);
  assert.equal(await store.contacts.delete('bob'), false);
  // returned objects are copies
  const a = await store.contacts.get('alice');
  a.email = 'changed';
  assert.equal((await store.contacts.get('alice')).email, 'alice@example.test');
  // provider
  assert.equal(await store.provider.get(), null);
  await store.provider.save({ provider: 'brevo', config: { senderEmail: 's@example.test' }, secrets: { apiKey: 'k' } });
  assert.equal((await store.provider.get()).secrets.apiKey, 'k');
  assert.equal(await store.provider.delete(), true);
  assert.equal(await store.provider.get(), null);
  // log: newest first, purge by age
  await store.log.append({ status: 'sent' });
  now.t += 40 * 86_400_000;
  await store.log.append({ status: 'cooldown' });
  assert.deepEqual((await store.log.list(10)).map((e) => e.status), ['cooldown', 'sent']);
  assert.equal(await store.log.purge(30), 1);
  assert.deepEqual((await store.log.list(10)).map((e) => e.status), ['cooldown']);
}

test('memory store follows the store contract', async () => {
  const now = { t: 1_000_000 };
  await contract(createMemoryStore({ now: () => now.t }), now);
});

test('json file store follows the store contract and survives a reopen', async () => {
  await withFileStore(async ({ make }) => {
    const now = { t: 1_000_000 };
    await contract(make(() => now.t), now);
    await make().contacts.save(contact('carol'));
    assert.equal((await make().contacts.get('carol')).slug, 'carol');
  });
});

test('json file store: the file is encrypted, private and replaced atomically', async () => {
  await withFileStore(async ({ path, make }) => {
    const store = make();
    await store.contacts.save(contact('dave', { email: 'dave.private@example.test' }));
    await store.provider.save({ provider: 'brevo', config: {}, secrets: { apiKey: 'brevo-key-123' } });
    const text = await readFile(path, 'utf8');
    for (const secret of ['dave', 'private@example.test', 'brevo-key-123', '+358401234567']) {
      assert.ok(!text.includes(secret), `file leaks ${secret}`);
    }
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test('json file store: concurrent saves are all kept', async () => {
  await withFileStore(async ({ make }) => {
    const store = make();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.contacts.save(contact(`c${String(i).padStart(2, '0')}`))));
    assert.equal((await store.contacts.list()).length, 20);
  });
});

test('json file store: a wrong key or damaged file is an error, never silently replaced', async () => {
  await withFileStore(async ({ path, make }) => {
    await make().contacts.save(contact('erin'));
    const wrong = createJsonFileStore({ path, secretBox: createSecretBox(randomBytes(32)) });
    await assert.rejects(() => wrong.contacts.list(), { name: 'SecretBoxError' });
    await assert.rejects(() => wrong.contacts.save(contact('x')), { name: 'SecretBoxError' });
    await writeFile(path, 'not an envelope');
    await assert.rejects(() => make().contacts.list(), { name: 'SecretBoxError' });
  });
});

test('json file store needs a secret box', () => {
  assert.throws(() => createJsonFileStore({ path: '/tmp/x' }), /secret box/);
});

test('fixed contacts from the environment cannot be changed or shadowed', async () => {
  const store = createMemoryStore();
  await store.contacts.save(contact('anna'));
  const contacts = withFixedContacts(store.contacts, [contact('superuser')]);
  assert.deepEqual((await contacts.list()).map((c) => [c.slug, !!c.fixed]), [['anna', false], ['superuser', true]]);
  assert.equal((await contacts.get('superuser')).fixed, true);
  await assert.rejects(() => contacts.save(contact('superuser')), /set by the environment/);
  await assert.rejects(() => contacts.delete('superuser'), /set by the environment/);
  await contacts.save(contact('anna', { name: 'Anna' }));
  assert.equal((await contacts.get('anna')).name, 'Anna');
});
