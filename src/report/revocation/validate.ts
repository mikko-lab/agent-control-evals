import Ajv from 'ajv/dist/2020';
import observationSchema from '../../../schemas/revocation/observation.schema.json';
import reportSchema from '../../../schemas/revocation/report.schema.json';
import runtimeObservationSchema from '../../../schemas/revocation/runtime-observation.schema.json';
import runtimeObservation2Schema from '../../../schemas/revocation/runtime-observation-2.schema.json';
import { RUNTIME_OBSERVATION_FORMAT_2 } from '../../spec/revocation/model';
import profileReportSchema from '../../../schemas/revocation/profile-report.schema.json';
const ajv = new Ajv({ allErrors: true, strict: true });
const observation = ajv.compile(observationSchema);
const report = ajv.compile(reportSchema);
const runtimeObservation = ajv.compile(runtimeObservationSchema);
const runtimeObservation2 = ajv.compile(runtimeObservation2Schema);
const profileReport = ajv.compile(profileReportSchema);
/** Schema issues with their JSON-pointer instance paths, so item-level defects can be isolated from envelope defects. */
export function observationIssues(value: unknown): { path: string; message: string }[] {
  return observation(value) ? [] : (observation.errors ?? []).map(e => ({ path: e.instancePath, message: `${e.instancePath || '/'}: ${e.message}` }));
}
/**
 * Schema issues of a revocation-0.4.0 pinned-runtime-adapter observation (with provenance, seq, probes and calls).
 * An observation that declares format 2 is checked against revision 2; any other against the unchanged revision 1.
 */
export function runtimeObservationIssues(value: unknown): { path: string; message: string }[] {
  const v2 = typeof value === 'object' && value !== null && (value as { format?: unknown }).format === RUNTIME_OBSERVATION_FORMAT_2;
  const validate = v2 ? runtimeObservation2 : runtimeObservation;
  return validate(value) ? [] : (validate.errors ?? []).map(e => ({ path: e.instancePath, message: `${e.instancePath || '/'}: ${e.message}` }));
}
/** The runtime observation format revision an observation declares (1 when it declares none). */
export const runtimeObservationFormat = (value: unknown): 1 | 2 => (typeof value === 'object' && value !== null && (value as { format?: unknown }).format === RUNTIME_OBSERVATION_FORMAT_2 ? 2 : 1);
export function validateObservation(value: unknown): string[] { return observationIssues(value).map(i => i.message); }
export function validateReport(value: unknown): string[] { return report(value) ? [] : (report.errors ?? []).map(e => `${e.instancePath}: ${e.message}`); }
export function validateProfileReport(value: unknown): string[] { return profileReport(value) ? [] : (profileReport.errors ?? []).map(e => `${e.instancePath}: ${e.message}`); }
