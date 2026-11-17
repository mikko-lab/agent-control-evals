const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const [buildArg,outArg] = process.argv.slice(2);
if(!buildArg || !outArg) throw new Error('usage: node scripts/p2-matrix.cjs BUILD NEW_OUT');
const root=process.cwd(), build=path.relative(root,path.resolve(buildArg)),out=path.resolve(outArg);
if(build.startsWith('..')) throw new Error('build must be within repository');
fs.mkdirSync(out);
const {evaluateLive,liveMutationDetected,semanticLive}=require(path.join(root,build,'src/external-actions/p2/live-evaluate.js'));
const {assessMatrix,bindRow}=require('./p2-matrix-gate.cjs');
const rows=[];
const boundRows=[];
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function save(){fs.writeFileSync(path.join(out,'matrix.json'),JSON.stringify({format:'p2-matrix/1',p2_acceptance:false,rows},null,2)+'\n');}
function run(version,guard,index,injection='') {
 const name=`node${version}-${guard}-${index}${injection?'-'+injection:''}`;
 const image=`ace-p2-linux:node${version}`;
 const imageId=cp.execFileSync('docker',['image','inspect',image,'--format','{{.Id}}'],{encoding:'utf8'}).trim();
 const args=['run','--rm','--network','none','--cap-add','SYS_ADMIN','--cap-add','NET_ADMIN','--security-opt','seccomp=unconfined',
 '--mount',`type=bind,src=${root},dst=/work,readonly`,'--mount',`type=bind,src=${out},dst=/evidence`,image,
 'node',`${build}/src/external-actions/p2/live-cli.js`,'run',`/evidence/${name}`,guard];
 if(injection) args.push(injection);
 const result=cp.spawnSync('docker',args,{encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 fs.writeFileSync(path.join(out,name+'.log'),(result.stdout||'')+(result.stderr||''));
 const rawPath=path.join(out,name,'raw.json'); let report=null, replay=false,error=null;
 try{const raw=JSON.parse(fs.readFileSync(rawPath,'utf8'));report=evaluateLive(raw);replay=semanticLive(report)===semanticLive(evaluateLive(JSON.parse(fs.readFileSync(rawPath,'utf8'))));
 fs.writeFileSync(path.join(out,name,'replayed-report.json'),JSON.stringify(report,null,2)+'\n');}catch(e){error=String(e);}
 const row={name,version,imageId,command:['docker',...args],exit:result.status,error:result.error?String(result.error):error,
 raw_sha256:fs.existsSync(rawPath)?sha(rawPath):null,reference_passed:report?.run_passed??false,mutation_detected:report?liveMutationDetected(report):false,replay,
 technical_detector:!!injection && result.status===2 && (!report || report.cases.some(c=>c.errors.length||c.incomplete.length))};
 rows.push(row);boundRows.push(bindRow(path.join(out,name),{version,guard,index,injection},result.status,['docker',...args]));save();console.log(JSON.stringify(row));
 if(!injection && (result.status!==0 || !(guard==='reference'?row.reference_passed:row.mutation_detected))) throw new Error('run failed; preserved, matrix stopped');
 return report;
}
try {
 for(const version of [22,24]) {
  let first;
  for(let i=1;i<=3;i++){const report=run(version,'reference',i);if(first && first!==semanticLive(report))throw new Error('semantic repeat mismatch');first=semanticLive(report);}
  for(const mutant of ['direct-ip-allow','alias-allow','proxy-final-unchecked','deny-all','deny-after-send'])run(version,mutant,1);
 }
 for(const injection of ['missing-journal','channel-writable','foreign-observation','isolation-changed','linger-executor'])run(22,'reference',1,injection);
} catch(e) { console.error(String(e)); process.exitCode=1; }
finally {
 save();
 const input={format:'p2-recorded-matrix/2',rows:boundRows};
 fs.writeFileSync(path.join(out,'recorded-matrix.json'),JSON.stringify(input,null,2)+'\n');
 const gate=assessMatrix(input,path.join(root,build));
 fs.writeFileSync(path.join(out,'gate.json'),JSON.stringify(gate,null,2)+'\n');
 if(!gate.matrix_gate_passed)process.exitCode=1;
}
