/**
 * Automotive adapter protocol (auto-adapter-0.1.0): process boundary, JSON Lines
 * over stdin/stdout. Types and strict structural validation only.
 *
 * The adapter reports what the SUT presented, as structured observations. It does
 * not decide whether those observations agree with the oracle: a wrong value, a
 * stale price, a cross-listing value or an unknown listing id is valid evidence,
 * never a protocol error. Protocol errors are reserved for malformed records:
 * wrong versions or ids, missing or duplicate step records, event
 * acknowledgements bound to a different event, impossible channel states,
 * malformed units, attributions or vocabularies, and non-integer numbers.
 *
 * Independent of the JSON Schema (schemas/automotive/adapter-protocol.schema.json):
 * this module validates everything the schema validates, plus the bindings to the
 * sent case (turn completeness, event acknowledgements) that a schema cannot
 * express. It imports no oracle, corpus generator, verdict or reason vocabulary.
 */
import { AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION } from "../../spec/automotive/version";
import {
  CURRENCY_CODE_PATTERN,
  FIRST_REGISTRATION_PATTERN,
  INVENTORY_STATUSES,
  PROBE_FIELDS,
  type AutomotiveCaseForAdapter,
  type InventoryChange,
  type ProbeField,
} from "../../corpus/automotive/types";

export class AutomotiveProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomotiveProtocolError";
  }
}

// ---------------------------------------------------------------- vocabularies

/** Channel observation states (semantics shared with, but not typed as, the ACS adapter's). */
export const AUTOMOTIVE_OBSERVATION_STATES = ["observed", "not_observed", "ambiguous", "unavailable"] as const;
/** Where a channel's observations come from. Free-text extraction is not a source in auto-0.1.0. */
export const AUTOMOTIVE_OBSERVATION_SOURCES = ["sut_structured_output", "adapter_structured_mapping", "none"] as const;
export const CLAIM_ATTRIBUTION_KINDS = ["trusted_fact", "quoted_untrusted", "approximate", "unknown"] as const;
/**
 * Vehicle-fact claim fields (canonical claim names, never storage names). Status is a separate claim kind.
 * Observed fuel and transmission values are open (any non-empty string): the case vocabularies describe
 * synthetic trusted input, not every value a SUT may present.
 */
export const OBSERVED_FACT_FIELDS = ["odometer", "model_year", "first_registration", "fuel", "transmission", "power"] as const;
export const OBSERVED_PRICE_BASES = ["listing_price", "total_with_mandatory_fees", "unknown"] as const;
export const PRICE_TEMPORAL_QUALIFIERS = ["current", "previous", "offer", "unknown"] as const;
/** Observed status vocabulary. `unavailable` and `unknown` are presentations, not trusted inventory states. */
export const OBSERVED_STATUSES = ["available", "reserved", "sold", "unavailable", "unknown"] as const;
export const REFERENCE_KINDS = ["mentioned", "recommended"] as const;
export const UNVERIFIABLE_CLASSIFICATIONS = ["qualitative", "approximate", "range", "outside_contract"] as const;
export const EVENT_DELIVERY_STATES = ["delivered", "not_delivered", "ambiguous", "unavailable"] as const;
export const EVENT_DELIVERY_SOURCES = ["push_ack", "pull_data_source_updated", "none"] as const;
export const CASE_RESULT_STATUSES = ["ok", "adapter_error"] as const;

export type AutomotiveObservationState = (typeof AUTOMOTIVE_OBSERVATION_STATES)[number];
export type AutomotiveObservationSource = (typeof AUTOMOTIVE_OBSERVATION_SOURCES)[number];
export type ClaimAttributionKind = (typeof CLAIM_ATTRIBUTION_KINDS)[number];
export type ObservedFactField = (typeof OBSERVED_FACT_FIELDS)[number];
export type ObservedPriceBasis = (typeof OBSERVED_PRICE_BASES)[number];
export type PriceTemporalQualifier = (typeof PRICE_TEMPORAL_QUALIFIERS)[number];
export type ObservedStatus = (typeof OBSERVED_STATUSES)[number];
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];
export type UnverifiableClassification = (typeof UNVERIFIABLE_CLASSIFICATIONS)[number];
export type EventDeliveryState = (typeof EVENT_DELIVERY_STATES)[number];
export type EventDeliverySource = (typeof EVENT_DELIVERY_SOURCES)[number];

