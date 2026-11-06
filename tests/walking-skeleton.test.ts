import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";

const requiredEnvironment = {
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "correct horse battery staple",
  SESSION_SECRET: "a-session-secret-that-is-at-least-32-chars",
  CLOUDFLARE_API_TOKEN: "fake-token",
  CLOUDFLARE_ACCOUNT_ID: "account-id",
  CLOUDFLARE_ZONE_ID: "zone-id",
  CLOUDFLARE_TUNNEL_ID: "tunnel-id",
  DOMAIN: "example.test",
  SERVICE_URL: "http://localhost:3000",
};

const children: Subprocess[] = [];

async function readStderr(child: Subprocess): Promise<string> {
  if (child.stderr === null || typeof child.stderr === "number") return "";
  return new Response(child.stderr).text();
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

async function listenForServer(child: Subprocess, port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early: ${await readStderr(child)}`);
    }
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
      return;
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error("server did not start within 5 seconds");
}

async function startServer(env: Record<string, string>): Promise<Subprocess> {
  const child = spawn({
    cmd: ["bun", `${import.meta.dir}/../src/index.ts`],
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
}

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop();
  return port;
}

describe("walking skeleton HTTP boundary", () => {
  test("missing configuration stops startup and names the variable", async () => {
    const child = await startServer({ PORT: String(freePort()) });
    const exitCode = await child.exited;
    const stderr = await readStderr(child);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("ADMIN_USERNAME");
  });

  test("weak session secret stops startup and names SESSION_SECRET", async () => {
    const child = await startServer({
      ...requiredEnvironment,
      SESSION_SECRET: "too-short",
      PORT: String(freePort()),
    });
    const exitCode = await child.exited;
    const stderr = await readStderr(child);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("SESSION_SECRET");
  });

  test("health is public, the login page is served, and health makes no Cloudflare call", async () => {
    const cloudflarePort = freePort();
    let cloudflareCalls = 0;
    const fakeCloudflare = Bun.serve({
      port: cloudflarePort,
      fetch() {
        cloudflareCalls += 1;
        return Response.json({ success: true, result: {} });
      },
    });
    const appPort = freePort();
    try {
      const child = await startServer({
        ...requiredEnvironment,
        PORT: String(appPort),
        CLOUDFLARE_API_BASE: `http://127.0.0.1:${cloudflarePort}/client/v4`,
      });
      await listenForServer(child, appPort);

      const health = await fetch(`http://127.0.0.1:${appPort}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
      expect(cloudflareCalls).toBe(0);

      const login = await fetch(`http://127.0.0.1:${appPort}/`);
      expect(login.status).toBe(200);
      expect(login.headers.get("content-type")).toContain("text/html");
      const page = await login.text();
      expect(page).toContain("Hostlet");
      expect(page).toContain('fetch("/api/login"');
      expect(page).toContain('id="dashboard"');
    } finally {
      fakeCloudflare.stop(true);
    }
  });

  test("login creates a signed strict HttpOnly 24-hour session; session and logout reflect it", async () => {
    const appPort = freePort();
    const child = await startServer({ ...requiredEnvironment, PORT: String(appPort) });
    await listenForServer(child, appPort);
    const origin = `http://127.0.0.1:${appPort}`;
    const login = await fetch(`${origin}/api/login`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: requiredEnvironment.ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=86400");
    const token = cookie.split(";")[0];
    expect((await fetch(`${origin}/api/session`)).status).toBe(200);
    expect(await (await fetch(`${origin}/api/session`, { headers: { Cookie: token } })).json()).toEqual({ authenticated: true });
    const logout = await fetch(`${origin}/api/logout`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: token }, body: "{}",
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await (await fetch(`${origin}/api/session`, { headers: { Cookie: token } })).json()).toEqual({ authenticated: true });
  });

  test("wrong credentials, cross-origin mutations, non-JSON mutations and protected endpoints are refused", async () => {
    const appPort = freePort();
    const child = await startServer({ ...requiredEnvironment, PORT: String(appPort) });
    await listenForServer(child, appPort);
    const origin = `http://127.0.0.1:${appPort}`;
    const wrong = await fetch(`${origin}/api/login`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    expect(wrong.status).toBe(401);
    expect((await fetch(`${origin}/api/login`, {
      method: "POST", headers: { Origin: "https://attacker.test", "Content-Type": "application/json" }, body: "{}",
    })).status).toBe(403);
    expect((await fetch(`${origin}/api/login`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "text/plain" }, body: "{}",
    })).status).toBe(403);
    expect((await fetch(`${origin}/api/hostnames`, { method: "POST" })).status).toBe(401);
    expect(await (await fetch(`${origin}/api/session`)).json()).toEqual({ authenticated: false });
  });

  test("login rate limit rejects the sixth failed attempt from one client IP", async () => {
    const appPort = freePort();
    const child = await startServer({ ...requiredEnvironment, PORT: String(appPort) });
    await listenForServer(child, appPort);
    const origin = `http://127.0.0.1:${appPort}`;
    let last: Response | undefined;
    for (let i = 0; i < 6; i += 1) {
      last = await fetch(`${origin}/api/login`, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1" },
        body: JSON.stringify({ username: "admin", password: "wrong" }),
      });
    }
    expect(last?.status).toBe(429);
  });

  test("login throttling is isolated by Cloudflare client IP", async () => {
    const appPort = freePort();
    const child = await startServer({ ...requiredEnvironment, PORT: String(appPort) });
    await listenForServer(child, appPort);
    const origin = `http://127.0.0.1:${appPort}`;

    async function login(ip: string, password: string): Promise<Response> {
      return fetch(`${origin}/api/login`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ username: "admin", password }),
      });
    }

    for (let i = 0; i < 5; i += 1) expect((await login("192.0.2.10", "wrong")).status).toBe(401);
    expect((await login("192.0.2.10", "wrong")).status).toBe(429);

    const otherIpSuccess = await login("192.0.2.11", requiredEnvironment.ADMIN_PASSWORD);
    expect(otherIpSuccess.status).toBe(200);
    expect(otherIpSuccess.headers.get("set-cookie")).toContain("hostlet_session=");
    expect((await login("192.0.2.10", requiredEnvironment.ADMIN_PASSWORD)).status).toBe(429);
  });
});
