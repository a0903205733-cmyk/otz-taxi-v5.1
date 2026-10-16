export const ADDRESS = "屏東縣東港鎮中山路12號";
export const TEMPLE = "東港鎮海宮";

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
