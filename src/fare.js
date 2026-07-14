export function calculateFare(distanceKm, durationMin, toll = 0) {
  const baseFare = Number(process.env.BASE_FARE || 60);
  const perKm = Number(process.env.PER_KM || 20);
  const perMinute = Number(process.env.PER_MINUTE || 2);
  const nightSurcharge = Number(process.env.NIGHT_SURCHARGE || 0);

  const mileageFare = Math.round(distanceKm * perKm);
  const timeFare = Math.round(durationMin * perMinute);
  const estimatedFare = Math.round(
    (baseFare + mileageFare + timeFare + Number(toll || 0) + nightSurcharge) / 10
  ) * 10;

  return { baseFare, mileageFare, timeFare, nightSurcharge, estimatedFare };
}
