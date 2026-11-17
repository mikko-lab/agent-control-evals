// Bind legacy evidence to the stricter gate without rewriting or rerunning it.
const fs=require('node:fs'),path=require('node:path');
const {bindRow,expected,name,hash}=require('./p2-matrix-gate.cjs');
const [matrixFile,inventoryFile,out]=process.argv.slice(2);
if(!matrixFile||!inventoryFile||!out)throw new Error('usage: node scripts/p2-matrix-import.cjs OLD_MATRIX OLD_COMPLETION_INVENTORY NEW_OUT');
fs.mkdirSync(out);
const matrix=JSON.parse(fs.readFileSync(matrixFile)),inventory=JSON.parse(fs.readFileSync(inventoryFile));
const root=process.cwd(),dir=path.dirname(path.resolve(matrixFile));
const verify=p=>{const recorded=inventory.evidence_files.find(f=>path.resolve(root,f.path)===path.resolve(p));if(!recorded||recorded.sha256!==hash(fs.readFileSync(p)))throw new Error('historical inventory mismatch: '+p);};
verify(matrixFile);
if(matrix.format!=='p2-matrix/1')throw new Error('legacy matrix format');
const rows=matrix.rows.map(r=>{
 const b=expected.find(b=>name(b)===r.name);if(!b)throw new Error('unexpected legacy row');
 const bound=bindRow(path.join(dir,r.name),b,r.exit,r.command);
 for(const f of Object.values(bound.files))if(f)verify(f.path);
 if(bound.files.raw?.sha256!==r.raw_sha256)throw new Error('legacy raw binding');
 return bound;
});
fs.writeFileSync(path.join(out,'recorded-matrix.json'),JSON.stringify({format:'p2-recorded-matrix/2',evaluation_kind:'legacy_rebinding_only',source_matrix_sha256:hash(fs.readFileSync(matrixFile)),source_inventory_sha256:hash(fs.readFileSync(inventoryFile)),rows},null,2)+'\n');
