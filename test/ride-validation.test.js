import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseRideRequest, parseRideFormSubmission, classifyRideSchedule, stripRouteFareQuestion, stripAddressPostalCode } from "../src/parser.js";
import { validateRideLocations } from "../src/locations.js";
import { isIntakeGroup, parseIntakeMention, formatIntakeDispatch } from "../src/group-intake.js";
import { getRoute } from "../src/maps.js";
import { calculateFare, calculateDonggangTownFare, isDonggangTownTrip } from "../src/fare.js";
import { ADDRESS, TEMPLE, geocodeResult, placeResult, mapsFetch, transportPlaces } from "./fixtures/locations.js";

const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("postal cleanup preserves house numbers and cleans the reported malformed input", () => {
  const pickup = "屏東縣崁頂鄉園寮村南州路1-2號";
  const destination = "屏東縣屏東市建民路104-3號";
  for (const value of [pickup + "924號", "924" + pickup, "924001 " + pickup, pickup + " 郵遞區號：924"]) {
    assert.equal(stripAddressPostalCode(value), pickup);
  }
  for (const value of [destination, "屏東縣崁頂鄉南州路924號", "屏東縣屏東市建民路104-3號2樓", pickup + "925號"]) {
    assert.equal(stripAddressPostalCode(value), value);
  }
  const parsed = parseRideRequest(`${pickup}924號\n${destination}`);
  assert.equal(parsed.pickup, pickup);
  assert.equal(parsed.destination, destination);
  const intake = parseIntakeMention(intakeEvent(`@OTZ 上車地點：${pickup}924號\n下車地點：${destination}`), "main-bot");
  assert.equal(intake.pickup, pickup);
  assert.equal(intake.destination, destination);
});

test("intake dispatch uses 01 numbers and omits missing destinations", () => {
  const order = { id: 123, pickup: TEMPLE, destination: "尚未提供", ride_details: "百回+30" };
  assert.equal(formatIntakeDispatch(order), `訂單：01-00123\n60/20/2\n上車地點：${TEMPLE}\n百回+30`);
  assert.equal(formatIntakeDispatch({ ...order, destination: ADDRESS }),
    `訂單：01-00123\n60/20/2\n上車地點：${TEMPLE}\n下車地點：${ADDRESS}\n百回+30`);
  assert.equal(formatIntakeDispatch({ ...order, ride_details: null }), null);
});

test("completion parser resolves both intake and regular order numbers", () => {
  const context = vm.createContext({});
  for (const name of ["parseDispatchCompletionText", "parseDispatchCompletionSegment"]) {
    const start = source.indexOf(`function ${name}(`);
    const rest = source.slice(start + 1);
    const next = rest.search(/^(?:async )?function /m);
    vm.runInContext(source.slice(start, start + 1 + next), context);
  }
  for (const number of ["01-00123", "OTZ-000123"]) {
    const result = context.parseDispatchCompletionText(`訂單：${number}\n60/20/2\n9820/白/15`);
    assert.equal(result.orderId, 123);
    assert.equal(result.fourDigits, "9820");
    assert.equal(result.twoDigits, "15");
  }
});

function intakeEvent(text = `@OTZ ${TEMPLE}`) {
  return { type: "message", destination: "main-bot", replyToken: "test-reply",
    source: { type: "group", groupId: "C24304391da7434a2bc0ff5d1dd8c9413", userId: "sender" },
    message: { id: "intake-message", type: "text", text, mention: { mentionees: [{ type: "user", userId: "main-bot", index: 0, length: 4 }] } } };
}

test("intake cancellation is a command, never a pickup address", async t => {
  for (const text of ["@OTZ 取消", "@OTZ 取消 01-00304", "@OTZ 不要取消", "@OTZ 取消 01-00304 01-00305"]) {
    const parsed = parseIntakeMention(intakeEvent(text), "main-bot");
    assert.equal(parsed.intakeCommand, "cancel");
    assert.equal(parsed.pickup, undefined);
  }
  assert.equal(parseIntakeMention(intakeEvent("@OTZ 取消 01-00304"), "main-bot").orderId, 304);
  assert.equal(parseIntakeMention(intakeEvent("@OTZ 不要取消"), "main-bot").invalid, true);
  const { context, calls } = harness(t);
  let cancellations = 0;
  context.cancelIntakeRide = async () => { cancellations += 1; };
  await context.handleLineEvent(intakeEvent("@OTZ 取消"));
  assert.equal(cancellations, 1);
  assert.equal(calls.orders.length, 0);
});