/** Canonical unit of each observed fact field (null = string-valued, no unit). */
export const OBSERVED_FACT_UNIT = {
  odometer: "km",
  model_year: "year",
  first_registration: null,
  fuel: null,
  transmission: null,
  power: "kW",
} as const satisfies Record<ObservedFactField, "km" | "year" | "kW" | null>;

// ---------------------------------------------------------------- observation types

export interface AutomotiveChannelObservation {
  state: AutomotiveObservationState;
  source: AutomotiveObservationSource;
  detail: string | null;
}

/** How the SUT/adapter presented a claim. It does not make the claim correct. */
export type AutomotiveClaimAttribution = { kind: "trusted_fact" } | { kind: "quoted_untrusted"; content_id: string } | { kind: "approximate" } | { kind: "unknown" };

export type AutomotiveObservedFactClaim =
  | { kind: "vehicle_fact"; listing_id: string; field: "odometer"; value: number; unit: "km"; attribution: AutomotiveClaimAttribution }
  | { kind: "vehicle_fact"; listing_id: string; field: "model_year"; value: number; unit: "year"; attribution: AutomotiveClaimAttribution }
  | { kind: "vehicle_fact"; listing_id: string; field: "power"; value: number; unit: "kW"; attribution: AutomotiveClaimAttribution }
  | { kind: "vehicle_fact"; listing_id: string; field: "first_registration" | "fuel" | "transmission"; value: string; unit: null; attribution: AutomotiveClaimAttribution };

export interface AutomotiveObservedPriceClaim {
  kind: "price";
  listing_id: string;
  field: "price";
  amount_minor: number;
  /** Upper-case ISO-style code, or null when no currency can be attributed. Never filled in from the scenario. */
  currency: string | null;
  basis: ObservedPriceBasis;
  temporal_qualifier: PriceTemporalQualifier;
  attribution: AutomotiveClaimAttribution;
}

export interface AutomotiveObservedStatusClaim {
  kind: "status";
  listing_id: string;
  field: "status";
  status: ObservedStatus;
  attribution: AutomotiveClaimAttribution;
}

export type AutomotiveObservedClaim = AutomotiveObservedFactClaim | AutomotiveObservedPriceClaim | AutomotiveObservedStatusClaim;

/** Informational record of a statement outside the exact claim contract. Not a verdict, not an exact claim. */
export interface AutomotiveUnverifiableClaim {
  listing_id: string | null;
  field: ProbeField | null;
  classification: UnverifiableClassification;
  text: string;
}

export interface AutomotiveObservedReference {
  listing_id: string;
  kind: ReferenceKind;
}

/** A status the turn presented for a listing independently of any conversational claim (e.g. a badge). */
export interface AutomotiveStatusPresentation {
  listing_id: string;
  status: ObservedStatus;
}

/** Exactly one per user_message step, including silent turns. */
export interface AutomotiveTurnObservation {
  step: number;
  claim_channel: AutomotiveChannelObservation;
  claims: AutomotiveObservedClaim[];
  unverifiable_claims: AutomotiveUnverifiableClaim[];
  reference_channel: AutomotiveChannelObservation;
  references: AutomotiveObservedReference[];
  status_channel: AutomotiveChannelObservation;
  status_presentations: AutomotiveStatusPresentation[];
}

/** Exactly one per inventory_event step, bound to that event's listing and change. */
export interface AutomotiveEventAcknowledgement {
  step: number;
  listing_id: string;
  change: InventoryChange;
  delivery: { state: EventDeliveryState; source: EventDeliverySource; detail: string | null };
}

export interface AutomotiveObservations {
  turns: AutomotiveTurnObservation[];
  event_acknowledgements: AutomotiveEventAcknowledgement[];
}

// ---------------------------------------------------------------- messages

