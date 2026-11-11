import { DurableObject } from "cloudflare:workers";
import { buildPushHTTPRequest } from "@pushforge/builder";

type Env = { HUB: DurableObjectNamespace<Hub>; TOKEN: string; VAPID_JWK: string };
type Payload = { web_push: 8030; notification: { title: string; body: string; navigate: string } };
type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };
// The key is the channel's secret: anyone with /c/<key> can send to it.
type Channel = { key: string; name: string; emoji: string; url: string };

// Holds every device subscription. shortcut: one user, one Hub instance; key it by user when you add accounts.
export class Hub extends DurableObject<Env> {
  async subscribe(sub: Sub) {
    await this.ctx.storage.put(`sub:${sub.endpoint}`, sub);
    return (await this.ctx.storage.list({ prefix: "sub:" })).size;
  }

  async channels() {
    return [...(await this.ctx.storage.list<Channel>({ prefix: "ch:" })).values()];
  }
  async channel(key: string) {
    return this.ctx.storage.get<Channel>(`ch:${key}`);
  }
  async saveChannel(ch: Channel) {
    await this.ctx.storage.put(`ch:${ch.key}`, ch);
  }
  async deleteChannel(key: string) {
    await this.ctx.storage.delete(`ch:${key}`);
  }

  async send(payload: Payload, origin: string) {
    const subs = [...(await this.ctx.storage.list<Sub>({ prefix: "sub:" })).values()];
    let sent = 0;
    for (const sub of subs) {
      const { endpoint, headers, body } = await buildPushHTTPRequest({
        privateJWK: this.env.VAPID_JWK,
        subscription: sub,
        // Apple rejects mailto:x@localhost-style subjects (403 BadJwtToken), so use our public URL.
        message: { payload, adminContact: origin, options: { ttl: 86400, urgency: "high" } },
      });
      const res = await fetch(endpoint, { method: "POST", headers, body });
      if (res.ok) sent++;
      else if (res.status === 404 || res.status === 410) await this.ctx.storage.delete(`sub:${sub.endpoint}`);
      else console.error("push failed", res.status, await res.text());
    }
    return `sent to ${sent}/${subs.length} devices\n`;
  }
}

// Public key = uncompressed P-256 point (0x04 || x || y), derived from the private JWK.
function publicKey(jwk: { x: string; y: string }) {
  const b = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const bytes = new Uint8Array([4, ...b(jwk.x), ...b(jwk.y)]);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Static files in public/ are served before this runs.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname, origin } = url;
    const hub = env.HUB.get(env.HUB.idFromName("default"));

    const notify = async (title: string, body?: string, link?: string) => {
      if (!body) return new Response("message required\n", { status: 400 });
      // iOS opens every notification tap inside the PWA, so links go through /open, which hands off to the app.
      const navigate = link ? `${origin}/open?u=${encodeURIComponent(link)}` : `${origin}/`;
      // Declarative Web Push format (Safari 18.4+ shows it without JS). sw.js handles older browsers.
      const payload: Payload = { web_push: 8030, notification: { title, body, navigate } };
      return new Response(await hub.send(payload, origin));
    };

    if (pathname === "/vapid") return Response.json({ publicKey: publicKey(JSON.parse(env.VAPID_JWK)) });

    if (pathname === "/subscribe" && req.method === "POST") {
      const { token, subscription } = (await req.json()) as { token: string; subscription: Sub };
      if (token !== env.TOKEN) return new Response("bad token\n", { status: 401 });
      return Response.json({ devices: await hub.subscribe(subscription) });
    }

    // curl -d token=... -d message=hi [-d title=...] [-d url=...] https://host/send
    if (pathname === "/send" && req.method === "POST") {
      const form = await req.formData();
      if (form.get("token") !== env.TOKEN) return new Response("bad token\n", { status: 401 });
      const f = (k: string) => form.get(k)?.toString();
      return notify(f("title") ?? "Pusher", f("message"), f("url"));
    }

    // Channel webhook. GET works from a browser or Shortcuts: /c/<key>?m=hi[&t=title][&u=url]
    const hook = pathname.match(/^\/c\/([a-f0-9]+)$/);
    if (hook) {
      const ch = await hub.channel(hook[1]!);
      if (!ch) return new Response("unknown channel\n", { status: 404 });
      const q = req.method === "POST" ? await req.formData() : url.searchParams;
      const f = (...ks: string[]) => ks.map((k) => q.get(k)?.toString()).find(Boolean);
      const title = f("t", "title") ?? ch.name;
      return notify(ch.emoji ? `${ch.emoji} ${title}` : title, f("m", "message"), f("u", "url") ?? (ch.url || undefined));
    }

    // Channel management, used by the web app. Same token as /send.
    if (pathname.startsWith("/channels")) {
      if (req.headers.get("authorization") !== `Bearer ${env.TOKEN}`) return new Response("bad token\n", { status: 401 });
      const key = pathname.split("/")[2];
      if (req.method === "GET") return Response.json(await hub.channels());
      if (req.method === "DELETE" && key) return (await hub.deleteChannel(key), new Response(null, { status: 204 }));
      if (req.method === "PUT") {
        const b = (await req.json()) as Partial<Channel>;
        const ch: Channel = {
          key: key ?? [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join(""),
          name: String(b.name ?? "").trim() || "Untitled",
          emoji: String(b.emoji ?? "").trim(),
          url: String(b.url ?? "").trim(),
        };
        await hub.saveChannel(ch);
        return Response.json(ch);
      }
    }

    return new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
