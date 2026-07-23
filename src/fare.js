export function calculateFare(distanceKm, durationMin, toll = 0, settings = {}) {
  const baseFare = Number(settings.base_fare ?? process.env.BASE_FARE ?? 60);
  const perKm = Number(settings.per_km ?? process.env.PER_KM ?? 20);
  const perMinute = Number(settings.per_minute ?? process.env.PER_MINUTE ?? 2);
  const nightSurcharge = Number(settings.night_surcharge ?? process.env.NIGHT_SURCHARGE ?? 0);

  const mileageFare = Math.round(distanceKm * perKm);
  const timeFare = Math.round(durationMin * perMinute);
  const estimatedFare = Math.round(
    (baseFare + mileageFare + timeFare + Number(toll || 0) + nightSurcharge) / 10
  ) * 10;

  return { baseFare, mileageFare, timeFare, nightSurcharge, estimatedFare };
}

export function isDonggangTownTrip(pickup, destination, route = {}) {
  return isDonggangTownPlace(pickup, route.originAddress) &&
    isDonggangTownPlace(destination, route.destinationAddress);
}

export function calculateDonggangTownFare() {
  return {
    baseFare: 150,
    mileageFare: 0,
    timeFare: 0,
    nightSurcharge: 0,
    estimatedFare: 150
  };
}

function isDonggangTownPlace(input, formattedAddress) {
  const text = `${input || ""} ${formattedAddress || ""}`.replace(/\s+/g, "");
  return text.includes("屏東縣東港鎮") || text.includes("東港鎮");
}
