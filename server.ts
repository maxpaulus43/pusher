import { generateVAPIDKeys, sendNotification, type PushSubscription } from "web-push";

const PORT = Number(process.env.PORT ?? 8787);
const STATE_FILE = "data/state.json";

type State = {
  vapid: { publicKey: string; privateKey: string };
  token: string;
  subs: PushSubscription[];
};

// shortcut: one user, state in a JSON file. Move to SQLite when you add users.
const file = Bun.file(STATE_FILE);
const state: State = (await file.exists())
  ? await file.json()
  : { vapid: generateVAPIDKeys(), token: crypto.randomUUID().replaceAll("-", ""), subs: [] };
const save = () => Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
await save();

async function send(title: string, body: string, url: string, origin: string) {
  // Declarative Web Push format (Safari 18.4+ shows it without JS). sw.js handles older browsers.
  const payload = JSON.stringify({ web_push: 8030, notification: { title, body, navigate: url } });
  let sent = 0;
  for (const sub of [...state.subs]) {
    try {
      await sendNotification(sub, payload, {
        TTL: 86400,
        urgency: "high",
        // Apple rejects subjects like mailto:x@localhost with 403 BadJwtToken, so use our public URL.
        vapidDetails: { subject: origin, ...state.vapid },
      });
      sent++;
    } catch (e: any) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        state.subs = state.subs.filter((s) => s.endpoint !== sub.endpoint);
        await save();
      } else console.error("push failed", e.statusCode ?? e.message, e.body ?? "");
    }
  }
  return sent;
}

Bun.serve({
  port: PORT,
  routes: {
    "/": Bun.file("public/index.html"),
    "/sw.js": Bun.file("public/sw.js"),
    "/manifest.json": Bun.file("public/manifest.json"),
    "/icon.svg": Bun.file("public/icon.svg"),
    "/vapid": () => Response.json({ publicKey: state.vapid.publicKey }),

    "/subscribe": {
      POST: async (req) => {
        const { token, subscription } = (await req.json()) as { token: string; subscription: PushSubscription };
        if (token !== state.token) return new Response("bad token\n", { status: 401 });
        state.subs = state.subs.filter((s) => s.endpoint !== subscription.endpoint);
        state.subs.push(subscription);
        await save();
        return Response.json({ devices: state.subs.length });
      },
    },

    // curl -d token=... -d message=hi [-d title=...] [-d url=...] https://host/send
    "/send": {
      POST: async (req) => {
        const form = await req.formData();
        if (form.get("token") !== state.token) return new Response("bad token\n", { status: 401 });
        const message = String(form.get("message") ?? "");
        if (!message) return new Response("message required\n", { status: 400 });
        const origin = req.headers.get("x-forwarded-host")
          ? `https://${req.headers.get("x-forwarded-host")}`
          : new URL(req.url).origin;
        const sent = await send(String(form.get("title") ?? "Pusher"), message, String(form.get("url") ?? origin + "/"), origin);
        return new Response(`sent to ${sent}/${state.subs.length} devices\n`);
      },
    },
  },
  fetch: () => new Response("not found\n", { status: 404 }),
});

console.log(`pusher on http://localhost:${PORT}`);
console.log(`token: ${state.token}`);
console.log(`devices: ${state.subs.length}`);
