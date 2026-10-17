import { isPlaceholderPlace } from "./parser.js";

const PLACE_TYPES = new Set([
  "airport", "bus_station", "bus_stop", "train_station", "subway_station",
  "transit_station", "ferry_terminal", "taxi_stand", "hospital", "doctor",
  "pharmacy", "school", "university", "library", "museum", "tourist_attraction",
  "park", "national_park", "amusement_park", "zoo", "aquarium", "stadium",
  "shopping_mall", "supermarket", "convenience_store", "department_store",
  "restaurant", "cafe", "bakery", "gas_station", "parking", "bank", "post_office",
  "police", "local_government_office", "city_hall", "lodging", "hotel", "motel",
  "hostel", "resort_hotel", "guest_house", "buddhist_temple", "hindu_temple",
  "church", "mosque", "synagogue", "cultural_landmark", "historical_landmark",
  "community_center", "convention_center", "sports_complex", "karaoke",
  "apartment_building", "apartment_complex", "corporate_office",
  "locality", "sublocality", "administrative_area_level_1",
  "administrative_area_level_2", "administrative_area_level_3"
]);
const NAME_THRESHOLD = 0.9;
const NAME_TIE_MARGIN = 0.02;
const TIMEOUT_MS = 8000;
const DISTRICT_TYPES = new Set([
  "locality", "administrative_area_level_2", "administrative_area_level_3",
  "sublocality", "sublocality_level_1"
]);

function unverified(reason) {
  const error = new Error(`Location not verified: ${reason}`);
  error.code = "LOCATION_UNVERIFIED";
  return error;
}

