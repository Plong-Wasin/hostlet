import { Elysia } from "elysia";

const requiredVariables = [
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "SESSION_SECRET",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_TUNNEL_ID",
  "DOMAIN",
  "SERVICE_URL",
] as const;

function validateConfiguration(env: Record<string, string | undefined>): void {
  for (const variable of requiredVariables) {
    if (!env[variable]) throw new Error(`Missing required environment variable: ${variable}`);
  }
  if ((env.SESSION_SECRET?.length ?? 0) < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }
}

validateConfiguration(Bun.env);

const loginPage = Bun.file(new URL("./public/login.html", import.meta.url));
const port = Number(Bun.env.PORT ?? "3000");

new Elysia()
  .get("/healthz", () => ({ status: "ok" }))
  .get("/", async ({ set }) => {
    set.headers["content-type"] = "text/html; charset=utf-8";
    return loginPage;
  })
  .listen(port);

console.log(`Hostlet listening on ${port}`);
