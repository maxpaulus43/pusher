# pusher

A small self-hosted Pushover. `curl` sends a notification to your phone through Web Push. It is a PWA, so it needs no native app and no Apple Developer account.

## Run

```sh
bun install
bun start                      # prints your token, listens on :8787
tailscale funnel --bg 8787     # public HTTPS, needed for service workers and push
```

## Phone (iOS 16.4+)

1. Open `https://<your-funnel-host>/?t=<token>` in Safari.
2. Tap Share → Add to Home Screen, then open Pusher from the Home Screen.
3. Tap **Enable notifications**.

## Send

```sh
curl -d token=<token> -d title=Build -d message="done" https://<your-funnel-host>/send
```

Optional field: `url`, the page that opens when you tap the notification.

Messages use the Declarative Web Push format, which iOS 18.4+ shows without JavaScript. `public/sw.js` handles older browsers. The token, VAPID keys and subscriptions are stored in `data/state.json`. Do not commit this file.
