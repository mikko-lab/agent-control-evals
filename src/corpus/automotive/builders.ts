/**
 * Builders for synthetic automotive cases. Pure and deterministic: no wall
 * clock, no randomness, no I/O. Every builder returns a fresh object that
 * shares no mutable state with the defaults or with earlier results.
 *
 * Builders construct trusted facts and untrusted content side by side, including
 * deliberate contradictions between them. They never decide what a
 * contradiction means: that is the oracle's job (PR B). The only checks here
 * are structural and referential (automotiveFixtureProblems), so that an
 * ill-formed fixture fails at construction instead of at evaluation.
 */
import { EXECUTABLE_AUTOMOTIVE_DOMAINS, type ExecutableAutomotiveDomain } from "../../spec/automotive/domains";
import { AUTOMOTIVE_CASE_SCHEMA_VERSION } from "../../spec/automotive/version";
import { SYNTHETIC_CURRENCY, SYNTHETIC_DEALERS, SYNTHETIC_DEFAULT_QUESTION, SYNTHETIC_DEFAULT_UNTRUSTED_TEXT, SYNTHETIC_LISTINGS } from "./fixtures";
import {
  AUTOMOTIVE_CASE_ID_PATTERN,
  AUTOMOTIVE_LABEL_PATTERN,
  AUTOMOTIVE_VARIANT_PATTERN,
  CURRENCY_CODE_PATTERN,
  FIRST_REGISTRATION_PATTERN,
  FUELS,
  INTEGER_VALUED_FIELDS,
  INVENTORY_STATUSES,
  MANDATORY_FEE_POLICIES,
  MODEL_YEAR_MAX,
  MODEL_YEAR_MIN,
  PROBE_FIELDS,
  STRING_VALUED_FIELDS,
  TRANSMISSIONS,
  UNTRUSTED_AUTHOR_ROLES,
  UNTRUSTED_SOURCES,
  type AutomotiveCase,
  type AutomotiveCaseForAdapter,
  type AutomotiveScenario,
  type HarnessAnnotations,
  type InventoryEventStep,
  type InventoryStatus,
  type PlantedValue,
  type Probe,
  type ProbeField,
  type SyntheticDealer,
  type TrustedListing,
  type UntrustedContent,
  type UserMessageStep,
} from "./types";

export class AutomotiveFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomotiveFixtureError";
  }
}

const clone = <T>(v: T): T => structuredClone(v);

// ---------------------------------------------------------------- primitives

export function automotiveCaseId(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1 || n > 999_999) throw new AutomotiveFixtureError(`case number ${n} must be an integer in 1..999999`);
  return `auto-case-${String(n).padStart(6, "0")}`;
}

export function buildDealer(id: keyof typeof SYNTHETIC_DEALERS = "D1", overrides: Partial<SyntheticDealer> = {}): SyntheticDealer {
  return { ...clone(SYNTHETIC_DEALERS[id]), ...clone(overrides) };
}

/** A trusted listing from a synthetic template, with field overrides (e.g. a new listing_id or a different odometer). */
export function buildListing(template: keyof typeof SYNTHETIC_LISTINGS = "L1", overrides: Partial<TrustedListing> = {}): TrustedListing {
  return { ...clone(SYNTHETIC_LISTINGS[template]), ...clone(overrides) };
}

export function buildUntrustedContent(overrides: Partial<UntrustedContent> = {}): UntrustedContent {
  return {
    content_id: "content-1",
    source: "listing_description",
    attached_to: "L1",
    author_role: "dealer",
    text: SYNTHETIC_DEFAULT_UNTRUSTED_TEXT,
    ...clone(overrides),
  };
}

export function userMessage(text: string = SYNTHETIC_DEFAULT_QUESTION): UserMessageStep {
  return { op: "user_message", text };
}

export function statusEvent(listing_id: string, status: InventoryStatus): InventoryEventStep {
  return { op: "inventory_event", listing_id, change: { kind: "status", status } };
}

export function priceEvent(listing_id: string, price_minor: number): InventoryEventStep {
  return { op: "inventory_event", listing_id, change: { kind: "price", price_minor } };
}

export function buildProbe(probe_id: string, step: number, listing_id: string, field: ProbeField): Probe {
  return { probe_id, step, listing_id, field };
}

export function plantedValue(v: PlantedValue): PlantedValue {
  return clone(v);
}

// ---------------------------------------------------------------- scenario and case

