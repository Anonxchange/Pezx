const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("../artifacts/pexo/node_modules/typescript");
const root = `${__dirname}/../artifacts/pexo/src/lib/`;

function load(name, imports, globals = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(root + name + ".ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: path => {
      if (!(path in imports)) throw new Error(`Unexpected import: ${path}`);
      return imports[path];
    },
    Event, CustomEvent, AbortSignal, setTimeout, console, Intl, ...globals,
  });
  return module.exports;
}

function preferences({ saved = {}, detect = async () => "NG", blocked = false } = {}) {
  const storage = new Map(Object.entries(saved));
  const window = new EventTarget();
  window.localStorage = {
    getItem(key) { if (blocked) throw new Error("blocked"); return storage.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error("blocked"); storage.set(key, value); },
  };
  const api = load("country-preferences", {
    react: { useEffect() {}, useSyncExternalStore() {} },
    "./geo": { getCountryCode: detect },
  }, { window });
  return { api, storage, window };
}

test("fresh entry shares one detection across concurrent initializers", async () => {
  let calls = 0;
  const { api } = preferences({ detect: async () => { calls++; return "NG"; } });
  await Promise.all([api.initializeCountryPreferences(), api.initializeCountryPreferences(), api.initializeCountryPreferences()]);
  assert.equal(calls, 1);
  assert.equal(api.getCountryPreferences().digital.country, "NG");
  assert.equal(api.getCountryPreferences().delivery.country, "NG");
});

test("manual choices made during detection win, and scopes stay independent", async () => {
  let resolve;
  const { api } = preferences({ detect: () => new Promise(r => { resolve = r; }) });
  const ready = api.initializeCountryPreferences();
  api.setCountryPreference("digital", "gb");
  resolve("NG");
  await ready;
  assert.equal(api.getCountryPreferences().digital.country, "GB");
  assert.equal(api.getCountryPreferences().delivery.country, "NG");
  api.setCountryPreference("delivery", "CA");
  assert.equal(api.getCountryPreferences().digital.country, "GB");
});

test("saved manual preferences survive reload and avoid detection", async () => {
  const first = preferences();
  first.api.setCountryPreference("digital", "FR");
  first.api.setCountryPreference("delivery", "CA");
  const second = preferences({ saved: Object.fromEntries(first.storage), detect: () => { throw new Error("must not detect"); } });
  await second.api.initializeCountryPreferences();
  assert.equal(second.api.getCountryPreferences().digital.country, "FR");
  assert.equal(second.api.getCountryPreferences().delivery.country, "CA");
});

test("migration keeps explicit header preference over conflicting shelf choice", () => {
  const { api } = preferences({ saved: {
    pexly_gift_card_country: "GB", "px-country": "NG", pexly_market_country: "CA",
  } });
  assert.equal(api.getCountryPreferences().digital.country, "GB");
  assert.equal(api.getCountryPreferences().delivery.country, "CA");
  assert.equal(api.getCountryPreferences().legacyConflict, true);
});

test("new preference is never overwritten by historic keys", () => {
  const { api } = preferences({ saved: {
    pexly_country_preferences_v1: JSON.stringify({ digital: { country: "FR", source: "manual" } }),
    pexly_gift_card_country: "GB", "px-country": "NG",
  } });
  assert.equal(api.getCountryPreferences().digital.country, "FR");
});

test("blocked storage retains choices in memory and reports session-only persistence", async () => {
  const { api } = preferences({ blocked: true });
  await api.initializeCountryPreferences();
  api.setCountryPreference("digital", "GB");
  assert.equal(api.getCountryPreferences().digital.country, "GB");
  assert.equal(api.getCountryPreferences().delivery.country, "NG");
  assert.equal(api.getCountryPreferences().storageBlocked, true);
});

test("detection failure leaves unset preferences unset, with no US fallback", async () => {
  const { api } = preferences({ detect: async () => { throw new Error("network"); } });
  await api.initializeCountryPreferences();
  assert.equal(api.getCountryPreferences().detection, "failed");
  assert.equal(api.getCountryPreferences().digital, undefined);
  assert.equal(api.getCountryPreferences().delivery, undefined);
  api.setCountryPreference("digital", "GB");
  assert.equal(api.getCountryPreferences().digital.country, "GB");
});

test("invalid stored values are ignored and invalid writes are rejected", () => {
  const { api } = preferences({ saved: { "px-country": "ALL", pexly_market_country: "abc" } });
  api.setCountryPreference("digital", "not-a-country");
  assert.equal(api.getCountryPreferences().digital, undefined);
  assert.equal(api.getCountryPreferences().delivery, undefined);
});

