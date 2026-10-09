import Ajv from 'ajv/dist/2020';
import observationSchema from '../../../schemas/revocation/observation.schema.json';
import reportSchema from '../../../schemas/revocation/report.schema.json';
import runtimeObservationSchema from '../../../schemas/revocation/runtime-observation.schema.json';
import profileReportSchema from '../../../schemas/revocation/profile-report.schema.json';
const ajv = new Ajv({ allErrors: true, strict: true });
const observation = ajv.compile(observationSchema);
const report = ajv.compile(reportSchema);
const runtimeObservation = ajv.compile(runtimeObservationSchema);
const profileReport = ajv.compile(profileReportSchema);
/** Schema issues with their JSON-pointer instance paths, so item-level defects can be isolated from envelope defects. */
export function observationIssues(value: unknown): { path: string; message: string }[] {
  return observation(value) ? [] : (observation.errors ?? []).map(e => ({ path: e.instancePath, message: `${e.instancePath || '/'}: ${e.message}` }));
}
/** Schema issues of a revocation-0.4.0 pinned-runtime-adapter observation (with provenance, seq, probes and calls). */
export function runtimeObservationIssues(value: unknown): { path: string; message: string }[] {
  return runtimeObservation(value) ? [] : (runtimeObservation.errors ?? []).map(e => ({ path: e.instancePath, message: `${e.instancePath || '/'}: ${e.message}` }));
}
export function validateObservation(value: unknown): string[] { return observationIssues(value).map(i => i.message); }
export function validateReport(value: unknown): string[] { return report(value) ? [] : (report.errors ?? []).map(e => `${e.instancePath}: ${e.message}`); }
export function validateProfileReport(value: unknown): string[] { return profileReport(value) ? [] : (profileReport.errors ?? []).map(e => `${e.instancePath}: ${e.message}`); }
