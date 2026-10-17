import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseRideRequest, parseRideFormSubmission, classifyRideSchedule } from "../src/parser.js";
import { validateRideLocations } from "../src/locations.js";
import { getRoute } from "../src/maps.js";
import { calculateFare, calculateDonggangTownFare, isDonggangTownTrip } from "../src/fare.js";
import { ADDRESS, TEMPLE, geocodeResult, placeResult, mapsFetch, transportPlaces } from "./fixtures/locations.js";

const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("short pickup/dropoff labels preserve the two locations", () => {
  const pickup = "高雄市左營區尾西里實踐路18號";
  for (const separator of [" ", "：", ": "]) {
    const text = `上${separator}${pickup}\n下${separator}新左營火車站`;
    for (const parsed of [parseRideRequest(text), parseRideFormSubmission(text)]) {
      assert.equal(parsed.pickup, pickup);
      assert.equal(parsed.destination, "新左營火車站");
    }
  }
  assert.equal(parseRideRequest("下厝街91號").pickup, "下厝街91號");
  assert.equal(parseRideRequest("上班\n下班").destination, "");
});

test("exactly two unlabeled location lines mean pickup then destination", () => {
  const pickup = "屏東縣竹田鄉大湖村大平路62-1號";
  const destination = "屏東縣新園鄉聖心路106巷2號";
  for (const text of [`${pickup}\n${destination}`, `${pickup}\\\r\n${destination}`, `\n${pickup}\n\n${destination}\n`]) {
    for (const parsed of [parseRideRequest(text), parseRideFormSubmission(text)]) {
      assert.equal(parsed.pickup, pickup);
      assert.equal(parsed.destination, destination);
    }
  }
  assert.equal(parseRideRequest(`${pickup}\n2人`).destination, "");
  assert.equal(parseRideRequest(`${pickup}\n${destination}\n${TEMPLE}`).destination, "");
});

// Run the actual handlers with isolated LINE/DB dependencies, without starting
// Express, loading production secrets, or sending customer messages.
function harness(t, options = {}) {
  const calls = { google: [], replies: [], orders: [], confirmations: [], customerWrites: 0, formCleared: 0 };
  let fareIntent = Boolean(options.fareIntent);
  t.mock.method(globalThis, "fetch", mapsFetch(calls.google, options));
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    process: { env: { GOOGLE_MAPS_API_KEY: "test-key" } },
    parseRideRequest, parseRideFormSubmission, classifyRideSchedule,
    validateRideLocations, getRoute, calculateFare, calculateDonggangTownFare, isDonggangTownTrip,
    isDispatchBotTagged: () => false,
    getPendingDispatchSearchPrompt: () => null,
    getPendingRideConfirmation: () => options.pendingConfirmation || null,
    getPendingRideFormReply: () => options.form ? {} : null,
    clearPendingRideConfirmation() {},
    clearPendingRideFormReply: () => { calls.formCleared += 1; },
    hasFareQuoteIntentToday: () => fareIntent,
    rememberFareQuoteIntent: () => { fareIntent = true; },
    clearFareQuoteIntent: () => { fareIntent = false; },
    listSettings: async () => ({}),
    upsertCustomerByLineId: async () => { calls.customerWrites += 1; return {}; },
    getRecentRideDispatch: () => null,
    rememberRecentRideDispatch() {},
    rememberPendingRideConfirmation: (_, parsed) => calls.confirmations.push(parsed),
    reply: async (_, text) => calls.replies.push(text),
    line: { replyMessage: async data => calls.replies.push(data) },
    createOrder: async order => { calls.orders.push(order); return { ...order, id: 123 }; },
    pushOrderToDispatchGroup: async () => true,
    quoteFlex: order => ({ type: "flex", order }),
    orderNo: id => `OTZ-${id}`,
    formatRideRequestTemplate: values => `${values.pickup}\n${values.destination}`,
    getRideSearchNotice: () => "searching",
    getDispatchGroupIds: () => ["test-group"],
    pushDispatchLineMessages: async () => [],
    normalizeLineText: text => text
  });
  for (const name of ["handleText", "createLineRideOrder", "handleMutedText", "getVerifiedRideInput",
    "isFareQuoteKeyword", "isFareQuoteInlineRequest", "getValidatedCapturedRoute", "extractCapturedRoute", "dispatchTestOrder"]) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
    assert.ok(start >= 0, name);
    const rest = source.slice(start + 1);
    const next = rest.search(/^(?:async )?function |^app\./m);
    const declaration = source.slice(start, next < 0 ? undefined : start + 1 + next);
    vm.runInContext(declaration, context, { filename: `server.js:${name}` });
  }
  const event = text => ({ type: "message", message: { type: "text", text }, source: { type: "user", userId: "test-user" }, replyToken: "test-reply" });
  return { context, calls, event };
}

