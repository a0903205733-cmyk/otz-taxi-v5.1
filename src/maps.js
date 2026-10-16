import { validateLocation } from "./locations.js";

export async function getRoute(origin, destination, apiKey, fareSettings = {}) {
  const [validatedOrigin, validatedDestination] = await Promise.all([
    validateLocation(origin, apiKey),
    validateLocation(destination, apiKey)
  ]);

  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration"
    },
    body: JSON.stringify({
      origin: { location: { latLng: validatedOrigin.location } },
      destination: { location: { latLng: validatedDestination.location } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      computeAlternativeRoutes: true,
      languageCode: "zh-TW",
      units: "METRIC"
    })
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`Routes API ${response.status}: ${raw}`);

  const routes = JSON.parse(raw).routes || [];
  if (!routes.length) throw new Error("找不到路線");

  const perKm = Number(fareSettings.per_km ?? process.env.PER_KM ?? 20);
  const perMinute = Number(fareSettings.per_minute ?? process.env.PER_MINUTE ?? 2);
  const candidates = routes.map(route => {
    const distanceKm = route.distanceMeters / 1000;
    const durationMin = Number(String(route.duration).replace("s", "")) / 60;
    return {
      distanceKm,
      durationMin,
      score: distanceKm * perKm + durationMin * perMinute
    };
  }).filter(route => Number.isFinite(route.distanceKm) && Number.isFinite(route.durationMin));

  candidates.sort((a, b) => a.score - b.score || a.durationMin - b.durationMin);
  const route = candidates[0];
  if (!route) throw new Error("找不到有效路線");

  return {
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
    alternativesEvaluated: candidates.length,
    originAddress: validatedOrigin.formattedAddress,
    destinationAddress: validatedDestination.formattedAddress,
    originLocation: validatedOrigin.location,
    destinationLocation: validatedDestination.location
  };
}

export async function validatePickupLocation(pickup, apiKey) {
  return validateLocation(pickup, apiKey);
}

export async function getPickupEtaMinutes(latitude, longitude, pickup, apiKey) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("DRIVER_LOCATION_REQUIRED");
  }

  // Driver GPS must also be on Taiwan's main island.
  if (lat < 21.75 || lat > 25.35 || lng < 120 || lng > 122) {
    throw new Error("DRIVER_LOCATION_OUTSIDE_TAIWAN");
  }

  const destinationLocation = pickup && typeof pickup === "object"
    ? { latitude: Number(pickup.latitude), longitude: Number(pickup.longitude) }
    : (await validateLocation(pickup, apiKey)).location;
  if (!Number.isFinite(destinationLocation.latitude) || !Number.isFinite(destinationLocation.longitude)) {
    throw new Error("PICKUP_LOCATION_REQUIRED");
  }
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters"
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: lat, longitude: lng } } },
      destination: { location: { latLng: destinationLocation } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      computeAlternativeRoutes: true,
      languageCode: "zh-TW",
      units: "METRIC"
    })
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`Routes API ${response.status}: ${raw}`);
  const routes = JSON.parse(raw).routes || [];
  const candidates = routes.map(route => ({
    durationMin: Number(String(route.duration || "").replace("s", "")) / 60,
    distanceKm: Number(route.distanceMeters || 0) / 1000
  })).filter(route => Number.isFinite(route.durationMin) && route.durationMin >= 0);

  candidates.sort((a, b) => a.durationMin - b.durationMin || a.distanceKm - b.distanceKm);
  if (!candidates.length) throw new Error("NO_PICKUP_ROUTE");
  return candidates[0];
}
