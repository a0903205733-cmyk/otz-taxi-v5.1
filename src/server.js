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
const PICKUP_ETA_LIMIT_MINUTES = 20;
const LOCATION_MAX_AGE_MS = 2 * 60 * 1000;
const ETA_CACHE_MS = 5 * 60 * 1000;

subscribeToFleetChanges(event => {
  const message = `data: ${JSON.stringify(event)}\n\n`;
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

async function handleLineEvent(event) {
  if (event.type === "message" && event.message.type === "text") return handleText(event);
  if (event.type === "postback") return handlePostback(event);
}

async function handleText(event) {
  const incomingText = String(event.message.text || "").trim();
  const isGroupChat = ["group", "room"].includes(event.source?.type);
  const rideText = incomingText.replace(/^我要叫車[，,、:：\s]*/, "");
  const parsed = parseRideRequest(rideText);

  // 私訊與群組使用相同的介入條件。普通聊天在讀取客戶資料與呼叫
  // Google API 之前就結束，避免誤建訂單與浪費 API 額度。
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
        event.replyToken,
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

  // 這些文字通常來自 LINE 圖文選單或其他官方帳號功能。
  // 命中時不由自訂 Bot 回覆，避免和 LINE 內建回應重複。
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
      // 沒有目的地時只驗證上車點，不呼叫 Routes API 或試算車資。
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
      pickup_latitude: route.originLocation?.latitude ?? null,
      pickup_longitude: route.originLocation?.longitude ?? null,
      distance_km: Number(route.distanceKm.toFixed(2)),
      duration_min: Number(route.durationMin.toFixed(2)),
      base_fare: fare.baseFare,
      mileage_fare: fare.mileageFare,
      time_fare: fare.timeFare,
      toll,
      night_surcharge: fare.nightSurcharge,
      estimated_fare: fare.estimatedFare,
      in_service_area: inServiceArea,
      status: "awaiting_customer"
    });

    return line.replyMessage({
      replyToken: event.replyToken,
      messages: [quoteFlex(order)]
    });
  } catch (error) {
    console.error("Quote error:", error);
    if (["INVALID_RIDE_TIME", "RIDE_TIME_EXPIRED"].includes(error.code)) {
      return reply(event.replyToken, `⚠️ ${error.message}`);
    }
    if (["LOCATION_OUTSIDE_TAIWAN", "LOCATION_AMBIGUOUS", "LOCATION_CONFLICT", "LOCATION_CITY_REQUIRED"].includes(error.code)) {
      return reply(event.replyToken, `⚠️ ${error.message}\nOTZ 車隊目前只接受台灣本島的上下車地點，不接受外島或國外行程。`);
    }
    return reply(event.replyToken, "目前無法完成估價，請稍後再試。");
  }
}

async function handlePostback(event) {
  const params = new URLSearchParams(event.postback.data);
  const action = params.get("action");
  const id = Number(params.get("id"));
  const order = await getOrder(id);

  if (action === "confirm") {
    if (order.status !== "awaiting_customer") {
      return reply(event.replyToken, "這筆訂單已處理。");
    }

    await updateOrder(id, { status: "pending" });

    return reply(
      event.replyToken,
      `✅ 叫車已確認\n訂單：${orderNo(id)}\n等待管理員或司機接單。`
    );
  }

  if (action === "cancel") {
    await updateOrder(id, {
      status: "cancelled",
      cancelled_at: new Date().toISOString()
    });

    return reply(event.replyToken, `已取消訂單 ${orderNo(id)}。`);
  }
}

app.use(express.json());