test("quoted intake cancellation targets saved groups and refuses ambiguous or arrived orders", async () => {
  const replies = [], pushes = [];
  let match = { orderId: 304, groupIds: ["original-dispatch"] }, cancelled = false, fail = false;
  let lookupArgs;
  const context = vm.createContext({
    console: { error() {} },
    findIntakeCancellation: async (...args) => { lookupArgs = args; return match; },
    cancelIntakeBeforeArrival: async () => {
      if (cancelled) return null;
      cancelled = true;
      return { order: { id: 304, pickup: "原上車點" } };
    },
    clearDispatchSearchPromptForOrder() {}, createAuditLog: async () => {}, logLinePushError() {},
    pushDispatchLineMessages: async (ids, text) => { if (fail) throw new Error("push failed"); pushes.push({ ids, text }); },
    reply: async (_, text) => replies.push(text)
  });
  const start = source.indexOf("async function cancelIntakeRide(");
  const end = source.indexOf("\nasync function handleDispatchBotTagged", start);
  vm.runInContext(source.slice(start, end), context);
  const event = intakeEvent("@OTZ 取消");
  event.message.quotedMessageId = "original-message";
  await context.cancelIntakeRide(event, { orderId: null });
  assert.deepEqual(lookupArgs, [event.source.groupId, null, "original-message"]);
  assert.equal(pushes[0].ids[0], "original-dispatch");
  assert.match(pushes[0].text, /01-00304.*\n此單已取消/);
  await context.cancelIntakeRide(event, { orderId: 304 });
  assert.equal(pushes.length, 1);
  assert.match(replies.at(-1), /已取消、已抵達/);
  match = null;
  await context.cancelIntakeRide(event, {});
  assert.match(replies.at(-1), /找不到/);
  match = { orderId: 304, groupIds: [] };
  await context.cancelIntakeRide(event, {});
  assert.match(replies.at(-1), /舊單/);
  match.groupIds = ["original-dispatch"];
  cancelled = false;
  fail = true;
  await context.cancelIntakeRide(event, {});
  assert.match(replies.at(-1), /部分派單群組通知失敗/);
  delete event.message.quotedMessageId;
  await context.cancelIntakeRide(event, {});
  assert.match(replies.at(-1), /請引用原叫車訊息/);
});

