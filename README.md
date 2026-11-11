# pusher

A small self-hosted Pushover on Cloudflare Workers. `curl` sends a notification to your phone through Web Push. It is a PWA, so it needs no native app and no Apple Developer account.

A Durable Object (`Hub`) stores device subscriptions. Static files in `public/` are served as Worker assets.

## Use it

1. Open the site in Safari on iPhone (iOS 16.4+) and tap **Get started**. On a computer, scan the QR code with your phone.
2. Tap Share → **Add to Home Screen**, then open Pusher from the Home Screen.
3. Tap **Enable notifications**.
4. Tap **+** to add a channel, then copy its URL:

```sh
curl "https://<host>/c/<account id>/<channel key>?m=hello"     # GET works from a browser or Shortcuts
curl -d m=hello -d t=Title -d u=spotify:// https://<host>/c/<account id>/<channel key>
```

To add another device, scan the **Add a device** QR code in the app.

## How accounts work

There is no sign-up. **Get started** creates a random key, and the key is the account. The link `/?k=<key>` carries it to the Home Screen app, because Safari and the Home Screen app don't share storage. Anyone with the link controls the account, so keep it private.

Each account has its own Durable Object (`Hub`), named by a hash of the key, which stores the account's devices and channels. Channel URLs contain the hash, not the key.

Limits: 10 devices and 50 channels per account, and 30 sends per minute per account. The server only accepts subscriptions from real push services.

## Deploy

```sh
bun install
bunx @pushforge/builder vapid          # copy the JSON private key
bunx wrangler secret put VAPID_JWK     # paste the JSON private key
bun run deploy
```

For local dev, put `VAPID_JWK=...` in `.dev.vars` and run `bun run dev`.

When you tap a notification that has a link, it opens `/open`, which hands off to the other app.

Messages use the Declarative Web Push format, which iOS 18.4+ shows without JavaScript. `public/sw.js` handles older browsers.
