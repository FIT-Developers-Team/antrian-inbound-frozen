/* ==========================================================================
 * TEMA
 *
 * Tiga keadaan, bukan dua: terang, gelap, dan "ikut sistem". Tanpa keadaan
 * ketiga, tablet gudang yang berpindah ke mode gelap otomatis pada malam hari
 * akan tetap menyala terang di mata operator shift malam.
 * ========================================================================== */

import { STORAGE } from "./config.js";

export function currentTheme() {
  try {
    return globalThis.localStorage?.getItem(STORAGE.theme) || "system";
  } catch {
    return "system";
  }
}

export function setTheme(mode) {
  try {
    if (mode === "system") globalThis.localStorage?.removeItem(STORAGE.theme);
    else globalThis.localStorage?.setItem(STORAGE.theme, mode);
  } catch {
    /* Mode penyamaran tetap dapat mengganti tema untuk sesi berjalan. */
  }
  applyTheme();
}

/**
 * `light` dan `dark` dipasang sebagai kelas eksplisit. Kelas `light` penting:
 * tanpa itu, pilihan terang akan kalah oleh `prefers-color-scheme: dark` di
 * perangkat yang setelan sistemnya gelap.
 */
export function applyTheme() {
  const mode = currentTheme();
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark");
  root.classList.toggle("light", mode === "light");
}

/** Menyiklus tema untuk tombol tunggal di topbar. */
export function cycleTheme() {
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(currentTheme()) + 1) % order.length];
  setTheme(next);
  return next;
}

export function themeIconName() {
  const mode = currentTheme();
  if (mode === "dark") return "moon";
  if (mode === "light") return "sun";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "moon" : "sun";
}
