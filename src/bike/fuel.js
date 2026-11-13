// Fuel cost is an ESTIMATE (spec §7.4):
//   estimatedFuelCost = (routeDistanceKm / mileageKmPerLitre) * fuelPricePerLitre
// Returns null — never a guess — unless BOTH assumptions are valid positive numbers.
// The caller must also surface where the price came from (fuel.priceSource / priceDate).
export function validateFuelAssumptions(f) {
  if (!f) return null;
  const ok = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (!ok(f.mileageKmPerLitre) || !ok(f.fuelPricePerLitre)) return null;
  return { mileageKmPerLitre: f.mileageKmPerLitre, fuelPricePerLitre: f.fuelPricePerLitre, priceSource: f.priceSource ?? 'user-supplied', priceDate: f.priceDate ?? null, currency: f.currency ?? 'INR' };
}

export function estimateFuelCost(distanceKm, fuel) {
  const f = validateFuelAssumptions(fuel);
  if (!f || distanceKm == null || !Number.isFinite(distanceKm) || distanceKm < 0) return null;
  return Math.round((distanceKm / f.mileageKmPerLitre) * f.fuelPricePerLitre * 100) / 100;
}