function hasText(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function normalize(value) {
  return String(value || "").normalize("NFKC").replace(/臺/gu, "台")
    .replace(/(\d+)號之(\d+)/gu, "$1-$2號")
    .replace(/(\d+)之(\d+)號/gu, "$1-$2號")
    .replace(/[\s,，()（）]/gu, "").toLowerCase();
}

export function extractLocationCandidate(value) {
  const query = String(value || "").normalize("NFKC").trim()
    .replace(/^(?:請問|麻煩|請)?\s*(?:幫我叫車到|幫我叫車|我想叫車|我要叫車|叫車|我現在在|我在|位置在|地址是|上車地點|下車地點|上車地址|下車地址|地址|從)\s*[：:,，]?\s*/u, "")
    .replace(/[，,。!！\s]*(?:謝謝|麻煩了|請幫我叫車)[。!！\s]*$/u, "")
    .trim();
  if (query.length < 2 || query.length > 100 || isPlaceholderPlace(query)) return null;
  if (!/\p{L}/u.test(query) || /[\r\n@?？!！。；;:=]/u.test(query)) return null;
  if (/^(?:好|好的|謝謝|收到|出發|準時|取消|不用|不要|繼續|等一下|尚未提供|上車點|下車點|附近|這裡|那裡)$/u.test(query)) return null;
  if (/(?:是否|怎麼|為什麼|多少|沒有|不是|找不到|到了|到家|到站|還沒|稍等|請稍|請問|聊天|叫車|試算|車資|今天|明天|等一下|不需要)/u.test(query)) return null;
  if (!/^[\p{L}\p{N}\s()（）·・'&.\-之]+$/u.test(query)) return null;
  const house = /\d+(?:[-之]\d+)?號(?:之\d+)?/u.test(query);
  const road = /(?:路|街|大道)(?:[一二三四五六七八九十\d]+段)?(?:\d+巷)?(?:\d+弄)?$/u.test(query);
  return { query, kind: house || road ? "address" : "place" };
}

export async function validateLocation(value, apiKey) {
  const candidate = extractLocationCandidate(value);
  if (!candidate) throw unverified("not a location fragment");
  if (!apiKey) throw unverified("API key missing");
  try {
    return candidate.kind === "address"
      ? await geocodeAddress(candidate, apiKey)
      : await searchPlace(candidate, apiKey);
  } catch (error) {
    if (error.code === "LOCATION_UNVERIFIED") throw error;
    // Do not leak URLs containing API keys or provider error payloads into logs.
    throw unverified("provider unavailable or malformed response");
  }
}

function componentNames(component) {
  return [component.long_name ?? component.longText, component.short_name ?? component.shortText]
    .filter(value => typeof value === "string" && value.trim()).map(normalize);
}

function inServiceArea(components, address, location) {
  const country = components.find(component => component.types?.includes("country"));
  const countryCode = country?.short_name ?? country?.shortText;
  if (countryCode !== "TW" || !location ||
      typeof location.latitude !== "number" || typeof location.longitude !== "number" ||
      !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return false;
  if (location.latitude < 21.75 || location.latitude > 25.35 ||
      location.longitude < 120 || location.longitude > 122) return false;
  const text = [address, ...components.flatMap(componentNames)].join(" ");
  return !/澎湖|金門|連江|馬祖|琉球|綠島|蘭嶼/u.test(text);
}

function isDistrict(component) {
  return component.types?.some(type => DISTRICT_TYPES.has(type)) &&
    /[區鄉鎮市]$/u.test(component.long_name ?? component.longText ?? "");
}

function stripAddressArea(value, components) {
  let text = normalize(value);
  const prefixes = components.filter(component => isDistrict(component) ||
    component.types?.some(type => ["country", "postal_code", "administrative_area_level_1"].includes(type)))
    .flatMap(componentNames).sort((a, b) => b.length - a.length);
  for (let i = 0; i < prefixes.length; i += 1) {
    const prefix = prefixes.find(name => text.startsWith(name));
    if (!prefix) break;
    text = text.slice(prefix.length);
  }
  return text;
}

function matchesAddressText(source, formatted, components, district, route) {
  const input = stripAddressArea(source, components);
  const output = stripAddressArea(formatted.replace(/^\d{3,6}(?=台灣)/u, ""), components);
  return componentNames(route).some(road => {
    const inputIndex = input.indexOf(road);
    const outputIndex = output.indexOf(road);
    if (inputIndex < 0 || outputIndex < 0 || input.slice(inputIndex) !== output.slice(outputIndex)) return false;
    const inputVillage = input.slice(0, inputIndex);
    const outputVillage = output.slice(0, outputIndex);
    const isVillage = text => /^[\p{Script=Han}]{1,8}[村里]$/u.test(text) && !/[縣市區鄉鎮]/u.test(text);
    if ((inputVillage && !isVillage(inputVillage)) || (outputVillage && !isVillage(outputVillage))) return false;
    if (inputVillage && outputVillage && inputVillage !== outputVillage) return false;
    const villages = components.filter(component => component.types?.some(type =>
      type === "neighborhood" || type.startsWith("sublocality") || type.startsWith("administrative_area_level_")))
      .flatMap(componentNames).filter(isVillage);
    if (inputVillage && villages.length && !villages.includes(inputVillage)) return false;
    // A village omitted by Google is optional only with an explicitly matching
    // district. The road, house number and unit still have to match exactly.
    if (inputVillage && !outputVillage && !villages.length &&
        !componentNames(district).some(name => source.includes(name))) return false;
    return true;
  });
}

function matchesAddress(query, result) {
  if (result.partial_match || !hasText(result.place_id) || !hasText(result.formatted_address)) return false;
  const components = result.address_components || [];
  if (components.some(component => component.inferred || component.replaced ||
      component.spellCorrected || (component.confirmationLevel && component.confirmationLevel !== "CONFIRMED"))) return false;
  const types = result.types || [];
  if (!types.some(type => ["street_address", "premise", "subpremise", "route"].includes(type))) return false;
  const source = normalize(query);
  const formatted = normalize(result.formatted_address);
  // Administrative areas may be omitted, but supplied areas must agree.
  const city = components.find(component => component.types?.includes("administrative_area_level_1"));
  const district = components.find(isDistrict);
  const route = components.find(component => component.types?.includes("route"));
  if (!city || !district || !route || !matchesAddressText(source, formatted, components, district, route)) return false;
  const critical = components.filter(component =>
    component.types?.some(type => ["route", "street_number", "subpremise"].includes(type)));
  if (!critical.every(component => componentNames(component).some(name => {
    if (component.types?.includes("street_number")) {
      const number = name.replace(/^no\.?/iu, "").replace(/號$/u, "").replace(/之/gu, "-");
      const inputNumber = source.match(/(\d+(?:-\d+)?)號/u)?.[1];
      return number === inputNumber;
    }
    if (component.types?.includes("subpremise")) {
      const unit = name.replace(/(?:樓|室)$/u, "");
      return [...source.matchAll(/(?:^|[^\d])(\d+)(?:樓|室)/gu)].some(match => match[1] === unit);
    }
    return source.includes(name);
  }))) return false;
  const inputHasNumber = /\d+(?:-\d+)?號/u.test(source);
  if (inputHasNumber && (!components.some(component => component.types?.includes("street_number")) ||
      result.geometry?.location_type !== "ROOFTOP")) return false;
  return true;
}

async function geocodeAddress(candidate, apiKey) {
  const params = new URLSearchParams({
    address: candidate.query, components: "country:TW", language: "zh-TW", key: apiKey
  });
  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw unverified(`geocoding HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.status !== "OK" || !Array.isArray(payload.results)) throw unverified("geocoding rejected");
  const candidates = payload.results.filter(result => matchesAddress(candidate.query, result)).map(result => ({
    query: candidate.query, kind: "address", placeId: result.place_id,
    formattedAddress: result.formatted_address,
    location: { latitude: result.geometry?.location?.lat, longitude: result.geometry?.location?.lng },
    components: result.address_components || []
  })).filter(result => inServiceArea(result.components, result.formattedAddress, result.location));
  const unique = [...new Map(candidates.map(result => [result.placeId, result])).values()];
  if (unique.length !== 1) throw unverified("address missing, inferred, partial or ambiguous");
  const { components, ...verified } = unique[0];
  return verified;
}

function nameSimilarity(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Only tolerate a small name extension; do not correct a different place name.
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return 0;
}

function placeNameScore(query, place) {
  const name = place.displayName?.text;
  if (!hasText(name)) return 0;
  let score = nameSimilarity(query, name);
  let remainder = normalize(query);
  const address = normalize(place.formattedAddress);
  // Strip only administrative prefixes actually present in the returned address.
  for (let i = 0; i < 3; i += 1) {
    const prefix = (place.addressComponents || []).filter(component =>
      isDistrict(component) || component.types?.includes("administrative_area_level_1"))
      .flatMap(componentNames).find(value => remainder.startsWith(value) && address.includes(value));
    if (!prefix) break;
    remainder = remainder.slice(prefix.length);
    score = Math.max(score, nameSimilarity(remainder, name) * 0.99);
  }
  return score;
}

async function searchPlace(candidate, apiKey) {
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.addressComponents,nextPageToken"
    },
    body: JSON.stringify({ textQuery: candidate.query, languageCode: "zh-TW", regionCode: "TW", pageSize: 20 }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw unverified(`places HTTP ${response.status}`);
  const payload = await response.json();
  // Additional pages mean uniqueness cannot be established from this response.
  if (payload.nextPageToken || !Array.isArray(payload.places)) throw unverified("incomplete place candidates");
  const ranked = payload.places.map(place => ({ place, score: placeNameScore(candidate.query, place) }))
    .filter(item => item.score >= NAME_THRESHOLD).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) throw unverified("place name mismatch");
  if (ranked.some(item => item !== best && item.place.id !== best.place.id &&
      best.score - item.score <= NAME_TIE_MARGIN)) throw unverified("ambiguous place name");
  const place = best.place;
  const allowedType = place.primaryType ? PLACE_TYPES.has(place.primaryType) :
    place.types?.some(type => PLACE_TYPES.has(type));
  if (!hasText(place.id) || !hasText(place.formattedAddress) || !allowedType ||
      !inServiceArea(place.addressComponents || [], place.formattedAddress, place.location)) {
    throw unverified("place metadata, type or service area rejected");
  }
  return {
    query: candidate.query, kind: "place", placeId: place.id,
    formattedAddress: place.formattedAddress, location: place.location
  };
}

export async function validateRideLocations(parsed, apiKey) {
  if (!parsed?.pickup) throw unverified("pickup missing");
  const pickup = await validateLocation(parsed.pickup, apiKey);
  const destination = parsed.destination ? await validateLocation(parsed.destination, apiKey) : null;
  return { ...parsed, pickup: pickup.query, destination: destination?.query || "", verifiedLocations: { pickup, destination } };
}