export type HarnessToAutomotiveAdapter =
  | { type: "hello"; protocol_version: typeof AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION }
  | { type: "case"; protocol_version: typeof AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION; case: AutomotiveCaseForAdapter }
  | { type: "shutdown"; protocol_version: typeof AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION };

/** Vendor-neutral identity. `revision` may be a commit, an image digest or a build id; null when none is exposed. */
export interface AutomotiveHelloResponse {
  type: "hello";
  protocol_version: typeof AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION;
  adapter: string;
  adapter_version: string;
  sut: { name: string; version: string; revision: string | null };
}

interface CaseResultBase {
  type: "case_result";
  protocol_version: typeof AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION;
  case_id: string;
  /** Adapter-specific material kept for review. Never interpreted by the protocol layer. */
  raw_sut_evidence: unknown;
}

/** adapter_error is valid protocol evidence that the adapter could not observe the case; it is not a SUT verdict. */
export type AutomotiveCaseResult =
  | (CaseResultBase & { status: "ok"; observations: AutomotiveObservations; error: null })
  | (CaseResultBase & { status: "adapter_error"; observations: null; error: { message: string } });

const ADAPTER_CASE_KEYS = ["case_id", "case_schema_version", "domain", "scenario", "variant"] as const;

/**
 * Builds the case message from an adapter view. Fails closed if the object carries
 * anything beyond the adapter view (annotations, expected output, corpus-entry
 * metadata), because a full AutomotiveCase or a corpus entry is structurally
 * assignable to the view type and must never be sent by accident.
 */
export function automotiveCaseMessage(view: AutomotiveCaseForAdapter): Extract<HarnessToAutomotiveAdapter, { type: "case" }> {
  const keys = Object.keys(view as object).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...ADAPTER_CASE_KEYS])) {
    throw new AutomotiveProtocolError(`case message must carry exactly the adapter view ${JSON.stringify(ADAPTER_CASE_KEYS)}, got ${JSON.stringify(keys)}`);
  }
  return { type: "case", protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, case: view };
}

// ---------------------------------------------------------------- validation helpers

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
function fail(where: string, msg: string): never {
  throw new AutomotiveProtocolError(`${where}: ${msg}`);
}

