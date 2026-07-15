const DATE_TIME_PATTERNS = [
  /(?:\d{4}[\/-])?\d{1,2}[\/-]\d{1,2}\s*(?:凌晨|早上|上午|中午|下午|晚上)?\s*(?:\d{1,2}(?::\d{1,2}|點(?:半|\d{1,2}分?)?)|[零〇一二兩三四五六七八九十]{1,3}(?:點|時)(?:半|[零〇一二兩三四五六七八九十]{1,3}分?)?)/,
  /(?:\d{4}年)?\d{1,2}月\d{1,2}日\s*(?:凌晨|早上|上午|中午|下午|晚上)?\s*(?:\d{1,2}(?::\d{1,2}|點(?:半|\d{1,2}分?)?)|[零〇一二兩三四五六七八九十]{1,3}(?:點|時)(?:半|[零〇一二兩三四五六七八九十]{1,3}分?)?)/,
  /(?:大後天|今天|明天|後天|本週[日一二三四五六]|下週[日一二三四五六]|星期[日天一二三四五六]|週[日天一二三四五六])\s*(?:凌晨|早上|上午|中午|下午|晚上)?\s*(?:\d{1,2}(?::\d{1,2}|點(?:半|\d{1,2}分?)?)|[零〇一二兩三四五六七八九十]{1,3}(?:點|時)(?:半|[零〇一二兩三四五六七八九十]{1,3}分?)?)/,
  /(?:凌晨|早上|上午|中午|下午|晚上)\s*(?:\d{1,2}(?::\d{1,2}|點(?:半|\d{1,2}分?)?)|[零〇一二兩三四五六七八九十]{1,3}(?:點|時)(?:半|[零〇一二兩三四五六七八九十]{1,3}分?)?)/,
  /\b\d{1,2}:\d{2}\b/,
  /[零〇一二兩三四五六七八九十]{1,3}(?:點|時)(?:半|[零〇一二兩三四五六七八九十]{1,3}分?)?/
];

export function parseRideRequest(text) {
  const normalized = String(text || "")
    .replace(/[➡➜➔⟶]/g, "→")
    .replace(/－>|--?>/g, "→")
    .replace(/\s+/g, " ")
    .trim();
  const rideTime = extractRideTime(normalized);
  let routeText = rideTime ? normalized.replace(rideTime, " ") : normalized;
  routeText = routeText
    .replace(/^我要叫車[，,、:：\s]*/u, "")
    .replace(/\d+\s*(?:位|人|名)/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\/，,、；;:：\s]+|[\/，,、；;:：\s]+$/g, "")
    .trim();

  let pickup = "", destination = "";
  const patterns = [
    /(?:從|上車(?:地點)?|出發(?:地點)?)[：:\s]*?(.+?)\s*(?:到|至|→|下車(?:地點)?|目的地)[：:\s]*?(.+)$/u,
    /^(.+?)\s*(?:到|至|→)\s*(.+)$/u
  ];
  for (const pattern of patterns) {
    const match = routeText.match(pattern);
    if (!match) continue;
    pickup = cleanPlace(match[1]);
    destination = cleanPlace(match[2]);
    break;
  }
  const passengerMatch = normalized.match(/(\d+)\s*(?:位|人|名)/u);
  return { pickup, destination, passengers: passengerMatch ? Number(passengerMatch[1]) : null, rideTime };
}

export function parseScheduledAt(rideTime, now = new Date()) {
  const text = String(rideTime || "").trim();
  if (!text) return null;
  const nowTaipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  let year = nowTaipei.getUTCFullYear(), month = nowTaipei.getUTCMonth() + 1, day = nowTaipei.getUTCDate();
  let hasExplicitDate = false, hasExplicitYear = false;
  let match = text.match(/(?:(\d{4})[\/-])?(\d{1,2})[\/-](\d{1,2})/);
  if (match) {
    if (match[1]) { year = Number(match[1]); hasExplicitYear = true; }
    month = Number(match[2]); day = Number(match[3]); hasExplicitDate = true;
  } else {
    match = text.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
    if (match) {
      if (match[1]) { year = Number(match[1]); hasExplicitYear = true; }
      month = Number(match[2]); day = Number(match[3]); hasExplicitDate = true;
    }
  }
  const baseDate = new Date(Date.UTC(year, month - 1, day));
  if (!hasExplicitDate) {
    if (text.includes("大後天")) baseDate.setUTCDate(baseDate.getUTCDate() + 3);
    else if (text.includes("後天")) baseDate.setUTCDate(baseDate.getUTCDate() + 2);
    else if (text.includes("明天")) baseDate.setUTCDate(baseDate.getUTCDate() + 1);
    else {
      const weekdayMatch = text.match(/(下週|本週|星期|週)([日天一二三四五六])/);
      if (weekdayMatch) {
        const weekdays = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
        let days = (weekdays[weekdayMatch[2]] - baseDate.getUTCDay() + 7) % 7;
        if (weekdayMatch[1] === "下週") days += 7;
        else if (days === 0 && weekdayMatch[1] !== "本週") days = 7;
        baseDate.setUTCDate(baseDate.getUTCDate() + days);
      }
    }
  }
  const time = parseClock(text);
  if (!time) return null;
  let { hour, minute } = time;
  if (/(下午|晚上)/.test(text) && hour < 12) hour += 12;
  if (/凌晨/.test(text) && hour === 12) hour = 0;
  if (/中午/.test(text) && hour < 11) hour += 12;
  let scheduled = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate(), hour - 8, minute));
  if (Number.isNaN(scheduled.getTime())) return null;
  if (hasExplicitDate && !hasExplicitYear && scheduled.getTime() < now.getTime() - 30 * 60 * 1000) {
    scheduled = new Date(Date.UTC(baseDate.getUTCFullYear() + 1, baseDate.getUTCMonth(), baseDate.getUTCDate(), hour - 8, minute));
  }
  if (!hasExplicitDate && !/(今天|明天|後天|大後天|本週|下週|星期|週)/.test(text) && scheduled.getTime() < now.getTime() - 30 * 60 * 1000) {
    scheduled = new Date(scheduled.getTime() + 24 * 60 * 60 * 1000);
  }
  return scheduled.toISOString();
}

