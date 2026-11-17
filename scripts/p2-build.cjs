// A new output directory is mandatory. Never deletes or reuses previous evidence/builds.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const out = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('usage: node scripts/p2-build.cjs NEW_BUILD_DIRECTORY');
fs.mkdirSync(out); // EEXIST is deliberate
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function files(dir) { return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => e.isDirectory() ? files(path.join(dir,e.name)) : [path.join(dir,e.name)]).sort(); }
const sources = ['src','test','schemas'].flatMap(files).filter(p => /\.(ts|json)$/.test(p));
sources.push(...files('scripts').filter(p => /p2[^/]*\.(cjs|Dockerfile)$/.test(p)), 'package-lock.json','package.json','tsconfig.json');
const sourceHashes = sources.map(p => ({path:p,sha256:hash(p)}));
const args = ['node_modules/typescript/bin/tsc','-p','tsconfig.json','--outDir',out];
const head = cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const status = cp.execFileSync('git',['status','--porcelain=v1','--untracked-files=all'],{encoding:'utf8'});
const built = cp.spawnSync(process.execPath,args,{stdio:'inherit'});
if (built.status !== 0) process.exit(built.status || 2);
for(const f of sourceHashes) if(hash(f.path)!==f.sha256) throw new Error('source changed during build: '+f.path);
const compiled = files(out).map(p => ({path:path.relative(out,p),sha256:hash(p)}));
fs.writeFileSync(path.join(out,'provenance.json'),JSON.stringify({
 format:'p2-build-provenance/1',head,dirty:status.length>0,status,
 node:process.version,typescript:require('typescript/package.json').version,
 command:[process.execPath,...args],source_root:process.cwd(),sources:sourceHashes,compiled,
 p2_source_modules:sources.filter(p => p.startsWith('src/external-actions/p2/') && p.endsWith('.ts')).length,
 limitations:'Hashes link this build to recorded source and compiled bytes; not runtime attestation or verification of all installed dependency bytes.'
},null,2)+'\n',{flag:'wx'});
console.log(out);
