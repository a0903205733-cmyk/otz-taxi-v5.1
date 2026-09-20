import express from "express";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { middleware, messagingApi } from "@line/bot-sdk";
import {
  parseRideRequest, classifyRideSchedule, isGroupRideRequest,
  hasRideIntent, isPlaceholderPlace, containsUnsupportedArea
} from "./parser.js";
import { getRoute, getPickupEtaMinutes, validatePickupLocation } from "./maps.js";
import { calculateDonggangTownFare, calculateFare, isDonggangTownTrip } from "./fare.js";
import { quoteFlex, pickupOnlyFlex, orderNo } from "./messages.js";
import {
  createOrder, listOrders, getOrder, updateOrder, claimOrder,
  listDrivers, createDriver, updateDriver,
  getDriverByUsername, getDriverById,
  listVehicles, getVehicleById, createVehicle, updateVehicle,
  subscribeToFleetChanges, listSettings, updateSetting,
  listCustomers, updateCustomer, upsertCustomerByLineId,
  createPayment, createReceipt, getReceiptByOrderId,
  listAuditLogs, createAuditLog
} from "./db.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8080);

const line = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

const realtimeClients = new Set();
const pickupEtaCache = new Map();
const DEFAULT_ADMIN_TOKEN = "0908160150";
const LINE_MUTED_SOURCES_SETTING = "muted_line_sources";
const HUMAN_HANDOFF_KEYWORDS = new Set(["人工介入", "轉人工", "人工客服"]);
const BOT_RESUME_KEYWORDS = new Set(["解除人工介入", "恢復機器人", "開啟機器人"]);
const PICKUP_ETA_LIMIT_MINUTES = 20;
const LOCATION_MAX_AGE_MS = 2 * 60 * 1000;
const ETA_CACHE_MS = 5 * 60 * 1000;

subscribeToFleetChanges(event => {
  const message = `data: ${JSON.stringify(event)}

`;
  for (const client of realtimeClients) client.write(message);
});

app.get("/", (_req, res) => res.send("OTZ V5.3.6 is running"));
app.get("/health", async (_req, res) => {
  const checks = {
    app: "ok",
    version: "5.3.6",
    line: Boolean(process.env.LINE_CHANNEL_SECRET && process.env.LINE_CHANNEL_ACCESS_TOKEN),
    google_maps: Boolean(process.env.GOOGLE_MAPS_API_KEY),
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY),
    jwt: Boolean(process.env.JWT_SECRET),
    realtime: true
  };

  const healthy = Object.entries(checks)
    .filter(([key]) => !["version"].includes(key))
    .every(([, value]) => value === "ok" || value === true);

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    ...checks,
    time: new Date().toISOString()
  });
});

app.use("/admin", express.static("public/admin"));
app.use("/driver", express.static("public/driver"));

app.post("/webhook", middleware({ channelSecret: process.env.LINE_CHANNEL_SECRET }), async (req, res) => {
  res.status(200).end();

  try {
    await Promise.all(req.body.events.map(handleLineEvent));
  } catch (error) {
    console.error("Webhook error:", error);
  }
});

// =================================================================
// 核心邏輯修改：新增官方網頁後台點擊手動聊天偵測與機器人阻斷機制
// =================================================================
async function handleLineEvent(event) {
  const sourceKey = getLineSourceKey(event);

  // 🎯 【網頁後台點擊偵測】客服直接在官方網頁後台點擊變更狀態時觸發
  if (event.type === "chatControl") {
    const chatMode = event.chatControl?.chatMode;
    
    // active: 客服在後台網頁開啟對話、移至處理中（開始手動聊天）
    // standby: 客服在後台網頁點擊「處理完畢」或移至「未處理」（結束手動聊天）
    const isManual = (chatMode === "active");

    if (isManual) {
      console.log(`[客服介入] 網頁後台操作：開始手動聊天 ➡️ 自動關閉機器人 (${sourceKey})`);
      await setLineSourceMuted(sourceKey, true);
    } else {
      console.log(`[客服離開] 網頁後台操作：結束手動聊天 ➡️ 自動復原機器人 (${sourceKey})`);
      await setLineSourceMuted(sourceKey, false);
    }
    return; // 狀態變更處理完畢，直接中斷事件，不往下執行
  }

  // 📥 【客戶文字訊息】保留原有的文字關鍵字開關（作為雙重保險）
  if (event.type === "message" && event.message.type === "text") {
    const incomingText = String(event.message.text || "").trim();

    if (BOT_RESUME_KEYWORDS.has(incomingText)) {
      await setLineSourceMuted(sourceKey, false);
      return reply(event.replyToken, "已恢復機器人自動回覆。");
    }

    if (HUMAN_HANDOFF_KEYWORDS.has(incomingText)) {
      await setLineSourceMuted(sourceKey, true);
      return reply(event.replyToken, "已切換人工處理，此聊天窗口的機器人自動回覆已關閉。");
    }
  }

  // ⛔ 【核心阻斷機制】如果目前處於手動聊天（Muted）狀態，機器人直接跳過、已讀不回
  if (await isLineSourceMuted(sourceKey)) {
    console.log(`[機器人靜音] 客服正在網頁端進行手動聊天，已忽略此訊息: ${sourceKey}`);
    return;
  }

  // 🚖 正常狀態：進入您原本的 OTZ 車隊自動叫車、估價邏輯
  if (event.type === "message" && event.message.type === "text") return handleText(event);
  if (event.type === "postback") return handlePostback(event);
}

