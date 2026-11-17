const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("../artifacts/pexo/node_modules/typescript");

function compile(path) {
  return ts.transpileModule(fs.readFileSync(`${__dirname}/../${path}`, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  }).outputText;
}

function gateway(provider = async () => ({ data: {} }), configured = true) {
  let handler;
  const calls = [];
  vm.runInNewContext(compile("supabase/functions/shopify-storefront/index.ts"), {
    Request, Response, Object,
    Deno: {
      serve: callback => { handler = callback; },
      // Synthetic fixture, not a real environment secret.
      env: { get: () => configured ? "test-only-not-a-credential" : undefined },
    },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, ...body });
      const result = await provider(body);
      return new Response(JSON.stringify(result), { status: 200 });
    },
  });
  return {
    handler, calls,
    async invoke(queryName, variables = {}) {
      return handler(new Request("https://example.invalid/functions/v1/shopify-storefront", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queryName, variables }),
      }));
    },
  };
}

test("storefront preflight accepts Supabase client headers without querying Shopify", async () => {
  const edge = gateway();
  const response = await edge.handler(new Request("https://example.invalid", {
    method: "OPTIONS", headers: { "Access-Control-Request-Headers": "authorization, x-supabase-client-runtime" },
  }));
  assert.equal(response.status, 204);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /x-supabase-client-runtime/);
  assert.equal(edge.calls.length, 0);
});