for (const fareIntent of [false, true]) {
  test(`invalid fragments cannot write addresses (fare intent ${fareIntent})`, async t => {
    const { context, calls, event } = harness(t, { fareIntent });
    for (const text of ["1", "2", "好", "謝謝", "我家", "試算車資 1到2", `試算車資 ${TEMPLE}到謝謝`]) {
      await context.handleText(event(text));
    }
    assert.equal(calls.orders.length, 0);
    assert.equal(calls.replies.length, 0);
    assert.equal(calls.confirmations.length, 0);
    assert.equal(calls.customerWrites, 0);
    assert.equal(calls.google.some(call => call.url.includes("computeRoutes")), false);
  });
}

test("fare keyword followed by a partial address produces no quote or order", async t => {
  const { context, calls, event } = harness(t, { geocode: [geocodeResult({ partial_match: true })] });
  await context.handleText(event("試算車資"));
  assert.equal(calls.replies.length, 1);
  await context.handleText(event(`${ADDRESS}到${TEMPLE}`));
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.orders.length, 0);
  assert.equal(calls.customerWrites, 0);
});

test("existing fare intent and inline keyword cannot bypass ambiguous Places", async t => {
  const { context, calls, event } = harness(t, { fareIntent: true, places: [placeResult(), placeResult({ id: "other" })] });
  await context.handleText(event(`${ADDRESS}到${TEMPLE}`));
  await context.handleText(event(`試算車資 ${ADDRESS}到${TEMPLE}`));
  assert.equal(calls.replies.length, 0);
  assert.equal(calls.orders.length, 0);
  assert.equal(calls.google.some(call => call.url.includes("computeRoutes")), false);
});

test("valid fare endpoints produce a quote only after validation", async t => {
  const { context, calls, event } = harness(t);
  await context.handleText(event(`試算車資 ${ADDRESS}到${TEMPLE}`));
  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].status, "awaiting_customer");
  assert.equal(calls.orders[0].pickup, ADDRESS);
  assert.equal(calls.orders[0].destination, TEMPLE);
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.confirmations.length, 0);
});

test("common transport names work for both ride confirmation and fare quotes", async t => {
  const { context, calls, event } = harness(t, { places: transportPlaces.map(item => item.place) });
  for (const { query } of transportPlaces) await context.handleText(event(query));
  assert.equal(calls.confirmations.length, transportPlaces.length);
  await context.handleText(event("試算車資 左營高鐵到小港機場"));
  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].pickup, "左營高鐵");
  assert.equal(calls.orders[0].destination, "小港機場");
});

for (const form of [false, true]) {
  test(`short labels work through the actual handler (pending form ${form})`, async t => {
    const pickup = "高雄市左營區尾西里實踐路18號";
    const result = geocodeResult({ formatted_address: `台灣${pickup}` });
    result.address_components[1].long_name = "高雄市";
    result.address_components[2].long_name = "左營區";
    result.address_components[3].long_name = "實踐路";
    result.address_components[4].long_name = "18";
    const { context, calls, event } = harness(t, { form, geocode: [result], places: transportPlaces.map(item => item.place) });
    await context.handleText(event(`上 ${pickup}\n下 新左營火車站`));
    assert.equal(calls.confirmations.length, 1);
    assert.equal(calls.confirmations[0].pickup, pickup);
    assert.equal(calls.confirmations[0].destination, "新左營火車站");
    assert.equal(calls.orders.length, 0);
  });
}

