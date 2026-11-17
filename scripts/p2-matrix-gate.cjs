// Offline gate. Files and collector are trusted inputs, not authenticated attestations.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = x => JSON.stringify(x, function (k, v) { return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v; });
const same = (a,b) => stable(a) === stable(b);
const mutants = ['direct-ip-allow','alias-allow','proxy-final-unchecked','deny-all','deny-after-send'];
const injections = ['missing-journal','channel-writable','foreign-observation','isolation-changed','linger-executor'];
const expected = [22,24].flatMap(version => [1,2,3].map(index=>({version,guard:'reference',index,injection:''})).concat(mutants.map(guard=>({version,guard,index:1,injection:''})))).concat(injections.map(injection=>({version:22,guard:'reference',index:1,injection})));
const name = r => `node${r.version}-${r.guard}-${r.index}${r.injection?'-'+r.injection:''}`;
function bindFile(file) { return fs.existsSync(file) ? {path:path.resolve(file),sha256:hash(fs.readFileSync(file))} : null; }
function bindRow(directory, binding, exit, command) {
 const files = Object.fromEntries([['raw','raw.json'],['report','report.json'],['diagnostic','channel-precheck.json'],['rejection','evaluation-error.txt']].map(([k,f])=>[k,bindFile(path.join(directory,f))]));
 const run_id = files.raw ? JSON.parse(fs.readFileSync(files.raw.path)).run_id : null;
 return {...binding,name:name(binding),run_id,exit,command,files};
}
function schemaSignature(errors) { return errors.map(e=>({instancePath:e.instancePath,keyword:e.keyword,params:e.params})).sort((a,b)=>stable(a).localeCompare(stable(b))); }
function assessMatrix(input, build, base = process.cwd()) {
 const api = require(path.resolve(build,'src/external-actions/p2/live-evaluate.js'));
 const {routeCases} = require(path.resolve(build,'src/external-actions/p2/corpus.js'));
 const {configurationIssues} = require(path.resolve(build,'src/external-actions/p2/topology.js'));
 const {validateP2Report} = require(path.resolve(build,'src/external-actions/p2/report-schema.js'));
 const reasons=[], checks=[], baselines=[], seen=new Set(), runIds=new Set();
 const check=(condition,reason)=>{if(!condition) reasons.push(reason);return condition;};
 if(!input || input.format!=='p2-recorded-matrix/2' || !Array.isArray(input.rows)) return {format:'p2-matrix-gate/1',matrix_gate_passed:false,p2_acceptance:false,reasons:['matrix_format'],checks:[]};
 check(input.rows.length===21,'row_count');
 for(const row of input.rows) {
  const start=reasons.length; let replay=false;
  const key=name(row), prefix=String(row.name)+':';
  const ok=(c,r)=>check(c,prefix+r);
  const want=expected.find(e=>name(e)===row.name);
  if(!ok(!!want && same({...want,name:name(want)}, {version:row.version,guard:row.guard,index:row.index,injection:row.injection,name:row.name}),'binding')) continue;
  ok(!seen.has(key),'duplicate_row');seen.add(key);
  ok(typeof row.run_id==='string' && row.run_id.length>0 && !runIds.has(row.run_id),'run_id');runIds.add(row.run_id);
  ok(row.exit===(row.injection?2:0),'exit');
  const command=row.command;
  ok(Array.isArray(command) && same(command.slice(-(row.injection?4:3)),['run',`/evidence/${row.name}`,row.guard,...(row.injection?[row.injection]:[])]),'command_binding');
  const read=(kind,required=true)=>{
   const f=row.files?.[kind];if(!f){if(required)ok(false,`${kind}_missing`);return null;}
   const bytes=fs.readFileSync(path.resolve(base,f.path));
   if(!ok(typeof f.sha256==='string' && hash(bytes)===f.sha256,`${kind}_hash`))return null;
   return bytes.toString('utf8');
  };
  try {
   const bytes=read('raw');if(bytes===null)throw new Error('raw_unavailable');
   const raw=JSON.parse(bytes);
   ok(raw.run_id===row.run_id && raw.guard===row.guard && raw.platform==='linux' && new RegExp(`^v${row.version}\\.`).test(raw.node),'raw_binding');
   ok(Array.isArray(raw.cases) && same(raw.cases.map(c=>c.case).sort(),routeCases().map(c=>c.id).sort()) && raw.cases.every(c=>c.run===row.run_id && c.attempt==='a1'),'case_binding');
   if(row.injection==='channel-writable') {
    ok(row.files.report===null,'unexpected_report');
    const diagnostic=read('diagnostic'), rejection=read('rejection');
    const c=raw.cases.find(c=>c.case==='canonical-P'), i=raw.cases.indexOf(c);
    const expectedErrors=[...['x','r','p','q'].map(k=>({instancePath:`/cases/${i}/states`,keyword:'required',params:{missingProperty:k}})),{instancePath:`/cases/${i}/processes`,keyword:'minItems',params:{limit:5}},{instancePath:`/cases/${i}/isolation/after`,keyword:'minLength',params:{limit:1}}];
    const a=api.rawSchemaErrors(raw), b=api.rawSchemaErrors(JSON.parse(bytes));
    ok(same(schemaSignature(a),schemaSignature(expectedErrors)),'channel_schema_reason');
    const recorded = rejection && rejection.startsWith('Error: P2 raw schema: ') ? JSON.parse(rejection.slice('Error: P2 raw schema: '.length)) : null;
    replay=same(a,b) && same(a,recorded);ok(replay,'rejection_replay');
    ok(diagnostic!==null && same(JSON.parse(diagnostic),{format:'p2-channel-precheck/1',run:raw.run_id,case:'canonical-P',attempt:'a1',guard:'reference',injection:'channel-writable',role:'p',mode_before:0o2750,mode_after:0o2777,channels_before_change:true,channels_after_change:false,precheck_rejected:true,executor_started:false}),'channel_permission_evidence');
    ok(c.decision==='UNKNOWN' && same(c.errors,['Error: isolation precheck failed']) && same(c.states,{}) && same(c.processes,[]) && Object.values(c.events).every(e=>same(e,[])),'channel_abort_shape');
    ok(c.isolation.channels_before===false && c.isolation.channels_after===false && c.isolation.after==='' && c.isolation.after_hash==='' && hash(c.isolation.before)===c.isolation.before_hash && configurationIssues(c.isolation.before).length===0 && same(c.isolation.probes,{e:true,x:true,r:true,p:true,q:true}),'channel_precheck');
    // Only evaluate original complete cases after checking the exact schema rejection above.
    if(same(schemaSignature(a),schemaSignature(expectedErrors))) for(const spec of routeCases().filter(c=>c.id!=='canonical-P')) {
     const result=api.evaluateRecordedCase(spec,raw.cases.find(c=>c.case===spec.id),raw.run_id);
     ok(result.verdict==='PASS' && !result.errors.length && !result.findings.length && !result.incomplete.length,`other_case:${spec.id}`);
    }
   } else {
    const originalBytes=read('report');if(originalBytes===null)throw new Error('report_unavailable');
    const original=JSON.parse(originalBytes);validateP2Report(original);
    const report=api.evaluateLive(raw), again=api.evaluateLive(JSON.parse(bytes));
    replay=same(report,original) && same(report,again);ok(replay,'report_replay');
    if(!row.injection) {
     ok(row.guard==='reference'?report.run_passed:api.liveMutationDetected(report),row.guard==='reference'?'reference_failed':'mutant_witness');
     if(row.guard==='reference')baselines.push(api.semanticLive(report));
    } else {
     const r=report.cases.find(c=>c.case_id==='canonical-P'), c=raw.cases.find(c=>c.case==='canonical-P');
     const specs={
      'missing-journal':['HARNESS_ERROR',['journal_missing:p','state_journal_mismatch:p'],['closure:p']],
      'foreign-observation':['HARNESS_ERROR',['identity:p','journal_chain:p'],[]],
      'isolation-changed':['HARNESS_ERROR',['configuration_not_json','isolation_changed'],[]],
      'linger-executor':['UNASSESSABLE',[],['closure:e']]
     };
     const [verdict,errors,incomplete]=specs[row.injection];
     ok(r.verdict===verdict && same([...r.errors].sort(),[...errors].sort()) && same(r.incomplete,incomplete) && same(r.findings,[]),'technical_witness');
     ok(report.cases.filter(c=>c.case_id!=='canonical-P').every(c=>c.verdict==='PASS' && !c.errors.length && !c.findings.length && !c.incomplete.length),'other_cases');
     ok(c.errors.length===0,'raw_errors');
     if(row.injection==='missing-journal')ok(same(c.events.p,[]) && same(c.states.p.records,['synthetic:canonical-P']),'missing_journal_cause');
     if(row.injection==='foreign-observation')ok(c.events.p[0]?.run==='foreign' && c.events.p.slice(1).every(e=>e.run===raw.run_id),'foreign_cause');
     if(row.injection==='isolation-changed')ok(c.isolation.after===c.isolation.before+'\nINJECTED' && c.isolation.after_hash===c.isolation.before_hash,'configuration_cause');
     if(row.injection==='linger-executor')ok(c.processes.some(p=>p.role==='e' && p.timed_out && p.code===null && p.signal==='SIGKILL') && c.processes.filter(p=>p.role!=='e').every(p=>!p.timed_out && p.code===0 && p.signal===null),'timeout_cause');
    }
   }
  } catch(e) {ok(false,`evaluation:${String(e)}`);}
  checks.push({name:row.name,passed:reasons.length===start,replay});
 }
 for(const e of expected)check(seen.has(name(e)),`missing:${name(e)}`);
 check(baselines.length===6 && baselines.every(s=>s===baselines[0]),'cross_version_semantics');
 return {format:'p2-matrix-gate/1',matrix_gate_passed:reasons.length===0,p2_acceptance:false,reasons,checks};
}
module.exports={assessMatrix,bindRow,bindFile,expected,name,stable,hash};
