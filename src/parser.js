const CHINESE_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

export function parseRideRequest(text) {
  const normalized = String(text || "")
    .replace(/[，、；]/g, ",")
    .replace(/[→➡➜]/g, "到")
    .replace(/--?>/g, "到")
    .replace(/\s+/g, " ")
    .trim();

  const rideTime = extractRideTime(normalized);
  const passengers = extractPassengerCount(normalized);
  let routeText = normalized;
  if (rideTime) routeText = routeText.replace(rideTime, " ");
  routeText = removePassengerText(routeText)
    .replace(/(?:要\s*)?[一二兩三四五六七八九十\d]+\s*台車/gu, " ")
    .replace(/^我要叫車\s*[,：:]*/u, "")
    .replace(/^叫車\s*[,：:]*/u, "")
    .replace(/\s+/g, " ")
    .replace(/^[,\/;:：\s]+|[,\/;:：\s]+$/g, "")
    .trim();

  let pickup = "";
  let destination = "";
  const labeled = routeText.match(/(?:從|上車(?:地點)?)[：:\s]*(.+?)\s*(?:到|至|前往|下車(?:地點)?)[：:\s]*(.+)$/u);
  const route = labeled || routeText.match(/^(.+?)\s*(?:到|至|前往)\s*(.+)$/u);
  if (route) {
    pickup = cleanPlace(route[1]);
    destination = cleanPlace(route[2]);
  } else if (routeText) {
    // 「我要叫車＋單一地點」視為只有上車地點，仍可派單。
    pickup = cleanPlace(routeText.replace(/^(?:從|上車(?:地點)?)[：:\s]*/u, ""));
  }

  return { pickup, destination, passengers, rideTime };
}

export function parseScheduledAt(rideTime, now = new Date()) {
  const text = String(rideTime || "").trim();
  if (!text) return null;
  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  let year = taipeiNow.getUTCFullYear();
  let month = taipeiNow.getUTCMonth() + 1;
  let day = taipeiNow.getUTCDate();
  let explicitDate = false;
  let explicitYear = false;

  let dateMatch = text.match(/(?:(\d{4})[\/-])?(\d{1,2})[\/-](\d{1,2})/);
  if (!dateMatch) dateMatch = text.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?/);
  if (dateMatch) {
    if (dateMatch[1]) { year = Number(dateMatch[1]); explicitYear = true; }
    month = Number(dateMatch[2]);
    day = Number(dateMatch[3]);
    explicitDate = true;
  }

  const base = new Date(Date.UTC(year, month - 1, day));
  if (!explicitDate) {
    if (text.includes("大後天")) base.setUTCDate(base.getUTCDate() + 3);
    else if (text.includes("後天")) base.setUTCDate(base.getUTCDate() + 2);
    else if (text.includes("明天")) base.setUTCDate(base.getUTCDate() + 1);
  }

  const clock = parseClock(text);
  if (!clock) return null;
  let { hour, minute } = clock;
  if (/(下午|晚上)/.test(text) && hour < 12) hour += 12;
  if (/凌晨/.test(text) && hour === 12) hour = 0;
  if (/中午/.test(text) && hour < 11) hour += 12;

  let scheduled = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour - 8, minute));
  if (Number.isNaN(scheduled.getTime())) return null;
  if (explicitDate && !explicitYear && scheduled.getTime() < now.getTime() - 30 * 60 * 1000) {
    scheduled = new Date(Date.UTC(base.getUTCFullYear() + 1, base.getUTCMonth(), base.getUTCDate(), hour - 8, minute));
  }
  if (!explicitDate && !/(今天|明天|後天|大後天)/.test(text) && scheduled.getTime() < now.getTime() - 30 * 60 * 1000) {
    scheduled = new Date(scheduled.getTime() + 24 * 60 * 60 * 1000);
  }
  return scheduled.toISOString();
}

