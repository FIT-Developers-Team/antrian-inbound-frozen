import { RealtimeClient } from "@supabase/realtime-js";

let supabaseClient = null;
let realtimeChannel = null;
let configIdentity = "";
let refreshTimer = null;
let startPromise = null;
let connectionGeneration = 0;

function updateRealtimeIndicator(status, text) {
  window.updateGlobalAutoSyncIndicatorV11?.(status, text);
}

function scheduleDeltaRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    window.forceGlobalAutoSyncV11?.();
  }, 80);
}

async function fetchRealtimeConfig() {
  const response = await fetch(`${window.INBOUND_BACKEND_URL}?action=realtime_config`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${window.getInboundSessionToken?.() || ""}`,
    },
    cache: "no-store",
  });
  const json = await response.json();
  if (!response.ok || json?.ok === false) {
    throw new Error(json?.message || "Realtime config gagal dimuat");
  }
  return json?.data || json;
}

async function disconnectCurrentChannel() {
  clearTimeout(refreshTimer);
  refreshTimer = null;
  configIdentity = "";
  if (realtimeChannel && supabaseClient) {
    try {
      await supabaseClient.removeChannel(realtimeChannel);
      await supabaseClient.disconnect();
    } catch {
      // Connection cleanup is best effort during logout/page teardown.
    }
  }
  realtimeChannel = null;
  supabaseClient = null;
}

async function stopInboundRealtime() {
  connectionGeneration += 1;
  startPromise = null;
  await disconnectCurrentChannel();
}

async function connectInboundRealtime() {
  if (!window.isLoggedIn?.()) return false;
  const generation = ++connectionGeneration;
  const config = await fetchRealtimeConfig();
  if (generation !== connectionGeneration || !window.isLoggedIn?.()) return false;
  if (!config?.enabled || !config.url || !config.publishable_key) {
    updateRealtimeIndicator("online", "Polling cadangan aktif");
    return false;
  }

  const identity = `${config.url}|${config.topic}|${config.event}`;
  if (realtimeChannel && configIdentity === identity) return true;
  await disconnectCurrentChannel();
  if (generation !== connectionGeneration || !window.isLoggedIn?.()) return false;
  configIdentity = identity;

  const realtimeUrl = `${config.url.replace(/^http/i, "ws")}/realtime/v1`;
  supabaseClient = new RealtimeClient(realtimeUrl, {
    params: {
      apikey: config.publishable_key,
      eventsPerSecond: 10,
    },
    accessToken: async () => config.publishable_key,
  });

  realtimeChannel = supabaseClient
    .channel(config.topic, {
      config: { broadcast: { ack: false, self: false }, private: false },
    })
    .on("broadcast", { event: config.event }, scheduleDeltaRefresh)
    .subscribe((status, error) => {
      if (status === "SUBSCRIBED") {
        updateRealtimeIndicator("online", "Realtime aktif");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error("Supabase Realtime channel gagal", status, error);
        updateRealtimeIndicator("pending", "Realtime reconnect · polling aktif");
      }
    });
  return true;
}

window.startInboundRealtime = function startInboundRealtime() {
  if (startPromise) return startPromise;
  startPromise = connectInboundRealtime()
    .catch((error) => {
      console.error("Supabase Realtime init gagal", error);
      updateRealtimeIndicator("pending", "Polling cadangan aktif");
      return false;
    })
    .finally(() => {
      startPromise = null;
    });
  return startPromise;
};

window.stopInboundRealtime = stopInboundRealtime;
