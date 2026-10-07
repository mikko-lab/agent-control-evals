import Ajv from 'ajv/dist/2020';
import observationSchema from '../../../schemas/revocation/observation.schema.json';
import reportSchema from '../../../schemas/revocation/report.schema.json';
const ajv = new Ajv({ allErrors: true, strict: true });
const observation = ajv.compile(observationSchema);
const report = ajv.compile(reportSchema);
export function validateObservation(value: unknown): string[] { return observation(value) ? [] : (observation.errors ?? []).map(e => `${e.instancePath}: ${e.message}`); }
export function validateReport(value: unknown): string[] { return report(value) ? [] : (report.errors ?? []).map(e => `${e.instancePath}: ${e.message}`); }
