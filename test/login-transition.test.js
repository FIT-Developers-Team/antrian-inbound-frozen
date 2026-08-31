const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSubmitLogin(context) {
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
  const start = source.indexOf("async function submitLogin(e)");
  const end = source.indexOf("function logoutUser()", start);
  assert.ok(start >= 0 && end > start, "submitLogin function must be present in js/app.js");
  const functionSource = source.slice(start, end);
  vm.runInNewContext(`${functionSource}; globalThis.__submitLogin = submitLogin;`, context);
  return context.__submitLogin;
}

test("successful login leaves the login screen before API initialization completes", async () => {
  let resolveApi;
  const apiPending = new Promise((resolve) => { resolveApi = resolve; });
  const renderedPages = [];
  const context = {
    window: {
      INBOUND_BACKEND_URL: "https://example.supabase.co/functions/v1/inbound-api",
      setInboundSessionToken() {},
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ data: { user: { username: "pandu", role: "DEVELOPER" } } }),
    }),
    setAuthUser() {},
    applyRoleAccessUI() {},
    showToast() {},
    normalizeRole: (role) => role,
    getDefaultPageForRole: () => "daftar",
    state: { page: "login" },
    initApi: () => apiPending,
    renderPage: (page) => renderedPages.push(page),
    console,
  };
  const submitLogin = loadSubmitLogin(context);
  const form = {
    username: { value: "pandu" },
    password: { value: "secret", classList: { add() {} } },
  };

  const loginPromise = submitLogin({ preventDefault() {}, target: form });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(renderedPages.length, 1);
  assert.equal(renderedPages[0], "daftar");
  resolveApi();
  await loginPromise;
});
