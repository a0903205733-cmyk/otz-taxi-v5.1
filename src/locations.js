import { isPlaceholderPlace } from "./parser.js";

const PLACE_TYPES = new Set([
  "airport", "bus_station", "bus_stop", "train_station", "subway_station",
  "transit_station", "ferry_terminal", "taxi_stand", "hospital", "doctor",
  "pharmacy", "school", "university", "library", "museum", "tourist_attraction",
  "park", "national_park", "amusement_park", "zoo", "aquarium", "stadium",
  "beach", "scenic_spot", "observation_deck", "nature_preserve",
  "historical_place", "tourist_information_center", "campground",
  "shopping_mall", "supermarket", "convenience_store", "department_store",
  "restaurant", "cafe", "bakery", "gas_station", "parking", "bank", "post_office",
  "police", "local_government_office", "city_hall", "lodging", "hotel", "motel",
  "hostel", "resort_hotel", "guest_house", "buddhist_temple", "hindu_temple",
  "church", "mosque", "synagogue", "place_of_worship", "cultural_landmark", "historical_landmark",
  "community_center", "convention_center", "sports_complex", "karaoke",
  "association_or_organization",
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
const LANDMARK_ALIASES = [
  {
    name: "東港東隆宮", city: "屏東縣", district: "東港鎮",
    types: ["place_of_worship", "buddhist_temple", "association_or_organization"],
    streetAddress: "東隆街21-1號",
    names: ["東隆宮", "東港東隆宮", "東港鎮東隆宮"]
  },
  {
    name: "鎮海宮", city: "屏東縣", district: "東港鎮", types: ["association_or_organization", "buddhist_temple", "hindu_temple", "place_of_worship"],
    names: ["東港鎮鎮海宮", "鎮海宮"], resultNames: ["東港鎮海宮"]
  },
  {
    name: "慈惠醫護管理專科學校", city: "屏東縣", district: "南州鄉", types: ["university", "school", "educational_institution"],
    streetAddress: "三民路367號",
    names: ["慈惠", "慈惠醫專", "慈惠醫護管理專科學校"]
  },
  {
    name: "新左營車站", city: "高雄市", district: "左營區", types: ["train_station", "transportation_service"],
    streetAddress: "站前北路1號", resultNames: ["新左營"],
    names: ["新左營火車站", "新左營車站", "新左營站", "台鐵新左營站", "台鐵新左營車站"]
  },
  {
    name: "國立東港高級海事水產職業學校", city: "屏東縣", district: "東港鎮", types: ["secondary_school", "school", "educational_institution"],
    streetAddress: "豐漁街66號",
    names: ["東港海事", "東港海事水產", "國立東港海事水產職業學校", "國立東港高級海事水產職業學校"]
  },
  {
    name: "高鐵左營站", city: "高雄市", district: "左營區", types: ["train_station", "transit_station"],
    resultNames: ["左營"], streetAddress: "高鐵路105號",
    names: ["高鐵", "左營高鐵", "左營高鐵站", "高鐵左營", "高鐵左營站", "台灣高鐵左營站", "台灣高鐵左營車站"]
  },
  {
    name: "高雄國際機場", city: "高雄市", district: "小港區", types: ["international_airport", "airport"],
    names: ["小港機場", "高雄機場", "高雄小港機場", "小港國際機場", "高雄國際機場"]
  },
  {
    name: "東琉線船運服務中心", city: "屏東縣", district: "東港鎮", types: ["ferry_terminal"],
    names: ["東港碼頭", "東港渡船碼頭", "東琉線搭船處", "東琉線碼頭", "東琉線船運服務中心"]
  },
  ...[["枋寮", "枋寮鄉"], ["林邊", "林邊鄉"], ["屏東", "屏東市"], ["潮州", "潮州鎮"]].map(([name, district]) => ({
    name: `${name}車站`, city: "屏東縣", district, types: ["train_station", "transit_station"],
    names: [`${name}火車站`, `${name}車站`, `${name}站`, `台鐵${name}車站`, `台鐵${name}站`]
  }))
];

function unverified(reason, allowAreaRetry = false) {
  const error = new Error(`Location not verified: ${reason}`);
  error.code = "LOCATION_UNVERIFIED";
  error.allowAreaRetry = allowAreaRetry;
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
    const lookup = candidate.kind === "address" ? geocodeAddress : searchPlace;
    try {
      return await lookup(candidate, apiKey);
    } catch (error) {
      const townshipWithoutCounty = /^[\p{Script=Han}]{1,4}[鄉鎮]/u.test(candidate.query) &&
        !/[縣市]/u.test(candidate.query.split(/[鄉鎮]/u)[0]);
      if (!error.allowAreaRetry || !townshipWithoutCounty) throw error;
      const result = await lookup({ ...candidate, query: `屏東縣${candidate.query}` }, apiKey);
      return { ...result, query: candidate.query };
    }
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

function repairPostalNumberSuffix(query, result) {
  const source = normalize(query);
  const number = source.match(/(\d+(?:-\d+)?)號$/u)?.[1];
  if (!number || (source.match(/號/gu) || []).length !== 1) return result;
  const components = result.address_components || [];
  const postal = components.find(component => component.types?.includes("postal_code"));
  const code = postal && componentNames(postal).find(value => /^\d{3,6}$/u.test(value));
  const street = components.find(component => component.types?.includes("street_number"));
  if (!code || !street) return result;
  const malformed = `${number}號${code}`;
  if (!componentNames(street).every(value => value === malformed || value === `${malformed}號`)) return result;
  const address = normalize(result.formatted_address);
  if (!address.endsWith(`${malformed}號`)) return result;
  // Only remove a duplicated postal-code suffix corroborated by both Google fields.
  return { ...result,
    formatted_address: address.slice(0, -`${malformed}號`.length) + `${number}號`,
    address_components: components.map(component => component === street ?
      { ...component, long_name: number, short_name: number } : component)
  };
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
  if (payload.status !== "OK" || !Array.isArray(payload.results)) throw unverified("geocoding rejected", payload.status === "ZERO_RESULTS");
  const candidates = payload.results.map(result => repairPostalNumberSuffix(candidate.query, result))
    .filter(result => matchesAddress(candidate.query, result)).map(result => ({
    query: candidate.query, kind: "address", placeId: result.place_id,
    formattedAddress: result.formatted_address,
    location: { latitude: result.geometry?.location?.lat, longitude: result.geometry?.location?.lng },
    components: result.address_components || []
  })).filter(result => inServiceArea(result.components, result.formattedAddress, result.location));
  const unique = [...new Map(candidates.map(result => [result.placeId, result])).values()];
  if (unique.length !== 1) throw unverified("address missing, inferred, partial or ambiguous", true);
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
  const isRailStation = place.primaryType ? place.primaryType === "train_station" : place.types?.includes("train_station");
  const stationName = value => isRailStation ? String(value).replace(/火車站$/u, "車站") : value;
  const compareName = value => nameSimilarity(stationName(value), stationName(name));
  let score = compareName(query);
  let remainder = normalize(query);
  const address = normalize(place.formattedAddress);
  // Strip only administrative prefixes actually present in the returned address.
  for (let i = 0; i < 3; i += 1) {
    const prefix = (place.addressComponents || []).filter(component =>
      isDistrict(component) || component.types?.includes("administrative_area_level_1"))
      .flatMap(componentNames).find(value => remainder.startsWith(value) && address.includes(value));
    if (!prefix) break;
    remainder = remainder.slice(prefix.length);
    score = Math.max(score, compareName(remainder) * 0.99);
  }
  return score;
}

function landmarkAlias(query) {
  const text = normalize(query);
  return LANDMARK_ALIASES.find(alias => ["", alias.city, alias.district, alias.city + alias.district]
    .some(prefix => alias.names.some(name => normalize(prefix + name) === text)));
}

function landmarkAliasScore(alias, place) {
  const typeIndex = alias.types.findIndex(type => place.primaryType ? type === place.primaryType : place.types?.includes(type));
  const address = normalize(place.formattedAddress);
  if (typeIndex < 0 || !address.includes(normalize(alias.city)) || !address.includes(normalize(alias.district)) ||
      (alias.streetAddress && !address.includes(normalize(alias.streetAddress))) ||
      ![...alias.names, ...(alias.resultNames || [])].some(name => normalize(name) === normalize(place.displayName?.text))) return 0;
  // Prefer a railway station over a generic transit entry for the same name.
  return 1 - typeIndex * 0.05;
}

async function searchPlace(candidate, apiKey) {
  const alias = landmarkAlias(candidate.query);
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.addressComponents,nextPageToken"
    },
    body: JSON.stringify({ textQuery: alias ? `${alias.city}${alias.district}${alias.name}` : candidate.query,
      languageCode: "zh-TW", regionCode: "TW", pageSize: 20 }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw unverified(`places HTTP ${response.status}`);
  const payload = await response.json();
  // Additional pages mean uniqueness cannot be established from this response.
  const places = payload.places === undefined && !payload.error ? [] : payload.places;
  if (payload.nextPageToken || !Array.isArray(places)) throw unverified("incomplete place candidates", Boolean(payload.nextPageToken));
  const ranked = places.map(place => ({ place,
    score: alias ? landmarkAliasScore(alias, place) : placeNameScore(candidate.query, place) }))
    .filter(item => item.score >= NAME_THRESHOLD).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) throw unverified("place name mismatch", true);
  if (ranked.some(item => item !== best && item.place.id !== best.place.id &&
      best.score - item.score <= NAME_TIE_MARGIN)) throw unverified("ambiguous place name", true);
  const place = best.place;
  const allowedType = alias ? landmarkAliasScore(alias, place) > 0 : (place.primaryType ? PLACE_TYPES.has(place.primaryType) :
    place.types?.some(type => PLACE_TYPES.has(type)));
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
