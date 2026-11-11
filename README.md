# pusher

A small self-hosted Pushover on Cloudflare Workers. `curl` sends a notification to your phone through Web Push. It is a PWA, so it needs no native app and no Apple Developer account.

A Durable Object (`Hub`) stores device subscriptions. Static files in `public/` are served as Worker assets.

## Setup

```sh
bun install
bunx @pushforge/builder vapid          # copy the JSON private key
bunx wrangler secret put VAPID_JWK     # paste the JSON private key
bunx wrangler secret put TOKEN         # any long random string
bun run deploy
```

For local dev, put the same values in `.dev.vars` (`TOKEN=...` and `VAPID_JWK=...`) and run `bun run dev`.

## Phone (iOS 16.4+)

1. Open `https://<worker-host>/?t=<token>` in Safari.
2. Tap Share → Add to Home Screen, then open Pusher from the Home Screen.
3. Tap **Enable notifications**.

## Send

```sh
curl -d token=<token> -d title=Build -d message="done" https://<worker-host>/send
curl -d token=<token> -d message="go" --data-urlencode "url=shortcuts://run-shortcut?name=X" https://<worker-host>/send
```

When you tap a notification that has a `url`, it opens `/open`, which hands off to the other app.

Messages use the Declarative Web Push format, which iOS 18.4+ shows without JavaScript. `public/sw.js` handles older browsers.
