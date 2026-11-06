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
const cloudflareBase = (Bun.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
let createQueue: Promise<void> = Promise.resolve();

type IngressRule = { hostname?: string; service: string; [key: string]: unknown };
async function serialCreate<T>(operation: () => Promise<T>): Promise<T> {
  const previous = createQueue;
  let release!: () => void;
  createQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await operation(); } finally { release(); }
}
function validSubdomain(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}
async function cloudflare(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${cloudflareBase}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${Bun.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json", ...init.headers },
  });
  let body: any;
  try { body = await response.json(); } catch { throw new Error("Cloudflare returned an invalid response"); }
  if (!response.ok || body.success !== true) {
    const message = Array.isArray(body.errors) ? body.errors.map((error: { message?: unknown }) => typeof error.message === "string" ? error.message : "").filter(Boolean).join("; ") : "";
    throw new Error(message || "Cloudflare request failed");
  }
  return body.result;
}
function publicCloudflareError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Cloudflare request failed";
  return message.replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{24,}/g, "[redacted]").replace(/\b(?:accounts|zones)\/[A-Za-z0-9_-]+/gi, "[redacted]").slice(0, 240);
}
async function createPublishedApplication(subdomain: string): Promise<{ status: number; body: unknown }> {
  const hostname = `${subdomain}.${Bun.env.DOMAIN}`;
  const tunnelPath = `/accounts/${encodeURIComponent(Bun.env.CLOUDFLARE_ACCOUNT_ID!)}/cfd_tunnel/${encodeURIComponent(Bun.env.CLOUDFLARE_TUNNEL_ID!)}/configurations`;
  const zonePath = `/zones/${encodeURIComponent(Bun.env.CLOUDFLARE_ZONE_ID!)}/dns_records`;
  try {
    return await serialCreate(async () => {
      const tunnel = await cloudflare(tunnelPath);
      const config = tunnel?.config ?? {};
      const ingress: IngressRule[] = Array.isArray(config.ingress) ? config.ingress : [];
      const records = await cloudflare(`${zonePath}?${new URLSearchParams({ name: hostname })}`);
      if (ingress.some((rule) => rule.hostname === hostname) || (Array.isArray(records) && records.length > 0)) {
        return { status: 409, body: { status: "error", message: "This Hostname already exists." } };
      }
      const newRule: IngressRule = { hostname, service: Bun.env.SERVICE_URL! };
      const catchAllIndex = ingress.findIndex((rule) => !rule.hostname);
      const updatedIngress = [...ingress];
      if (catchAllIndex >= 0) updatedIngress.splice(catchAllIndex, 0, newRule);
      else updatedIngress.push(newRule, { service: "http_status:404" });
      await cloudflare(tunnelPath, { method: "PUT", body: JSON.stringify({ config: { ...config, ingress: updatedIngress } }) });
      await cloudflare(zonePath, { method: "POST", body: JSON.stringify({ type: "CNAME", name: hostname, content: `${Bun.env.CLOUDFLARE_TUNNEL_ID}.cfargotunnel.com`, proxied: true, ttl: 1 }) });
      return { status: 201, body: { status: "created", hostname, url: `https://${hostname}` } };
    });
  } catch (error) {
    return { status: 502, body: { status: "error", message: publicCloudflareError(error) } };
  }
}

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
    return (await loginPage.text()).replaceAll("__HOSTLET_DOMAIN__", Bun.env.DOMAIN!);
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
  .post("/api/hostnames", async ({ request }) => {
    const token = request.headers.get("cookie")?.split(/;\s*/).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!validSession(token)) return new Response("Unauthorized", { status: 401 });
    if (!hasSameOrigin(request) || !isJsonRequest(request)) return new Response("Invalid request", { status: 403 });
    let payload: { subdomain?: unknown };
    try { payload = await request.json() as typeof payload; } catch { return new Response("Invalid request", { status: 400 }); }
    if (typeof payload.subdomain !== "string") return Response.json({ status: "error", message: "Enter a valid Subdomain." }, { status: 400 });
    const subdomain = payload.subdomain.toLowerCase();
    if (!validSubdomain(subdomain)) return Response.json({ status: "error", message: "Use one label with 1 to 63 lowercase letters, numbers, or hyphens; it cannot start or end with a hyphen." }, { status: 400 });
    const result = await createPublishedApplication(subdomain);
    return Response.json(result.body, { status: result.status });
  })
  .all("/api/*", ({ request }) => {
    const token = request.headers.get("cookie")?.split(/;\s*/).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return new Response("Unauthorized", { status: validSession(token) ? 404 : 401 });
  })
  .listen(port);

console.log(`Hostlet listening on ${port}`);