export function buildScenario(overrides: Partial<AutomotiveScenario> = {}): AutomotiveScenario {
  const base: AutomotiveScenario = {
    currency: SYNTHETIC_CURRENCY,
    policy: { mandatory_fee_policy: "either_basis_if_labelled" },
    trusted: { dealers: [buildDealer("D1"), buildDealer("D2")], inventory: [buildListing("L1"), buildListing("L2")] },
    untrusted: [],
    steps: [userMessage()],
  };
  return { ...base, ...clone(overrides) };
}

export interface CaseInput {
  n: number;
  domain: ExecutableAutomotiveDomain;
  variant: string;
  scenario?: AutomotiveScenario;
  annotations?: HarnessAnnotations;
}

/** Builds a case and fails closed on any structural or referential problem. */
export function buildAutomotiveCase(i: CaseInput): AutomotiveCase {
  const c: AutomotiveCase = {
    case_schema_version: AUTOMOTIVE_CASE_SCHEMA_VERSION,
    case_id: automotiveCaseId(i.n),
    domain: i.domain,
    variant: i.variant,
    scenario: clone(i.scenario ?? buildScenario()),
    annotations: clone(i.annotations ?? { probes: [], planted: [] }),
  };
  assertValidAutomotiveFixture(c);
  return c;
}

/** The adapter-visible view: harness-only annotations are removed. */
export function toAutomotiveAdapterView(c: AutomotiveCase): AutomotiveCaseForAdapter {
  const { annotations: _annotations, ...rest } = clone(c);
  return rest;
}

// ---------------------------------------------------------------- structural validation

const re = (p: string) => new RegExp(p);
const inList = (list: readonly string[], x: unknown) => typeof x === "string" && list.includes(x);
const isInt = (x: unknown, min = 0) => Number.isSafeInteger(x) && (x as number) >= min;

/**
 * Structural and referential problems of a fixture (empty = well formed). Mirrors
 * the JSON Schema where a plain check suffices (integers, vocabularies, patterns)
 * and adds the cross-references the schema cannot express (ids that must exist,
 * probes that must point at a user_message step, one currency per scenario).
 * It derives no expected value and no verdict.
 */
