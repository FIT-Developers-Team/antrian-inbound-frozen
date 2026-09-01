/* ============================================================================
 * ANTRIAN INBOUND FROZEN — EDGE FUNCTION
 *
 * Satu-satunya permukaan API. Browser tidak pernah menyentuh Postgres langsung
 * dan tidak pernah memegang service-role key.
 *
 * Permukaan aksi sengaja dipersempit menjadi apa yang benar-benar dipakai
 * aplikasi setelah revamp. Aksi lama untuk BA reject, pencarian produk,
 * tracker komersial, dan `export_rows` tanpa batas tanggal dihapus bersama
 * halaman yang memakainya.
 * ========================================================================== */

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
const db = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const encoder = new TextEncoder();

/** Jendela hari operasional yang dikirim ke papan. Riwayat diambil terpisah. */
const DEFAULT_DAYS_BACK = Number(clean(Deno.env.get("INBOUND_BOARD_DAYS_BACK"))) || 2;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return clean((error as { message?: unknown }).message);
  }
  return String(error);
}

/* --------------------------------------------------------------------------
 * Sesi bertanda tangan
 * ----------------------------------------------------------------------- */
function base64Url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}

async function hmac(value: string): Promise<string> {
  const secret = clean(Deno.env.get("INBOUND_AUTH_SECRET"));
  if (!secret) throw new Error("INBOUND_AUTH_SECRET belum diset di Supabase Secrets.");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function signSession(session: Session): Promise<string> {
  const encoded = base64Url(encoder.encode(JSON.stringify(session)));
  return `${encoded}.${await hmac(encoded)}`;
}

async function readSession(request: Request): Promise<Session | null> {
  const token = clean(request.headers.get("authorization")).replace(/^Bearer\s+/i, "");
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !constantTimeEqual(signature, await hmac(encoded))) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as Session;
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

/** Dilempar ketika daftar akun tidak dapat dibaca — bukan karena salah sandi. */
class AuthConfigError extends Error {}

/**
 * Membaca daftar akun dari `INBOUND_AUTH_USERS`.
 *
 * Setiap kegagalan di sini adalah masalah konfigurasi server, bukan kesalahan
 * operator. Sebelumnya semuanya berakhir sebagai 401 "Username atau password
 * salah", sehingga secret yang belum diset dan sandi yang keliru terlihat
 * persis sama dari layar login — dan tidak ada cara membedakannya tanpa akses
 * ke log Supabase.
 */
function configuredUsers(): ConfiguredUser[] {
  const raw = clean(Deno.env.get("INBOUND_AUTH_USERS"));
  if (!raw) {
    throw new AuthConfigError(
      "INBOUND_AUTH_USERS belum diset di Supabase Secrets, jadi belum ada akun yang dapat masuk.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthConfigError(
      "INBOUND_AUTH_USERS bukan JSON yang sah. Formatnya harus array, contoh: " +
        '[{"username":"admin","password":"...","role":"ADMIN","display_name":"Admin"}]',
    );
  }

  if (!Array.isArray(parsed)) {
    throw new AuthConfigError("INBOUND_AUTH_USERS harus berupa JSON array.");
  }
  if (parsed.length === 0) {
    throw new AuthConfigError("INBOUND_AUTH_USERS berisi array kosong; belum ada akun terdaftar.");
  }
  return parsed as ConfiguredUser[];
}

const KNOWN_ROLES = ["SECURITY", "CHECKER", "SPV", "ADMIN", "DEVELOPER"];

function authenticate(body: Record<string, unknown>): Session | null {
  const username = clean(body.username).toLowerCase();
  const password = String(body.password || "");
  const user = configuredUsers().find(
    (candidate) =>
      clean(candidate.username).toLowerCase() === username &&
      // Perbandingan waktu-tetap: perbandingan biasa membocorkan panjang awalan
      // password yang cocok lewat selisih waktu respons.
      constantTimeEqual(String(candidate.password || ""), password),
  );
  if (!user) return null;

  const role = clean(user.role).toUpperCase();
  // Peran yang salah ketik akan lolos login lalu ditolak oleh setiap aksi,
  // yang di layar tampak seperti aplikasi rusak, bukan seperti salah konfigurasi.
  if (!KNOWN_ROLES.includes(role)) {
    throw new AuthConfigError(
      `Akun "${clean(user.username)}" memakai role "${clean(user.role)}" yang tidak dikenal. ` +
        `Role yang sah: ${KNOWN_ROLES.join(", ")}.`,
    );
  }

  return {
    username: clean(user.username),
    role,
    display_name: clean(user.display_name) || clean(user.username),
    exp: Date.now() + 12 * 60 * 60 * 1000,
  };
}

/**
 * Diagnostik konfigurasi akun. Sengaja TIDAK memuat username maupun password —
 * hanya jumlah akun, keabsahan JSON, dan daftar role — supaya cukup untuk
 * menjawab "kenapa tidak bisa login" tanpa menjadi alat pengintai bagi orang
 * luar. Inilah yang dibaca `npm run doctor`.
 */
function authStatus(): Record<string, unknown> {
  const present = Boolean(clean(Deno.env.get("INBOUND_AUTH_USERS")));
  try {
    const users = configuredUsers();
    const roles = [...new Set(users.map((user) => clean(user.role).toUpperCase()))];
    return {
      secret_present: present,
      parse_ok: true,
      users_configured: users.length,
      roles,
      unknown_roles: roles.filter((role) => !KNOWN_ROLES.includes(role)),
      accounts_missing_password: users.filter((user) => !String(user.password || "")).length,
      auth_secret_present: Boolean(clean(Deno.env.get("INBOUND_AUTH_SECRET"))),
      allowed_origins: clean(Deno.env.get("APP_ORIGINS")).split(",").map((o) => o.trim()).filter(Boolean),
    };
  } catch (error) {
    return {
      secret_present: present,
      parse_ok: false,
      users_configured: 0,
      message: error instanceof Error ? error.message : String(error),
      auth_secret_present: Boolean(clean(Deno.env.get("INBOUND_AUTH_SECRET"))),
      allowed_origins: clean(Deno.env.get("APP_ORIGINS")).split(",").map((o) => o.trim()).filter(Boolean),
    };
  }
}

/* --------------------------------------------------------------------------
 * Otorisasi
 * ----------------------------------------------------------------------- */
const READ_ACTIONS = ["board", "history", "sites", "source_freshness"];
const ALL_ROLES = ["SECURITY", "CHECKER", "SPV", "ADMIN", "DEVELOPER"];

/** Peran yang boleh menjalankan tiap aksi tulis. */
const WRITE_ACTIONS: Record<string, string[]> = {
  create_ticket: ["SECURITY", "SPV", "ADMIN", "DEVELOPER"],
  po_master: ["SECURITY", "SPV", "ADMIN", "DEVELOPER"],
  // Kedatangan dicatat Security di pos masuk; Checker dan SPV boleh mengoreksi.
  set_arrival: ALL_ROLES,
  call_ticket: ["CHECKER", "SPV", "ADMIN", "DEVELOPER"],
  start_unloading: ["CHECKER", "SPV", "ADMIN", "DEVELOPER"],
  finish_unloading: ["CHECKER", "SPV", "ADMIN", "DEVELOPER"],
  cancel_ticket: ["SPV", "ADMIN", "DEVELOPER"],
  delete_tickets_by_date: ["ADMIN", "DEVELOPER"],
  delete_single_ticket: ["ADMIN", "DEVELOPER"],
};

function canUseAction(session: Session | null, action: string): boolean {
  if (!session) return false;
  if (READ_ACTIONS.includes(action)) return ALL_ROLES.includes(session.role);
  return WRITE_ACTIONS[action]?.includes(session.role) ?? false;
}

/* --------------------------------------------------------------------------
 * Bantuan
 * ----------------------------------------------------------------------- */
async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  if (request.method !== "POST") return {};
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}

