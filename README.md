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

## Channels

In the Pusher web app, tap **+** to add a channel. Each channel has a name, an emoji (added to the start of the title, because iOS ignores notification icons), an optional link to open on tap, and its own secret URL:

```sh
curl "https://<worker-host>/c/<key>?m=hello"              # GET works from a browser or Shortcuts
curl -d m=hello -d t=Title -d u=spotify:// https://<worker-host>/c/<key>
```

When you tap a notification that has a `url`, it opens `/open`, which hands off to the other app.

Messages use the Declarative Web Push format, which iOS 18.4+ shows without JavaScript. `public/sw.js` handles older browsers.
