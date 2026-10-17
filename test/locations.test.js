import test from "node:test";
import assert from "node:assert/strict";
import { extractLocationCandidate, validateLocation, validateRideLocations } from "../src/locations.js";
import { getRoute } from "../src/maps.js";
import { ADDRESS, TEMPLE, geocodeResult, placeResult, mapsFetch } from "./fixtures/locations.js";

function stub(t, options) {
  const calls = [];
  t.mock.method(globalThis, "fetch", mapsFetch(calls, options));
  return calls;
}

test("plain replies and non-location messages do not call Google", async t => {
  const calls = stub(t);
  for (const text of ["1", "2", "１２", "60/20/2", "好", "謝謝", "收到", "我家", "請問多少錢", "沒有車嗎", "我到了", "上車點"]) {
    assert.equal(extractLocationCandidate(text), null, text);
    await assert.rejects(validateLocation(text, "test-key"), { code: "LOCATION_UNVERIFIED" });
  }
  assert.equal(calls.length, 0);
});

test("extracts a location fragment without inventing a city or alias", () => {
  assert.deepEqual(extractLocationCandidate(`我在${TEMPLE}，謝謝`), { query: TEMPLE, kind: "place" });
  assert.deepEqual(extractLocationCandidate(ADDRESS), { query: ADDRESS, kind: "address" });
  assert.equal(extractLocationCandidate("夢時代").query, "夢時代");
});

test("exact address preserves input and verified coordinates", async t => {
  const calls = stub(t);
  const result = await validateLocation(ADDRESS, "test-key");
  assert.equal(result.placeId, "address-12");
  assert.equal(result.query, ADDRESS);
  assert.deepEqual(result.location, { latitude: 22.465, longitude: 120.45 });
  assert.equal(new URL(calls[0].url).searchParams.get("address"), ADDRESS);
});

for (const [name, query, result] of [
  ["partial match", ADDRESS, geocodeResult({ partial_match: true })],
  ["conflicting city", "台北市中山路12號", geocodeResult()],
  ["conflicting district", "屏東縣潮州鎮中山路12號", geocodeResult()],
  ["inferred house number", "屏東縣東港鎮中山路", geocodeResult()],
  ["different road", "屏東縣東港鎮新中山路12號", geocodeResult()],
  ["different number", "屏東縣東港鎮中山路2號", geocodeResult()],
  ["interpolated number", ADDRESS, geocodeResult({ geometry: { location: { lat: 22.465, lng: 120.45 }, location_type: "RANGE_INTERPOLATED" } })],
  ["missing coordinates", ADDRESS, geocodeResult({ geometry: {} })],
  ["missing id", ADDRESS, geocodeResult({ place_id: "" })],
  ["blank id", ADDRESS, geocodeResult({ place_id: " " })],
  ["blank address", ADDRESS, geocodeResult({ formatted_address: " " })]
]) {
  test(`rejects address with ${name}`, async t => {
    const calls = stub(t, { geocode: [result] });
    await assert.rejects(validateLocation(query, "test-key"), { code: "LOCATION_UNVERIFIED" });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /geocode/);
  });
}

test("rejects inferred/replaced/unconfirmed critical components", async t => {
  for (const flags of [{ inferred: true }, { replaced: true }, { spellCorrected: true }, { confirmationLevel: "UNCONFIRMED_BUT_PLAUSIBLE" }]) {
    const result = geocodeResult();
    Object.assign(result.address_components[3], flags);
    t.mock.method(globalThis, "fetch", mapsFetch([], { geocode: [result] }));
    await assert.rejects(validateLocation(ADDRESS, "test-key"), { code: "LOCATION_UNVERIFIED" });
  }
});

test("omitted city and district are allowed only for a unique exact street address", async t => {
  stub(t);
  for (const query of ["東港鎮中山路12號", "屏東縣中山路12號", "中山路12號"]) {
    const result = await validateLocation(query, "test-key");
    assert.equal(result.query, query);
    assert.equal(result.placeId, "address-12");
  }
  t.mock.method(globalThis, "fetch", mapsFetch([], { geocode: [geocodeResult(), geocodeResult({ place_id: "another-city" })] }));
  await assert.rejects(validateLocation("中山路12號", "test-key"), { code: "LOCATION_UNVERIFIED" });
});

test("village formatting can differ while district, road and house number stay exact", async t => {
  const query = "屏東縣長治鄉德榮村下厝街91號";
  const result = geocodeResult({ formatted_address: "台灣屏東縣長治鄉下厝街91號" });
  result.address_components[2].long_name = "長治鄉";
  result.address_components[3].long_name = "下厝街";
  result.address_components[4].long_name = "91";
  stub(t, { geocode: [result] });
  assert.equal((await validateLocation(query, "test-key")).query, query);
  for (const invalid of [query.replace("長治鄉", "潮州鎮"), query.replace("下厝街", "上厝街"), query.replace("91號", "9號"), "德榮村下厝街91號"]) {
    await assert.rejects(validateLocation(invalid, "test-key"), { code: "LOCATION_UNVERIFIED" });
  }
  result.formatted_address = `台灣${query}`;
  result.address_components.push({ long_name: "德榮村", types: ["sublocality_level_2"] });
  assert.equal((await validateLocation("長治鄉下厝街91號", "test-key")).placeId, result.place_id);
  await assert.rejects(validateLocation(query.replace("德榮村", "其他村"), "test-key"), { code: "LOCATION_UNVERIFIED" });
  result.formatted_address = "台灣屏東縣長治鄉下厝街91號";
  await assert.rejects(validateLocation(query.replace("德榮村", "其他村"), "test-key"), { code: "LOCATION_UNVERIFIED" });
});

