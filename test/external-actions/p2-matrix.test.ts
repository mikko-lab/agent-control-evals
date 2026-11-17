import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, rechain } from './p2-test-fixtures';
import { evaluateLive, rawSchemaErrors } from '../../src/external-actions/p2/live-evaluate';
import { ips, LiveRun } from '../../src/external-actions/p2/live-model';
const root=process.cwd(), build=resolve(__dirname,'../..');
const gate=require(join(root,'scripts/p2-matrix-gate.cjs'));
const write=(p:string,v:any)=>writeFileSync(p,JSON.stringify(v));
// Synthetic contract fixtures only. These are never collected as live evidence.
function makeMatrix(dir:string) {
 const rows=gate.expected.map((binding:any)=>{
  const name=gate.name(binding), folder=join(dir,name);mkdirSync(folder);
  const raw=fixture();raw.run_id=name;raw.node=`v${binding.version}.0.0`;raw.guard=binding.guard;
  for(const c of raw.cases) {c.run=name;for(const stream of Object.values(c.events)){for(const e of stream)e.run=name;rechain(stream);}}
  if(binding.guard!=='reference') {
   const id=({'direct-ip-allow':'ipv4-Q','alias-allow':'alias-Q','proxy-final-unchecked':'proxy-Q','deny-all':'canonical-P','deny-after-send':'ipv4-Q'} as any)[binding.guard];
   const c=raw.cases.find(c=>c.case===id)!;
   if(binding.guard==='deny-all') {
    c.decision='DENY';c.events.e[0].data.decision='DENY';c.states.p.records=[];
    c.events.p=c.events.p.filter(e=>e.kind==='closed');c.events.p[0].data=c.states.p;
   } else {
    const proxy=id==='proxy-Q', body=`synthetic:${id}`;
    const source=raw.cases.find(c=>c.case===(proxy?'proxy-P':'canonical-P'))!;
    c.decision=binding.guard==='deny-after-send'?'DENY':'ALLOW';c.events.e[0].data.decision=c.decision;
    c.events.q=structuredClone(source.events.p);c.states.q.records=[body];
    for(const e of c.events.q){e.case=id;e.service='q';if('body' in e.data)e.data.body=body;if('address' in e.data)e.data.address=ips.q;if(e.kind==='closed')e.data=c.states.q;}
    if(proxy){
     c.events.x=structuredClone(source.events.x);
     for(const e of c.events.x){e.case=id;if(e.kind==='request')e.data.body=JSON.stringify({final_url:'http://protected.test:8080/submit',body});}
     const extra=structuredClone(c.events.r.filter(e=>e.kind!=='closed'));
     for(const e of extra)if('peer' in e.data)e.data.peer=ips.x;
     c.events.r.splice(c.events.r.length-1,0,...extra);
    }
   }
   for(const stream of Object.values(c.events))rechain(stream);
  }
  const c=raw.cases.find(c=>c.case==='canonical-P')!;
  switch(binding.injection) {
   case 'missing-journal':c.events.p=[];break;
   case 'foreign-observation':c.events.p[0].run='foreign';break;
   case 'isolation-changed':c.isolation.after+='\nINJECTED';break;
   case 'linger-executor':Object.assign(c.processes.find(p=>p.role==='e')!,{timed_out:true,code:null,signal:'SIGKILL'});break;
   case 'channel-writable':
    c.decision='UNKNOWN';c.errors=['Error: isolation precheck failed'];c.states={};c.processes=[];c.events={e:[],p:[],q:[],x:[],r:[]};
    Object.assign(c.isolation,{after:'',after_hash:'',channels_before:false,channels_after:false});
    write(join(folder,'channel-precheck.json'),{format:'p2-channel-precheck/1',run:name,case:'canonical-P',attempt:'a1',guard:'reference',injection:'channel-writable',role:'p',mode_before:0o2750,mode_after:0o2777,channels_before_change:true,channels_after_change:false,precheck_rejected:true,executor_started:false});break;
  }
  write(join(folder,'raw.json'),raw);
  try{write(join(folder,'report.json'),evaluateLive(raw));}catch(e){writeFileSync(join(folder,'evaluation-error.txt'),String(e)+'\n');}
  return gate.bindRow(folder,binding,binding.injection?2:0,['node','live-cli.js','run',`/evidence/${name}`,binding.guard,...(binding.injection?[binding.injection]:[])]);
 });return {format:'p2-recorded-matrix/2',rows};
}
function withMatrix(fn:(m:any,dir:string)=>void) {const d=mkdtempSync(join(tmpdir(),'p2-matrix-test-'));try{fn(makeMatrix(d),d);}finally{rmSync(d,{recursive:true,force:true});}}
function changeRaw(row:any,fn:(raw:LiveRun)=>void, replay=true) {
 const r=JSON.parse(readFileSync(row.files.raw.path,'utf8'));fn(r);write(row.files.raw.path,r);row.files.raw=gate.bindFile(row.files.raw.path);
 if(replay){try{write(row.files.report.path,evaluateLive(r));row.files.report=gate.bindFile(row.files.report.path);}catch{/* expected schema rejection */}}
}
function reject(m:any,reason:string){const r=gate.assessMatrix(m,build);assert.equal(r.matrix_gate_passed,false);assert.ok(r.reasons.some((s:string)=>s.includes(reason)),JSON.stringify(r.reasons));}