test("second completion accepts only standalone arrival and not the ETA label", async () => {
  const pushes = [], replies = [], statuses = [];
  let claimed = false, failure = false;
  let order = { id: 123, status: "completed", customer_line_id: "customer" };
  const context = vm.createContext({
    console: { error() {} }, formatIntakeDispatch, isIntakeGroup,
    isOnlyDispatchBotMention: () => false,
    getOrder: async () => order,
    orderNo: () => "OTZ-000123",
    getIntakeSource: async () => intakeEvent().source,
    claimDispatchArrival: async () => { if (claimed) return null; claimed = true; return 7; },
    finishDispatchArrival: async (_, __, status) => statuses.push(status),
    line: { pushMessage: async value => { if (failure) throw new Error("429"); pushes.push(value); } },
    reply: async (_, text) => replies.push(text),
    replyMentionUser: async (_, user, __, text) => replies.push({ user, text }),
    getLineNickname: async () => "driver", logLinePushError() {}
  });
  for (const name of ["handleDispatchBotTagged", "handleDispatchArrival", "isDispatchArrivalText", "parseDispatchCompletionText", "parseDispatchCompletionSegment"]) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
    const next = source.slice(start + 1).search(/^(?:async )?function /m);
    vm.runInContext(source.slice(start, start + 1 + next), context);
  }
  for (const text of ["抵達時間：15", "尚未抵達", "快抵達", "車牌/顏色/抵達時間：9820/白/15"]) {
    assert.equal(context.isDispatchArrivalText(text), false);
  }
  const event = { replyToken: "reply", source: { userId: "driver-id" } };
  const message = "訂單：OTZ-000123\n抵達 @派單機器人2";
  await context.handleDispatchBotTagged(event, message);
  assert.equal(pushes[0].to, "customer");
  assert.equal(pushes[0].messages[0].text, "訂單：OTZ-000123\n司機已抵達。");
  assert.equal(replies[0].user, "driver-id");
  await context.handleDispatchBotTagged(event, message);
  assert.equal(pushes.length, 1);
  assert.match(replies.at(-1), /不重複發送/);
  claimed = false;
  order = { ...order, ride_details: "百回+30" };
  await context.handleDispatchBotTagged(event, "訂單：01-00123\n抵達\n@A1");
  assert.equal(pushes[1].to, intakeEvent().source.groupId);
  assert.match(pushes[1].messages[0].text, /01-00123/);
  claimed = false;
  failure = true;
  await context.handleDispatchBotTagged(event, message);
  assert.equal(statuses.at(-1), "failed_or_unknown");
  assert.match(replies.at(-1), /未確認送達/);
  order = { ...order, status: "pending" };
  await context.handleDispatchBotTagged(event, message);
  assert.match(replies.at(-1), /資料不完整/);
  assert.equal(pushes.length, 2);
  order = { ...order, status: "cancelled", cancelled_at: "2026-10-19" };
  for (const body of [message, "訂單：01-00123\n9820/白/15\n@A1"]) {
    await context.handleDispatchBotTagged(event, body);
    assert.match(replies.at(-1), /已取消，不接受/);
  }
  assert.equal(pushes.length, 2);
});

test("cancel after driver report closes immediately and tags the original driver in their group", async () => {
  const pushes = [], replies = [];
  const context = vm.createContext({
    console: { error() {} },
    findIntakeCancellation: async () => ({ orderId: 304, groupIds: ["dispatch-one", "driver-group"] }),
    cancelIntakeBeforeArrival: async () => ({
      order: { id: 304, status: "cancelled", pickup: "原上車點" },
      driverSource: { type: "group", groupId: "driver-group", userId: "original-driver" }
    }),
    clearDispatchSearchPromptForOrder() {}, createAuditLog: async () => {}, logLinePushError() {},
    pushDispatchLineMessage: async (group, text, options) => {
      pushes.push({ group, text, options }); return { name: "A1" };
    },
    withDispatchMentionAll: text => `@All\n${text}`,
    reply: async (_, text) => replies.push(text)
  });
  for (const name of ["cancelIntakeRide", "pushDispatchLineMessages"]) {
    const start = source.indexOf(`async function ${name}(`);
    const next = source.slice(start + 1).search(/^(?:async )?function /m);
    vm.runInContext(source.slice(start, start + 1 + next), context);
  }
  await context.cancelIntakeRide(intakeEvent("@OTZ 取消 01-00304"), { orderId: 304 });
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].options.mentionUserId, null);
  assert.equal(pushes[1].options.mentionUserId, "original-driver");
  assert.equal(pushes[1].group, "driver-group");
  assert.match(pushes[1].text, /此單已取消，請勿前往/);
  assert.match(replies[0], /已取消，已通知派單群組/);
});

test("driver cancellation uses textV2 user mention and does not silently fall back to plain text", async () => {
  const messages = [];
  let fail = false;
  const context = vm.createContext({
    dispatchTokenCursor: 0, console: { error() {}, warn() {} },
    normalizeLineText: text => text,
    getDispatchLineAccounts: () => [{ name: "A1", client: { pushMessage: async value => {
      messages.push(value); if (fail) throw new Error("bad request");
    } } }],
    getLinePushErrorDetails: () => ({ status: 400 })
  });
  for (const name of ["createUserMentionMessage", "pushDispatchLineMessage"]) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
    const next = source.slice(start + 1).search(/^(?:async )?function /m);
    vm.runInContext(source.slice(start, start + 1 + next), context);
  }
  await context.pushDispatchLineMessage("driver-group", "此單已取消", { mentionUserId: "original-driver" });
  const message = messages[0].messages[0];
  assert.equal(message.type, "textV2");
  assert.equal(message.substitution.user.mentionee.userId, "original-driver");
  fail = true;
  await assert.rejects(context.pushDispatchLineMessage("driver-group", "取消", { mentionUserId: "original-driver" }));
  assert.equal(messages.length, 2);
});

