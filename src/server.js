import express from "express";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { middleware, messagingApi } from "@line/bot-sdk";
import { parseRideRequest } from "./parser.js";
import { getRoute } from "./maps.js";
import { calculateFare } from "./fare.js";
import { quoteFlex, orderNo } from "./messages.js";
import {
  createOrder, listOrders, getOrder, updateOrder,
  listDrivers, createDriver, updateDriver,
  getDriverByUsername, getDriverById
} from "./db.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 8080);

const line = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

app.get("/", (_req, res) => res.send("OTZ V5.0 is running"));
app.get("/health", async (_req, res) => {
  const checks = {
    app: "ok",
    version: "5.0.0",
    line: Boolean(process.env.LINE_CHANNEL_SECRET && process.env.LINE_CHANNEL_ACCESS_TOKEN),
    google_maps: Boolean(process.env.GOOGLE_MAPS_API_KEY),
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY),
    jwt: Boolean(process.env.JWT_SECRET)
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

  // 這些文字通常來自 LINE 圖文選單或其他官方帳號功能。
  // 命中時不由自訂 Bot 回覆，避免和 LINE 內建回應重複。
  const ignoredKeywords = new Set([
    "常見問題",
    "試算車資",
    "應徵司機"
  ]);

  if (ignoredKeywords.has(incomingText)) {
    console.log(`Ignored LINE keyword: ${incomingText}`);
    return;
  }

  const parsed = parseRideRequest(incomingText);

  if (!parsed.pickup || !parsed.destination) {
    return reply(
      event.replyToken,
      "請輸入：上車地點到下車地點、時間、人數\\n例如：明天早上8點，東港碼頭到左營高鐵，2位"
    );
  }

  try {
    const route = await getRoute(
      parsed.pickup,
      parsed.destination,
      process.env.GOOGLE_MAPS_API_KEY
    );

    const toll = Number(process.env.DEFAULT_TOLL || 0);
    const fare = calculateFare(route.distanceKm, route.durationMin, toll);
    const areas = String(process.env.SERVICE_AREAS || "東港,潮州,林邊,佳冬,枋寮").split(",");
    const inServiceArea = areas.some(area =>
      `${parsed.pickup} ${parsed.destination}`.includes(area.trim())
    );

    const order = await createOrder({
      customer_line_id: event.source?.userId || null,
      pickup: parsed.pickup,
      destination: parsed.destination,
      ride_time: parsed.rideTime || null,
      passengers: parsed.passengers,
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
      `✅ 叫車已確認\\n訂單：${orderNo(id)}\\n等待管理員或司機接單。`
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

    const driver = await createDriver({
      name: req.body.name,
      username,
      password_hash: passwordHash,
      phone: req.body.phone || null,
      plate: req.body.plate || null,
      vehicle: req.body.vehicle || null,
      status: "available",
      is_active: true
    });

    res.json({
      id: driver.id,
      name: driver.name,
      username: driver.username,
      phone: driver.phone,
      plate: driver.plate,
      vehicle: driver.vehicle,
      status: driver.status,
      is_active: driver.is_active
    });
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
    const order = await getOrder(Number(req.params.id));

    if (order.status !== "pending") {
      return res.status(409).json({ error: "只有待接單可以派單" });
    }

    const driver = await getDriverById(Number(req.body.driverId));

    if (!driver || !driver.is_active) {
      return res.status(404).json({ error: "找不到可用司機" });
    }

    const updated = await updateOrder(order.id, {
      status: "accepted",
      assigned_driver_id: driver.id,
      driver_name: driver.name,
      driver_phone: driver.phone,
      driver_plate: driver.plate,
      final_fare: Number(req.body.finalFare || order.estimated_fare),
      accepted_at: new Date().toISOString()
    });

    await updateDriver(driver.id, { status: "busy" });
    await notifyCustomer(updated, "accept");

    res.json(updated);
  } catch (error) {
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

    if (order.assigned_driver_id) {
      await updateDriver(order.assigned_driver_id, { status: "available" });
    }

    await notifyCustomer(updated, action);
    res.json(updated);
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
      status: driver.status,
      is_active: driver.is_active
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/driver/orders", driverJwtAuth, async (req, res) => {
  try {
    const orders = await listOrders();

    const visible = orders.filter(order =>
      order.status === "pending" ||
      (order.status === "accepted" &&
       Number(order.assigned_driver_id) === Number(req.driver.driverId))
    );

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

    const updated = await updateOrder(order.id, {
      status: "accepted",
      assigned_driver_id: driver.id,
      driver_name: driver.name,
      driver_phone: driver.phone,
      driver_plate: driver.plate,
      final_fare: order.estimated_fare,
      accepted_at: new Date().toISOString()
    });

    await updateDriver(driver.id, { status: "busy" });
    await notifyCustomer(updated, "accept");

    res.json(updated);
  } catch (error) {
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

async function notifyCustomer(order, action) {
  if (!order.customer_line_id) return;

  let text = "";

  if (action === "accept") {
    text =
      `✅ 司機已接單\\n訂單：${orderNo(order.id)}\\n` +
      `司機：${order.driver_name || "OTZ車隊"}\\n` +
      `${order.driver_phone ? `電話：${order.driver_phone}\\n` : ""}` +
      `${order.driver_plate ? `車牌：${order.driver_plate}\\n` : ""}` +
      `確認車資：${order.final_fare || order.estimated_fare} 元`;
  } else if (action === "start") {
    text =
      `🚖 行程已開始\\n訂單：${orderNo(order.id)}\\n` +
      `祝您一路平安。`;
  } else if (action === "complete") {
    text =
      `✅ 行程已完成\\n訂單：${orderNo(order.id)}\\n` +
      `感謝使用 OTZ 車隊。`;
  } else if (action === "cancel") {
    text = `訂單 ${orderNo(order.id)} 已取消。`;
  }

  if (text) {
    await line.pushMessage({
      to: order.customer_line_id,
      messages: [{ type: "text", text }]
    });
  }
}

function reply(replyToken, text) {
  return line.replyMessage({
    replyToken,
    messages: [{ type: "text", text }]
  });
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
  console.log(`OTZ V4.2 listening on ${port}`);
});
