import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  clean,
  constantTimeEqual,
  jsonResponse,
  matchesEtag,
  notModifiedResponse,
  optionsResponse,
  weakEtag,
} from "../_shared/http.ts";

type Session = { username: string; role: string; display_name: string; exp: number };
type ConfiguredUser = { username: string; password: string; role: string; display_name?: string };

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const encoder = new TextEncoder();

/** Jendela hari operasional yang dikirim ke browser. Riwayat lama diambil lewat export_rows. */
const DEFAULT_DAYS_BACK = Number(clean(Deno.env.get("INBOUND_SNAPSHOT_DAYS_BACK"))) || 7;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return clean((error as { message?: unknown }).message);
  return String(error);
}

function base64Url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(normalized);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function hmac(value: string): Promise<string> {
  const secret = clean(Deno.env.get("INBOUND_AUTH_SECRET"));
  if (!secret) throw new Error("INBOUND_AUTH_SECRET belum diset di Supabase Secrets.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function signSession(session: Session): Promise<string> {
  const encoded = base64Url(encoder.encode(JSON.stringify(session)));
  return `${encoded}.${await hmac(encoded)}`;
}

async function readSession(request: Request): Promise<Session | null> {
  const authorization = clean(request.headers.get("authorization"));
  const token = authorization.replace(/^Bearer\s+/i, "");
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !constantTimeEqual(signature, await hmac(encoded))) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as Session;
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

function configuredUsers(): ConfiguredUser[] {
  const raw = Deno.env.get("INBOUND_AUTH_USERS") || "[]";
  const users = JSON.parse(raw);
  if (!Array.isArray(users)) throw new Error("INBOUND_AUTH_USERS harus berupa JSON array.");
  const commercialRaw = Deno.env.get("INBOUND_COMMERCIAL_USER") || "";
  if (!commercialRaw) return users;
  const commercial = JSON.parse(commercialRaw);
  const commercialUsers = Array.isArray(commercial) ? commercial : [commercial];
  return [...users, ...commercialUsers];
}

function authenticate(body: Record<string, unknown>): Session | null {
  const username = clean(body.username).toLowerCase();
  const password = String(body.password || "");
  const user = configuredUsers().find((candidate) =>
    clean(candidate.username).toLowerCase() === username && constantTimeEqual(String(candidate.password || ""), password)
  );
  if (!user) return null;
  return {
    username: clean(user.username),
    role: clean(user.role).toUpperCase(),
    display_name: clean(user.display_name) || clean(user.username),
    exp: Date.now() + 12 * 60 * 60 * 1000,
  };
}

const READ_ROLES = ["SECURITY", "CHECKER", "SPV", "ADMIN", "DEVELOPER", "COMERCIAL"];
const WRITE_ROLES = ["SECURITY", "CHECKER", "SPV", "ADMIN", "DEVELOPER"];

function canUseAction(session: Session | null, action: string): boolean {
  if (!session) return false;
  const role = session.role;
  if (["delete_tickets_by_date", "delete_single_ticket"].includes(action)) return ["ADMIN", "DEVELOPER"].includes(role);
  if (action === "bulk_complete_operational") return role === "DEVELOPER";
  if (["state", "state_delta", "realtime_config", "tickets", "export_rows", "sites"].includes(action)) {
    return READ_ROLES.includes(role);
  }
  // Master PO hanya dipakai layar pendaftaran; COMERCIAL tidak perlu payload berat ini.
  if (action === "po_master") return WRITE_ROLES.includes(role);
  if (["create_ticket", "create_tickets_bulk"].includes(action)) {
    return WRITE_ROLES.includes(role);
  }
  if (["superset_freshness", "ba_list", "ba_detail", "product_lookup", "create_ba"].includes(action)) {
    return ["SPV", "ADMIN", "DEVELOPER"].includes(role);
  }
  return ["updatechecker", "startcheckerpo", "donecheckerpo", "donegrpo", "donegrpos", "handovergrn", "failcall", "update_ticket_status"].includes(action)
    && ["CHECKER", "SPV", "ADMIN", "DEVELOPER"].includes(role);
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  if (request.method !== "POST") return {};
  try { return await request.json(); } catch { return {}; }
}

/**
 * Pagination stabil. `range()` tanpa kolom urut yang unik dapat melewatkan atau
 * menduplikasi baris ketika kolom urutnya punya nilai kembar, jadi selalu ada
 * tiebreaker unik di urutan kedua.
 */
async function fetchAll(
  table: string,
  select = "*",
  orderColumn = "created_at",
  ascending = false,
  tiebreaker = "",
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let query = db.from(table).select(select).order(orderColumn, { ascending });
    if (tiebreaker) query = query.order(tiebreaker, { ascending: true });
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}

function siteParam(requestUrl: URL, body: Record<string, unknown>): string | null {
  const value = clean(requestUrl.searchParams.get("site") || body.site_code || body.site).toUpperCase();
  return value || null;
}

function daysBackParam(requestUrl: URL): number {
  const raw = Number(clean(requestUrl.searchParams.get("days_back")));
  if (!Number.isFinite(raw)) return DEFAULT_DAYS_BACK;
  return Math.min(Math.max(Math.trunc(raw), 0), 90);
}

/** Membungkus payload ber-fingerprint jadi respons 200 + ETag atau 304. */
function fingerprinted(
  request: Request,
  payload: Record<string, unknown>,
  extra: Record<string, string> = {},
): Response {
  const etag = weakEtag(clean(payload.fingerprint));
  if (matchesEtag(request, etag)) return notModifiedResponse(request, etag);
  return jsonResponse(request, 200, { ok: true, data: payload }, { etag, ...extra });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  const requestUrl = new URL(request.url);
  const body = await bodyOf(request);
  const action = clean(requestUrl.searchParams.get("action") || body.action).toLowerCase();
  try {
    if (request.method === "GET" && action === "health") {
      return jsonResponse(request, 200, { ok: true, ...(await rpc("inbound_health", {}) as Record<string, unknown>) });
    }
    if (request.method === "POST" && action === "login") {
      const session = authenticate(body);
      if (!session) return jsonResponse(request, 401, { ok: false, message: "Username atau password salah." });
      return jsonResponse(request, 200, { ok: true, data: { token: await signSession(session), user: {
        username: session.username, role: session.role, display_name: session.display_name,
      } } });
    }
    if (request.method === "POST" && action === "logout") return jsonResponse(request, 200, { ok: true });

    const session = await readSession(request);
    if (!canUseAction(session, action)) return jsonResponse(request, 401, { ok: false, message: "Unauthorized" });
    const site = siteParam(requestUrl, body);

    if (request.method === "GET" && action === "realtime_config") {
      return jsonResponse(request, 200, { ok: true, data: { enabled: false, url: "", publishable_key: "", topic: "", event: "" } });
    }
    if (request.method === "GET" && action === "sites") {
      const { data, error } = await db.from("site_master")
        .select("site_code,location_id,site_name,short_name,gate_prefix,gate_count,active,sort_order")
        .order("sort_order");
      if (error) throw error;
      return jsonResponse(request, 200, { ok: true, data });
    }
    if (request.method === "GET" && action === "state") {
      const payload = await rpc("inbound_operational_snapshot", {
        p_site_code: site, p_days_back: daysBackParam(requestUrl),
      }) as Record<string, unknown>;
      return fingerprinted(request, payload, {
        "x-inbound-rows": String((payload.outputForm as unknown[] | undefined)?.length ?? 0),
        "x-inbound-site": site || "ALL",
      });
    }
    if (request.method === "GET" && action === "state_delta") {
      const since = clean(requestUrl.searchParams.get("since"));
      if (!since || Number.isNaN(new Date(since).getTime())) {
        throw new Error("Parameter since wajib berupa timestamp ISO yang valid.");
      }
      const payload = await rpc("inbound_operational_delta", {
        p_since: since, p_site_code: site, p_days_back: daysBackParam(requestUrl),
      });
      return jsonResponse(request, 200, { ok: true, data: payload });
    }
    if (request.method === "GET" && action === "po_master") {
      // Fingerprint dihitung lebih dulu supaya klien yang sudah up-to-date
      // tidak pernah memaksa Postgres membangun payload puluhan ribu baris.
      const fingerprint = clean(await rpc("inbound_po_master_fingerprint", { p_site_code: site }) as string);
      const etag = weakEtag(fingerprint);
      if (matchesEtag(request, etag)) return notModifiedResponse(request, etag);
      const payload = await rpc("inbound_po_master", { p_site_code: site }) as Record<string, unknown>;
      return jsonResponse(request, 200, { ok: true, data: payload }, {
        etag: weakEtag(clean(payload.fingerprint) || fingerprint),
        "x-inbound-rows": String(payload.total ?? 0),
        "x-inbound-site": site || "ALL",
      });
    }
    if (request.method === "GET" && action === "superset_freshness") return jsonResponse(request, 200, { ok: true, data: await rpc("inbound_superset_freshness", {}) });
    if (request.method === "GET" && action === "export_rows") {
      return jsonResponse(request, 200, {
        ok: true,
        data: await fetchAll("inbound_operational_rows", "*", "created_at", false, "ticket_po_id"),
      });
    }
    if (request.method === "GET" && action === "tickets") {
      let query = db.from("inbound_ticket_summaries").select("*").order("created_at", { ascending: false }).limit(5000);
      const status = clean(requestUrl.searchParams.get("status"));
      if (status) query = query.eq("status", status);
      if (site) query = query.eq("site_code", site);
      const { data, error } = await query; if (error) throw error;
      return jsonResponse(request, 200, { ok: true, data });
    }
    if (request.method === "GET" && action === "product_lookup") {
      const q = clean(requestUrl.searchParams.get("q"));
      if (!q) throw new Error("SKU atau Product ID wajib diisi.");
      let result = await db.from("product_master").select("sku_number,product_id,product_name").eq("sku_number", q).maybeSingle();
      if (!result.data && !result.error) result = await db.from("product_master").select("sku_number,product_id,product_name").eq("product_id", q).limit(1).maybeSingle();
      if (result.error) throw result.error;
      return jsonResponse(request, 200, { ok: true, data: result.data });
    }
    if (request.method === "GET" && action === "ba_list") {
      let query = db.from("ba_documents_summary").select("*").order("created_at", { ascending: false }).limit(500);
      if (site) query = query.eq("site_code", site);
      const { data, error } = await query; if (error) throw error;
      return jsonResponse(request, 200, { ok: true, data });
    }
    if (request.method === "GET" && action === "ba_detail") {
      const baId = clean(requestUrl.searchParams.get("ba_id"));
      const [{ data: document, error: docError }, { data: items, error: itemError }] = await Promise.all([
        db.from("ba_documents").select("*").eq("ba_id", baId).single(),
        db.from("ba_items").select("*").eq("ba_id", baId).order("created_at"),
      ]);
      if (docError || itemError) throw docError || itemError;
      return jsonResponse(request, 200, { ok: true, data: { document, items } });
    }

    const actor = { role: session!.role, name: session!.display_name };
    if (request.method === "POST" && ["create_ticket", "create_tickets_bulk"].includes(action)) {
      const payload = action === "create_ticket" ? { tickets: [body], site_code: site } : { ...body, site_code: site ?? body.site_code };
      const data = await rpc("inbound_create_tickets_bulk", { p_payload: payload, p_actor: actor });
      const result = data as { created?: Record<string, unknown>[] };
      return jsonResponse(request, 201, { ok: true, data: action === "create_ticket" ? result.created?.[0] : data });
    }
    if (request.method === "POST" && action === "update_ticket_status") {
      return jsonResponse(request, 200, { ok: true, data: await rpc("inbound_update_ticket_status", { p_payload: body, p_actor: actor }) });
    }
    if (request.method === "POST" && ["updatechecker", "startcheckerpo", "donecheckerpo", "donegrpo", "donegrpos", "handovergrn", "failcall"].includes(action)) {
      return jsonResponse(request, 200, { ok: true, data: await rpc("inbound_update_ticket_pos", { p_action: action, p_payload: body, p_actor: actor }) });
    }
    if (request.method === "POST" && action === "delete_tickets_by_date") {
      return jsonResponse(request, 200, { ok: true, data: await rpc("inbound_delete_tickets_by_date", { p_operational_date: body.operational_date }) });
    }
    if (request.method === "POST" && action === "delete_single_ticket") {
      return jsonResponse(request, 200, { ok: true, data: await rpc("inbound_delete_single_ticket", { p_payload: body }) });
    }
    if (request.method === "POST" && action === "bulk_complete_operational") {
      return jsonResponse(request, 200, { ok: true, data: await rpc("inbound_bulk_complete_operational", { p_payload: body, p_actor: actor }) });
    }
    if (request.method === "POST" && action === "create_ba") {
      return jsonResponse(request, 201, { ok: true, data: await rpc("inbound_create_ba", { p_payload: { ...body, site_code: site ?? body.site_code }, p_actor: actor }) });
    }
    return jsonResponse(request, 404, { ok: false, message: "Action belum tersedia di backend Supabase." });
  } catch (error) {
    const message = errorMessage(error) || "Supabase backend error";
    console.error("inbound-api", { action, message });
    return jsonResponse(request, 500, { ok: false, message });
  }
});
