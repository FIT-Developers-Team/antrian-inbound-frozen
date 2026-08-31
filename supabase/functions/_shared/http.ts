export function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function allowedOrigins(): string[] {
  return clean(Deno.env.get("APP_ORIGINS"))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowed = allowedOrigins();
  // Tanpa APP_ORIGINS (mis. saat pengembangan lokal) izinkan semua asal.
  // Begitu APP_ORIGINS diisi, asal di luar daftar tidak pernah dipantulkan balik.
  const corsOrigin = allowed.length === 0 ? "*" : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    "access-control-allow-origin": corsOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-sync-secret,if-none-match",
    // Tanpa baris ini browser tidak dapat membaca ETag pada respons lintas asal,
    // sehingga If-None-Match tidak pernah terkirim dan 304 tidak pernah terjadi.
    "access-control-expose-headers": "etag,x-inbound-rows,x-inbound-site",
    "access-control-max-age": "86400",
    "vary": "Origin, Accept-Encoding, If-None-Match",
  };
}

export function jsonResponse(
  request: Request,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(status === 204 || status === 304 ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(request),
      ...extraHeaders,
    },
  });
}

export function optionsResponse(request: Request): Response {
  return jsonResponse(request, 204, null);
}

/** ETag lemah dari fingerprint yang sudah dihitung Postgres. */
export function weakEtag(fingerprint: string): string {
  return `W/"${clean(fingerprint) || "0"}"`;
}

/** True bila klien sudah memegang versi ini dan cukup dikirimi 304. */
export function matchesEtag(request: Request, etag: string): boolean {
  const header = clean(request.headers.get("if-none-match"));
  if (!header || !etag) return false;
  return header.split(",").some((candidate) => candidate.trim() === etag);
}

export function notModifiedResponse(request: Request, etag: string): Response {
  return jsonResponse(request, 304, null, { etag });
}

export function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) result |= a[index] ^ b[index];
  return result === 0;
}