async function handleText(event) {
  const incomingText = String(event.message.text || "").trim();
  if (incomingText === "我要試算車資") {
    return reply(event.replyToken, "請問上下車地點");
  }
  if (incomingText === "我想叫車") {
    const nickname = await getLineNickname(event);
    return reply(
      event.replyToken,
      `${nickname}請提供您的上下車地點\n` +
        "🔴➡️ 上車地點（必填）：\n" +
        "🔴➡️ 下車地點（必填）：\n" +
        "🔴➡️ 人數 ：\n" +
        "🔴➡️ 行李 ：\n" +
        "🔴➡️ 特殊需求："
    );
  }
  if (incomingText === "我要叫車") {
    const settings = await listSettings();
    return reply(
      event.replyToken,
      settings.line_welcome_message ||
        "請輸入：上車地點到下車地點、時間、人數\n例如：明天早上8點，東港碼頭到左營高鐵，2位"
    );
  }
  const isGroupChat = ["group", "room"].includes(event.source?.type);
  const rideText = incomingText.replace(/^我要叫車[，,、:：\s]*/, "");
  const parsed = parseRideRequest(rideText);

  const explicitRideIntent = hasRideIntent(incomingText);
  if (incomingText !== "我要叫車" && !isGroupRideRequest(incomingText, parsed)) {
    if (explicitRideIntent && (isPlaceholderPlace(parsed.pickup) || isPlaceholderPlace(parsed.destination))) {
      return reply(event.replyToken, "請提供可導航的上車或下車地點；『我家／某某家』需先提供完整地址。");
    }
    if (explicitRideIntent && containsUnsupportedArea(incomingText)) {
      return reply(event.replyToken, "OTZ 車隊目前只接受台灣本島行程，不接受國外或外島地點。");
    }
    console.log("Ignored non-ride message");
    return;
  }

  if (isGroupChat) {
    if (incomingText === "我要叫車") {
      const groupSettings = await listSettings();
      return reply(
        event.source?.groupId || event.source?.roomId,
        groupSettings.line_welcome_message ||
          "請輸入：上車地點到下車地點、時間、人數\n例如：明天早上八點，東港到林邊，2位"
      );
    }
    if (!isGroupRideRequest(incomingText, parsed)) {
      console.log("Ignored non-ride group message");
      return;
    }
  }

  const settings = await listSettings();

  const ignoredKeywords = new Set(
    Array.isArray(settings.ignored_keywords)
      ? settings.ignored_keywords
      : ["常見問題", "試算車資", "應徵司機"]
  );

  if (ignoredKeywords.has(incomingText)) {
    console.log(`Ignored LINE keyword: ${incomingText}`);
    return;
  }

  const customer = await upsertCustomerByLineId(event.source?.userId || null);
  if (customer?.customer_type === "blacklist") {
    return reply(event.replyToken, "此帳號目前無法使用自動叫車，請聯絡 OTZ 車隊客服。");
  }

  if (!parsed.pickup) {
    return reply(
      event.replyToken,
      settings.line_welcome_message ||
        "請輸入：上車地點到下車地點、時間、人數\n例如：明天早上8點，東港碼頭到左營高鐵，2位"
    );
  }

  try {
    const schedule = classifyRideSchedule(parsed.rideTime);
    if (!parsed.destination) {
      const pickupResult = await validatePickupLocation(
        parsed.pickup,
        process.env.GOOGLE_MAPS_API_KEY
      );
      const order = await createOrder({
        customer_line_id: event.source?.userId || null,
        pickup: parsed.pickup,
        destination: "尚未提供",
        ride_time: parsed.rideTime || null,
        is_reservation: schedule.isReservation,
        scheduled_at: schedule.scheduledAt,
        passengers: parsed.passengers,
        pickup_latitude: pickupResult.location?.latitude ?? null,
        pickup_longitude: pickupResult.location?.longitude ?? null,
        distance_km: 0,
        duration_min: 0,
        base_fare: 0,
        mileage_fare: 0,
        time_fare: 0,
        toll: 0,
        night_surcharge: 0,
        estimated_fare: 0,
        in_service_area: true,
        status: "pending"
      });
      return line.replyMessage({
        replyToken: event.replyToken,
        messages: [pickupOnlyFlex(order)]
      });
    }
    const route = await getRoute(
      parsed.pickup,
      parsed.destination,
      process.env.GOOGLE_MAPS_API_KEY,
      settings
    );

    const toll = Number(settings.default_toll ?? process.env.DEFAULT_TOLL ?? 0);
    const fare = isDonggangTownTrip(parsed.pickup, parsed.destination, route)
      ? calculateDonggangTownFare()
      : calculateFare(route.distanceKm, route.durationMin, toll, settings);
    const areas = String(process.env.SERVICE_AREAS || "東港,潮州,林邊,佳冬,枋寮").split(",");
    const inServiceArea = areas.some(area =>
      `${parsed.pickup} ${parsed.destination}`.includes(area.trim())
    );

    const order = await createOrder({
      customer_line_id: event.source?.userId || null,
      pickup: parsed.pickup,
      destination: parsed.destination,
      ride_time: parsed.rideTime || null,
      is_reservation: schedule.isReservation,
      scheduled_at: schedule.scheduledAt,
      passengers: parsed.passengers,
      pickup_latitude: route.startLocation?.latitude ?? null,
      pickup_longitude: route.startLocation?.longitude ?? null,
      destination_latitude: route.endLocation?.latitude ?? null,
      destination_longitude: route.endLocation?.longitude ?? null,
      distance_km: route.distanceKm,
      duration_min: route.durationMin,
      base_fare: fare.baseFare,
      mileage_fare: fare.mileageFare,
      time_fare: fare.timeFare,
      toll: fare.toll,
      night_surcharge: fare.nightSurcharge,
      estimated_fare: fare.totalFare,
      in_service_area: inServiceArea,
      status: "pending"
    });

    return line.replyMessage({
      replyToken: event.replyToken,
      messages: [quoteFlex(order)]
    });
  } catch (error) {
    console.error("Handle text error:", error);
    return reply(event.replyToken, "抱歉，系統估價失敗或地點不正確，請重新輸入正確起訖點。");
  }
}

