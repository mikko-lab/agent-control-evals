// Deterministic fake automotive adapter for protocol contract tests (auto-adapter-0.2.0).
// Mode is argv[2]. No network, no filesystem, no oracle: valid responses are derived
// mechanically from the received adapter view (initial trusted values, no event
// simulation). This is a protocol fixture, not a reference agent.
"use strict";
const readline = require("node:readline");

const VERSION = "auto-adapter-0.2.0";
const mode = process.argv[2] || "valid";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ch = (state, source = "sut_structured_output", detail = null) => ({ state, source: state === "unavailable" ? "none" : source, detail });
const trusted = { kind: "trusted_fact" };

function hello() {
  return {
    type: "hello",
    protocol_version: mode === "wrong_protocol_version" ? "auto-adapter-9.9.9" : VERSION,
    adapter: "fake-automotive-adapter",
    adapter_version: "0.1.0",
    sut: { name: "synthetic-fake-sut", version: "0.0.0", revision: null },
  };
}

function baseTurn(c, step) {
  const s = c.scenario;
  const l = s.trusted.inventory[0];
  return {
    step,
    claim_channel: ch("observed"),
    claims: [
      { kind: "vehicle_fact", listing_id: l.listing_id, field: "odometer", value: l.odometer_km, unit: "km", attribution: trusted },
      { kind: "price", listing_id: l.listing_id, field: "price", amount_minor: l.price_minor, currency: s.currency, basis: "listing_price", temporal_qualifier: "current", attribution: trusted },
      { kind: "status", listing_id: l.listing_id, field: "status", status: l.status, attribution: trusted },
    ],
    unverifiable_claims: [],
    reference_channel: ch("observed", "adapter_structured_mapping"),
    references: s.trusted.inventory.map((x) => ({ listing_id: x.listing_id, kind: "mentioned" })),
    status_channel: ch("observed", "adapter_structured_mapping"),
    status_presentations: s.trusted.inventory.map((x) => ({ listing_id: x.listing_id, status: x.status })),
    recommendation_channel: ch("not_observed"),
    recommendation: null,
  };
}

function silentTurn(step, state) {
  return { step, claim_channel: ch(state), claims: [], unverifiable_claims: [], reference_channel: ch(state), references: [], status_channel: ch(state), status_presentations: [], recommendation_channel: ch(state), recommendation: null };
}

function fidelityTurn(c, step) {
  const s = c.scenario;
  const [a, b] = s.trusted.inventory;
  const quoted = s.untrusted.length > 0 ? s.untrusted[0].content_id : "content-not-in-case";
  return {
    step,
    claim_channel: ch("observed"),
    claims: [
      { kind: "vehicle_fact", listing_id: a.listing_id, field: "model_year", value: a.model_year, unit: "year", attribution: trusted },
      { kind: "vehicle_fact", listing_id: a.listing_id, field: "first_registration", value: a.first_registration, unit: null, attribution: trusted },
      { kind: "vehicle_fact", listing_id: a.listing_id, field: "fuel", value: a.fuel, unit: null, attribution: trusted },
      { kind: "vehicle_fact", listing_id: a.listing_id, field: "transmission", value: a.transmission, unit: null, attribution: trusted },
      { kind: "vehicle_fact", listing_id: a.listing_id, field: "power", value: a.power_kw, unit: "kW", attribution: trusted },
      { kind: "vehicle_fact", listing_id: a.listing_id, field: "odometer", value: 87000, unit: "km", attribution: { kind: "quoted_untrusted", content_id: quoted } },
      { kind: "vehicle_fact", listing_id: b.listing_id, field: "odometer", value: 65000, unit: "km", attribution: { kind: "approximate" } },
      { kind: "price", listing_id: a.listing_id, field: "price", amount_minor: 2249000, currency: null, basis: "unknown", temporal_qualifier: "previous", attribution: { kind: "unknown" } },
      { kind: "price", listing_id: b.listing_id, field: "price", amount_minor: 1800000, currency: s.currency, basis: "total_with_mandatory_fees", temporal_qualifier: "offer", attribution: trusted },
      { kind: "status", listing_id: a.listing_id, field: "status", status: "available", attribution: trusted },
    ],
    unverifiable_claims: [{ listing_id: a.listing_id, field: null, classification: "qualitative", text: "Synthetic: low mileage for its age." }],
    reference_channel: ch("observed", "adapter_structured_mapping"),
    references: [
      { listing_id: a.listing_id, kind: "recommended" },
      { listing_id: b.listing_id, kind: "mentioned" },
    ],
    status_channel: ch("observed", "adapter_structured_mapping"),
    // Deliberately disagrees with the status claim above: observed behaviour, not malformed protocol.
    status_presentations: [{ listing_id: a.listing_id, status: "sold" }],
    recommendation_channel: ch("not_observed"),
    recommendation: null,
  };
}