test("one manual change emits one shared-scope event", () => {
  const { api, window } = preferences();
  let digital = 0, delivery = 0;
  window.addEventListener("pexly:gift-card-market-changed", () => digital++);
  window.addEventListener("pexly:market-changed", () => delivery++);
  api.setCountryPreference("digital", "CA");
  assert.equal(digital, 1);
  assert.equal(delivery, 0);
});

test("geo lookup is cached and deduplicated independently of callers", async () => {
  let calls = 0;
  const geo = load("geo", {}, {
    document: { querySelector: () => null },
    fetch: async () => { calls++; return { ok: true, json: async () => ({ country_code: "ng" }) }; },
  });
  assert.deepEqual(await Promise.all([geo.getCountryCode(), geo.getCountryCode()]), ["NG", "NG"]);
  assert.equal(calls, 1);
});

test("geo failure is cached and explicitly rejected", async () => {
  let calls = 0;
  const geo = load("geo", {}, {
    document: { querySelector: () => null },
    fetch: async () => { calls++; throw new Error("timeout"); },
  });
  await assert.rejects(geo.getCountryCode(), /choose it in the header/);
  await assert.rejects(geo.getCountryCode(), /choose it in the header/);
  assert.equal(calls, 1);
  assert.equal(await geo.getCallingCode(), "");
});

function shop({ countries = ["GB", "CA"], rejectIdentity = false, rejectLocalization = false, identityHttpError = false } = {}) {
  let country = "GB";
  const calls = [];
  const store = new Map([["shopify_cart_id", "test-cart"]]);
  const window = new EventTarget();
  const api = load("shopify-service", {
    sonner: { toast: { error() {}, info() {} } },
    "./dev-logger": { devLog: { error() {}, warn() {} } },
    "./safe-storage": { safeStorage: { getItem: key => store.get(key) ?? null } },
    "./country-preferences": {
      getCountryPreferences: () => ({ delivery: { country } }),
      setCountryPreference: (_scope, value) => { country = value; },
      initializeCountryPreferences: async () => {},
    },
    "./supabase": { getSupabase: async () => ({ functions: { invoke: async (_name, { body }) => {
      calls.push(body);
      if (body.queryName === "getLocalization" && rejectLocalization) return { error: { message: "Invalid query name", status: 400 } };
      if (body.queryName === "cartBuyerIdentityUpdate" && identityHttpError) return { error: { message: "Invalid query name", status: 400 } };
      if (body.queryName === "getLocalization") return { data: { data: { localization: {
        availableCountries: countries.map(isoCode => ({ isoCode, name: isoCode, currency: { isoCode: isoCode === "GB" ? "GBP" : "CAD" } })),
      } } } };
      if (body.queryName === "cartBuyerIdentityUpdate") return { data: { data: {
        cartBuyerIdentityUpdate: {
          cart: { id: "test-cart", buyerIdentity: { countryCode: body.variables.buyerIdentity.countryCode } },
          userErrors: rejectIdentity ? [{ message: "Not supported" }] : [],
        },
      } } };
      return { data: { data: { products: { edges: [] } } } };
    } } }) },
  }, { window });
  return { api, calls, country: () => country };
}

test("only configured Shopify markets are offered and delivery change updates cart first", async () => {
  const { api, calls, country } = shop();
  const markets = await api.shopifyService.getAvailableCountries();
  assert.equal(markets.length, 2);
  await api.shopifyService.changeDeliveryCountry("CA");
  assert.equal(country(), "CA");
  const mutation = calls.find(c => c.queryName === "cartBuyerIdentityUpdate");
  assert.equal(mutation.variables.buyerIdentity.countryCode, "CA");
  await api.shopifyService.getProducts();
  assert.equal(calls.at(-1).variables.country, "CA");
  assert.equal(calls.filter(c => c.queryName === "getLocalization").length, 1);
});

test("unsupported delivery choice never mutates preference or cart", async () => {
  const { api, calls, country } = shop();
  await assert.rejects(api.shopifyService.changeDeliveryCountry("NG"), /not available/);
  assert.equal(country(), "GB");
  assert.equal(calls.length, 1);
});

test("rejected cart localization preserves the old delivery preference", async () => {
  const { api, country } = shop({ rejectIdentity: true });
  await assert.rejects(api.shopifyService.changeDeliveryCountry("CA"), /cart could not be updated/);
  assert.equal(country(), "GB");
});

test("unsupported localization operation gives a usable error, not primary-market prices", async () => {
  const { api, country } = shop({ rejectLocalization: true });
  await assert.rejects(api.shopifyService.getProducts(), /delivery markets could not be verified/);
  assert.equal(country(), "GB");
});

test("a cart-country HTTP error explains the failure and preserves the previous choice", async () => {
  const { api, country } = shop({ identityHttpError: true });
  await assert.rejects(api.shopifyService.changeDeliveryCountry("CA"), /cart could not be updated.*country has not changed/);
  assert.equal(country(), "GB");
});