test("intake completion sends sorted driver data to the original group through main LINE client", async () => {
  const pushes = [];
  let savedSource = intakeEvent().source;
  const context = vm.createContext({
    formatIntakeDispatch, isIntakeGroup,
    getIntakeSource: async () => savedSource,
    line: { pushMessage: async message => pushes.push(message) },
    orderNo: id => `OTZ-${String(id).padStart(6, "0")}`,
    normalizeLineText: text => text
  });
  for (const name of ["notifyCustomer", "parseDispatchCompletionText", "parseDispatchCompletionSegment"]) {
    const start = source.indexOf(`${name === "notifyCustomer" ? "async " : ""}function ${name}(`);
    const next = source.slice(start + 1).search(/^(?:async )?function /m);
    vm.runInContext(source.slice(start, start + 1 + next), context);
  }
  const order = { id: 123, customer_line_id: "customer", ride_details: "百回+30" };
  for (const segment of ["9820/15/白", "白/9820/5", "準時/白/9820"]) {
    const completion = context.parseDispatchCompletionText(`訂單：01-00123\n60/20/2\n百回+30\n${segment}\n@派單機器人2`);
    await context.notifyCustomer(order, "complete", { dispatchCompletion: completion });
    const sent = pushes.at(-1);
    assert.equal(sent.to, savedSource.groupId);
    assert.ok(sent.messages[0].text.includes("訂單：01-00123"));
    assert.ok(sent.messages[0].text.includes(`9820/白/${completion.twoDigits}`));
  }
  const completion = { fourDigits: "9820", color: "白", twoDigits: "15" };
  await context.notifyCustomer({ ...order, ride_details: null }, "complete", { dispatchCompletion: completion });
  assert.equal(pushes.at(-1).to, "customer");
  assert.ok(pushes.at(-1).messages[0].text.includes("OTZ-000123"));
  for (const invalid of [null, { type: "group", groupId: "unrelated" }]) {
    savedSource = invalid;
    await assert.rejects(context.notifyCustomer(order, "complete", { dispatchCompletion: completion }), /source group/);
  }
  assert.equal(pushes.length, 4);
});

test("intake group only accepts real mentions of the receiving main bot", () => {
  const event = intakeEvent();
  assert.equal(parseIntakeMention(event, "main-bot").pickup, TEMPLE);
  for (const change of [
    e => { e.destination = "a1"; },
    e => { e.source.groupId = "other-group"; },
    e => { e.message.mention.mentionees[0].userId = "a1"; },
    e => { delete e.message.mention; },
    e => { e.message.mention.mentionees[0].length = 999; }
  ]) {
    const altered = structuredClone(event);
    change(altered);
    assert.equal(parseIntakeMention(altered, "main-bot"), null);
  }
  assert.equal(parseIntakeMention(intakeEvent("@OTZ"), "main-bot"), null);
});

test("intake group copies addresses without Google and only acknowledges with 好", async t => {
  const { context, calls } = harness(t);
  await context.handleLineEvent(intakeEvent());
  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].status, "pending");
  assert.equal(calls.intakeSource.id, 123);
  assert.equal(calls.intakeSource.source.groupId, intakeEvent().source.groupId);
  assert.equal(calls.intakeSource.messageId, "intake-message");
  assert.deepEqual(calls.intakeSource.dispatchGroupIds, ["test-group"]);
  assert.equal(calls.orders[0].ride_details, "百回+30");
  assert.equal(calls.orders[0].pickup, TEMPLE);
  assert.equal(calls.orders[0].destination, "尚未提供");
  assert.equal(calls.confirmations.length, 0);
  assert.deepEqual(calls.replies, ["好"]);
  assert.equal(calls.orders[0].pickup_latitude, null);
  await context.handleLineEvent(intakeEvent(`@OTZ 上車地點：${TEMPLE}\n下車地點：${ADDRESS}`));
  assert.equal(calls.orders.length, 2);
  assert.equal(calls.orders[1].destination, ADDRESS);
  await context.handleLineEvent(intakeEvent("@OTZ 上車地點：自訂集合點\n下車地點：另一個集合點"));
  assert.equal(calls.orders[2].pickup, "自訂集合點");
  assert.equal(calls.orders[2].destination, "另一個集合點");
  assert.equal(calls.google.length, 0);
  assert.deepEqual(calls.replies, ["好", "好", "好"]);
});

