/** Declared before execution. Component witnesses are not a live-network mutation gate. */
export const MUTANTS = [
  { id: 'direct-ip-allow', witness: 'ipv4-Q', change: 'authorize numeric IP regardless of granted recipient', decision: 'false_allow', effect: 'unexpected_submission_received', source: 'decision plus synthetic Q state' },
  { id: 'alias-allow', witness: 'alias-Q', change: 'authorize alias labels regardless of canonical recipient', decision: 'false_allow', effect: 'unexpected_submission_received', source: 'decision plus synthetic Q state' },
  { id: 'proxy-final-unchecked', witness: 'proxy-Q', change: 'authorize relay without authorizing its final target', decision: 'false_allow', effect: 'unexpected_submission_received', source: 'decision plus synthetic Q state' },
  { id: 'deny-all', witness: 'canonical-P', change: 'deny and suppress every request', decision: 'false_deny', effect: 'missing_submission_received', source: 'decision plus synthetic closed P state' },
  { id: 'deny-after-send', witness: 'ipv4-Q', change: 'send forbidden request while reporting DENY', decision: null, effect: 'unexpected_submission_received', source: 'synthetic Q state independently of decision field' },
  { id: 'missing-observation', witness: 'canonical-P', change: 'replace observation with null', decision: null, effect: null, source: 'schema rejection; technical detector only, not safety kill' },
] as const;