test("floor must be explicit and cannot be inferred from a house number", async t => {
  const result = geocodeResult({ formatted_address: `928台灣${ADDRESS}2樓` });
  result.address_components.push({ long_name: "2", types: ["subpremise"] });
  stub(t, { geocode: [result] });
  await assert.rejects(validateLocation(ADDRESS, "test-key"), { code: "LOCATION_UNVERIFIED" });
  await assert.rejects(validateLocation(`${ADDRESS}12樓`, "test-key"), { code: "LOCATION_UNVERIFIED" });
  assert.equal((await validateLocation(`${ADDRESS}2樓`, "test-key")).placeId, result.place_id);
});

test("rejects multiple exact address candidates", async t => {
  stub(t, { geocode: [geocodeResult(), geocodeResult({ place_id: "second" })] });
  await assert.rejects(validateLocation(ADDRESS, "test-key"), { code: "LOCATION_UNVERIFIED" });
});

test("landmark uses Places Text Search with complete field mask", async t => {
  const calls = stub(t);
  const result = await validateLocation(TEMPLE, "test-key");
  assert.equal(result.kind, "place");
  assert.equal(result.placeId, "temple");
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].body).textQuery, TEMPLE);
  for (const field of ["places.id", "places.formattedAddress", "places.location", "places.displayName", "places.types", "nextPageToken"]) {
    assert.ok(calls[0].headers["X-Goog-FieldMask"].includes(field));
  }
});

for (const [name, patch] of [
  ["id", { id: "" }], ["address", { formattedAddress: "" }],
  ["nonblank id", { id: " " }], ["nonblank address", { formattedAddress: " " }],
  ["coordinates", { location: null }], ["numeric coordinates", { location: { latitude: "22.4", longitude: "120.4" } }],
  ["name", { displayName: null }], ["country", { addressComponents: [] }],
  ["allowed type", { primaryType: "establishment", types: ["establishment", "point_of_interest"] }],
  ["close name", { displayName: { text: "東港其他廟宇" } }],
  ["Taiwan main island", { formattedAddress: "屏東縣琉球鄉", location: { latitude: 22.34, longitude: 120.37 } }]
]) {
  test(`rejects landmark without ${name}`, async t => {
    stub(t, { places: [placeResult(patch)] });
    await assert.rejects(validateLocation(TEMPLE, "test-key"), { code: "LOCATION_UNVERIFIED" });
  });
}

test("same-name and near-equal candidates are rejected; same id is deduplicated", async t => {
  stub(t, { places: [placeResult(), placeResult({ id: "second" })] });
  await assert.rejects(validateLocation(TEMPLE, "test-key"), { code: "LOCATION_UNVERIFIED" });
  t.mock.method(globalThis, "fetch", mapsFetch([], { places: [placeResult(), placeResult({
    id: "near-equal", displayName: { text: `屏東縣${TEMPLE}` }
  })] }));
  await assert.rejects(validateLocation(`屏東縣${TEMPLE}`, "test-key"), { code: "LOCATION_UNVERIFIED" });
  t.mock.method(globalThis, "fetch", mapsFetch([], { places: [placeResult(), placeResult()] }));
  assert.equal((await validateLocation(TEMPLE, "test-key")).placeId, "temple");
});

test("administrative prefix must agree with returned address", async t => {
  stub(t);
  assert.equal((await validateLocation(`屏東縣${TEMPLE}`, "test-key")).placeId, "temple");
  await assert.rejects(validateLocation(`台北市${TEMPLE}`, "test-key"), { code: "LOCATION_UNVERIFIED" });
});

test("generic chain name cannot silently select a branch", async t => {
  stub(t, { places: [placeResult({ displayName: { text: "全家便利商店東港中山店" }, primaryType: "convenience_store" })] });
  await assert.rejects(validateLocation("全家", "test-key"), { code: "LOCATION_UNVERIFIED" });
});

test("unread pages, provider errors, missing key and malformed responses fail closed", async t => {
  for (const response of [
    Response.json({ places: [placeResult()], nextPageToken: "more" }),
    Response.json({ error: { message: "denied" } }, { status: 403 }),
    Response.json({ places: null }), new Response("not-json")
  ]) {
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(validateLocation(TEMPLE, "test-key"), { code: "LOCATION_UNVERIFIED" });
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("timeout"); });
  await assert.rejects(validateLocation(TEMPLE, "test-key"), { code: "LOCATION_UNVERIFIED" });
  await assert.rejects(validateLocation(TEMPLE, ""), { code: "LOCATION_UNVERIFIED" });
});

test("validation is all-or-nothing and does not mutate original addresses", async t => {
  stub(t);
  const parsed = { pickup: TEMPLE, destination: "謝謝", rideDetails: "行李：兩件" };
  await assert.rejects(validateRideLocations(parsed, "test-key"), { code: "LOCATION_UNVERIFIED" });
  assert.equal(parsed.destination, "謝謝");
  assert.equal(parsed.verifiedLocations, undefined);
  const valid = await validateRideLocations({ ...parsed, destination: "" }, "test-key");
  assert.equal(valid.destination, "");
  assert.equal(valid.rideDetails, parsed.rideDetails);
});

test("fare routes are requested only after both places pass validation", async t => {
  const calls = stub(t);
  await assert.rejects(getRoute(ADDRESS, "好", "test-key"), { code: "LOCATION_UNVERIFIED" });
  assert.equal(calls.some(call => call.url.includes("computeRoutes")), false);
  const route = await getRoute(ADDRESS, TEMPLE, "test-key");
  assert.equal(route.distanceKm, 10);
  const request = JSON.parse(calls.find(call => call.url.includes("computeRoutes")).body);
  assert.deepEqual(request.origin.location.latLng, { latitude: 22.465, longitude: 120.45 });
});
