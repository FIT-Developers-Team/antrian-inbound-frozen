(function configureInboundSupabaseBackend() {
  "use strict";

  const FUNCTION_BASE =
    "https://qiafoaoslnbmtsbnmqou.supabase.co/functions/v1/inbound-api";
  const SESSION_KEY = "inbound_frozen_supabase_session_v1";

  window.INBOUND_BACKEND_URL = FUNCTION_BASE;
  window.getInboundSessionToken = function getInboundSessionToken() {
    return localStorage.getItem(SESSION_KEY) || "";
  };
  window.setInboundSessionToken = function setInboundSessionToken(token) {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  };
  window.clearInboundSessionToken = function clearInboundSessionToken() {
    localStorage.removeItem(SESSION_KEY);
  };
})();
