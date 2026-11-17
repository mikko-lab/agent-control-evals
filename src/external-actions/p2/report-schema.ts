import Ajv from 'ajv/dist/2020';
import schema from '../../../schemas/external-actions/p2-report-1.schema.json';
const check = new Ajv({ strict: true, strictRequired: false, allErrors: true }).compile(schema);
export function validateP2Report(value: unknown) {
  if (!check(value)) throw new Error(`P2 report schema: ${JSON.stringify(check.errors)}`);
}
