import test from "node:test";
import assert from "node:assert/strict";
import { extractLocationCandidate, validateLocation, validateRideLocations } from "../src/locations.js";
import { getRoute } from "../src/maps.js";
import { postalSuffixResult } from "./fixtures/locations.js";
import { ADDRESS, TEMPLE, geocodeResult, placeResult, mapsFetch, transportPlaces } from "./fixtures/locations.js";

function stub(t, options) {
  const calls = [];
  t.mock.method(globalThis, "fetch", mapsFetch(calls, options));
  return calls;
}

test("all organization IDs are eligible but incomplete or ambiguous places are rejected", async t => {
  const query = "測試發展協會";
  const organization = placeResult({ id: "any-organization", displayName: { text: query },
    primaryType: "association_or_organization", types: ["association_or_organization"] });
  let places = [organization];
  t.mock.method(globalThis, "fetch", async () => Response.json({ places }));
  assert.equal((await validateLocation(query, "test-key")).placeId, organization.id);
  for (const invalid of [
    [organization, { ...organization, id: "other" }],
    [{ ...organization, location: null }], [{ ...organization, formattedAddress: "" }],
    [{ ...organization, displayName: { text: "另一個協會" } }]
  ]) {
    places = invalid;
    await assert.rejects(validateLocation(query, "test-key"), { code: "LOCATION_UNVERIFIED" });
  }
});

test("repairs only corroborated postal suffixes without bypassing address validation", async t => {
  const query = "屏東縣崁頂鄉園寮村南州路1-2號";
  let result = postalSuffixResult();
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "OK", results: [result] }));
  const valid = await validateLocation(query, "test-key");
  assert.equal(valid.formattedAddress, `924台灣${query}`);
  assert.equal(valid.query, query);
  for (const mutate of [
    r => { r.partial_match = true; },
    r => { r.address_components[6].long_name = "900"; },
    r => { r.address_components.pop(); },
    r => { r.address_components[0].long_name = "1-3號924"; },
    r => { r.formatted_address = r.formatted_address.replace("1-2", "1-3"); },
    r => { r.geometry.location_type = "RANGE_INTERPOLATED"; },
    r => { r.address_components[0].inferred = true; }
  ]) {
    result = postalSuffixResult();
    mutate(result);
    await assert.rejects(validateLocation(query, "test-key"), { code: "LOCATION_UNVERIFIED" });
  }
});

for (const type of ["tourist_attraction", "beach", "scenic_spot", "observation_deck", "nature_preserve", "historical_place", "tourist_information_center", "campground"]) {
  test(`scenic places accept verified ${type} without a street number`, async t => {
    const place = placeResult({ displayName: { text: "測試觀景台" }, primaryType: type,
      types: [type], formattedAddress: "屏東縣東港鎮" });
    stub(t, { places: [place] });
    assert.equal((await validateLocation("測試觀景台", "test-key")).placeId, place.id);
  });
}

test("scenic places still reject ambiguity, missing metadata and mismatched names", async t => {
  const place = placeResult({ displayName: { text: "測試沙灘" }, primaryType: "beach", types: ["beach"] });
  let places = [place];
  t.mock.method(globalThis, "fetch", async () => Response.json({ places }));
  for (const invalid of [
    [{ ...place, location: null }], [{ ...place, formattedAddress: "" }],
    [{ ...place, id: "" }], [{ ...place, displayName: { text: "別處沙灘" } }],
    [place, { ...place, id: "another-beach" }],
    [{ ...place, primaryType: "point_of_interest", types: ["point_of_interest"] }]
  ]) {
    places = invalid;
    await assert.rejects(validateLocation("測試沙灘", "test-key"), { code: "LOCATION_UNVERIFIED" });
  }
});

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