test("two unlabeled address lines are verified before fare calculation", async t => {
  const pickup = "屏東縣竹田鄉大湖村大平路62-1號";
  const destination = "屏東縣新園鄉聖心路106巷2號";
  const origin = geocodeResult({ formatted_address: `台灣${pickup}` });
  origin.address_components[2].long_name = "竹田鄉";
  origin.address_components[3].long_name = "大平路";
  origin.address_components[4].long_name = "62-1";
  const target = geocodeResult({ place_id: "destination", formatted_address: `台灣${destination}` });
  target.address_components[2].long_name = "新園鄉";
  target.address_components[3].long_name = "聖心路106巷";
  target.address_components[4].long_name = "2";
  const { context, calls, event } = harness(t, { geocode: [origin, target] });
  await context.handleText(event(`試算車資\n${pickup}\n${destination}`));
  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].pickup, pickup);
  assert.equal(calls.orders[0].destination, destination);
});

test("village-form address works for both ride confirmation and fare calculation", async t => {
  const query = "屏東縣長治鄉德榮村下厝街91號";
  const result = geocodeResult({ formatted_address: "台灣屏東縣長治鄉下厝街91號" });
  result.address_components[2].long_name = "長治鄉";
  result.address_components[3].long_name = "下厝街";
  result.address_components[4].long_name = "91";
  const { context, calls, event } = harness(t, { geocode: [result] });
  await context.handleText(event(query));
  assert.equal(calls.confirmations.length, 1);
  assert.equal(calls.confirmations[0].pickup, query);
  assert.equal(calls.orders.length, 0);
  await context.handleText(event(`試算車資 ${query}到${TEMPLE}`));
  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].pickup, query);
  assert.equal(calls.orders[0].status, "awaiting_customer");
});

test("single pickup is allowed for rides but cannot produce a fare quote", async t => {
  const { context, calls, event } = harness(t);
  await context.handleText(event(TEMPLE));
  assert.equal(calls.confirmations.length, 1);
  assert.equal(calls.orders.length, 0);
  await context.handleText(event(`試算車資 ${TEMPLE}`));
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.orders.length, 0);
});

test("form replies validate both addresses and retain raw non-address fields", async t => {
  const { context, calls, event } = harness(t, { form: true });
  await context.handleText(event(`上車地點：${TEMPLE}\n下車地點：謝謝\n人數：一人`));
  assert.equal(calls.formCleared, 0);
  assert.equal(calls.confirmations.length, 0);
  await context.handleText(event(`上車地點：${TEMPLE}\n下車地點：${ADDRESS}\n人數：一人\n行李：兩件`));
  assert.equal(calls.confirmations.length, 1);
  assert.equal(calls.confirmations[0].rideDetails, "人數：一人\n行李：兩件");
  assert.equal(calls.formCleared, 1);
});

test("old confirmations revalidate before any order write", async t => {
  const { context, calls, event } = harness(t, { pendingConfirmation: { parsed: { pickup: "1", destination: "" } } });
  await context.handleText(event("1"));
  assert.equal(calls.orders.length, 0);
  assert.equal(calls.replies.length, 0);
});

test("valid single-pickup confirmation writes verified coordinates", async t => {
  const { context, calls, event } = harness(t, { pendingConfirmation: { parsed: { pickup: TEMPLE, destination: "", rideDetails: "行李：兩件" } } });
  await context.handleText(event("1"));
  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].pickup_latitude, 22.465);
  assert.equal(calls.orders[0].pickup_longitude, 120.45);
  assert.equal(calls.orders[0].ride_details, "行李：兩件");
});

test("muted quote handler applies the same strict validation", async t => {
  const { context, calls, event } = harness(t, { geocode: [geocodeResult({ partial_match: true })] });
  await context.handleMutedText(event(`試算車資 ${ADDRESS}到${TEMPLE}`));
  assert.equal(calls.replies.length, 0);
  assert.equal(calls.orders.length, 0);
  assert.equal(calls.google.some(call => call.url.includes("computeRoutes")), false);
});

test("test orders and capture forwarding cannot write unverified locations", async t => {
  const { context, calls, event } = harness(t);
  await context.dispatchTestOrder(event("測試派單 1"), "測試派單 1");
  assert.equal(calls.orders.length, 0);
  const invalid = `上車地點：${TEMPLE}\n下車地點：謝謝`;
  assert.equal(await context.getValidatedCapturedRoute(event(invalid), invalid), null);
  const destinationOnly = `下車地址：${TEMPLE}`;
  assert.equal(await context.getValidatedCapturedRoute(event(destinationOnly), destinationOnly), null);
});