test("intake group ignores untagged and empty messages but permits ID lookup", async t => {
  const { context, calls } = harness(t);
  const untagged = intakeEvent();
  delete untagged.message.mention;
  await context.handleLineEvent(untagged);
  await context.handleLineEvent(intakeEvent("@OTZ"));
  const dispatch = intakeEvent();
  dispatch.destination = "a1";
  await context.handleLineEvent(dispatch);
  assert.equal(calls.orders.length, 0);
  const lookup = intakeEvent("查群組ID");
  await context.handleLineEvent(lookup);
  assert.deepEqual(calls.replies, ["group-id"]);
});

test("dispatch template retains the fixed intake note", () => {
  const start = source.indexOf("function formatRideRequestTemplate(");
  const end = source.indexOf("\nfunction ", start + 1);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.formatRideRequestTemplate({ pickup: TEMPLE, destination: ADDRESS, rideDetails: "百回+30" }),
    `60/20/2\n上車地點:${TEMPLE}\n下車地點:${ADDRESS}\n百回+30`);
});

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
    parseRideRequest, parseRideFormSubmission, classifyRideSchedule, stripRouteFareQuestion,
    isIntakeGroup, parseIntakeMention, getMainBotId: async () => "main-bot",
    getLineSourceKey: () => "group:intake", replyLineSourceId: () => calls.replies.push("group-id"),
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
    saveIntakeSource: async (id, source, messageId, dispatchGroupIds) => { calls.intakeSource = { id, source, messageId, dispatchGroupIds }; },
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
  for (const name of ["handleLineEvent", "handleText", "createLineRideOrder", "handleMutedText", "getVerifiedRideInput",
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

test("scenic names enter ride confirmation and validated fare routes", async t => {
  const names = ["測試沙灘", "測試觀景台"];
  const places = names.map((name, index) => placeResult({ id: `scenic-${index}`,
    displayName: { text: name }, primaryType: index ? "observation_deck" : "beach" }));
  const { context, calls, event } = harness(t, { places });
  for (const name of names) await context.handleText(event(name));
  assert.equal(calls.confirmations.length, 2);
  await context.handleText(event(`試算車資\n${names.join("\n")}`));
  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].pickup, names[0]);
  assert.equal(calls.orders[0].destination, names[1]);
});

test("organizations enter ride and fare flows only after unique place validation", async t => {
  const query = "測試發展協會";
  const organization = placeResult({ id: "organization", displayName: { text: query },
    primaryType: "association_or_organization", types: ["association_or_organization"] });
  const { context, calls, event } = harness(t, { places: [organization, placeResult()] });
  await context.handleText(event(query));
  assert.equal(calls.confirmations.length, 1);
  assert.equal(calls.confirmations[0].pickup, query);
  await context.handleText(event(`試算車資 ${query}到${TEMPLE}`));
  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].pickup, query);
});

test("customer temple routes and bare HSR shorthand reach confirmation", async t => {
  const places = [placeResult({ id: "donglong", displayName: { text: "東港東隆宮" },
    formattedAddress: "928屏東縣東港鎮東隆里東隆街21-1號", primaryType: "place_of_worship" }),
    placeResult({ primaryType: "association_or_organization",
      formattedAddress: "42之, No. 5號鎮海路鎮海里東港鎮屏東縣92845" }),
    transportPlaces.find(item => item.query === "左營高鐵").place];
  const { context, calls, event } = harness(t, { places });
  for (const text of ["東港東隆宮到東港鎮海宮", "東隆宮到高鐵", "鎮海宮到高鐵"]) {
    await context.handleText(event(text));
  }
  assert.equal(calls.confirmations.length, 3);
  for (const parsed of calls.confirmations.slice(1)) {
    assert.equal(parsed.verifiedLocations.destination.placeId, places[2].id);
  }
  assert.equal(calls.orders.length, 0);
});