function obj(x: unknown, keys: readonly string[], where: string): Obj {
  if (!isObj(x)) fail(where, "must be an object");
  const o = x as Obj;
  for (const k of keys) if (!(k in o)) fail(where, `missing ${k}`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(where, `unexpected property ${k}`);
  return o;
}
function nonEmpty(x: unknown, where: string): string {
  if (typeof x !== "string" || x.length === 0) fail(where, "must be a non-empty string");
  return x as string;
}
function nonEmptyOrNull(x: unknown, where: string): string | null {
  return x === null ? null : nonEmpty(x, where);
}
function count(x: unknown, where: string): number {
  if (!Number.isSafeInteger(x) || (x as number) < 0) fail(where, `must be a non-negative integer, got ${JSON.stringify(x)}`);
  return x as number;
}
function oneOf<T extends string>(list: readonly T[], x: unknown, where: string): T {
  if (typeof x !== "string" || !(list as readonly string[]).includes(x)) fail(where, `must be one of ${list.join("|")}, got ${JSON.stringify(x)}`);
  return x as T;
}
function arr(x: unknown, where: string): unknown[] {
  if (!Array.isArray(x)) fail(where, "must be an array");
  return x as unknown[];
}
const version = (x: unknown, where: string) => {
  if (x !== AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION) fail(where, `protocol_version ${JSON.stringify(x)} != ${AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION}`);
};

function channel(x: unknown, where: string): AutomotiveChannelObservation {
  const o = obj(x, ["state", "source", "detail"], where);
  const state = oneOf(AUTOMOTIVE_OBSERVATION_STATES, o.state, `${where}.state`);
  const source = oneOf(AUTOMOTIVE_OBSERVATION_SOURCES, o.source, `${where}.source`);
  if (state === "unavailable" && source !== "none") fail(where, "an unavailable channel must use source none");
  if (state !== "unavailable" && source === "none") fail(where, `a ${state} channel must not use source none`);
  nonEmptyOrNull(o.detail, `${where}.detail`);
  return o as unknown as AutomotiveChannelObservation;
}

function attribution(x: unknown, where: string): void {
  if (!isObj(x)) fail(where, "must be an object");
  const kind = oneOf(CLAIM_ATTRIBUTION_KINDS, (x as Obj).kind, `${where}.kind`);
  if (kind === "quoted_untrusted") {
    // The cited content id is recorded as presented; whether it exists in the case is for the evaluator.
    nonEmpty(obj(x, ["kind", "content_id"], where).content_id, `${where}.content_id`);
  } else obj(x, ["kind"], where);
}

function claim(x: unknown, where: string): void {
  if (!isObj(x)) fail(where, "must be an object");
  const kind = (x as Obj).kind;
  if (kind === "vehicle_fact") {
    const o = obj(x, ["kind", "listing_id", "field", "value", "unit", "attribution"], where);
    nonEmpty(o.listing_id, `${where}.listing_id`);
    const field = oneOf(OBSERVED_FACT_FIELDS, o.field, `${where}.field`);
    const unit = OBSERVED_FACT_UNIT[field];
    if (o.unit !== unit) fail(`${where}.unit`, `${field} requires unit ${JSON.stringify(unit)}, got ${JSON.stringify(o.unit)}`);
    if (unit !== null) count(o.value, `${where}.value`);
    else if (field === "first_registration") {
      if (typeof o.value !== "string" || !new RegExp(FIRST_REGISTRATION_PATTERN).test(o.value)) fail(`${where}.value`, "first_registration must be YYYY-MM");
    } else {
      // Open observation vocabulary: any non-empty string. The synthetic FUELS / TRANSMISSIONS lists constrain
      // trusted input only; an observed "hydrogen" or "cvt" is evidence for the evaluator, not a protocol error.
      nonEmpty(o.value, `${where}.value`);
    }
    attribution(o.attribution, `${where}.attribution`);
  } else if (kind === "price") {
    const o = obj(x, ["kind", "listing_id", "field", "amount_minor", "currency", "basis", "temporal_qualifier", "attribution"], where);
    nonEmpty(o.listing_id, `${where}.listing_id`);
    if (o.field !== "price") fail(`${where}.field`, "must be price");
    count(o.amount_minor, `${where}.amount_minor`);
    if (o.currency !== null && (typeof o.currency !== "string" || !new RegExp(CURRENCY_CODE_PATTERN).test(o.currency))) fail(`${where}.currency`, "must be an upper-case 3-letter code or null");
    oneOf(OBSERVED_PRICE_BASES, o.basis, `${where}.basis`);
    oneOf(PRICE_TEMPORAL_QUALIFIERS, o.temporal_qualifier, `${where}.temporal_qualifier`);
    attribution(o.attribution, `${where}.attribution`);
  } else if (kind === "status") {
    const o = obj(x, ["kind", "listing_id", "field", "status", "attribution"], where);
    nonEmpty(o.listing_id, `${where}.listing_id`);
    if (o.field !== "status") fail(`${where}.field`, "must be status");
    oneOf(OBSERVED_STATUSES, o.status, `${where}.status`);
    attribution(o.attribution, `${where}.attribution`);
  } else fail(`${where}.kind`, `unknown claim kind ${JSON.stringify(kind)}`);
}

function unverifiable(x: unknown, where: string): void {
  const o = obj(x, ["listing_id", "field", "classification", "text"], where);
  nonEmptyOrNull(o.listing_id, `${where}.listing_id`);
  if (o.field !== null) oneOf(PROBE_FIELDS, o.field, `${where}.field`);
  oneOf(UNVERIFIABLE_CLASSIFICATIONS, o.classification, `${where}.classification`);
  nonEmpty(o.text, `${where}.text`);
}

/** Channel/collection consistency: items only on an observed channel, and an observed channel has items. */
function consistent(ch: AutomotiveChannelObservation, items: number, where: string): void {
  if (items > 0 && ch.state !== "observed") fail(where, `${items} item(s) recorded on a ${ch.state} channel`);
  if (items === 0 && ch.state === "observed") fail(where, "an observed channel must record at least one item (use not_observed for silence)");
}

function turn(x: unknown, where: string): AutomotiveTurnObservation {
  const o = obj(x, ["step", "claim_channel", "claims", "unverifiable_claims", "reference_channel", "references", "status_channel", "status_presentations"], where);
  count(o.step, `${where}.step`);
  const cc = channel(o.claim_channel, `${where}.claim_channel`);
  const claims = arr(o.claims, `${where}.claims`);
  claims.forEach((c, i) => claim(c, `${where}.claims[${i}]`));
  const unv = arr(o.unverifiable_claims, `${where}.unverifiable_claims`);
  unv.forEach((u, i) => unverifiable(u, `${where}.unverifiable_claims[${i}]`));
  consistent(cc, claims.length + unv.length, `${where}.claim_channel`);
  const rc = channel(o.reference_channel, `${where}.reference_channel`);
  const refs = arr(o.references, `${where}.references`);
  refs.forEach((r, i) => {
    const ro = obj(r, ["listing_id", "kind"], `${where}.references[${i}]`);
    nonEmpty(ro.listing_id, `${where}.references[${i}].listing_id`);
    oneOf(REFERENCE_KINDS, ro.kind, `${where}.references[${i}].kind`);
  });
  consistent(rc, refs.length, `${where}.reference_channel`);
  const sc = channel(o.status_channel, `${where}.status_channel`);
  const sps = arr(o.status_presentations, `${where}.status_presentations`);
  sps.forEach((s, i) => {
    const so = obj(s, ["listing_id", "status"], `${where}.status_presentations[${i}]`);
    nonEmpty(so.listing_id, `${where}.status_presentations[${i}].listing_id`);
    oneOf(OBSERVED_STATUSES, so.status, `${where}.status_presentations[${i}].status`);
  });
  consistent(sc, sps.length, `${where}.status_channel`);
  return o as unknown as AutomotiveTurnObservation;
}

function change(x: unknown, where: string): InventoryChange {
  if (!isObj(x)) fail(where, "must be an object");
  const kind = (x as Obj).kind;
  if (kind === "status") oneOf(INVENTORY_STATUSES, obj(x, ["kind", "status"], where).status, `${where}.status`);
  else if (kind === "price") count(obj(x, ["kind", "price_minor"], where).price_minor, `${where}.price_minor`);
  else fail(`${where}.kind`, `unknown change kind ${JSON.stringify(kind)}`);
  return x as InventoryChange;
}

const sameChange = (a: InventoryChange, b: InventoryChange) =>
  a.kind === b.kind && (a.kind === "status" ? a.status === (b as typeof a).status : a.price_minor === (b as typeof a).price_minor);

function eventAck(x: unknown, where: string): AutomotiveEventAcknowledgement {
  const o = obj(x, ["step", "listing_id", "change", "delivery"], where);
  count(o.step, `${where}.step`);
  nonEmpty(o.listing_id, `${where}.listing_id`);
  change(o.change, `${where}.change`);
  const d = obj(o.delivery, ["state", "source", "detail"], `${where}.delivery`);
  const state = oneOf(EVENT_DELIVERY_STATES, d.state, `${where}.delivery.state`);
  const source = oneOf(EVENT_DELIVERY_SOURCES, d.source, `${where}.delivery.source`);
  if (state === "unavailable" && source !== "none") fail(`${where}.delivery`, "an unavailable acknowledgement must use source none");
  if (state !== "unavailable" && source === "none") fail(`${where}.delivery`, `a ${state} acknowledgement must not use source none`);
  nonEmptyOrNull(d.detail, `${where}.delivery.detail`);
  return o as unknown as AutomotiveEventAcknowledgement;
}

/** Structure plus completeness and binding against the case that was sent. */
function observations(x: unknown, sent: AutomotiveCaseForAdapter, where: string): AutomotiveObservations {
  const o = obj(x, ["turns", "event_acknowledgements"], where);
  const steps = sent.scenario.steps;
  const turns = arr(o.turns, `${where}.turns`).map((t, i) => turn(t, `${where}.turns[${i}]`));
  const seenTurns = new Set<number>();
  for (const t of turns) {
    const s = steps[t.step];
    if (s === undefined) fail(`${where}.turns`, `observation for nonexistent step ${t.step}`);
    if (s.op !== "user_message") fail(`${where}.turns`, `observation attached to step ${t.step}, which is an ${s.op} step`);
    if (seenTurns.has(t.step)) fail(`${where}.turns`, `duplicate observation for step ${t.step}`);
    seenTurns.add(t.step);
  }
  const acks = arr(o.event_acknowledgements, `${where}.event_acknowledgements`).map((a, i) => eventAck(a, `${where}.event_acknowledgements[${i}]`));
  const seenAcks = new Set<number>();
  for (const a of acks) {
    const s = steps[a.step];
    if (s === undefined) fail(`${where}.event_acknowledgements`, `acknowledgement for nonexistent step ${a.step}`);
    if (s.op !== "inventory_event") fail(`${where}.event_acknowledgements`, `acknowledgement attached to step ${a.step}, which is a ${s.op} step`);
    if (seenAcks.has(a.step)) fail(`${where}.event_acknowledgements`, `duplicate acknowledgement for step ${a.step}`);
    seenAcks.add(a.step);
    if (a.listing_id !== s.listing_id) fail(`${where}.event_acknowledgements`, `step ${a.step} acknowledges listing ${a.listing_id}, the event is for ${s.listing_id}`);
    if (!sameChange(a.change, s.change)) fail(`${where}.event_acknowledgements`, `step ${a.step} acknowledges ${JSON.stringify(a.change)}, the event is ${JSON.stringify(s.change)}`);
  }
  steps.forEach((s, i) => {
    if (s.op === "user_message" && !seenTurns.has(i)) fail(`${where}.turns`, `missing observation for user_message step ${i}`);
    if (s.op === "inventory_event" && !seenAcks.has(i)) fail(`${where}.event_acknowledgements`, `missing acknowledgement for inventory_event step ${i}`);
  });
  return { turns, event_acknowledgements: acks };
}

// ---------------------------------------------------------------- public validators

export function validateAutomotiveHello(x: unknown): AutomotiveHelloResponse {
  const o = obj(x, ["type", "protocol_version", "adapter", "adapter_version", "sut"], "hello");
  if (o.type !== "hello") fail("hello", `type must be hello, got ${JSON.stringify(o.type)}`);
  version(o.protocol_version, "hello");
  nonEmpty(o.adapter, "hello.adapter");
  nonEmpty(o.adapter_version, "hello.adapter_version");
  const s = obj(o.sut, ["name", "version", "revision"], "hello.sut");
  nonEmpty(s.name, "hello.sut.name");
  nonEmpty(s.version, "hello.sut.version");
  nonEmptyOrNull(s.revision, "hello.sut.revision");
  return o as unknown as AutomotiveHelloResponse;
}

/**
 * Strict validation of one case result against the case that was sent. Anything
 * malformed throws AutomotiveProtocolError; an incorrect but well-formed
 * observation is returned unchanged as evidence.
 */
export function validateAutomotiveCaseResult(x: unknown, sent: AutomotiveCaseForAdapter): AutomotiveCaseResult {
  const where = `case_result(${sent.case_id})`;
  const o = obj(x, ["type", "protocol_version", "case_id", "status", "observations", "raw_sut_evidence", "error"], where);
  if (o.type !== "case_result") fail(where, `type must be case_result, got ${JSON.stringify(o.type)}`);
  version(o.protocol_version, where);
  if (o.case_id !== sent.case_id) fail(where, `case_id ${JSON.stringify(o.case_id)} != sent ${sent.case_id}`);
  const status = oneOf(CASE_RESULT_STATUSES, o.status, `${where}.status`);
  if (status === "adapter_error") {
    if (o.observations !== null) fail(where, "adapter_error must carry observations: null");
    nonEmpty(obj(o.error, ["message"], `${where}.error`).message, `${where}.error.message`);
  } else {
    if (o.error !== null) fail(where, "status ok must carry error: null");
    if (o.observations === null) fail(where, "status ok requires observations");
    observations(o.observations, sent, `${where}.observations`);
  }
  return o as unknown as AutomotiveCaseResult;
}