export function classifyRideSchedule(rideTime, now = new Date()) {
  if (!String(rideTime || "").trim()) return { scheduledAt: null, isReservation: false };
  const scheduledAt = parseScheduledAt(rideTime, now);
  if (!scheduledAt) throw rideTimeError("INVALID_RIDE_TIME", "無法辨識上車時間，請重新輸入日期與時間。");
  const deltaMs = Date.parse(scheduledAt) - now.getTime();
  if (deltaMs < -30 * 60 * 1000) throw rideTimeError("RIDE_TIME_EXPIRED", "上車時間已超過現在 30 分鐘，請重新輸入。");
  return { scheduledAt, isReservation: deltaMs > 30 * 60 * 1000 };
}

export function isGroupRideRequest(text, parsed) {
  if (!parsed?.pickup) return false;
  const compact = String(text || "").replace(/\s+/g, "").trim();
  if (!compact || compact.length > 160) return false;
  const explicitIntent = hasRideIntent(compact);
  if (!parsed.destination) {
    return !containsUnsupportedArea(parsed.pickup) && isLikelyLocation(parsed.pickup);
  }
  if (!/(?:到|至|前往|→|➡|->)/.test(compact)) return false;
  if (isPlaceholderPlace(parsed.pickup) || isPlaceholderPlace(parsed.destination)) return false;
  if (containsUnsupportedArea(`${parsed.pickup} ${parsed.destination}`)) return false;
  return explicitIntent || isLikelyLocation(parsed.pickup) || isLikelyLocation(parsed.destination);
}

export function hasRideIntent(text) {
  return /我要叫車|幫我叫車|叫車|要\s*[一二兩三四五六七八九十\d]+\s*台車|需要\s*[一二兩三四五六七八九十\d]*\s*台車/u.test(String(text || ""));
}

export function isPlaceholderPlace(value) {
  const text = String(value || "").replace(/\s+/g, "");
  if (!text) return true;
  if (/^(?:我家|你家|他家|她家|自己家|朋友家|客人家|乘客家|某某家)$/u.test(text)) return true;
  return text !== "全家" && /^[\p{Script=Han}A-Za-z0-9]{1,12}家$/u.test(text);
}

export function containsUnsupportedArea(value) {
  const text = String(value || "").replace(/\s+/g, "");
  return /東京|大阪|京都|北海道|沖繩|日本|韓國|首爾|釜山|中國|香港|澳門|新加坡|馬來西亞|泰國|越南|菲律賓|美國|加拿大|歐洲|迪士尼|金門|澎湖|馬祖|綠島|蘭嶼|小琉球/u.test(text);
}

function isLikelyLocation(value) {
  const text = String(value || "").replace(/\s+/g, "");
  if (!text || isPlaceholderPlace(text)) return false;
  const known = /東港|林邊|潮州|佳冬|枋寮|屏東|高雄|左營|三民|小港|鳳山|苓雅|前鎮|楠梓|鼓山|鹽埕|旗津|岡山|高醫|長庚|榮總|夢時代|東山|星光|大東港/u;
  const address = /(?:縣|市|區|鄉|鎮|村|里|路|街|大道|巷|弄|號)/u;
  const poi = /(?:醫院|診所|車站|高鐵|機場|碼頭|漁港|港口|KTV|ktv|釣蝦場|學校|大學|宮|廟|市場|夜市|飯店|旅館|民宿|餐廳|超商|便利商店|銀行|郵局|分局|分駐所|派出所|公園|館|店|中心)/u;
  return known.test(text) || address.test(text) || poi.test(text);
}