async function handlePostback(event) {
  console.log("Postback received:", event.postback.data);
}

function getLineSourceKey(event) {
  if (event.source?.type === "user") return `user:${event.source.userId}`;
  if (event.source?.type === "group") return `group:${event.source.groupId}`;
  if (event.source?.type === "room") return `room:${event.source.roomId}`;
  return `unknown:${Date.now()}`;
}

async function isLineSourceMuted(sourceKey) {
  const settings = await listSettings();
  const muted = settings[LINE_MUTED_SOURCES_SETTING];
  if (!muted || typeof muted !== "object") return false;
  return Boolean(muted[sourceKey]);
}

async function setLineSourceMuted(sourceKey, isMuted) {
  const settings = await listSettings();
  const muted = { ...(settings[LINE_MUTED_SOURCES_SETTING] || {}) };
  if (isMuted) {
    muted[sourceKey] = true;
  } else {
    delete muted[sourceKey];
  }
  await updateSetting(LINE_MUTED_SOURCES_SETTING, muted);
}

async function reply(replyToken, text) {
  try {
    await line.replyMessage({
      replyToken,
      messages: [{ type: "text", text }]
    });
  } catch (error) {
    console.error("Reply error:", error);
  }
}

async function getLineNickname(event) {
  try {
    if (event.source?.type === "user") {
      const profile = await line.getProfile(event.source.userId);
      return profile.displayName ? `${profile.displayName} ` : "";
    }
  } catch (e) {
    console.error("Error getting profile:", e);
  }
  return "";
}

app.listen(port, () => console.log(`Server listening on port ${port}`));