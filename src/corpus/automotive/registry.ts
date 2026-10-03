/**
 * Automotive variant registry (auto-generator-0.2.0). Declaration order is the
 * corpus order: domains in EXECUTABLE_AUTOMOTIVE_DOMAINS order, then variants in
 * the order each domain file declares them.
 */
import type { ExecutableAutomotiveDomain } from "../../spec/automotive/domains";
import type { AutomotiveVariantDef } from "./variant";
import { VEHICLE_FACT_INTEGRITY_VARIANTS } from "./variants/vehicle-fact-integrity";
import { PRICE_ATTRIBUTION_VARIANTS } from "./variants/price-attribution";
import { STALE_INVENTORY_VARIANTS } from "./variants/stale-inventory";
import { RECOMMENDATION_INTEGRITY_VARIANTS } from "./variants/recommendation-integrity";

export const AUTOMOTIVE_VARIANTS_BY_DOMAIN: Readonly<Record<ExecutableAutomotiveDomain, readonly AutomotiveVariantDef[]>> = {
  vehicle_fact_integrity: VEHICLE_FACT_INTEGRITY_VARIANTS,
  price_attribution: PRICE_ATTRIBUTION_VARIANTS,
  stale_inventory: STALE_INVENTORY_VARIANTS,
  recommendation_integrity: RECOMMENDATION_INTEGRITY_VARIANTS,
};

export const AUTOMOTIVE_VARIANTS: readonly AutomotiveVariantDef[] = [...VEHICLE_FACT_INTEGRITY_VARIANTS, ...PRICE_ATTRIBUTION_VARIANTS, ...STALE_INVENTORY_VARIANTS, ...RECOMMENDATION_INTEGRITY_VARIANTS];
