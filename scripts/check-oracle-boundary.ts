import { join } from "node:path";
import { checkOracleBoundary } from "../src/oracle/boundary-check";

const root = join(__dirname, "..", "..");
const r = checkOracleBoundary(root);
console.log(JSON.stringify({ ok: r.ok, closure: r.closure, violations: r.violations }, null, 2));
process.exit(r.ok ? 0 : 2);
