import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";

const config = {
  ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "correct horse battery staple",
  SESSION_SECRET: "a-session-secret-that-is-at-least-32-chars", CLOUDFLARE_API_TOKEN: "fake-token",
  CLOUDFLARE_ACCOUNT_ID: "account-id", CLOUDFLARE_ZONE_ID: "zone-id", CLOUDFLARE_TUNNEL_ID: "tunnel-id",
  DOMAIN: "example.test", SERVICE_URL: "http://origin.internal:8080",
};
const children: Subprocess[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const server of servers.splice(0)) server.stop(true);
});

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop();
  return port;
}

async function startApp(extra: Record<string, string> = {}) {
  const port = freePort();
  const child = spawn({ cmd: ["bun", `${import.meta.dir}/../src/index.ts`], cwd: `${import.meta.dir}/..`, env: { ...process.env, ...config, PORT: String(port), ...extra }, stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i += 1) {
    if (child.exitCode !== null) throw new Error(`app exited: ${await new Response(child.stderr!).text()}`);
    try { await fetch(`${base}/healthz`); break; } catch { await Bun.sleep(25); }
  }
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ username: config.ADMIN_USERNAME, password: config.ADMIN_PASSWORD }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  return { base, cookie };
}

describe("published applications", () => {
  test("reports a Tunnel-only partial result and a retry finishes the DNS Record", async () => {
    let tunnelConfig: any = { ingress: [] };
    let dnsRecord = false;
    let failDnsWrite = true;
    const writes: string[] = [];
    const fake = Bun.serve({ port: freePort(), async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path.endsWith("/configurations")) return Response.json({ success: true, result: { config: tunnelConfig } });
      if (req.method === "GET") return Response.json({ success: true, result: dnsRecord ? [{ name: "app.example.test" }] : [] });
      if (req.method === "PUT") { writes.push("tunnel"); tunnelConfig = (await req.json() as any).config; return Response.json({ success: true, result: {} }); }
      if (req.method === "POST") {
        writes.push("dns");
        if (failDnsWrite) return Response.json({ success: false, errors: [{ message: `denied token ${config.CLOUDFLARE_API_TOKEN}, account ${config.CLOUDFLARE_ACCOUNT_ID}, zone ${config.CLOUDFLARE_ZONE_ID}, tunnel ${config.CLOUDFLARE_TUNNEL_ID}` }] }, { status: 403 });
        dnsRecord = true;
        return Response.json({ success: true, result: {} });
      }
      return Response.json({ success: false, errors: [] }, { status: 500 });
    } });
    servers.push(fake);
    const { base, cookie } = await startApp({ CLOUDFLARE_API_BASE: `http://127.0.0.1:${fake.port}/client/v4` });
    const create = () => fetch(`${base}/api/hostnames`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ subdomain: "app" }) });
    const partial = await create();
    expect(partial.status).toBe(502);
    const partialBody = await partial.json();
    expect(partialBody.status).toBe("partial");
    expect(partialBody.succeeded).toBe("Tunnel configuration");
    expect(partialBody.failed).toBe("DNS Record");
    for (const secret of [config.CLOUDFLARE_API_TOKEN, config.CLOUDFLARE_ACCOUNT_ID, config.CLOUDFLARE_ZONE_ID, config.CLOUDFLARE_TUNNEL_ID]) {
      expect(partialBody.message).not.toContain(secret);
    }
    expect(writes).toEqual(["tunnel", "dns"]);

    failDnsWrite = false;
    const resumed = await create();
    expect(resumed.status).toBe(201);
    expect(await resumed.json()).toEqual({ status: "created", hostname: "app.example.test", url: "https://app.example.test" });
    expect(writes).toEqual(["tunnel", "dns", "dns"]);
    expect(dnsRecord).toBe(true);
  });

  test("reports an error with nothing changed when Cloudflare fails before a write", async () => {
    let writes = 0;
    const fake = Bun.serve({ port: freePort(), fetch(req) {
      if (req.method === "GET" && new URL(req.url).pathname.endsWith("/configurations")) return Response.json({ success: false, errors: [{ message: "upstream unavailable" }] }, { status: 503 });
      if (req.method !== "GET") writes += 1;
      return Response.json({ success: true, result: [] });
    } });
    servers.push(fake);
    const { base, cookie } = await startApp({ CLOUDFLARE_API_BASE: `http://127.0.0.1:${fake.port}/client/v4` });
    const response = await fetch(`${base}/api/hostnames`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ subdomain: "app" }) });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ status: "error", message: "upstream unavailable" });
    expect(writes).toBe(0);
  });

  test("refuses a complete duplicate without writing either Cloudflare resource", async () => {
    const calls: string[] = [];
    const fake = Bun.serve({ port: freePort(), fetch(req) {
      const path = new URL(req.url).pathname;
      calls.push(`${req.method} ${path}`);
      if (req.method === "GET" && path.endsWith("/configurations")) return Response.json({ success: true, result: { config: { ingress: [{ hostname: "app.example.test", service: config.SERVICE_URL }] } } });
      if (req.method === "GET") return Response.json({ success: true, result: [{ name: "app.example.test" }] });
      return Response.json({ success: true, result: {} });
    } });
    servers.push(fake);
    const { base, cookie } = await startApp({ CLOUDFLARE_API_BASE: `http://127.0.0.1:${fake.port}/client/v4` });
    const response = await fetch(`${base}/api/hostnames`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ subdomain: "app" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "error", message: "This Hostname is already a Published Application." });
    expect(calls).toHaveLength(2);
  });

  test("resumes a Hostname with an Ingress Rule by creating only the missing DNS Record", async () => {
    const calls: string[] = [];
    const fake = Bun.serve({ port: freePort(), fetch(req) {
      const path = new URL(req.url).pathname;
      calls.push(`${req.method} ${path}`);
      if (req.method === "GET" && path.endsWith("/configurations")) return Response.json({ success: true, result: { config: { ingress: [{ hostname: "app.example.test", service: config.SERVICE_URL }] } } });
      if (req.method === "GET") return Response.json({ success: true, result: [] });
      if (req.method === "POST") return Response.json({ success: true, result: {} });
      return Response.json({ success: false, errors: [{ message: "unexpected write" }] });
    } });
    servers.push(fake);
    const { base, cookie } = await startApp({ CLOUDFLARE_API_BASE: `http://127.0.0.1:${fake.port}/client/v4` });
    const response = await fetch(`${base}/api/hostnames`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ subdomain: "app" }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: "created", hostname: "app.example.test", url: "https://app.example.test" });
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain("POST /client/v4/zones/zone-id/dns_records");
  });

  test("refuses a foreign DNS Record without modifying it or adding an Ingress Rule", async () => {
    const calls: string[] = [];
    const fake = Bun.serve({ port: freePort(), fetch(req) {
      const path = new URL(req.url).pathname;
      calls.push(`${req.method} ${path}`);
      if (req.method === "GET" && path.endsWith("/configurations")) return Response.json({ success: true, result: { config: { ingress: [] } } });
      if (req.method === "GET") return Response.json({ success: true, result: [{ name: "app.example.test", type: "A", content: "192.0.2.1" }] });
      return Response.json({ success: true, result: {} });
    } });
    servers.push(fake);
    const { base, cookie } = await startApp({ CLOUDFLARE_API_BASE: `http://127.0.0.1:${fake.port}/client/v4` });
    const response = await fetch(`${base}/api/hostnames`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ subdomain: "app" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "error", message: "A DNS Record already exists for this Hostname and is not managed by Hostlet." });
    expect(calls).toHaveLength(2);
  });

  test("validates and lowercases one subdomain label before calling Cloudflare", async () => {
    const calls: string[] = [];
    const fake = Bun.serve({ port: freePort(), fetch(req) { calls.push(`${req.method} ${new URL(req.url).pathname}`); return Response.json({ success: true, result: {} }); } });
    servers.push(fake);
    const { base, cookie } = await startApp({ CLOUDFLARE_API_BASE: `http://127.0.0.1:${fake.port}/client/v4` });
    for (const subdomain of ["", "-bad", "bad-", "two.levels", "*", "a".repeat(64), "has space"]) {
      const response = await fetch(`${base}/api/hostnames`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ subdomain }) });
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test("creates exact tunnel and DNS requests, preserving existing rules before catch-all", async () => {
    const existing = [{ hostname: "old.example.test", service: "http://old.internal" }, { service: "http_status:404" }];
    let written: unknown;
    const received: Array<{ method: string; path: string; body?: unknown; authorization?: string }> = [];
    const fake = Bun.serve({ port: freePort(), async fetch(req) {
      const requestUrl = new URL(req.url);
      const path = requestUrl.pathname + requestUrl.search;
      const item: typeof received[number] = { method: req.method, path, authorization: req.headers.get("authorization") ?? undefined };
      if (req.method === "PUT" || req.method === "POST") item.body = await req.json();
      received.push(item);
      if (req.method === "GET" && path.endsWith("/configurations")) return Response.json({ success: true, result: { config: { ingress: existing } } });
      if (req.method === "GET" && path.includes("/dns_records")) return Response.json({ success: true, result: [] });
      if (req.method === "PUT") { written = item.body; return Response.json({ success: true, result: {} }); }
      if (req.method === "POST") return Response.json({ success: true, result: {} });
      return Response.json({ success: false, errors: [{ message: "unexpected request" }] }, { status: 404 });
    } });
    servers.push(fake);
    const { base, cookie } = await startApp({ CLOUDFLARE_API_BASE: `http://127.0.0.1:${fake.port}/client/v4` });
    const response = await fetch(`${base}/api/hostnames`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ subdomain: "MyApp" }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: "created", hostname: "myapp.example.test", url: "https://myapp.example.test" });
    expect(written).toEqual({ config: { ingress: [{ hostname: "old.example.test", service: "http://old.internal" }, { hostname: "myapp.example.test", service: "http://origin.internal:8080" }, { service: "http_status:404" }] } });
    expect(received).toEqual([
      { method: "GET", path: "/client/v4/accounts/account-id/cfd_tunnel/tunnel-id/configurations", authorization: "Bearer fake-token" },
      { method: "GET", path: "/client/v4/zones/zone-id/dns_records?name=myapp.example.test", authorization: "Bearer fake-token" },
      { method: "PUT", path: "/client/v4/accounts/account-id/cfd_tunnel/tunnel-id/configurations", authorization: "Bearer fake-token", body: written },
      { method: "POST", path: "/client/v4/zones/zone-id/dns_records", authorization: "Bearer fake-token", body: { type: "CNAME", name: "myapp.example.test", content: "tunnel-id.cfargotunnel.com", proxied: true, ttl: 1 } },
    ]);
  });

  test("adds a 404 catch-all when the tunnel has no ingress rules and shows a linked success message", async () => {
    let configBody: any;
    const fake = Bun.serve({ port: freePort(), async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path.endsWith("/configurations")) return Response.json({ success: true, result: { config: { ingress: [] } } });
      if (req.method === "GET") return Response.json({ success: true, result: [] });
      if (req.method === "PUT") { configBody = await req.json(); return Response.json({ success: true, result: {} }); }
      return Response.json({ success: true, result: {} });
    } });
    servers.push(fake);
    const { base, cookie } = await startApp({ CLOUDFLARE_API_BASE: `http://127.0.0.1:${fake.port}/client/v4` });
    const response = await fetch(`${base}/api/hostnames`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ subdomain: "app" }) });
    expect(response.status).toBe(201);
    expect(configBody).toEqual({ config: { ingress: [{ hostname: "app.example.test", service: "http://origin.internal:8080" }, { service: "http_status:404" }] } });
    const page = await (await fetch(base)).text();
    expect(page).toContain('id="subdomain"');
    expect(page).toContain('const domain = "example.test"');
    expect(page).toContain('link.id = "success-link"');
    expect(page).toContain('`Partial: ${result.succeeded} succeeded; ${result.failed} failed.');
  });

  test("preserves every ingress rule when different Creates arrive concurrently", async () => {
    let ingress: Array<{ hostname?: string; service: string }> = [{ service: "http_status:404" }];
    const fake = Bun.serve({ port: freePort(), async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path.endsWith("/configurations")) {
        await Bun.sleep(30);
        return Response.json({ success: true, result: { config: { ingress } } });
      }
      if (req.method === "GET") return Response.json({ success: true, result: [] });
      if (req.method === "PUT") {
        const body = await req.json() as { config: { ingress: typeof ingress } };
        ingress = body.config.ingress;
        return Response.json({ success: true, result: {} });
      }
      if (req.method === "POST") return Response.json({ success: true, result: {} });
      return Response.json({ success: false, errors: [{ message: "unexpected request" }] }, { status: 404 });
    } });
    servers.push(fake);
    const { base, cookie } = await startApp({ CLOUDFLARE_API_BASE: `http://127.0.0.1:${fake.port}/client/v4` });
    const create = (subdomain: string) => fetch(`${base}/api/hostnames`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ subdomain }) });
    const responses = await Promise.all([create("first"), create("second"), create("third")]);
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    expect(ingress.filter((rule) => rule.hostname).map((rule) => rule.hostname).sort()).toEqual([
      "first.example.test", "second.example.test", "third.example.test",
    ]);
  });

  test("releases the Tunnel update lock after a failed Create", async () => {
    let ingress: Array<{ hostname?: string; service: string }> = [{ service: "http_status:404" }];
    let failFirstWrite = true;
    const fake = Bun.serve({ port: freePort(), async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path.endsWith("/configurations")) return Response.json({ success: true, result: { config: { ingress } } });
      if (req.method === "GET") return Response.json({ success: true, result: [] });
      if (req.method === "PUT") {
        if (failFirstWrite) {
          failFirstWrite = false;
          return Response.json({ success: false, errors: [{ message: "temporary failure" }] }, { status: 500 });
        }
        const body = await req.json() as { config: { ingress: typeof ingress } };
        ingress = body.config.ingress;
        return Response.json({ success: true, result: {} });
      }
      if (req.method === "POST") return Response.json({ success: true, result: {} });
      return Response.json({ success: false, errors: [{ message: "unexpected request" }] }, { status: 404 });
    } });
    servers.push(fake);
    const { base, cookie } = await startApp({ CLOUDFLARE_API_BASE: `http://127.0.0.1:${fake.port}/client/v4` });
    const create = (subdomain: string) => fetch(`${base}/api/hostnames`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ subdomain }) });
    expect((await create("failed")).status).toBe(502);
    expect((await create("after-failure")).status).toBe(201);
    expect(ingress.map((rule) => rule.hostname)).toEqual(["after-failure.example.test", undefined]);
  });
});
