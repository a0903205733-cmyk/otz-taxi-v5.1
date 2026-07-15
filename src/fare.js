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
