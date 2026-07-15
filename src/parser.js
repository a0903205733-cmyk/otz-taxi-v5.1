export function parseRideRequest(text) {
  const normalized = String(text)
    .replace(/\s+/g, " ")
    .replace(/→|➡️|➡|➜|前往|到達/g, "到")
    .trim();

  let pickup = "";
  let destination = "";

  const patterns = [
    /(?:從|上車(?:地點)?[:：]?)\s*(.+?)\s*(?:到|去|下車(?:地點)?[:：]?)\s*(.+?)(?=(?:[,，。；;]|\d+\s*(?:位|人)|$))/,
    /^(.+?)\s*(?:到|去)\s*(.+?)(?=(?:[,，。；;]|\d+\s*(?:位|人)|$))/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      pickup = clean(match[1]);
      destination = clean(match[2]);
      break;
    }
  }

  const passengerMatch = normalized.match(/(\d+)\s*(?:位|人)/);
  const timeMatch = normalized.match(
    /((?:今天|明天|後天|星期[一二三四五六日天]|週[一二三四五六日天])?\s*(?:早上|上午|中午|下午|晚上|凌晨)?\s*\d{1,2}(?::\d{2})?\s*(?:點|時)?(?:半)?)/
  );

  return {
    pickup,
    destination,
    passengers: passengerMatch ? Number(passengerMatch[1]) : null,
    rideTime: timeMatch ? timeMatch[1].trim() : ""
  };
}

export function parseScheduledAt(rideTime, now = new Date()) {
  const text = String(rideTime || "").trim();
  if (!text) return null;

  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const date = new Date(Date.UTC(
    taipei.getUTCFullYear(), taipei.getUTCMonth(), taipei.getUTCDate()
  ));

  if (text.includes("明天")) date.setUTCDate(date.getUTCDate() + 1);
  else if (text.includes("後天")) date.setUTCDate(date.getUTCDate() + 2);
  else {
    const weekdayMatch = text.match(/(?:星期|週)([一二三四五六日天])/);
    if (weekdayMatch) {
      const weekdays = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
      let days = (weekdays[weekdayMatch[1]] - date.getUTCDay() + 7) % 7;
      if (days === 0) days = 7;
      date.setUTCDate(date.getUTCDate() + days);
    }
  }

  const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(?:點|時)?(半)?/);
  if (!timeMatch) return null;
  let hour = Number(timeMatch[1]);
  const minute = timeMatch[3] ? 30 : Number(timeMatch[2] || 0);
  if (!Number.isInteger(hour) || hour > 23 || minute > 59) return null;

  if (/(下午|晚上)/.test(text) && hour < 12) hour += 12;
  if (/(早上|上午|凌晨)/.test(text) && hour === 12) hour = 0;

  return new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour - 8, minute
  )).toISOString();
}

function clean(value) {
  return String(value)
    .replace(/(?:今天|明天|後天|星期[一二三四五六日天]|週[一二三四五六日天])?\s*(?:早上|上午|中午|下午|晚上|凌晨)?\s*\d{1,2}(?::\d{2})?\s*(?:點|時)?(?:半)?/g, "")
    .replace(/\d+\s*(?:位|人)/g, "")
    .replace(/^[，,。；;：:\s]+|[，,。；;：:\s]+$/g, "");
}
