// No Docker, sockets or child process execution: recorded input only.
const fs=require('node:fs'),path=require('node:path');
const {assessMatrix,hash}=require('./p2-matrix-gate.cjs');
const [build,input,out]=process.argv.slice(2);
if(!build||!input||!out)throw new Error('usage: node scripts/p2-matrix-check.cjs BUILD INPUT_JSON NEW_OUT');
fs.mkdirSync(out);
let result;
try {const bytes=fs.readFileSync(input);result={...assessMatrix(JSON.parse(bytes),build,path.dirname(path.resolve(input))),evaluation_kind:'recorded_reassessment',input_sha256:hash(bytes)};}
catch(e){result={format:'p2-matrix-gate/1',matrix_gate_passed:false,p2_acceptance:false,reasons:[String(e)],evaluation_kind:'recorded_reassessment'};}
fs.writeFileSync(path.join(out,'gate.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));process.exitCode=result.matrix_gate_passed?0:1;