test('complete synthetic 21-run matrix passes exact technical, safety, original replay and cross-version gates',()=>withMatrix(m=>{
 const r=gate.assessMatrix(m,build);assert.equal(r.matrix_gate_passed,true,JSON.stringify(r.reasons));assert.equal(r.p2_acceptance,false);assert.equal(r.checks.length,21);assert.ok(r.checks.every((c:any)=>c.replay));
}));
test('technical absence, wrong cause, wrong case, extra error and wrong-run evidence fail',()=>{
 for(const mode of ['absent','wrong-cause','wrong-case','extra-error','wrong-run'])withMatrix(m=>{
  const row=m.rows.find((r:any)=>r.injection==='missing-journal');
  changeRaw(row,r=>{const c=r.cases.find(c=>c.case==='canonical-P')!;
   if(mode==='absent'||mode==='wrong-case'){const src=fixture().cases.find(c=>c.case==='canonical-P')!;c.events.p=src.events.p;for(const e of c.events.p)e.run=r.run_id;rechain(c.events.p);if(mode==='wrong-case')r.cases[0].events.p=[];}
   if(mode==='wrong-cause'){c.errors.push('random startup error');}
   if(mode==='extra-error')c.events.q=[];
   if(mode==='wrong-run')c.run='unrelated';
  });reject(m,mode==='wrong-run'?'case_binding':'technical_witness');
 });
});
test('linger cannot be replaced by harness errors; channel requires permission proof and exact schema rejection',()=>{
 withMatrix(m=>{const row=m.rows.find((r:any)=>r.injection==='linger-executor');changeRaw(row,r=>r.cases[4].errors.push('startup error'));reject(m,'technical_witness');});
 for(const mode of ['diagnostic','schema','startup','missing'])withMatrix(m=>{
  const row=m.rows.find((r:any)=>r.injection==='channel-writable');
  if(mode==='missing')row.files.diagnostic=null;
  if(mode==='diagnostic'){const p=row.files.diagnostic.path,r=JSON.parse(readFileSync(p,'utf8'));r.mode_after=0o2750;write(p,r);row.files.diagnostic=gate.bindFile(p);}
  if(mode==='schema')changeRaw(row,r=>{(r as any).format='random';},false);
  if(mode==='startup')changeRaw(row,r=>{r.cases[4].errors=['spawn failed'];},false);
  reject(m,mode==='schema'?'channel_schema_reason':mode==='startup'?'channel_abort_shape':mode==='missing'?'diagnostic_missing':'channel_permission_evidence');
 });
});
test('original-report mismatch, changed raw bytes, wrong binding, duplicate and absent rows fail',()=>{
 withMatrix(m=>{const row=m.rows[0],p=row.files.report.path,r=JSON.parse(readFileSync(p,'utf8'));r.run_id='foreign';write(p,r);row.files.report=gate.bindFile(p);reject(m,'report_replay');});
 withMatrix(m=>{writeFileSync(m.rows[0].files.raw.path,'{}');reject(m,'raw_hash');});
 withMatrix(m=>{m.rows[0].version=24;reject(m,'binding');});
 withMatrix(m=>{m.rows[0].run_id='foreign';reject(m,'raw_binding');});
 withMatrix(m=>{m.rows.pop();reject(m,'missing:');});
 withMatrix(m=>{m.rows[1]=m.rows[0];reject(m,'duplicate_row');});
 withMatrix(m=>{m.rows[0].files.report.sha256='0'.repeat(64);reject(m,'report_hash');});
});
test('cross-version semantic disagreement fails even when every individual reference passes',()=>withMatrix(m=>{
 const api=require(join(build,'src/external-actions/p2/live-evaluate.js')),old=api.semanticLive;
 try{api.semanticLive=(r:any)=>old(r)+(r.run_id.startsWith('node24')?'different':'');reject(m,'cross_version_semantics');}finally{api.semanticLive=old;}
}));
test('offline CLI returns success/failure and always saves concrete gate reasons',()=>withMatrix((m,d)=>{
 const input=join(d,'input.json');write(input,m);
 for(const good of [true,false]){if(!good){m.rows.pop();write(input,m);}const out=join(d,good?'ok':'bad');const r=spawnSync(process.execPath,[join(root,'scripts/p2-matrix-check.cjs'),build,input,out],{encoding:'utf8'});assert.equal(r.status,good?0:1,r.stderr);const saved=JSON.parse(readFileSync(join(out,'gate.json'),'utf8'));assert.equal(saved.matrix_gate_passed,good);assert.equal(saved.evaluation_kind,'recorded_reassessment');if(!good)assert.ok(saved.reasons.includes('row_count'));}
}));
test('live matrix orchestrator fails closed on a technical wrong-cause run and saves final reasons',()=>withMatrix((m,d)=>{
 const row=m.rows.find((r:any)=>r.injection==='linger-executor');changeRaw(row,r=>r.cases[4].errors.push('unrelated failure'));
 const bin=join(d,'bin');mkdirSync(bin);const docker=join(bin,'docker');
 writeFileSync(docker,`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);if(a[0]==='image'){console.log('synthetic-test-image');process.exit(0)}const dest=a.find(x=>x.startsWith('type=bind,src=')&&x.endsWith('dst=/evidence')).split('src=')[1].split(',dst=')[0],n=a.find(x=>x.startsWith('/evidence/')).split('/').pop();fs.cpSync(path.join(${JSON.stringify(d)},n),path.join(dest,n),{recursive:true});process.exit(n.includes('reference-1-')?2:0);\n`);chmodSync(docker,0o755);
 const out=join(d,'runner-output');const r=spawnSync(process.execPath,[join(root,'scripts/p2-matrix.cjs'),build,out],{env:{...process.env,PATH:bin+':'+process.env.PATH},encoding:'utf8'});
 assert.equal(r.status,1,r.stderr);const saved=JSON.parse(readFileSync(join(out,'gate.json'),'utf8'));assert.equal(saved.matrix_gate_passed,false);assert.ok(saved.reasons.some((s:string)=>s.includes('technical_witness')),JSON.stringify(saved.reasons));
 changeRaw(row,r=>{r.cases[4].errors=[];});
 const goodOut=join(d,'runner-good');const good=spawnSync(process.execPath,[join(root,'scripts/p2-matrix.cjs'),build,goodOut],{env:{...process.env,PATH:bin+':'+process.env.PATH},encoding:'utf8'});
 assert.equal(good.status,0,good.stderr);assert.equal(JSON.parse(readFileSync(join(goodOut,'gate.json'),'utf8')).matrix_gate_passed,true);
}));

test('guard/injection/command swaps and nondeterministic evaluation do not satisfy replay',()=>{
 withMatrix(m=>{m.rows[0].command[m.rows[0].command.length-1]='deny-all';reject(m,'command_binding');});
 withMatrix(m=>{const row=m.rows.find((r:any)=>r.injection==='foreign-observation');row.injection='missing-journal';reject(m,'binding');});
 withMatrix(m=>{changeRaw(m.rows[0],r=>{r.guard='deny-all';});reject(m,'raw_binding');});
 withMatrix(m=>{const api=require(join(build,'src/external-actions/p2/live-evaluate.js')),old=api.evaluateLive;let n=0;
  try{api.evaluateLive=(r:any)=>({...old(r),run_id:++n%2?'different':r.run_id});reject(m,'report_replay');}finally{api.evaluateLive=old;}
 });
});
