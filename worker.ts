import { DurableObject } from "cloudflare:workers";
import { buildPushHTTPRequest } from "@pushforge/builder";
import qrcode from "qrcode-generator";

type Env = { HUB: DurableObjectNamespace<Hub>; VAPID_JWK: string };
type Payload = { web_push: 8030; notification: { title: string; body: string; navigate: string } };
type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };
// The key is the channel's secret: anyone with /c/<account id>/<key> can send to it.
type Channel = { key: string; name: string; emoji: string; url: string };

const MAX_DEVICES = 10;
const MAX_CHANNELS = 50;
const SENDS_PER_MINUTE = 30;
// Only real push services. Without this, anyone could make the Worker POST to any URL.
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;

// One Hub per account: holds that account's devices and channels.
export class Hub extends DurableObject<Env> {
  async subscribe(sub: Sub) {
    const subs = await this.ctx.storage.list({ prefix: "sub:" });
    if (!subs.has(`sub:${sub.endpoint}`) && subs.size >= MAX_DEVICES) return null;
    await this.ctx.storage.put(`sub:${sub.endpoint}`, sub);
    return subs.size + (subs.has(`sub:${sub.endpoint}`) ? 0 : 1);
  }

  async channels() {
    return [...(await this.ctx.storage.list<Channel>({ prefix: "ch:" })).values()];
  }
  async channel(key: string) {
    return this.ctx.storage.get<Channel>(`ch:${key}`);
  }
  async saveChannel(ch: Channel) {
    const exists = await this.ctx.storage.get(`ch:${ch.key}`);
    if (!exists && (await this.ctx.storage.list({ prefix: "ch:" })).size >= MAX_CHANNELS) return false;
    await this.ctx.storage.put(`ch:${ch.key}`, ch);
    return true;
  }
  async deleteChannel(key: string) {
    await this.ctx.storage.delete(`ch:${key}`);
  }

  async send(payload: Payload, origin: string) {
    // Fixed one-minute window. In-memory is fine: a DO restart only resets the count.
    const minute = Math.floor(Date.now() / 60000);
    if (this.window !== minute) (this.window = minute), (this.count = 0);
    if (++this.count > SENDS_PER_MINUTE) return null;

    const subs = [...(await this.ctx.storage.list<Sub>({ prefix: "sub:" })).values()];
    let sent = 0;
    for (const sub of subs) {
      try {
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
      } catch (e) {
        // Bad keys can never work, so drop the device instead of failing every send.
        console.error("bad subscription, removing", e);
        await this.ctx.storage.delete(`sub:${sub.endpoint}`);
      }
    }
    return `sent to ${sent}/${subs.length} devices\n`;
  }
  private window = 0;
  private count = 0;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (bytes: Uint8Array) => [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
const randomHex = () => hex(crypto.getRandomValues(new Uint8Array(16)));

// Public key = uncompressed P-256 point (0x04 || x || y), derived from the private JWK.
function publicKey(jwk: { x: string; y: string }) {
  const b = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return b64url(new Uint8Array([4, ...b(jwk.x), ...b(jwk.y)]));
}

// Account id = hash of the secret key. Safe to put in channel URLs; can't be turned back into the key.
async function accountId(key: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))).slice(0, 16);
}

const text = (body: string, status = 200) => new Response(body, { status });
const isKey = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{32}$/.test(s);

// Static files in public/ are served before this runs.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname, origin } = url;
    const hubFor = (id: string) => env.HUB.get(env.HUB.idFromName(id));

    if (pathname === "/vapid") return Response.json({ publicKey: publicKey(JSON.parse(env.VAPID_JWK)) });

    // QR code as SVG, for "add another device". Only encodes links to this site.
    if (pathname === "/qr") {
      const data = url.searchParams.get("d") ?? "";
      if (!data.startsWith(origin + "/") || data.length > 300) return text("bad data\n", 400);
      const qr = qrcode(0, "M");
      qr.addData(data);
      qr.make();
      return new Response(qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }), {
        headers: { "content-type": "image/svg+xml", "cache-control": "private, max-age=3600" },
      });
    }

    // Create an account. The key is the only credential; the client keeps it.
    if (pathname === "/account" && req.method === "POST") {
      const key = randomHex();
      return Response.json({ key, id: await accountId(key) });
    }

    // Channel webhook. GET works from a browser or Shortcuts: /c/<account id>/<key>?m=hi[&t=title][&u=url]
    const hook = pathname.match(/^\/c\/([a-f0-9]{16})\/([a-f0-9]{32})$/);
    if (hook) {
      const hub = hubFor(hook[1]!);
      const ch = await hub.channel(hook[2]!);
      if (!ch) return text("unknown channel\n", 404);
      const q = req.method === "POST" ? await req.formData() : url.searchParams;
      const f = (...ks: string[]) => ks.map((k) => q.get(k)?.toString()).find(Boolean);
      const title = f("t", "title") ?? ch.name;
      const body = f("m", "message");
      if (!body) return text("message required\n", 400);
      const link = f("u", "url") ?? (ch.url || undefined);
      // iOS opens every notification tap inside the PWA, so links go through /open, which hands off to the app.
      const navigate = link ? `${origin}/open?u=${encodeURIComponent(link)}` : `${origin}/`;
      // Declarative Web Push format (Safari 18.4+ shows it without JS). sw.js handles older browsers.
      const payload: Payload = {
        web_push: 8030,
        notification: { title: (ch.emoji ? `${ch.emoji} ${title}` : title).slice(0, 200), body: body.slice(0, 1000), navigate },
      };
      const result = await hub.send(payload, origin);
      return result === null ? text("rate limited\n", 429) : text(result);
    }

    // Everything below needs the account key.
    const key = req.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!isKey(key)) return text("not found\n", 404);
    const id = await accountId(key);
    const hub = hubFor(id);

    if (pathname === "/me") return Response.json({ id });

    if (pathname === "/subscribe" && req.method === "POST") {
      const sub = (await req.json()) as Sub;
      let host = "";
      try {
        host = new URL(sub.endpoint).hostname;
      } catch {}
      if (!PUSH_HOSTS.test(host) || !sub.keys?.p256dh || !sub.keys?.auth) return text("bad subscription\n", 400);
      const devices = await hub.subscribe({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
      return devices === null ? text(`device limit (${MAX_DEVICES}) reached\n`, 409) : Response.json({ devices });
    }

    if (pathname.startsWith("/channels")) {
      const chKey = pathname.split("/")[2];
      if (req.method === "GET") return Response.json(await hub.channels());
      if (req.method === "DELETE" && isKey(chKey)) return (await hub.deleteChannel(chKey), new Response(null, { status: 204 }));
      if (req.method === "PUT" && (chKey === undefined || isKey(chKey))) {
        const b = (await req.json()) as Partial<Channel>;
        const ch: Channel = {
          key: chKey ?? randomHex(),
          name: String(b.name ?? "").trim().slice(0, 60) || "Untitled",
          emoji: String(b.emoji ?? "").trim().slice(0, 8),
          url: String(b.url ?? "").trim().slice(0, 500),
        };
        return (await hub.saveChannel(ch)) ? Response.json(ch) : text(`channel limit (${MAX_CHANNELS}) reached\n`, 409);
      }
    }

    return text("not found\n", 404);
  },
} satisfies ExportedHandler<Env>;