test("configured countries operation preserves Shopify's envelope and actual currency codes", async () => {
  const expected = { data: { localization: { availableCountries: [
    { isoCode: "GB", name: "United Kingdom", currency: { isoCode: "GBP" } },
  ] } } };
  const edge = gateway(async () => expected);
  const response = await edge.invoke("getLocalization");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.match(edge.calls[0].query, /availableCountries\s*\{\s*isoCode name currency/);
});

test("all catalog operations apply the selected market, including category and collection lists", async () => {
  const edge = gateway();
  for (const query of [
    "getProducts", "getProductByHandle", "getProductTypes", "getCollections",
    "getCollectionByHandle", "getCollectionProductTypes",
  ]) {
    const response = await edge.invoke(query, { country: " ca ", first: 20, handle: "test" });
    assert.equal(response.status, 200);
    assert.match(edge.calls.at(-1).query, /@inContext\(country: \$country\)/);
    assert.equal(edge.calls.at(-1).variables.country, "CA");
  }
});

test("cart-country mutation forwards buyerIdentity and requests confirmation", async () => {
  const edge = gateway();
  const response = await edge.invoke("cartBuyerIdentityUpdate", {
    cartId: "test-cart", buyerIdentity: { countryCode: "CA" },
  });
  assert.equal(response.status, 200);
  assert.equal(edge.calls[0].variables.buyerIdentity.countryCode, "CA");
  assert.match(edge.calls[0].query, /buyerIdentity\s*\{\s*countryCode\s*\}/);
  assert.match(edge.calls[0].query, /userErrors\s*\{\s*field message\s*\}/);
});

test("cart read requests actual buyer country, contextual line costs and inventory", async () => {
  const edge = gateway();
  await edge.invoke("cartQuery", { id: "test-cart" });
  assert.match(edge.calls[0].query, /buyerIdentity\s*\{\s*countryCode/);
  assert.match(edge.calls[0].query, /availableForSale/);
  assert.match(edge.calls[0].query, /totalAmount\s*\{\s*amount currencyCode/);
});

test("bad country input is rejected rather than silently falling back to the primary market", async () => {
  const edge = gateway();
  for (const country of ["Canada", 123, "", "C1"]) {
    assert.equal((await edge.invoke("getProducts", { country })).status, 400);
  }
  assert.equal(edge.calls.length, 0);
});

test("unknown operations and prototype property names are not accepted", async () => {
  const edge = gateway();
  for (const query of ["unknown", "constructor", "__proto__", "toString"]) {
    assert.equal((await edge.invoke(query)).status, 400);
  }
  assert.equal(edge.calls.length, 0);
});

test("existing cart line operations remain available", async () => {
  const edge = gateway();
  for (const query of ["cartCreate", "cartLinesAdd", "cartLinesUpdate", "cartLinesRemove"]) {
    assert.equal((await edge.invoke(query)).status, 200);
  }
});

test("missing existing Shopify configuration fails clearly without an upstream call", async () => {
  const edge = gateway(undefined, false);
  const response = await edge.invoke("getLocalization");
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Server configuration error" });
  assert.equal(edge.calls.length, 0);
});

function client(edge, initialCountry = "GB", initialize = async () => {}) {
  let country = initialCountry;
  const module = { exports: {} };
  const imports = {
    sonner: { toast: { error() {}, info() {} } },
    "./dev-logger": { devLog: { error() {}, warn() {} } },
    "./safe-storage": { safeStorage: { getItem: () => "test-cart" } },
    "./country-preferences": {
      getCountryPreferences: () => ({ delivery: { country } }),
      setCountryPreference: (_scope, value) => { country = value; },
      initializeCountryPreferences: async () => { await initialize(value => { country = value; }); },
    },
    "./supabase": { getSupabase: async () => ({ functions: { invoke: async (_name, { body }) => {
      const response = await edge.invoke(body.queryName, body.variables);
      const data = await response.json();
      return response.ok ? { data } : { error: { status: response.status, message: data.error } };
    } } }) },
  };
  vm.runInNewContext(compile("artifacts/pexo/src/lib/shopify-service.ts"), {
    module, exports: module.exports, Intl, window: new EventTarget(), CustomEvent,
    require: path => {
      if (!(path in imports)) throw new Error(`Unexpected import: ${path}`);
      return imports[path];
    },
  });
  return { api: module.exports.shopifyService, country: () => country };
}

test("frontend → real function handler → simulated Shopify: country, catalog and existing cart stay consistent", async () => {
  let buyerCountry = "GB";
  const edge = gateway(async ({ query, variables }) => {
    if (query.includes("query GetLocalization")) return { data: { localization: { availableCountries: [
      { isoCode: "GB", name: "United Kingdom", currency: { isoCode: "GBP" } },
      { isoCode: "CA", name: "Canada", currency: { isoCode: "CAD" } },
    ] } } };
    if (query.includes("mutation cartBuyerIdentityUpdate")) {
      buyerCountry = variables.buyerIdentity.countryCode;
      return { data: { cartBuyerIdentityUpdate: {
        cart: { id: "test-cart", buyerIdentity: { countryCode: buyerCountry } }, userErrors: [],
      } } };
    }
    if (query.includes("query GetProducts")) return { data: { products: { edges: [{
      node: { priceRange: { minVariantPrice: { amount: "30", currencyCode: variables.country === "CA" ? "CAD" : "GBP" } } },
    }] } } };
    if (query.includes("query cart(")) return { data: { cart: {
      id: "test-cart", totalQuantity: 2, checkoutUrl: "https://example.invalid/checkout",
      buyerIdentity: { countryCode: buyerCountry },
      lines: { edges: [{ node: {
        id: "test-line", quantity: 2, cost: { totalAmount: { amount: "60", currencyCode: "CAD" } },
        merchandise: { id: "test-variant", title: "Default Title", availableForSale: false, product: { title: "Test product" } },
      } }] },
    } } };
    throw new Error("Unexpected Shopify query");
  });
  const { api, country } = client(edge);
  await api.changeDeliveryCountry("CA");
  assert.equal(country(), "CA");
  assert.equal(buyerCountry, "CA");
  const products = await api.getProducts();
  assert.equal(products.products[0].node.priceRange.minVariantPrice.currencyCode, "CAD");
  const cart = await api.getCart("test-cart");
  assert.equal(cart.countryCode, "CA");
  assert.equal(cart.items[0].currency, "CAD");
  assert.equal(cart.items[0].price, 30);
  assert.equal(cart.items[0].quantity, 2);
  assert.equal(cart.items[0].availableForSale, false);
  await assert.rejects(api.changeDeliveryCountry("NG"), /not available/);
  assert.equal(country(), "CA");
});

test("a mismatched Shopify buyer-country confirmation does not commit the new preference", async () => {
  const edge = gateway(async ({ query }) => query.includes("query GetLocalization")
    ? { data: { localization: { availableCountries: [{ isoCode: "CA", name: "Canada", currency: { isoCode: "CAD" } }] } } }
    : { data: { cartBuyerIdentityUpdate: {
      cart: { id: "test-cart", buyerIdentity: { countryCode: "GB" } }, userErrors: [],
    } } });
  const { api, country } = client(edge);
  await assert.rejects(api.changeDeliveryCountry("CA"), /did not confirm/);
  assert.equal(country(), "GB");
});

test("cart creation waits for initial detection before capturing buyer country", async () => {
  let createVariables;
  const edge = gateway(async ({ query, variables }) => {
    if (query.includes("query GetLocalization")) return { data: { localization: { availableCountries: [
      { isoCode: "CA", name: "Canada", currency: { isoCode: "CAD" } },
    ] } } };
    createVariables = variables;
    return { data: { cartCreate: {
      cart: {
        id: "test-cart", checkoutUrl: "https://example.invalid/checkout",
        buyerIdentity: { countryCode: "CA" },
        lines: { edges: [{ node: { id: "test-line" } }] },
      }, userErrors: [],
    } } };
  });
  const { api } = client(edge, undefined, async set => { set("CA"); });
  await api.createCart({ variantId: "test-variant", quantity: 1 });
  assert.equal(createVariables.input.buyerIdentity.countryCode, "CA");
  assert.equal(createVariables.country, "CA");
});