function observe(c) {
  const steps = c.scenario.steps;
  const turns = [];
  const acks = [];
  steps.forEach((s, i) => {
    if (s.op === "user_message") {
      if (mode === "silent_claim_channel") turns.push(silentTurn(i, "not_observed"));
      else if (mode === "channel_unavailable") turns.push(silentTurn(i, "unavailable"));
      else if (mode === "mapping_fidelity") turns.push(fidelityTurn(c, i));
      else turns.push(baseTurn(c, i));
    } else {
      const unavailable = mode === "channel_unavailable";
      acks.push({
        step: i,
        listing_id: s.listing_id,
        change: s.change,
        delivery: unavailable ? { state: "unavailable", source: "none", detail: "no delivery channel" } : { state: "delivered", source: "push_ack", detail: null },
      });
    }
  });
  const t0 = turns[0];
  switch (mode) {
    case "missing_turn":
      turns.pop();
      break;
    case "duplicate_turn":
      turns.push(JSON.parse(JSON.stringify(t0)));
      break;
    case "turn_on_event_step": {
      const ev = steps.findIndex((s) => s.op === "inventory_event");
      turns.push({ ...JSON.parse(JSON.stringify(t0)), step: ev >= 0 ? ev : steps.length });
      break;
    }
    case "missing_event_ack":
      acks.pop();
      break;
    case "wrong_event_binding":
      if (acks[0]) acks[0] = { ...acks[0], listing_id: acks[0].listing_id === "L2" ? "L1" : "L2" };
      break;
    case "observed_empty_channel":
      t0.claims = [];
      break;
    case "unavailable_with_claim":
      t0.claim_channel = ch("unavailable");
      break;
    case "float_price":
      t0.claims[1].amount_minor = 2149000.5;
      break;
    case "wrong_unit":
      t0.claims[0].unit = "mi";
      break;
    case "quoted_untrusted":
      t0.claims[0].attribution = { kind: "quoted_untrusted", content_id: c.scenario.untrusted.length > 0 ? c.scenario.untrusted[0].content_id : "content-not-in-case" };
      break;
    case "unknown_listing":
      t0.claims[0].listing_id = "L999";
      t0.references.push({ listing_id: "L999", kind: "recommended" });
      break;
    case "open_vocabulary": {
      // Values outside the synthetic input vocabulary: wrong for a diesel automatic, but valid observations.
      const id = c.scenario.trusted.inventory[0].listing_id;
      t0.claims = [
        { kind: "vehicle_fact", listing_id: id, field: "fuel", value: "hydrogen", unit: null, attribution: trusted },
        { kind: "vehicle_fact", listing_id: id, field: "transmission", value: "cvt", unit: null, attribution: trusted },
      ];
      break;
    }
    case "cross_listing_value": {
      // The SUT presents another listing's price on the first listing: wrong, but faithfully reported.
      const other = c.scenario.trusted.inventory[1];
      if (other) t0.claims[1].amount_minor = other.price_minor;
      break;
    }
    default:
      break;
  }
  return { turns, event_acknowledgements: acks };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "hello") return out(hello());
  if (msg.type === "shutdown") process.exit(0);
  if (msg.type !== "case") process.exit(5);
  const c = msg.case;
  const base = { type: "case_result", protocol_version: VERSION, case_id: c.case_id };
  switch (mode) {
    case "malformed_json":
      return process.stdout.write("{not json\n");
    case "hang":
      return;
    case "premature_exit":
      return process.exit(9);
    case "adapter_error":
      return out({ ...base, status: "adapter_error", observations: null, raw_sut_evidence: { note: "synthetic failure" }, error: { message: "synthetic adapter failure" } });
    case "wrong_case_id":
      return out({ ...base, case_id: "auto-case-999999", status: "ok", observations: observe(c), raw_sut_evidence: null, error: null });
    default:
      return out({ ...base, status: "ok", observations: observe(c), raw_sut_evidence: { mode }, error: null });
  }
});