test("religious places enter ride and fare flows without an alias", async t => {
  const names = ["測試寺", "測試教堂", "測試清真寺", "測試宗祠", "測試精舍"];
  const places = names.map((name, index) => placeResult({ id: `religion-${index}`,
    displayName: { text: name }, primaryType: "place_of_worship", types: ["place_of_worship"] }));
  const { context, calls, event } = harness(t, { places });
  for (const name of names) await context.handleText(event(name));
  assert.equal(calls.confirmations.length, names.length);
  await context.handleText(event(`試算車資 ${names[0]}到${names[1]}`));
  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].pickup, names[0]);
  assert.equal(calls.orders[0].destination, names[1]);
});

test("Xishi to Linbian works for ride confirmation and fare calculation", async t => {
  const places = [placeResult({ id: "xishi", displayName: { text: "西勢火車站" },
    formattedAddress: "屏東縣竹田鄉西勢村西豐路2號", primaryType: "train_station" }),
    transportPlaces.find(item => item.query === "林邊火車站").place];
  const { context, calls, event } = harness(t, { places });
  await context.handleText(event("西勢車站到林邊車站"));
  assert.equal(calls.confirmations.length, 1);
  assert.equal(calls.confirmations[0].pickup, "西勢車站");
  assert.equal(calls.confirmations[0].destination, "林邊車站");
  await context.handleText(event("試算車資 西勢車站到林邊車站"));
  assert.equal(calls.orders.length, 1);
});

for (const fareIntent of [false, true]) {
  test(`route price questions remove only the fare suffix (prior intent ${fareIntent})`, async t => {
    const places = [placeResult({ id: "xishi", displayName: { text: "西勢火車站" }, primaryType: "train_station" }),
      transportPlaces.find(item => item.query === "林邊火車站").place];
    const { context, calls, event } = harness(t, { places, fareIntent });
    for (const suffix of ["多少", "多少錢？", "要多少錢", "車資多少", "大概要多少錢？"]) {
      await context.handleText(event(`西勢車站到林邊車站${suffix}`));
    }
    assert.equal(calls.orders.length, 5);
    assert.equal(calls.confirmations.length, 0);
    for (const order of calls.orders) {
      assert.equal(order.pickup, "西勢車站");
      assert.equal(order.destination, "林邊車站");
      assert.equal(order.status, "awaiting_customer");
    }
    await context.handleText(event("西勢車站到謝謝多少"));
    assert.equal(calls.orders.length, 5);
    assert.equal(stripRouteFareQuestion("多少錢"), "多少錢");
    assert.equal(stripRouteFareQuestion("西勢車站到多少錢餐廳"), "西勢車站到多少錢餐廳");
  });
}

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

for (const form of [false, true]) {
  test(`postal suffix repair accepts the customer form (pending ${form})`, async t => {
    const pickup = "屏東縣崁頂鄉園寮村南州路1-2號";
    const destination = "屏東縣屏東市建民路104-3號";
    const target = geocodeResult({ place_id: "target", formatted_address: `900台灣${destination}` });
    target.address_components[2].long_name = "屏東市";
    target.address_components[3].long_name = "建民路";
    target.address_components[4].long_name = "104-3號";
    const { context, calls, event } = harness(t, { form, geocode: [postalSuffixResult(), target] });
    await context.handleText(event(`上車地點：${pickup}\n下車地點：${destination}`));
    assert.equal(calls.confirmations.length, 1);
    assert.equal(calls.confirmations[0].pickup, pickup);
    assert.equal(calls.confirmations[0].destination, destination);
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
import { postalSuffixResult } from "./fixtures/locations.js";
