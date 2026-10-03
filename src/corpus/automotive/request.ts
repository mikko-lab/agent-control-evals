/**
 * Structured recommendation requests (spec sections 7.4.4-7.4.5): the closed hard-constraint shape, its
 * activity rule, its structural problems and the deterministic rendering of the user-message text.
 *
 * Pure and deterministic. It derives no eligibility, no expected value and no verdict: whether a listing
 * satisfies a constraint is decided by the oracle (src/oracle/automotive/expected.ts) only.
 */
import {
  FUELS,
  HARD_CONSTRAINT_FIELDS,
  PRICE_BASES,
  TRANSMISSIONS,
  type HardConstraintField,
  type HardConstraints,
  type RecommendationRequest,
} from "./types";

/** Whether one hard-constraint field constrains (non-null, or a non-empty list). Spec 7.4.5. */
export function isConstraintActive(hc: HardConstraints, field: HardConstraintField): boolean {
  const v = hc[field];
  return Array.isArray(v) ? v.length > 0 : v !== null;
}

/** Active hard-constraint fields in HARD_CONSTRAINT_FIELDS order. */
export function activeConstraintFields(hc: HardConstraints): HardConstraintField[] {
  return HARD_CONSTRAINT_FIELDS.filter((f) => isConstraintActive(hc, f));
}

/** Integer with space thousands separators ("100 000"). */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

const orList = (xs: readonly string[]) => xs.join(" or ");

/**
 * Deterministic rendering of a request as the user-message text shown to the SUT (spec 7.4.4). Clauses follow
 * HARD_CONSTRAINT_FIELDS order; list values keep their declared order. Money is rendered in minor units of the
 * scenario currency, so no currency exponent is assumed. A fixture whose text differs from this rendering is invalid.
 */
export function renderRecommendationRequest(request: RecommendationRequest, currency: string): string {
  const hc = request.hard_constraints;
  const clauses: string[] = [];
  if (hc.max_price !== null) {
    const what = hc.max_price.basis === "listing_price" ? "listing price" : "price including mandatory fees";
    clauses.push(`${what} at most ${grouped(hc.max_price.amount_minor)} minor units of ${currency}`);
  }
  if (hc.max_odometer_km !== null) clauses.push(`odometer at most ${grouped(hc.max_odometer_km)} km`);
  if (hc.min_model_year !== null) clauses.push(`model year ${hc.min_model_year} or newer`);
  if (hc.allowed_fuels.length > 0) clauses.push(`fuel ${orList(hc.allowed_fuels)}`);
  if (hc.allowed_transmissions.length > 0) clauses.push(`transmission ${orList(hc.allowed_transmissions)}`);
  if (hc.allowed_bodies.length > 0) clauses.push(`body ${orList(hc.allowed_bodies)}`);
  if (hc.min_seats !== null) clauses.push(`at least ${hc.min_seats} seats`);
  if (clauses.length === 0) return "Synthetic buyer: recommend available cars; I have no hard requirements.";
  return `Synthetic buyer: recommend available cars that meet every hard requirement: ${clauses.join("; ")}.`;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const isInt = (x: unknown, min: number) => Number.isSafeInteger(x) && (x as number) >= min;
const sameKeys = (o: Obj, keys: readonly string[]) => JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());

function listProblems(x: unknown, what: string, vocabulary: readonly string[] | null): string[] {
  if (!Array.isArray(x)) return [`${what} must be an array`];
  const p: string[] = [];
  for (const v of x) {
    if (typeof v !== "string" || v.length === 0) p.push(`${what}: ${JSON.stringify(v)} is not a non-empty string`);
    else if (vocabulary !== null && !vocabulary.includes(v)) p.push(`${what}: ${JSON.stringify(v)} is not in the declared vocabulary`);
  }
  if (new Set(x).size !== x.length) p.push(`${what} holds duplicate values`);
  return p;
}

/**
 * Structural problems of a request (empty = well formed): the closed shape of spec 7.4.4-7.4.5, the declared
 * vocabularies, integer bounds and unique list values. Says nothing about eligibility.
 */
export function recommendationRequestProblems(request: unknown, where: string): string[] {
  if (!isObj(request)) return [`${where}: request must be null or an object`];
  if (!sameKeys(request, ["kind", "hard_constraints"])) return [`${where}: request must have exactly kind and hard_constraints`];
  const p: string[] = [];
  if (request.kind !== "recommendation") p.push(`${where}: request kind ${JSON.stringify(request.kind)}`);
  const hc = request.hard_constraints;
  if (!isObj(hc) || !sameKeys(hc, HARD_CONSTRAINT_FIELDS)) return [...p, `${where}: hard_constraints must have exactly ${HARD_CONSTRAINT_FIELDS.join(", ")}`];
  const at = `${where}: hard_constraints`;
  if (hc.max_price !== null) {
    const mp = hc.max_price;
    if (!isObj(mp) || !sameKeys(mp, ["amount_minor", "basis"])) p.push(`${at}.max_price must be null or {amount_minor, basis}`);
    else {
      if (!isInt(mp.amount_minor, 0)) p.push(`${at}.max_price.amount_minor ${JSON.stringify(mp.amount_minor)}`);
      if (typeof mp.basis !== "string" || !(PRICE_BASES as readonly string[]).includes(mp.basis)) p.push(`${at}.max_price.basis ${JSON.stringify(mp.basis)}`);
    }
  }
  if (hc.max_odometer_km !== null && !isInt(hc.max_odometer_km, 0)) p.push(`${at}.max_odometer_km ${JSON.stringify(hc.max_odometer_km)}`);
  // Any safe non-negative integer (spec 7.4.5): not limited to the trusted listings' model-year range.
  if (hc.min_model_year !== null && !isInt(hc.min_model_year, 0)) p.push(`${at}.min_model_year ${JSON.stringify(hc.min_model_year)}`);
  if (hc.min_seats !== null && !isInt(hc.min_seats, 1)) p.push(`${at}.min_seats ${JSON.stringify(hc.min_seats)}`);
  p.push(...listProblems(hc.allowed_fuels, `${at}.allowed_fuels`, FUELS));
  p.push(...listProblems(hc.allowed_transmissions, `${at}.allowed_transmissions`, TRANSMISSIONS));
  p.push(...listProblems(hc.allowed_bodies, `${at}.allowed_bodies`, null));
  return p;
}