function extractRideTime(text) {
  const patterns = [
    /(?:\d{4}[\/-])?\d{1,2}[\/-]\d{1,2}\s*(?:凌晨|早上|上午|中午|下午|晚上)?\s*(?:\d{1,2}(?::\d{1,2}|點(?:半|\d{1,2}分?)?)|[零〇一二兩三四五六七八九十]{1,3}點(?:半|[零〇一二兩三四五六七八九十]{1,3}分?)?)/,
    /(?:\d{4}年)?\d{1,2}月\d{1,2}日?\s*(?:凌晨|早上|上午|中午|下午|晚上)?\s*(?:\d{1,2}(?::\d{1,2}|點(?:半|\d{1,2}分?)?)|[零〇一二兩三四五六七八九十]{1,3}點(?:半|[零〇一二兩三四五六七八九十]{1,3}分?)?)/,
    /(?:今天|明天|後天|大後天)\s*(?:凌晨|早上|上午|中午|下午|晚上)?\s*(?:\d{1,2}(?::\d{1,2}|點(?:半|\d{1,2}分?)?)|[零〇一二兩三四五六七八九十]{1,3}點(?:半|[零〇一二兩三四五六七八九十]{1,3}分?)?)/,
    /(?:凌晨|早上|上午|中午|下午|晚上)\s*(?:\d{1,2}(?::\d{1,2}|點(?:半|\d{1,2}分?)?)|[零〇一二兩三四五六七八九十]{1,3}點(?:半|[零〇一二兩三四五六七八九十]{1,3}分?)?)/,
    /\b\d{1,2}:\d{2}\b/
  ];
  for (const pattern of patterns) {
    const match = String(text).match(pattern);
    if (match) return match[0].trim();
  }
  return "";
}

function parseClock(text) {
  let match = String(text).match(/(\d{1,2}):(\d{2})/);
  if (match) return validClock(Number(match[1]), Number(match[2]));
  match = String(text).match(/(\d{1,2})點(?:\s*(半|\d{1,2})分?)?/);
  if (match) return validClock(Number(match[1]), match[2] === "半" ? 30 : Number(match[2] || 0));
  match = String(text).match(/([零〇一二兩三四五六七八九十]{1,3})點(?:\s*(半|[零〇一二兩三四五六七八九十]{1,3})分?)?/);
  if (match) return validClock(chineseNumber(match[1]), match[2] === "半" ? 30 : match[2] ? chineseNumber(match[2]) : 0);
  return null;
}

function validClock(hour, minute) {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}

function chineseNumber(value) {
  const text = String(value || "");
  if (text === "十") return 10;
  if (text.includes("十")) {
    const [tens, ones] = text.split("十");
    return (tens ? CHINESE_DIGITS[tens] : 1) * 10 + (ones ? CHINESE_DIGITS[ones] : 0);
  }
  return Number([...text].map(char => CHINESE_DIGITS[char]).join(""));
}

function cleanPlace(value) {
  return String(value || "")
    .replace(/^(?:從|上車(?:地點)?)[：:\s]*/u, "")
    .replace(/^(?:到|至|前往|下車(?:地點)?)[：:\s]*/u, "")
    .replace(/^[,\/;:：\s]+|[,\/;:：\s]+$/g, "")
    .trim();
}

function extractPassengerCount(text) {
  const source = String(text || "");
  let match = source.match(/([零〇一二兩三四五六七八九十\d]+)\s*大\s*([零〇一二兩三四五六七八九十\d]+)\s*小/u);
  if (match) return toCount(match[1]) + toCount(match[2]);
  match = source.match(/(?:人數|乘客)[：:\s]*([零〇一二兩三四五六七八九十\d]+)\s*(?:位|個人|人)?/u);
  if (match) return toCount(match[1]);
  match = source.match(/([零〇一二兩三四五六七八九十\d]+)\s*(?:位|個人|人)(?:乘客)?/u);
  return match ? toCount(match[1]) : null;
}

function removePassengerText(text) {
  return String(text || "")
    .replace(/[零〇一二兩三四五六七八九十\d]+\s*大\s*[零〇一二兩三四五六七八九十\d]+\s*小/gu, " ")
    .replace(/(?:人數|乘客)[：:\s]*[零〇一二兩三四五六七八九十\d]+\s*(?:位|個人|人)?/gu, " ")
    .replace(/[零〇一二兩三四五六七八九十\d]+\s*(?:位|個人|人)(?:乘客)?/gu, " ");
}

function toCount(value) {
  const count = /^\d+$/.test(String(value)) ? Number(value) : chineseNumber(value);
  return Number.isInteger(count) && count > 0 && count <= 99 ? count : null;
}

function rideTimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