app.get("/api/events", (req, res) => {
  const adminToken = String(req.query.adminToken || "");
  const driverToken = String(req.query.driverToken || "");
  const isAdmin = adminToken && adminToken === process.env.ADMIN_TOKEN;
  let isDriver = false;

  if (driverToken) {
    try {
      jwt.verify(driverToken, process.env.JWT_SECRET);
      isDriver = true;
    } catch {
      isDriver = false;
    }
  }

  if (!isAdmin && !isDriver) {
    return res.status(401).json({ error: "未授權" });
  }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ table: "connected", eventType: "READY" })}\n\n`);
  realtimeClients.add(res);

  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    realtimeClients.delete(res);
  });
});

app.post("/api/driver/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({ error: "請輸入帳號與密碼" });
    }

    const driver = await getDriverByUsername(username);

    if (!driver || !driver.is_active || !driver.password_hash) {
      return res.status(401).json({ error: "帳號或密碼錯誤" });
    }

    const valid = await bcrypt.compare(password, driver.password_hash);

    if (!valid) {
      return res.status(401).json({ error: "帳號或密碼錯誤" });
    }

    await updateDriver(driver.id, {
      last_login_at: new Date().toISOString(),
      status: driver.status === "offline" ? "available" : driver.status
    });

    const token = jwt.sign(
      {
        driverId: driver.id,
        username: driver.username,
        name: driver.name
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      driver: {
        id: driver.id,
        name: driver.name,
        phone: driver.phone,
        plate: driver.plate,
        vehicle: driver.vehicle,
        vehicle_id: driver.vehicle_id,
        member_role: driver.member_role,
        status: driver.status
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/orders", adminAuth, async (_req, res) => {
  try {
    res.json(await listOrders());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/drivers", adminAuth, async (_req, res) => {
  try {
    res.json(await listDrivers());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/vehicles", adminAuth, async (_req, res) => {
  try {
    res.json(await listVehicles());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/vehicles", adminAuth, async (req, res) => {
  try {
    const plate = String(req.body.plate || "").trim().toUpperCase();
    const model = String(req.body.model || "").trim();
    const seats = Number(req.body.seats || 4);

    if (!plate || !model || !Number.isInteger(seats) || seats < 1 || seats > 20) {
      return res.status(400).json({ error: "車牌、車型必填，座位數需為 1～20" });
    }

    const vehicle = await createVehicle({
      plate,
      brand: String(req.body.brand || "").trim() || null,
      model,
      color: String(req.body.color || "").trim() || null,
      seats,
      is_active: true
    });

    await createAuditLog({ actor_type: "admin", action: "vehicle.create", entity_type: "vehicle", entity_id: String(vehicle.id), details: { plate, model } });

    res.status(201).json(vehicle);
  } catch (error) {
    const status = String(error.code) === "23505" ? 409 : 500;
    res.status(status).json({ error: status === 409 ? "車牌已存在" : error.message });
  }
});

app.post("/api/admin/vehicles/:id/toggle", adminAuth, async (req, res) => {
  try {
    const vehicle = await getVehicleById(Number(req.params.id));
    res.json(await updateVehicle(vehicle.id, { is_active: !vehicle.is_active }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/drivers", adminAuth, async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!req.body.name || !username || password.length < 8) {
      return res.status(400).json({
        error: "姓名、帳號必填，密碼至少 8 個字元"
      });
    }

    const existing = await getDriverByUsername(username);

    if (existing) {
      return res.status(409).json({ error: "司機帳號已存在" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const allowedRoles = ["driver", "dispatcher", "manager"];
    const memberRole = allowedRoles.includes(req.body.memberRole)
      ? req.body.memberRole
      : "driver";
    const vehicleId = req.body.vehicleId ? Number(req.body.vehicleId) : null;
    const assignedVehicle = vehicleId ? await getVehicleById(vehicleId) : null;

    if (assignedVehicle && !assignedVehicle.is_active) {
      return res.status(409).json({ error: "無法指派已停用的車輛" });
    }

    const driver = await createDriver({
      name: req.body.name,
      username,
      password_hash: passwordHash,
      phone: req.body.phone || null,
      plate: assignedVehicle?.plate || null,
      vehicle: assignedVehicle?.model || null,
      vehicle_id: assignedVehicle?.id || null,
      member_role: memberRole,
      status: "available",
      is_active: true
    });

    await createAuditLog({ actor_type: "admin", action: "member.create", entity_type: "driver", entity_id: String(driver.id), details: { username, member_role: memberRole } });

    res.json({
      id: driver.id,
      name: driver.name,
      username: driver.username,
      phone: driver.phone,
      plate: driver.plate,
      vehicle: driver.vehicle,
      vehicle_id: driver.vehicle_id,
      member_role: driver.member_role,
      status: driver.status,
      is_active: driver.is_active
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/drivers/:id/vehicle", adminAuth, async (req, res) => {
  try {
    const driver = await getDriverById(Number(req.params.id));
    const vehicleId = req.body.vehicleId ? Number(req.body.vehicleId) : null;
    const vehicle = vehicleId ? await getVehicleById(vehicleId) : null;

    if (vehicle && !vehicle.is_active) {
      return res.status(409).json({ error: "無法指派已停用的車輛" });
    }

    const updated = await updateDriver(driver.id, {
      vehicle_id: vehicle?.id || null,
      plate: vehicle?.plate || null,
      vehicle: vehicle?.model || null
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/drivers/:id/toggle", adminAuth, async (req, res) => {
  try {
    const driver = await getDriverById(Number(req.params.id));

    const updated = await updateDriver(driver.id, {
      is_active: !driver.is_active,
      status: driver.is_active ? "offline" : "available"
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/orders/:id/assign", adminAuth, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const driverId = Number(req.body.driverId);
    if (!Number.isInteger(orderId) || !Number.isInteger(driverId)) {
      return res.status(400).json({ error: "訂單或司機資料格式不正確，請重新整理後再派單" });
    }

    const order = await getOrder(orderId);

    if (order.status !== "pending") {
      return res.status(409).json({ error: "只有待接單可以派單" });
    }

    const driver = await getDriverById(driverId);

    if (!driver || !driver.is_active) {
      return res.status(404).json({ error: "找不到可用司機" });
    }

    const updated = await claimOrder(
      order.id,
      driver.id,
      Number(req.body.finalFare || order.estimated_fare)
    );

    await createAuditLog({ actor_type: "admin", action: "order.assign", entity_type: "order", entity_id: String(order.id), details: { driver_id: driver.id, final_fare: updated.final_fare } });

    await notifyCustomer(updated, "accept");

    res.json(updated);
  } catch (error) {
    if (sendClaimError(res, error)) return;
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/orders/:id/action", adminAuth, async (req, res) => {
  try {
    const order = await getOrder(Number(req.params.id));
    const action = req.body.action;
    let values = {};

    if (action === "complete") {
      values = {
        status: "completed",
        completed_at: new Date().toISOString()
      };
    } else if (action === "cancel") {
      values = {
        status: "cancelled",
        cancelled_at: new Date().toISOString()
      };
    } else {
      return res.status(400).json({ error: "未知操作" });
    }

    const updated = await updateOrder(order.id, values);

    await createAuditLog({ actor_type: "admin", action: `order.${action}`, entity_type: "order", entity_id: String(order.id), details: values });

    if (order.assigned_driver_id) {
      await updateDriver(order.assigned_driver_id, { status: "available" });
    }

    await notifyCustomer(updated, action);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/admin/orders/:id/fare", adminAuth, async (req, res) => {
  try {
    const amount = Number(req.body.finalFare);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: "車資格式不正確" });
    }
    const updated = await updateOrder(Number(req.params.id), { final_fare: Math.round(amount) });
    await createAuditLog({ actor_type: "admin", action: "order.fare.update", entity_type: "order", entity_id: String(updated.id), details: { final_fare: updated.final_fare } });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/settings", adminAuth, async (_req, res) => {
  try {
    res.json(await listSettings());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/admin/settings", adminAuth, async (req, res) => {
  try {
    const allowed = new Set([
      "fleet_name", "base_fare", "per_km", "per_minute", "default_toll",
      "night_surcharge", "line_welcome_message", "ignored_keywords", "receipt_prefix"
    ]);
    const entries = Object.entries(req.body || {}).filter(([key]) => allowed.has(key));

    if (!entries.length) return res.status(400).json({ error: "沒有可更新的設定" });

    for (const [key, value] of entries) await updateSetting(key, value);
    await createAuditLog({
      actor_type: "admin", action: "settings.update", entity_type: "settings",
      details: Object.fromEntries(entries)
    });
    res.json(await listSettings());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/customers", adminAuth, async (_req, res) => {
  try {
    res.json(await listCustomers());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/admin/customers/:id", adminAuth, async (req, res) => {
  try {
    const allowedTypes = ["regular", "vip", "blacklist"];
    if (!allowedTypes.includes(req.body.customer_type)) {
      return res.status(400).json({ error: "客戶類型不正確" });
    }
    const customer = await updateCustomer(Number(req.params.id), {
      name: String(req.body.name || "").trim() || null,
      phone: String(req.body.phone || "").trim() || null,
      customer_type: req.body.customer_type,
      notes: String(req.body.notes || "").trim() || null
    });
    await createAuditLog({ actor_type: "admin", action: "customer.update", entity_type: "customer", entity_id: String(customer.id), details: req.body });
    res.json(customer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/orders/:id/payment", adminAuth, async (req, res) => {
  try {
    const order = await getOrder(Number(req.params.id));
    const method = String(req.body.method || "");
    if (!["cash", "line_pay"].includes(method)) {
      return res.status(400).json({ error: "付款方式不正確" });
    }
    const amount = Number(req.body.amount || order.final_fare || order.estimated_fare || 0);
    const payment = await createPayment({ order_id: order.id, method, amount, status: "paid", transaction_ref: req.body.transactionRef || null, recorded_by: "admin" });
    await updateOrder(order.id, { payment_method: method, payment_status: "paid", paid_at: new Date().toISOString() });
    const settings = await listSettings();
    const receipt = await createReceipt({
      order_id: order.id,
      receipt_no: `${settings.receipt_prefix || "OTZR"}-${String(order.id).padStart(8, "0")}`,
      amount,
      payment_method: method
    });
    await createAuditLog({ actor_type: "admin", action: "payment.record", entity_type: "order", entity_id: String(order.id), details: { method, amount } });
    res.json({ payment, receipt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/orders/:id/receipt", adminAuth, async (req, res) => {
  try {
    const receipt = await getReceiptByOrderId(Number(req.params.id));
    if (!receipt) return res.status(404).json({ error: "尚未開立收據" });
    res.json(receipt);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/orders/:id/rebook", adminAuth, async (req, res) => {
  try {
    const source = await getOrder(Number(req.params.id));
    const schedule = classifyRideSchedule(req.body.rideTime);
    const duplicate = await createOrder({
      customer_line_id: source.customer_line_id,
      customer_phone: source.customer_phone,
      pickup: source.pickup,
      destination: source.destination,
      ride_time: req.body.rideTime || null,
      is_reservation: schedule.isReservation,
      scheduled_at: schedule.scheduledAt,
      passengers: source.passengers,
      pickup_latitude: source.pickup_latitude,
      pickup_longitude: source.pickup_longitude,
      distance_km: source.distance_km,
      duration_min: source.duration_min,
      base_fare: source.base_fare,
      mileage_fare: source.mileage_fare,
      time_fare: source.time_fare,
      toll: source.toll,
      night_surcharge: source.night_surcharge,
      estimated_fare: source.estimated_fare,
      in_service_area: source.in_service_area,
      status: "pending"
    });
    await createAuditLog({ actor_type: "admin", action: "order.rebook", entity_type: "order", entity_id: String(duplicate.id), details: { source_order_id: source.id } });
    res.status(201).json(duplicate);
  } catch (error) {
    if (["INVALID_RIDE_TIME", "RIDE_TIME_EXPIRED"].includes(error.code)) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/admin/audit-logs", adminAuth, async (_req, res) => {
  try {
    res.json(await listAuditLogs());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/driver/me", driverJwtAuth, async (req, res) => {
  try {
    const driver = await getDriverById(req.driver.driverId);

    res.json({
      id: driver.id,
      name: driver.name,
      username: driver.username,
      phone: driver.phone,
      plate: driver.plate,
      vehicle: driver.vehicle,
      vehicle_id: driver.vehicle_id,
      member_role: driver.member_role,
      status: driver.status,
      is_active: driver.is_active
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/driver/location", driverJwtAuth, async (req, res) => {
  try {
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);
    const accuracy = Number(req.body.accuracy);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ error: "無法取得有效的 GPS 定位" });
    }
    if (latitude < 21.75 || latitude > 25.35 || longitude < 120 || longitude > 122) {
      return res.status(400).json({ error: "司機目前位置不在台灣本島範圍" });
    }
    if (Number.isFinite(accuracy) && accuracy > 1000) {
      return res.status(400).json({ error: "GPS 定位誤差過大，請移至訊號較佳處" });
    }

    const updated = await updateDriver(req.driver.driverId, {
      current_latitude: latitude,
      current_longitude: longitude,
      last_location_at: new Date().toISOString()
    });
    res.json({
      latitude: updated.current_latitude,
      longitude: updated.current_longitude,
      last_location_at: updated.last_location_at
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/driver/orders", driverJwtAuth, async (req, res) => {
  try {
    const orders = await listOrders();
    const driver = await getDriverById(req.driver.driverId);
    const ownOrders = orders.filter(order =>
      order.status === "accepted" &&
      Number(order.assigned_driver_id) === Number(driver.id)
    );
    const pendingOrders = orders.filter(order => order.status === "pending");
    const nearbyOrders = await filterNearbyPickupOrders(driver, pendingOrders);
    const visible = [...ownOrders, ...nearbyOrders];

    res.json(visible);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/driver/orders/:id/claim", driverJwtAuth, async (req, res) => {
  try {
    const order = await getOrder(Number(req.params.id));

    if (order.status !== "pending") {
      return res.status(409).json({ error: "訂單已被接走" });
    }

    const driver = await getDriverById(req.driver.driverId);

    if (!driver.is_active) {
      return res.status(403).json({ error: "司機帳號已停用" });
    }

    const nearby = await filterNearbyPickupOrders(driver, [order], { bypassCache: true });
    if (!nearby.length) {
      return res.status(409).json({
        error: "此訂單距離目前位置超過 20 分鐘，或 GPS 定位已失效，無法接單"
      });
    }

    const updated = await claimOrder(order.id, driver.id, order.estimated_fare);

    await createAuditLog({ actor_type: "driver", actor_id: String(driver.id), action: "order.claim", entity_type: "order", entity_id: String(order.id), details: {} });

    await notifyCustomer(updated, "accept");

    res.json(updated);
  } catch (error) {
    if (sendClaimError(res, error)) return;
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/driver/orders/:id/action", driverJwtAuth, async (req, res) => {
  try {
    const order = await getOrder(Number(req.params.id));

    if (Number(order.assigned_driver_id) !== Number(req.driver.driverId)) {
      return res.status(403).json({ error: "這不是您的訂單" });
    }

    if (order.status !== "accepted") {
      return res.status(409).json({ error: "只有已接單訂單可以操作" });
    }

    const action = req.body.action;
    let values = {};

    if (action === "start") {
      values = { started_at: new Date().toISOString() };
    } else if (action === "complete") {
      values = {
        status: "completed",
        completed_at: new Date().toISOString()
      };
    } else {
      return res.status(400).json({ error: "未知操作" });
    }

    const updated = await updateOrder(order.id, values);

    await createAuditLog({ actor_type: "driver", actor_id: String(req.driver.driverId), action: `order.${action}`, entity_type: "order", entity_id: String(order.id), details: values });

    if (action === "complete") {
      await updateDriver(req.driver.driverId, { status: "available" });
    }

    await notifyCustomer(updated, action);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/driver/status", driverJwtAuth, async (req, res) => {
  try {
    const allowed = ["available", "busy", "offline"];
    const status = String(req.body.status || "");

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "狀態不正確" });
    }

    const updated = await updateDriver(req.driver.driverId, { status });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function filterNearbyPickupOrders(driver, orders, { bypassCache = false } = {}) {
  const latitude = Number(driver.current_latitude);
  const longitude = Number(driver.current_longitude);
  const locatedAt = Date.parse(driver.last_location_at || "");
  const locationIsFresh = Number.isFinite(latitude) && Number.isFinite(longitude) &&
    Number.isFinite(locatedAt) && Date.now() - locatedAt <= LOCATION_MAX_AGE_MS;

  if (!locationIsFresh) return [];

  const results = await Promise.all(orders.slice(0, 100).map(async order => {
    const pickupLatitude = Number(order.pickup_latitude);
    const pickupLongitude = Number(order.pickup_longitude);

    // Orders created before GPS coordinates were stored are not sent to
    // drivers automatically. This avoids an extra Geocoding API request.
    if (!Number.isFinite(pickupLatitude) || !Number.isFinite(pickupLongitude)) {
      return null;
    }

    // About 1.1 km buckets prevent a moving phone from creating a fresh API
    // request every few metres.
    const roundedLat = latitude.toFixed(2);
    const roundedLng = longitude.toFixed(2);
    const cacheKey = `${order.id}:${roundedLat}:${roundedLng}`;
    const cached = pickupEtaCache.get(cacheKey);
    let eta;

    if (!bypassCache && cached && Date.now() - cached.createdAt < ETA_CACHE_MS) {
      eta = cached.value;
    } else {
      try {
        const pickup = {
          latitude: pickupLatitude,
          longitude: pickupLongitude
        };
        eta = await getPickupEtaMinutes(
          latitude,
          longitude,
          pickup,
          process.env.GOOGLE_MAPS_API_KEY
        );
        pickupEtaCache.set(cacheKey, { value: eta, createdAt: Date.now() });
      } catch (error) {
        console.error(`Pickup ETA failed for order ${order.id}:`, error.message);
        return null;
      }
    }

    if (eta.durationMin > PICKUP_ETA_LIMIT_MINUTES) return null;
    return {
      ...order,
      pickup_eta_minutes: Math.ceil(eta.durationMin),
      pickup_distance_km: Number(eta.distanceKm.toFixed(1))
    };
  }));

  // Prevent an unbounded in-memory cache on long-running Railway instances.
  if (pickupEtaCache.size > 2000) {
    for (const [key, item] of pickupEtaCache) {
      if (Date.now() - item.createdAt > ETA_CACHE_MS) pickupEtaCache.delete(key);
    }
  }
  return results.filter(Boolean);
}

async function notifyCustomer(order, action) {
  if (!order.customer_line_id) return;

  let text = "";

  if (action === "accept") {
    text =
      `✅ 司機已接單\n訂單：${orderNo(order.id)}\n` +
      `司機：${order.driver_name || "OTZ車隊"}\n` +
      `${order.driver_phone ? `電話：${order.driver_phone}\n` : ""}` +
      `${order.driver_plate ? `車牌：${order.driver_plate}\n` : ""}` +
      `${order.destination === "尚未提供"
        ? "車資：待確認"
        : `確認車資：${order.final_fare || order.estimated_fare} 元`}`;
  } else if (action === "start") {
    text =
      `🚖 行程已開始\n訂單：${orderNo(order.id)}\n` +
      `祝您一路平安。`;
  } else if (action === "complete") {
    text =
      `✅ 行程已完成\n訂單：${orderNo(order.id)}\n` +
      `感謝使用 OTZ 車隊。`;
  } else if (action === "cancel") {
    text = `訂單 ${orderNo(order.id)} 已取消。`;
  }

  if (text) {
    await line.pushMessage({
      to: order.customer_line_id,
      messages: [{ type: "text", text: normalizeLineText(text) }]
    });
  }
}

function reply(replyToken, text) {
  return line.replyMessage({
    replyToken,
    messages: [{ type: "text", text: normalizeLineText(text) }]
  });
}

function normalizeLineText(value) {
  return String(value ?? "")
    .replace(/\\+r\\+n/g, "\n")
    .replace(/\\+n/g, "\n");
}

function sendClaimError(res, error) {
  const message = String(error?.message || "");
  if (message.includes("DRIVER_HAS_ACTIVE_ORDER")) {
    res.status(409).json({ error: "同一時間只能進行一張一般訂單；請先完成目前訂單" });
    return true;
  }
  if (message.includes("DRIVER_HAS_IMMINENT_RESERVATION")) {
    res.status(409).json({ error: "已有預約單即將開始，上車時間前 30 分鐘禁止再接單" });
    return true;
  }
  if (message.includes("ORDER_NOT_PENDING")) {
    res.status(409).json({ error: "訂單已被其他司機接走" });
    return true;
  }
  if (message.includes("DRIVER_NOT_AVAILABLE")) {
    res.status(409).json({ error: "司機目前無法接單" });
    return true;
  }
  return false;
}

function adminAuth(req, res, next) {
  if (req.get("x-admin-token") !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "未授權" });
  }
  next();
}

function driverJwtAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    return res.status(401).json({ error: "請重新登入" });
  }

  try {
    req.driver = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "登入已過期，請重新登入" });
  }
}

app.listen(port, "0.0.0.0", () => {
  console.log(`OTZ V5.3.6 listening on ${port}`);
});
