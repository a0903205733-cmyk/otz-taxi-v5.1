export const ADDRESS = "屏東縣東港鎮中山路12號";
export const TEMPLE = "東港鎮海宮";

export function postalSuffixResult() {
  return geocodeResult({
    formatted_address: "924台灣屏東縣崁頂鄉園寮村南州路1-2號924號",
    address_components: [
      { long_name: "1-2號924", short_name: "1-2號924", types: ["street_number"] },
      { long_name: "南州路", types: ["route"] },
      { long_name: "園寮村", types: ["administrative_area_level_3"] },
      { long_name: "崁頂鄉", types: ["administrative_area_level_2"] },
      { long_name: "屏東縣", types: ["administrative_area_level_1"] },
      { long_name: "台灣", short_name: "TW", types: ["country"] },
      { long_name: "924", types: ["postal_code"] }
    ]
  });
}

export function geocodeResult(overrides = {}) {
  return {
    place_id: "address-12", formatted_address: `928台灣${ADDRESS}`,
    types: ["street_address"],
    geometry: { location: { lat: 22.465, lng: 120.45 }, location_type: "ROOFTOP" },
    address_components: [
      { long_name: "台灣", short_name: "TW", types: ["country"] },
      { long_name: "屏東縣", types: ["administrative_area_level_1"] },
      { long_name: "東港鎮", types: ["administrative_area_level_3"] },
      { long_name: "中山路", types: ["route"] },
      { long_name: "12", types: ["street_number"] }
    ],
    ...overrides
  };
}

export function placeResult(overrides = {}) {
  return {
    id: "temple", displayName: { text: TEMPLE },
    formattedAddress: "屏東縣東港鎮鎮海路42號之5",
    location: { latitude: 22.465, longitude: 120.45 },
    primaryType: "buddhist_temple", types: ["buddhist_temple", "place_of_worship", "establishment"],
    addressComponents: [
      { longText: "台灣", shortText: "TW", types: ["country"] },
      { longText: "屏東縣", types: ["administrative_area_level_1"] },
      { longText: "東港鎮", types: ["administrative_area_level_3"] }
    ],
    ...overrides
  };
}

export function mapsFetch(calls, { geocode = [geocodeResult()], places = [placeResult()] } = {}) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    if (String(url).includes("/geocode/")) return Response.json({ status: "OK", results: geocode });
    if (String(url).includes("places:searchText")) return Response.json({ places });
    if (String(url).includes("computeRoutes")) return Response.json({ routes: [{ distanceMeters: 10000, duration: "900s" }] });
    throw new Error("Unexpected endpoint");
  };
}

export const transportPlaces = [
  ["左營高鐵", "高鐵左營站", "高雄市左營區", "train_station"],
  ["小港機場", "高雄國際機場", "高雄市小港區", "international_airport"],
  ["枋寮火車站", "枋寮車站", "屏東縣枋寮鄉", "train_station"],
  ["林邊火車站", "林邊車站", "屏東縣林邊鄉", "train_station"],
  ["屏東火車站", "屏東車站", "屏東縣屏東市", "train_station"],
  ["潮州火車站", "潮州車站", "屏東縣潮州鎮", "train_station"],
  ["東港碼頭", "東琉線船運服務中心", "屏東縣東港鎮", "ferry_terminal"],
  ["新左營火車站", "新左營車站", "高雄市左營區", "transportation_service"],
  ["東港海事", "國立東港高級海事水產職業學校", "屏東縣東港鎮", "secondary_school"],
  ["慈惠", "慈惠醫護管理專科學校", "屏東縣南州鄉", "university"]
].map(([query, name, area, type]) => ({ query, place: placeResult({
  id: `transport-${query}`, displayName: { text: name }, formattedAddress: `${area}${{
    "左營高鐵": "高鐵路105號", "新左營火車站": "站前北路1號", "東港海事": "豐漁街66號", "慈惠": "三民路367號"
  }[query] || "測試路1號"}`,
  primaryType: type, types: [type], addressComponents: [{ longText: "台灣", shortText: "TW", types: ["country"] }]
}) }));
