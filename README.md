# notify-core

Notification core for email and SMS (phone calls later): one service that applies consent, an active flag, a per-contact cooldown and hourly/daily caps before any provider call, and logs every attempt. Extracted from the `lcyt-notify` plugin of [live-captions-yt](https://github.com/jsilvanus/live-captions-yt) so LCYT and the Pi services (`pinotify`) share one implementation.

ESM, Node >= 20, EUPL-1.2. Not verified against the real providers: the Brevo SMS request format in particular was taken from search extracts and should be checked against Brevo's reference before production use.

## What is in it

- `createNotifyService({ adapters, limits, cooldownMs, now, onLog })`: `send({ channel, contact, text, subject, trigger })` returns a result (`sent`, `skipped_*`, `cooldown`, `rate_limited`, `failed`), provider errors are results, never thrown.
- Adapters: `createBrevoEmailAdapter`, `createBrevoSmsAdapter`, `createSmtpEmailAdapter` (email only; `nodemailer` is an optional peer dependency, loaded only when no `transportFactory` is given). Keys and passwords never appear in errors.
- `validateContact`, `validateProvider`, `buildNotifyAdapters`: pure validation and wiring (no database, no HTTP).
- `createSecretBox(key)`: AES-256-GCM envelopes for data at rest. The key comes from the host's environment (64 hex characters or base64) and is never stored here.
- Stores (async, one interface): `createMemoryStore()` for tests, `createJsonFileStore({ path, secretBox })` which keeps contacts, the provider setting and the log in one file that is encrypted as a whole (mode 0600, atomic replace; a wrong key or damaged file is an error and the file is never replaced silently). Hosts can bring their own store (LCYT keeps its SQL one).
- `withFixedContacts(store.contacts, [...])`: contacts set by the environment (for example a superuser) that cannot be edited or shadowed through the store.

```js
import { createNotifyService, buildNotifyAdapters, createJsonFileStore, createSecretBox } from '@jsilvanus/notify-core';

const store = createJsonFileStore({
  path: '/var/lib/pinotify/notify.enc',
  secretBox: createSecretBox(process.env.PINOTIFY_SECRET_KEY),
});
const provider = await store.provider.get();
const adapters = provider ? buildNotifyAdapters(provider.provider, provider.config, provider.secrets) : {};
const notify = createNotifyService({ adapters, onLog: (e) => store.log.append(e) });
await notify.send({ channel: 'sms', contact: await store.contacts.get('warden'), text: 'Candles are still on.', trigger: 'manual' });
```

## Privacy

Contact details and provider secrets are personal data or credentials: keep the key and the data file outside any repository, keep consent per channel on each contact, and log masked recipients only. Contact data never belongs in git.

## Development

```
npm install
npm test        # node:test, fake HTTP servers, no real sends
npm run changeset
```

Releases use Changesets and npm trusted publishing (`.github/workflows/release.yml`); register that workflow as a Trusted Publisher for `@jsilvanus/notify-core` on npmjs.com before the first release.