export function classifyRideSchedule(rideTime, now = new Date()) {
  if (!String(rideTime || "").trim()) return { scheduledAt: null, isReservation: false };
  const scheduledAt = parseScheduledAt(rideTime, now);
  if (!scheduledAt) throw rideTimeError("INVALID_RIDE_TIME", "無法辨識上車時間，請重新輸入完整日期與時間。");
  const deltaMs = Date.parse(scheduledAt) - now.getTime();
  if (deltaMs < -30 * 60 * 1000) throw rideTimeError("RIDE_TIME_EXPIRED", "上車時間已經超過30分鐘，請重新輸入新的上車時間。");
  return { scheduledAt, isReservation: deltaMs > 30 * 60 * 1000 };
}

export function isGroupRideRequest(text, parsed) {
  if (!parsed?.pickup || !parsed?.destination) return false;
  const compact = String(text || "").replace(/\s+/g, "").trim();
  if (!compact || compact.length > 120) return false;
  const explicitIntent = /(我要叫車|叫車|上車|下車|出發|目的地|接送)/.test(compact);
  const routeShape = /(?:到|至|→|➡️|->)/.test(compact);
  if (!explicitIntent && !routeShape) return false;
  if (!explicitIntent && /[了嗎呢喔哦吧啦]$/.test(compact)) return false;
  return parsed.pickup.length >= 2 && parsed.destination.length >= 2;
}

function extractRideTime(text) {
  for (const pattern of DATE_TIME_PATTERNS) {
    const match = String(text).match(pattern);
    if (match) return match[0].trim();
  }
  return "";
}

function parseClock(text) {
  let match = String(text).match(/(\d{1,2}):(\d{2})/);
  if (match) {
    const hour = Number(match[1]), minute = Number(match[2]);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
  }
  match = String(text).match(/(\d{1,2})(?:點|時)(半|\d{1,2}分?)?/);
  if (match) {
    const hour = Number(match[1]);
    const minute = match[2] === "半" ? 30 : Number(String(match[2] || "0").replace("分", ""));
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
  }
  match = String(text).match(/([零〇一二兩三四五六七八九十]{1,3})(?:點|時)(半|[零〇一二兩三四五六七八九十]{1,3}分?)?/);
  if (match) {
    const hour = chineseNumber(match[1]);
    const minute = match[2] === "半" ? 30 : match[2] ? chineseNumber(match[2].replace("分", "")) : 0;
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
  }
  match = String(text).match(/(?:凌晨|早上|上午|中午|下午|晚上)\s*(\d{1,2})(?:點|時)?(?:\s*(\d{1,2})分?)?/);
  if (match) {
    const hour = Number(match[1]), minute = Number(match[2] || 0);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
  }
  return null;
}

function chineseNumber(value) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const text = String(value || "");
  if (text === "十") return 10;
  if (text.includes("十")) {
    const [tens, ones] = text.split("十");
    return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  }
  return Number([...text].map(char => digits[char]).join(""));
}

function cleanPlace(value) {
  return String(value || "")
    .replace(/^(?:從|上車(?:地點)?|出發(?:地點)?)[：:\s]*/u, "")
    .replace(/^(?:到|至|→|下車(?:地點)?|目的地)[：:\s]*/u, "")
    .replace(/^[\/，,、；;:：\s]+|[\/，,、；;:：\s]+$/g, "")
    .trim();
}

function rideTimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