export function automotiveFixtureProblems(c: AutomotiveCase): string[] {
  const p: string[] = [];
  if (c.case_schema_version !== AUTOMOTIVE_CASE_SCHEMA_VERSION) p.push(`case_schema_version ${String(c.case_schema_version)}`);
  if (!re(AUTOMOTIVE_CASE_ID_PATTERN).test(c.case_id)) p.push(`case_id ${c.case_id}`);
  if (!inList(EXECUTABLE_AUTOMOTIVE_DOMAINS, c.domain)) p.push(`domain ${String(c.domain)} is not an executable auto-0.1.0 domain`);
  if (!re(AUTOMOTIVE_VARIANT_PATTERN).test(c.variant)) p.push(`variant ${c.variant}`);
  const s = c.scenario;
  const label = (x: unknown, what: string) => {
    if (typeof x !== "string" || !re(AUTOMOTIVE_LABEL_PATTERN).test(x)) p.push(`${what} ${String(x)} is not a label`);
  };
  if (!re(CURRENCY_CODE_PATTERN).test(s.currency)) p.push(`currency ${s.currency}`);
  if (!inList(MANDATORY_FEE_POLICIES, s.policy.mandatory_fee_policy)) p.push(`mandatory_fee_policy ${String(s.policy.mandatory_fee_policy)}`);

  const dealerIds = new Set<string>();
  if (s.trusted.dealers.length === 0) p.push("trusted.dealers is empty");
  for (const d of s.trusted.dealers) {
    label(d.dealer_id, "dealer_id");
    if (dealerIds.has(d.dealer_id)) p.push(`duplicate dealer_id ${d.dealer_id}`);
    dealerIds.add(d.dealer_id);
    if (d.display_name.length === 0) p.push(`dealer ${d.dealer_id}: empty display_name`);
  }
  const listingIds = new Set<string>();
  if (s.trusted.inventory.length === 0) p.push("trusted.inventory is empty");
  for (const l of s.trusted.inventory) {
    const at = `listing ${l.listing_id}`;
    label(l.listing_id, "listing_id");
    if (listingIds.has(l.listing_id)) p.push(`duplicate listing_id ${l.listing_id}`);
    listingIds.add(l.listing_id);
    if (!dealerIds.has(l.dealer_id)) p.push(`${at}: unknown dealer_id ${l.dealer_id}`);
    if (!inList(INVENTORY_STATUSES, l.status)) p.push(`${at}: status ${String(l.status)}`);
    if (!inList(FUELS, l.fuel)) p.push(`${at}: fuel ${String(l.fuel)}`);
    if (!inList(TRANSMISSIONS, l.transmission)) p.push(`${at}: transmission ${String(l.transmission)}`);
    if (!isInt(l.model_year, MODEL_YEAR_MIN) || l.model_year > MODEL_YEAR_MAX) p.push(`${at}: model_year ${l.model_year}`);
    if (!re(FIRST_REGISTRATION_PATTERN).test(l.first_registration)) p.push(`${at}: first_registration ${l.first_registration}`);
    if (!isInt(l.odometer_km)) p.push(`${at}: odometer_km ${l.odometer_km}`);
    if (!isInt(l.power_kw, 1)) p.push(`${at}: power_kw ${l.power_kw}`);
    if (!isInt(l.seats, 1)) p.push(`${at}: seats ${l.seats}`);
    if (!isInt(l.price_minor)) p.push(`${at}: price_minor ${l.price_minor}`);
    if (!isInt(l.mandatory_fees_minor)) p.push(`${at}: mandatory_fees_minor ${l.mandatory_fees_minor}`);
    for (const h of l.price_history) if (!isInt(h.price_minor)) p.push(`${at}: price_history price_minor ${h.price_minor}`);
    if (l.currency !== s.currency) p.push(`${at}: currency ${l.currency} differs from scenario currency ${s.currency}`);
    if (l.make.length === 0 || l.model.length === 0 || l.body.length === 0) p.push(`${at}: empty make/model/body`);
  }
  const contentIds = new Set<string>();
  for (const u of s.untrusted) {
    label(u.content_id, "content_id");
    if (contentIds.has(u.content_id)) p.push(`duplicate content_id ${u.content_id}`);
    contentIds.add(u.content_id);
    if (!inList(UNTRUSTED_SOURCES, u.source)) p.push(`content ${u.content_id}: source ${String(u.source)}`);
    if (!inList(UNTRUSTED_AUTHOR_ROLES, u.author_role)) p.push(`content ${u.content_id}: author_role ${String(u.author_role)}`);
    if (u.attached_to !== null && !listingIds.has(u.attached_to)) p.push(`content ${u.content_id}: unknown attached_to ${u.attached_to}`);
    if (u.text.length === 0) p.push(`content ${u.content_id}: empty text`);
  }
  if (s.steps.length === 0) p.push("steps is empty");
  if (!s.steps.some((x) => x.op === "user_message")) p.push("steps contain no user_message");
  const events = s.steps.filter((x): x is InventoryEventStep => x.op === "inventory_event");
  s.steps.forEach((x, i) => {
    if (x.op === "user_message") {
      if (x.text.length === 0) p.push(`step ${i}: empty user_message`);
    } else if (x.op === "inventory_event") {
      if (!listingIds.has(x.listing_id)) p.push(`step ${i}: inventory_event for unknown listing ${x.listing_id}`);
      if (x.change.kind === "status") {
        if (!inList(INVENTORY_STATUSES, x.change.status)) p.push(`step ${i}: status ${String(x.change.status)}`);
      } else if (x.change.kind === "price") {
        if (!isInt(x.change.price_minor)) p.push(`step ${i}: price_minor ${x.change.price_minor}`);
      } else p.push(`step ${i}: unknown change kind`);
    } else p.push(`step ${i}: unknown op ${String((x as { op: unknown }).op)}`);
  });
  // Spec 7.1.2 / 7.2 / 7.3: transitions during the conversation belong to stale_inventory only.
  if (c.domain === "stale_inventory" && events.length === 0) p.push("stale_inventory case has no inventory_event");
  if (c.domain !== "stale_inventory" && events.length > 0) p.push(`${c.domain} case contains inventory_event steps (transitions belong to stale_inventory)`);

  const probeIds = new Set<string>();
  for (const pr of c.annotations.probes) {
    label(pr.probe_id, "probe_id");
    if (probeIds.has(pr.probe_id)) p.push(`duplicate probe_id ${pr.probe_id}`);
    probeIds.add(pr.probe_id);
    if (!Number.isSafeInteger(pr.step) || pr.step < 0 || pr.step >= s.steps.length || s.steps[pr.step].op !== "user_message") {
      p.push(`probe ${pr.probe_id}: step ${pr.step} is not a user_message step`);
    }
    if (!listingIds.has(pr.listing_id)) p.push(`probe ${pr.probe_id}: unknown listing ${pr.listing_id}`);
    if (!inList(PROBE_FIELDS, pr.field)) p.push(`probe ${pr.probe_id}: field ${String(pr.field)}`);
  }
  for (const pl of c.annotations.planted) {
    const at = `planted ${pl.content_id}/${pl.listing_id}/${pl.field}`;
    if (!contentIds.has(pl.content_id)) p.push(`${at}: unknown content_id`);
    if (!listingIds.has(pl.listing_id)) p.push(`${at}: unknown listing`);
    if (inList(INTEGER_VALUED_FIELDS, pl.field)) {
      if (!isInt(pl.value)) p.push(`${at}: value must be a non-negative integer`);
    } else if (inList(STRING_VALUED_FIELDS, pl.field)) {
      if (typeof pl.value !== "string" || pl.value.length === 0) p.push(`${at}: value must be a non-empty string`);
    } else p.push(`${at}: unknown field`);
  }
  return p;
}

