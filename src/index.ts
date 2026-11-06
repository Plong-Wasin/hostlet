import { timingSafeEqual, createHmac } from "node:crypto";
import { Elysia } from "elysia";

const requiredVariables = [
  "ADMIN_USERNAME", "ADMIN_PASSWORD", "SESSION_SECRET", "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ZONE_ID", "CLOUDFLARE_TUNNEL_ID", "DOMAIN", "SERVICE_URL",
] as const;
function validateConfiguration(env: Record<string, string | undefined>): void {
  for (const variable of requiredVariables) if (!env[variable]) throw new Error(`Missing required environment variable: ${variable}`);
  if ((env.SESSION_SECRET?.length ?? 0) < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
}
validateConfiguration(Bun.env);

const loginPage = Bun.file(new URL("./public/login.html", import.meta.url));
const port = Number(Bun.env.PORT ?? "3000");
const cookieName = "hostlet_session";
const sessionDuration = 24 * 60 * 60;
const secret = Bun.env.SESSION_SECRET!;
const attempts = new Map<string, { count: number; expires: number }>();

function signature(payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
function sessionToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + sessionDuration })).toString("base64url");
  return `${payload}.${signature(payload)}`;
}
function validSession(cookie: string | undefined): boolean {
  if (!cookie) return false;
  const [payload, suppliedSignature, ...extra] = cookie.split(".");
  if (!payload || !suppliedSignature || extra.length) return false;
  const expected = Buffer.from(signature(payload));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: number };
    return typeof decoded.exp === "number" && decoded.exp > Date.now() / 1000;
  } catch { return false; }
}
function constantEqual(left: string, right: string): boolean {
  const a = createHmac("sha256", "hostlet-credential-comparison").update(left).digest();
  const b = createHmac("sha256", "hostlet-credential-comparison").update(right).digest();
  return timingSafeEqual(a, b) && left.length === right.length;
}
function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";
}
function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const requestUrl = new URL(request.url);
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? requestUrl.host;
    const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? requestUrl.protocol.slice(0, -1);
    return new URL(origin).origin === new URL(`${protocol}://${host}`).origin;
  } catch { return false; }
}
function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}
function blockedByRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.expires <= now) return false;
  return entry.count >= 5;
}
function recordFailure(ip: string): void {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || current.expires <= now) attempts.set(ip, { count: 1, expires: now + 15 * 60_000 });
  else current.count += 1;
}

new Elysia()
  .get("/healthz", () => ({ status: "ok" }))
  .get("/", async ({ set }) => {
    set.headers["content-type"] = "text/html; charset=utf-8";
    return loginPage;
  })
  .post("/api/login", async ({ request, set }) => {
    if (!hasSameOrigin(request) || !isJsonRequest(request)) return new Response("Invalid request", { status: 403 });
    const ip = clientIp(request);
    if (blockedByRateLimit(ip)) return new Response("Too many attempts", { status: 429 });
    let credentials: { username?: unknown; password?: unknown };
    try { credentials = await request.json() as typeof credentials; } catch { return new Response("Invalid request", { status: 400 }); }
    const username = typeof credentials.username === "string" ? credentials.username : "";
    const password = typeof credentials.password === "string" ? credentials.password : "";
    const usernameOk = constantEqual(username, Bun.env.ADMIN_USERNAME!);
    const passwordOk = constantEqual(password, Bun.env.ADMIN_PASSWORD!);
    if (!usernameOk || !passwordOk) {
      recordFailure(ip);
      return new Response("Invalid username or password", { status: 401 });
    }
    attempts.delete(ip);
    set.headers["set-cookie"] = `${cookieName}=${sessionToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDuration}`;
    return { authenticated: true };
  })
  .get("/api/session", ({ request }) => ({ authenticated: validSession(request.headers.get("cookie")?.split(/;\s*/).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)) }))
  .post("/api/logout", ({ request, set }) => {
    if (!hasSameOrigin(request) || !isJsonRequest(request)) return new Response("Invalid request", { status: 403 });
    const token = request.headers.get("cookie")?.split(/;\s*/).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!validSession(token)) return new Response("Unauthorized", { status: 401 });
    set.headers["set-cookie"] = `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
    return { authenticated: false };
  })
  .all("/api/*", ({ request }) => {
    const token = request.headers.get("cookie")?.split(/;\s*/).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return new Response("Unauthorized", { status: validSession(token) ? 404 : 401 });
  })
  .listen(port);

console.log(`Hostlet listening on ${port}`);
