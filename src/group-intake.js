import { parseRideRequest } from "./parser.js";

const DEFAULT_GROUP = "C24304391da7434a2bc0ff5d1dd8c9413";

export function formatIntakeDispatch(order) {
  if (order.ride_details !== "百回+30") return null;
  return [
    `訂單：01-${String(order.id).padStart(5, "0")}`,
    "60/20/2",
    `上車地點：${order.pickup}`,
    order.destination && order.destination !== "尚未提供" ? `下車地點：${order.destination}` : "",
    "百回+30"
  ].filter(Boolean).join("\n");
}
let botCache = { token: "", id: "", expiresAt: 0 };

export function isIntakeGroup(event) {
  const groups = String(process.env.LINE_INTAKE_GROUP_IDS || DEFAULT_GROUP).split(/[,\r\n]+/u).map(value => value.trim());
  return event.source?.type === "group" && groups.includes(event.source.groupId);
}

export async function getMainBotId() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return "";
  if (botCache.token === token && botCache.expiresAt > Date.now()) return botCache.id;
  const response = await fetch("https://api.line.me/v2/bot/info", {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`Main bot identity lookup failed: ${response.status}`);
  const info = await response.json();
  if (!info.userId) throw new Error("Main bot identity missing");
  botCache = { token, id: info.userId, expiresAt: Date.now() + 3600000 };
  return info.userId;
}

export function parseIntakeMention(event, mainBotId) {
  if (!isIntakeGroup(event) || !mainBotId || event.destination !== mainBotId || event.message?.type !== "text") return null;
  const mentions = event.message.mention?.mentionees || [];
  if (!mentions.some(item => item.type === "user" && item.userId === mainBotId)) return null;
  let text = String(event.message.text || "");
  const ranges = mentions.filter(item => Number.isInteger(item.index) && Number.isInteger(item.length) &&
    item.index >= 0 && item.length > 0 && item.index + item.length <= text.length).sort((a, b) => b.index - a.index);
  if (ranges.length !== mentions.length) return null;
  for (const item of ranges) text = text.slice(0, item.index) + " " + text.slice(item.index + item.length);
  if (!text.trim()) return null;
  if (text.includes("取消")) {
    const orderIds = [...text.matchAll(/01-(\d{5,})(?!\d)/gu)].map(match => Number(match[1]));
    const command = text.replace(/(?:訂單\s*[：:]?\s*)?01-\d+/gu, "").replace(/[\s：:，,。!！]/gu, "");
    return { intakeCommand: "cancel", orderId: orderIds.length === 1 ? orderIds[0] : null,
      invalid: command !== "取消" || orderIds.length > 1 };
  }
  const parsed = parseRideRequest(text.trim());
  if (!parsed.pickup) return null;
  return { ...parsed, rideDetails: "百回+30" };
}