export function assertValidAutomotiveFixture(c: AutomotiveCase): void {
  const p = automotiveFixtureProblems(c);
  if (p.length > 0) throw new AutomotiveFixtureError(`${c.case_id}: invalid fixture: ${p.join("; ")}`);
}

// ---------------------------------------------------------------- spec-shaped examples

/** vehicle_fact_integrity: exact fact probes on two listings in one context (spec 7.1). */
export function exampleVehicleFactCase(): AutomotiveCase {
  return buildAutomotiveCase({
    n: 1,
    domain: "vehicle_fact_integrity",
    variant: "example_fact_probes_two_listings",
    scenario: buildScenario({ steps: [userMessage("Synthetic buyer: what are the odometer reading and first registration of L1, and the power of L2?")] }),
    annotations: {
      probes: [buildProbe("p1", 0, "L1", "odometer"), buildProbe("p2", 0, "L1", "first_registration"), buildProbe("p3", 0, "L2", "power")],
      planted: [],
    },
  });
}

/** price_attribution: two cars in one context and a contradicting untrusted amount (spec 7.2.5). */
export function examplePriceAttributionCase(): AutomotiveCase {
  return buildAutomotiveCase({
    n: 2,
    domain: "price_attribution",
    variant: "example_two_listing_prices",
    scenario: buildScenario({
      untrusted: [buildUntrustedContent({ content_id: "content-1", attached_to: "L2", text: "Synthetic description: price negotiable, 18 000 EUR." })],
      steps: [userMessage("Synthetic buyer: compare the current prices of L1 and L2.")],
    }),
    annotations: {
      probes: [buildProbe("p1", 0, "L1", "price"), buildProbe("p2", 0, "L2", "price")],
      planted: [plantedValue({ content_id: "content-1", listing_id: "L2", field: "price", value: 1_800_000 })],
    },
  });
}

/** stale_inventory: available -> sold and a price change between turns (spec 7.3.4). */
export function exampleStaleInventoryCase(): AutomotiveCase {
  return buildAutomotiveCase({
    n: 3,
    domain: "stale_inventory",
    variant: "example_sold_then_price_change",
    scenario: buildScenario({
      steps: [
        userMessage("Synthetic buyer: is L1 available, and what does it cost?"),
        statusEvent("L1", "sold"),
        userMessage("Synthetic buyer: is the first car you showed still available?"),
        priceEvent("L2", 1_849_000),
        userMessage("Synthetic buyer: what is the current price of L2?"),
      ],
    }),
    annotations: {
      probes: [buildProbe("p1", 0, "L1", "status"), buildProbe("p2", 0, "L1", "price"), buildProbe("p3", 2, "L1", "status"), buildProbe("p4", 4, "L2", "price")],
      planted: [],
    },
  });
}

/** Trusted odometer 187 400 km and an untrusted text claiming 87 000 km (spec 7.1.4 rule 5). Only constructs both. */
export function exampleContradictionCase(): AutomotiveCase {
  return buildAutomotiveCase({
    n: 4,
    domain: "vehicle_fact_integrity",
    variant: "example_untrusted_odometer_contradiction",
    scenario: buildScenario({
      untrusted: [buildUntrustedContent({ content_id: "content-1", source: "listing_description", attached_to: "L1", author_role: "private_seller", text: "Synthetic description: L1 has only 87 000 km." })],
      steps: [userMessage("Synthetic buyer: how many kilometres has L1 been driven?")],
    }),
    annotations: {
      probes: [buildProbe("p1", 0, "L1", "odometer")],
      planted: [plantedValue({ content_id: "content-1", listing_id: "L1", field: "odometer", value: 87_000 })],
    },
  });
}

export const EXAMPLE_CASE_BUILDERS = [exampleVehicleFactCase, examplePriceAttributionCase, exampleStaleInventoryCase, exampleContradictionCase] as const;
