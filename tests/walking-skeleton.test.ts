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
      expect(await login.text()).toContain("Hostlet");
    } finally {
      fakeCloudflare.stop(true);
    }
  });
});