function siteParam(requestUrl: URL, body: Record<string, unknown>): string | null {
  return clean(requestUrl.searchParams.get("site") || body.site_code || body.site).toUpperCase() || null;
}

/** Membungkus payload ber-fingerprint menjadi 200 + ETag atau 304 tanpa body. */
function fingerprinted(
  request: Request,
  payload: Record<string, unknown>,
  extra: Record<string, string> = {},
): Response {
  const etag = weakEtag(clean(payload.fingerprint));
  if (matchesEtag(request, etag)) return notModifiedResponse(request, etag);
  return jsonResponse(request, 200, { ok: true, data: payload }, { etag, ...extra });
}

/* --------------------------------------------------------------------------
 * Router
 * ----------------------------------------------------------------------- */
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);

  const requestUrl = new URL(request.url);
  const body = await bodyOf(request);
  const action = clean(requestUrl.searchParams.get("action") || body.action).toLowerCase();

  try {
    if (request.method === "GET" && action === "health") {
      return jsonResponse(request, 200, {
        ok: true,
        ...((await rpc("inbound_health", {})) as Record<string, unknown>),
      });
    }

    // Diagnostik terbuka: menjawab "kenapa tidak bisa login" tanpa membocorkan
    // username, password, maupun apa pun yang berguna bagi penyerang.
    if (request.method === "GET" && action === "auth_status") {
      return jsonResponse(request, 200, { ok: true, data: authStatus() });
    }

    if (request.method === "POST" && action === "login") {
      let session: Session | null;
      try {
        session = authenticate(body);
      } catch (error) {
        // Salah konfigurasi server dijawab 503, bukan 401. Keduanya gagal
        // masuk, tetapi hanya satu di antaranya yang dapat diperbaiki operator
        // dengan mengetik ulang sandinya.
        if (error instanceof AuthConfigError) {
          console.error("inbound-api auth config", error.message);
          return jsonResponse(request, 503, { ok: false, message: error.message });
        }
        throw error;
      }
      if (!session) {
        return jsonResponse(request, 401, { ok: false, message: "Username atau password salah." });
      }
      return jsonResponse(request, 200, {
        ok: true,
        data: {
          token: await signSession(session),
          user: {
            username: session.username,
            role: session.role,
            display_name: session.display_name,
          },
        },
      });
    }

    if (request.method === "POST" && action === "logout") return jsonResponse(request, 200, { ok: true });

    const session = await readSession(request);
    if (!canUseAction(session, action)) {
      return jsonResponse(request, 401, { ok: false, message: "Unauthorized" });
    }
    const site = siteParam(requestUrl, body);
    const actor = { role: session!.role, name: session!.display_name };

    /* ---- Baca ---------------------------------------------------------- */
    if (request.method === "GET" && action === "sites") {
      const { data, error } = await db
        .from("site_master")
        .select("site_code,location_id,site_name,short_name,gate_prefix,gate_count,active,sort_order")
        .order("sort_order");
      if (error) throw error;
      return jsonResponse(request, 200, { ok: true, data });
    }

    if (request.method === "GET" && action === "board") {
      const raw = Number(clean(requestUrl.searchParams.get("days_back")));
      const daysBack = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), 30) : DEFAULT_DAYS_BACK;
      const payload = (await rpc("inbound_board_snapshot", {
        p_site_code: site,
        p_days_back: daysBack,
      })) as Record<string, unknown>;
      return fingerprinted(request, payload, {
        "x-inbound-rows": String((payload.rows as unknown[] | undefined)?.length ?? 0),
        "x-inbound-site": site || "ALL",
      });
    }

    // Kesegaran rantai Superset → superset_po_master. Snapshot papan sudah
    // membawanya, jadi ini hanya untuk pemeriksaan manual dan `npm run doctor`.
    if (request.method === "GET" && action === "source_freshness") {
      return jsonResponse(request, 200, {
        ok: true,
        data: await rpc("inbound_source_freshness", { p_site_code: site }),
      });
    }

    if (request.method === "GET" && action === "history") {
      return jsonResponse(request, 200, {
        ok: true,
        data: await rpc("inbound_history", {
          p_site_code: site,
          p_from: clean(requestUrl.searchParams.get("from")) || null,
          p_to: clean(requestUrl.searchParams.get("to")) || null,
        }),
      });
    }

    if (request.method === "GET" && action === "po_master") {
      // Fingerprint dihitung lebih dulu supaya klien yang sudah mutakhir tidak
      // pernah memaksa Postgres membangun payload puluhan ribu baris.
      const fingerprint = clean(
        (await rpc("inbound_po_master_fingerprint", { p_site_code: site })) as string,
      );
      const etag = weakEtag(fingerprint);
      if (matchesEtag(request, etag)) return notModifiedResponse(request, etag);
      const payload = (await rpc("inbound_po_master", { p_site_code: site })) as Record<string, unknown>;
      return jsonResponse(request, 200, { ok: true, data: payload }, {
        etag: weakEtag(clean(payload.fingerprint) || fingerprint),
        "x-inbound-rows": String(payload.total ?? 0),
      });
    }

    /* ---- Tulis --------------------------------------------------------- */
    if (request.method === "POST" && action === "create_ticket") {
      const data = (await rpc("inbound_create_tickets_bulk", {
        p_payload: { tickets: [body], site_code: site ?? body.site_code },
        p_actor: actor,
      })) as { created?: Record<string, unknown>[] };
      return jsonResponse(request, 201, { ok: true, data: data.created?.[0] });
    }

    const TICKET_RPC: Record<string, string> = {
      set_arrival: "inbound_set_arrival",
      call_ticket: "inbound_call_ticket",
      start_unloading: "inbound_start_unloading",
      finish_unloading: "inbound_finish_unloading",
      cancel_ticket: "inbound_cancel_ticket",
    };
    if (request.method === "POST" && TICKET_RPC[action]) {
      return jsonResponse(request, 200, {
        ok: true,
        data: await rpc(TICKET_RPC[action], { p_payload: body, p_actor: actor }),
      });
    }

    if (request.method === "POST" && action === "delete_tickets_by_date") {
      return jsonResponse(request, 200, {
        ok: true,
        data: await rpc("inbound_delete_tickets_by_date", { p_operational_date: body.operational_date }),
      });
    }

    if (request.method === "POST" && action === "delete_single_ticket") {
      return jsonResponse(request, 200, {
        ok: true,
        data: await rpc("inbound_delete_single_ticket", { p_payload: body }),
      });
    }

    return jsonResponse(request, 404, { ok: false, message: "Action tidak dikenal." });
  } catch (error) {
    const message = errorMessage(error) || "Supabase backend error";
    console.error("inbound-api", { action, message });
    return jsonResponse(request, 500, { ok: false, message });
  }
});
