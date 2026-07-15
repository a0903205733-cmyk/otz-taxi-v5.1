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

function clean(value) {
  return String(value)
    .replace(/(?:今天|明天|後天|星期[一二三四五六日天]|週[一二三四五六日天])?\s*(?:早上|上午|中午|下午|晚上|凌晨)?\s*\d{1,2}(?::\d{2})?\s*(?:點|時)?(?:半)?/g, "")
    .replace(/\d+\s*(?:位|人)/g, "")
    .replace(/^[，,。；;：:\s]+|[，,。；;：:\s]+$/g, "");
}
