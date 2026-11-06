import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";

const root = `${import.meta.dir}/..`;
const image = `hostlet-container-test:${crypto.randomUUID()}`;
const project = `hostlet-container-test-${crypto.randomUUID()}`;
const environmentFile = `/tmp/${project}.env`;
const deploymentEnvironment = {
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

async function run(
  cmd: string[],
  options: { env?: Record<string, string | undefined> } = {},
): Promise<{ exitCode: number; output: string }> {
  const child: Subprocess = spawn({
    cmd,
    cwd: root,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout && typeof child.stdout !== "number"
      ? new Response(child.stdout).text()
      : "",
    child.stderr && typeof child.stderr !== "number"
      ? new Response(child.stderr).text()
      : "",
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

function withoutDeploymentVariables(): Record<string, string> {
  return Object.entries(process.env).reduce<Record<string, string>>(
    (environment, [key, value]) => {
      if (value !== undefined && !(key in deploymentEnvironment)) {
        environment[key] = value;
      }
      return environment;
    },
    {},
  );
}

describe("container deployment", () => {
  beforeAll(async () => {
    const build = await run(["docker", "build", "--tag", image, "."]);
    expect(build.exitCode, build.output).toBe(0);
  }, 120_000);

  afterAll(async () => {
    await run([
      "docker",
      "compose",
      "--project-name",
      project,
      "--env-file",
      environmentFile,
      "-f",
      "docker-compose.dokploy.yml",
      "down",
      "--volumes",
      "--rmi",
      "local",
    ]);
    await run(["docker", "image", "rm", "--force", image]);
    await run(["docker", "image", "rm", "--force", `${project}-app:latest`]);
    await Bun.file(environmentFile).delete();
  }, 120_000);

  test("builds and runs non-root with a healthy compose-compatible health endpoint", async () => {
    const imageUser = await run([
      "docker",
      "image",
      "inspect",
      "--format",
      "{{.Config.User}}",
      image,
    ]);
    expect(imageUser.exitCode, imageUser.output).toBe(0);
    expect(imageUser.output.trim()).toBe("bun");

    await Bun.write(
      environmentFile,
      `${Object.entries(deploymentEnvironment)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
    );
    const composeArgs = [
      "docker",
      "compose",
      "--project-name",
      project,
      "--env-file",
      environmentFile,
      "-f",
      "docker-compose.dokploy.yml",
    ];
    const start = await run([
      ...composeArgs,
      "up",
      "--detach",
      "--build",
    ]);
    expect(start.exitCode, start.output).toBe(0);

    const deadline = Date.now() + 30_000;
    let health = "starting";
    while (Date.now() < deadline && health === "starting") {
      await Bun.sleep(250);
      const inspect = await run([
        ...composeArgs,
        "ps",
        "--quiet",
        "app",
      ]);
      expect(inspect.exitCode, inspect.output).toBe(0);
      const id = inspect.output.trim();
      expect(id).not.toBe("");
      const status = await run([
        "docker",
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        id,
      ]);
      expect(status.exitCode, status.output).toBe(0);
      health = status.output.trim();
    }
    expect(health).toBe("healthy");

    const endpoint = await run([
      ...composeArgs,
      "exec",
      "--no-TTY",
      "app",
      "id",
      "-u",
    ]);
    expect(endpoint.exitCode, endpoint.output).toBe(0);
    expect(endpoint.output.trim()).not.toBe("0");

    const healthResponse = await run([
      ...composeArgs,
      "exec",
      "--no-TTY",
      "app",
      "bun",
      "-e",
      "fetch('http://127.0.0.1:3000/healthz').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) }).catch(() => process.exit(1))",
    ]);
    expect(healthResponse.exitCode, healthResponse.output).toBe(0);
    expect(healthResponse.output).toContain('200 {"status":"ok"}');
  }, 45_000);

  test("Dokploy compose requires configuration and has no published ports or Traefik labels", async () => {
    const missingVariables = await run(
      ["docker", "compose", "-f", "docker-compose.dokploy.yml", "config"],
      { env: withoutDeploymentVariables() },
    );
    expect(missingVariables.exitCode).not.toBe(0);
    expect(missingVariables.output).toContain("ADMIN_USERNAME");

    const configured = await run(
      ["docker", "compose", "-f", "docker-compose.dokploy.yml", "config"],
      { env: { ...process.env, ...deploymentEnvironment } },
    );
    expect(configured.exitCode, configured.output).toBe(0);
    expect(configured.output).toContain("expose:");
    expect(configured.output).toContain('"3000"');
    expect(configured.output).not.toMatch(/^\s+ports:/m);
    expect(configured.output).not.toMatch(/^\s+labels:/m);
    expect(configured.output.toLowerCase()).not.toContain("traefik");
  });
});
