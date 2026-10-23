import { parseRideRequest } from "./parser.js";

const DEFAULT_GROUPS = [
  "C0b0d5b3bce8b7d9cfe8eb2e133afeafa"
];

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
  const groups = String(process.env.LINE_INTAKE_GROUP_IDS || DEFAULT_GROUPS.join(",")).split(/[,\r\n]+/u).map(value => value.trim());
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
  if (isIntakeFollowUp(text)) return null;
  const parsed = parseRideRequest(text.trim());
  if (!parsed.pickup || isIntakeFollowUp(parsed.pickup) ||
      (parsed.destination && isIntakeFollowUp(parsed.destination))) return null;
  return { ...parsed, rideDetails: "百回+30" };
}

function isIntakeFollowUp(value) {
  const text = String(value || "").normalize("NFKC").replace(/[\s\p{P}]/gu, "");
  return /^(?:(?:請問|不好意思|麻煩問一下))?(?:(?:還|現在|目前)?有(?:車|司機|人接單|人接)?(?:了)?(?:嗎|沒|沒有)|有人接(?:單)?(?:嗎|了嗎)|(?:車|司機)?(?:找到了嗎|找到了沒|還沒到嗎|到了嗎|多久到)|還在找(?:車)?嗎|還沒(?:嗎|好嗎)|可以嗎|好了嗎|好|好的|收到|了解|謝謝|謝謝你|感謝|沒關係|不用了)$/u.test(text);
}
