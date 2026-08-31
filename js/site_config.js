/* ==========================================================================
 * ANTRIAN INBOUND FROZEN — SITE REGISTRY (SINGLE SOURCE OF TRUTH)
 *
 * Seluruh nama gudang, location_id Superset, prefix gate, dan prefix nomor BA
 * hanya boleh didefinisikan di file ini. Menambah gudang baru cukup dengan
 * mengubah `active: false` menjadi `active: true` pada entri di bawah.
 *
 * location_id di sini WAJIB sama dengan kolom `location_id` pada chart Superset
 * dan kolom `site_master.location_id` di Supabase.
 * ========================================================================== */
(function exposeInboundSiteRegistry(root, factory) {
  const registry = factory();
  if (typeof module === "object" && module.exports) module.exports = registry;
  if (root) root.InboundSites = registry;
})(typeof globalThis !== "undefined" ? globalThis : this, function createInboundSiteRegistry() {
  "use strict";

  const STORAGE_KEY = "inbound_frozen_site_v1";

  /**
   * gateCount mengikuti jumlah dock inbound fisik per gudang.
   * Ubah angkanya bila gudang menambah/mengurangi dock; UI, dropdown gate,
   * dan panel visibilitas gate otomatis mengikuti.
   */
  const SITE_LIST = [
    {
      code: "PGS",
      location_id: "160",
      name: "Pegangsaan",
      short_name: "Pegangsaan",
      timezone: "Asia/Jakarta",
      gate_prefix: "PGS-GATE-INB-01",
      gate_count: 9,
      active: true,
    },
    {
      code: "SRG",
      location_id: "796",
      name: "Srengseng",
      short_name: "Srengseng",
      timezone: "Asia/Jakarta",
      gate_prefix: "SRG-GATE-INB-01",
      gate_count: 6,
      active: false,
    },
    {
      code: "BIT",
      location_id: "983",
      name: "Bitung",
      short_name: "Bitung",
      timezone: "Asia/Jakarta",
      gate_prefix: "BIT-GATE-INB-01",
      gate_count: 6,
      active: false,
    },
    {
      code: "CSI",
      location_id: "998",
      name: "Cileungsi",
      short_name: "Cileungsi",
      timezone: "Asia/Jakarta",
      gate_prefix: "CSI-GATE-INB-01",
      gate_count: 6,
      active: false,
    },
  ];

  const BY_CODE = new Map(SITE_LIST.map((site) => [site.code, site]));
  const BY_LOCATION_ID = new Map(SITE_LIST.map((site) => [site.location_id, site]));

  /**
   * Daftar gate yang dikirim backend (tabel site_master). Bila tersedia, ini
   * yang dipakai UI supaya mengaktifkan gudang baru cukup dilakukan di database
   * tanpa perlu men-deploy ulang frontend.
   */
  let serverGates = null;

  function normalizeCode(value) {
    return String(value || "").trim().toUpperCase();
  }

  function gateNamesFor(site) {
    if (!site) return [];
    return Array.from(
      { length: Math.max(0, Number(site.gate_count) || 0) },
      (_, index) => `${site.gate_prefix}-${String(index + 1).padStart(2, "0")}`,
    );
  }

  function all() {
    return SITE_LIST.map((site) => ({ ...site, gates: gateNamesFor(site) }));
  }

  function activeSites() {
    return all().filter((site) => site.active);
  }

  function get(code) {
    const site = BY_CODE.get(normalizeCode(code));
    return site ? { ...site, gates: gateNamesFor(site) } : null;
  }

  function byLocationId(locationId) {
    const site = BY_LOCATION_ID.get(String(locationId || "").trim());
    return site ? { ...site, gates: gateNamesFor(site) } : null;
  }

  function defaultSite() {
    return activeSites()[0] || all()[0];
  }

  /** Gudang yang sedang dilihat operator. Tersimpan per browser. */
  function current() {
    let stored = "";
    try {
      stored = normalizeCode(globalThis.localStorage?.getItem(STORAGE_KEY));
    } catch {
      stored = "";
    }
    const site = stored ? get(stored) : null;
    return site && site.active ? site : defaultSite();
  }

  function setCurrent(code) {
    const site = get(code);
    if (!site || !site.active) return current();
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, site.code);
    } catch {
      /* Private mode tetap jalan dengan default site. */
    }
    return site;
  }

  function activeLocationIds() {
    return activeSites().map((site) => site.location_id);
  }

  /**
   * Katalog dari backend menimpa daftar lokal. Dipanggil setiap kali payload
   * `state` diterima; `active` di file ini hanya menjadi nilai awal.
   */
  function applyServerCatalog(catalog = {}) {
    const sites = Array.isArray(catalog.sites) ? catalog.sites : [];
    sites.forEach((row) => {
      const site = BY_CODE.get(normalizeCode(row.site_code || row.code));
      if (!site) return;
      site.active = true;
      if (row.location_id) site.location_id = String(row.location_id).trim();
      if (row.site_name) site.name = String(row.site_name).trim();
      if (row.short_name) site.short_name = String(row.short_name).trim();
      if (row.gate_prefix) site.gate_prefix = String(row.gate_prefix).trim();
      if (Number.isFinite(Number(row.gate_count))) site.gate_count = Number(row.gate_count);
    });
    if (sites.length) {
      const activeCodes = new Set(sites.map((row) => normalizeCode(row.site_code || row.code)));
      SITE_LIST.forEach((site) => {
        site.active = activeCodes.has(site.code);
      });
      BY_LOCATION_ID.clear();
      SITE_LIST.forEach((site) => BY_LOCATION_ID.set(site.location_id, site));
    }
    const gates = Array.isArray(catalog.gates) ? catalog.gates.filter(Boolean) : [];
    serverGates = gates.length ? gates.map((gate) => String(gate).trim()) : null;
    return activeSites();
  }

  /** Nama gate untuk gudang yang sedang dilihat. */
  function gateOptions(code) {
    const site = code ? get(code) : current();
    if (serverGates?.length) {
      const scoped = serverGates.filter((gate) =>
        site ? gate.toUpperCase().startsWith(`${site.code}-`) : true,
      );
      if (scoped.length) return scoped;
    }
    return gateNamesFor(site);
  }

  function activeGateNames() {
    if (serverGates?.length) return [...serverGates];
    return activeSites().flatMap((site) => gateNamesFor(site));
  }

  /** Mengubah "PGS-GATE-INB-01-03" menjadi "PGS 03" untuk kartu gate. */
  function gateLabel(gate) {
    const text = String(gate || "").trim();
    if (!text) return "-";
    const site = all().find((item) => text.toUpperCase().startsWith(`${item.code}-`));
    const number = text.match(/(\d{2})\s*$/)?.[1] || text.match(/\d+/)?.[0] || "-";
    return site ? `${site.code} ${number}` : text;
  }

  function siteOfGate(gate) {
    const text = String(gate || "").trim().toUpperCase();
    return all().find((item) => text.startsWith(`${item.code}-`)) || null;
  }

  const BRAND_FULL = "Antrian Inbound Frozen";
  const BRAND_SHORT = "Inbound Frozen";

  /** "Inbound Frozen · Pegangsaan" — dipakai di header, tiket, dan layar TV. */
  function brand(withSite = true) {
    const site = current();
    return withSite && site ? `${BRAND_SHORT} · ${site.short_name || site.name}` : BRAND_SHORT;
  }

  function brandFull() {
    return BRAND_FULL;
  }

  /** Row Superset milik gudang aktif saja. */
  function rowBelongsToActiveSite(row) {
    const site = byLocationId(row?.location_id);
    return !!site && site.active;
  }

  return {
    BRAND_FULL,
    BRAND_SHORT,
    STORAGE_KEY,
    all,
    activeSites,
    brand,
    brandFull,
    activeLocationIds,
    activeGateNames,
    applyServerCatalog,
    byLocationId,
    current,
    defaultSite,
    gateLabel,
    gateNamesFor,
    gateOptions,
    get,
    normalizeCode,
    rowBelongsToActiveSite,
    setCurrent,
    siteOfGate,
  };
});