test("Donggang township Zhenhai temple alias verifies names and district", async t => {
  let places = [placeResult()];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(JSON.parse(init.body));
    return Response.json({ places });
  });
  for (const name of ["鎮海宮", "東港鎮海宮", "東港鎮鎮海宮"]) {
    places = [placeResult({ displayName: { text: name } })];
    const result = await validateLocation("東港鎮鎮海宮", "test-key");
    assert.equal(result.placeId, "temple");
    assert.equal(result.query, "東港鎮鎮海宮");
  }
  assert.equal(calls[0].textQuery, "屏東縣東港鎮鎮海宮");
  places = [placeResult({ formattedAddress: "高雄市旗津區鎮海路1號" })];
  await assert.rejects(validateLocation("東港鎮鎮海宮", "test-key"), { code: "LOCATION_UNVERIFIED" });
  places = [placeResult(), placeResult({ id: "second-temple" })];
  await assert.rejects(validateLocation("東港鎮鎮海宮", "test-key"), { code: "LOCATION_UNVERIFIED" });
});

test("Zhenhai temple organization classification still requires matching name and area", async t => {
  let place = placeResult({ id: "ChIJizjuxIPhcTQRaP4VtvQb2UA",
    formattedAddress: "42之, No. 5號鎮海路鎮海里東港鎮屏東縣92845",
    primaryType: "association_or_organization", types: ["tourist_attraction", "place_of_worship", "association_or_organization"] });
  const original = structuredClone(place);
  t.mock.method(globalThis, "fetch", async () => Response.json({ places: [place] }));
  assert.equal((await validateLocation("東港鎮鎮海宮", "test-key")).placeId, original.id);
  for (const patch of [
    { formattedAddress: "高雄市旗津區鎮海路1號" }, { displayName: { text: "東港鎮海宮大營" } }
  ]) {
    place = { ...original, ...patch };
    await assert.rejects(validateLocation("東港鎮鎮海宮", "test-key"), { code: "LOCATION_UNVERIFIED" });
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

for (const { query, place } of transportPlaces) {
  test(`transport alias ${query} verifies the official place and preserves customer wording`, async t => {
    const calls = stub(t, { places: [place] });
    const result = await validateLocation(query, "test-key");
    assert.equal(result.query, query);
    assert.equal(result.placeId, place.id);
    assert.ok(JSON.parse(calls[0].body).textQuery.includes(place.displayName.text));
  });
}

test("transport aliases reject nearby shops, bus stops, conflicting areas and duplicate stations", async t => {
  const { query, place } = transportPlaces[0];
  for (const patch of [
    { displayName: { text: "高鐵左營站租車店" } },
    { primaryType: "bus_station", types: ["bus_station"] },
    { formattedAddress: "台北市中正區高鐵路1號" },
    { id: "" }, { location: null }
  ]) {
    t.mock.method(globalThis, "fetch", mapsFetch([], { places: [{ ...place, ...patch }] }));
    await assert.rejects(validateLocation(query, "test-key"), { code: "LOCATION_UNVERIFIED" });
  }
  t.mock.method(globalThis, "fetch", mapsFetch([], { places: [place, { ...place, id: "second-station" }] }));
  await assert.rejects(validateLocation(query, "test-key"), { code: "LOCATION_UNVERIFIED" });
  t.mock.method(globalThis, "fetch", mapsFetch([], { places: [place] }));
  await assert.rejects(validateLocation("台北市左營高鐵", "test-key"), { code: "LOCATION_UNVERIFIED" });
  assert.equal((await validateLocation("高雄市左營高鐵", "test-key")).placeId, place.id);
});

test("railway entries outrank generic transit entries and HSR must use the station street address", async t => {
  const station = transportPlaces.find(item => item.query === "潮州火車站");
  stub(t, { places: [station.place, { ...station.place, id: "transit", primaryType: "transit_station" }] });
  assert.equal((await validateLocation(station.query, "test-key")).placeId, station.place.id);
  const hsr = { ...transportPlaces[0].place, displayName: { text: "左營" } };
  t.mock.method(globalThis, "fetch", mapsFetch([], { places: [hsr] }));
  assert.equal((await validateLocation("左營高鐵", "test-key")).placeId, hsr.id);
  hsr.formattedAddress = "高雄市左營區站前北路1號";
  await assert.rejects(validateLocation("左營高鐵", "test-key"), { code: "LOCATION_UNVERIFIED" });
});

test("Donggang pier and ferry boarding alias use the terminal, not a ticket office", async t => {
  const terminal = transportPlaces.find(item => item.query === "東港碼頭").place;
  stub(t, { places: [terminal, { ...terminal, id: "office", primaryType: "tour_agency" }] });
  for (const query of ["東港碼頭", "東琉線搭船處"]) {
    assert.equal((await validateLocation(query, "test-key")).placeId, terminal.id);
  }
});

test("TRA Xin Zuoying and Donggang school aliases do not select the HSR or nearby businesses", async t => {
  const railway = transportPlaces.find(item => item.query === "新左營火車站").place;
  const school = transportPlaces.find(item => item.query === "東港海事").place;
  stub(t, { places: [railway, school, transportPlaces[0].place] });
  assert.equal((await validateLocation("新左營火車站", "test-key")).placeId, railway.id);
  assert.equal((await validateLocation("國立東港海事水產職業學校", "test-key")).placeId, school.id);
  t.mock.method(globalThis, "fetch", mapsFetch([], { places: [{ ...school, primaryType: "bus_stop" }] }));
  await assert.rejects(validateLocation("東港海事", "test-key"), { code: "LOCATION_UNVERIFIED" });
});

test("Tzu Hui shorthand resolves only to the Nanzhou school", async t => {
  const school = structuredClone(transportPlaces.find(item => item.query === "慈惠").place);
  stub(t, { places: [school] });
  assert.equal((await validateLocation("慈惠醫專", "test-key")).placeId, school.id);
  school.formattedAddress = "高雄市三民區三民路367號";
  await assert.rejects(validateLocation("慈惠", "test-key"), { code: "LOCATION_UNVERIFIED" });
});

test("unresolved township street address retries once with Pingtung County", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async url => {
    calls.push(new URL(url).searchParams.get("address"));
    return Response.json(calls.length === 1 ? { status: "ZERO_RESULTS", results: [] } : { status: "OK", results: [geocodeResult()] });
  });
  const query = "東港鎮中山路12號";
  assert.equal((await validateLocation(query, "test-key")).query, query);
  assert.deepEqual(calls, [query, `屏東縣${query}`]);
});

test("unresolved township place retries with Pingtung without accepting conflicting counties", async t => {
  const calls = [];
  const place = placeResult({ displayName: { text: "長治鄉" }, formattedAddress: "屏東縣長治鄉", primaryType: "administrative_area_level_2" });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls.push(JSON.parse(init.body).textQuery);
    return Response.json(calls.length === 1 ? {} : { places: [place] });
  });
  assert.equal((await validateLocation("長治鄉", "test-key")).query, "長治鄉");
  assert.deepEqual(calls, ["長治鄉", "屏東縣長治鄉"]);
  calls.length = 0;
  place.formattedAddress = "台北市長治鄉";
  place.addressComponents[1].longText = "台北市";
  await assert.rejects(validateLocation("長治鄉", "test-key"), { code: "LOCATION_UNVERIFIED" });
  assert.equal(calls.length, 2);
});

test("county retries do not override explicit counties or retry API outages", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return Response.json({ places: [] });
  });
  await assert.rejects(validateLocation("宜蘭縣羅東鎮", "test-key"), { code: "LOCATION_UNVERIFIED" });
  assert.equal(calls.length, 1);
  calls.length = 0;
  t.mock.method(globalThis, "fetch", async () => { calls.push("outage"); throw new Error("network unavailable"); });
  await assert.rejects(validateLocation("長治鄉", "test-key"), { code: "LOCATION_UNVERIFIED" });
  assert.equal(calls.length, 1);
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
