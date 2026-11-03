import { writeFileSync } from 'node:fs';
process.loadEnvFile(new URL('../../../private/ob1-actions.env', import.meta.url));
const origin='https://ob1-actions.andresslack.deno.net';
const report={origin,started:new Date().toISOString(),tests:[],captures:0};
function assert(ok,msg){if(!ok)throw Error(msg);}
async function get(path){return fetch(origin+path,{signal:AbortSignal.timeout(40000),redirect:'error'});}
async function read(name,args){const r=await fetch(origin+'/actions/'+name,{method:'POST',headers:{authorization:'Bearer '+process.env.ACTION_API_KEY,'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(40000),redirect:'error'});assert(r.ok,name+' HTTP '+r.status);const data=await r.json();if(name==='search')assert(data.results.every(x=>!Object.hasOwn(x,'url')),'Search leaked citation URL');if(name==='fetch')assert(!Object.hasOwn(data,'url'),'Fetch leaked citation URL');return data;}
async function test(name,fn){try{await fn();report.tests.push({name,passed:true});console.log('PASS '+name);}catch(e){report.tests.push({name,passed:false,error:e.message});console.log('FAIL '+name+': '+e.message);process.exitCode=1;}}
await test('health',async()=>assert((await get('/health')).ok,'Health failed'));
await test('OpenAPI six operations and correct origin',async()=>{const r=await get('/openapi.json');assert(r.ok,'Schema failed');const s=await r.json();assert(s.servers[0].url===origin && Object.keys(s.paths).length===6,'Schema mismatch');});
await test('unauthenticated request rejected',async()=>assert((await fetch(origin+'/actions/thought_stats',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status===401,'Expected 401'));
let found;
for(const [name,args] of [['thought_stats',{}],['list_thoughts',{limit:1}],['search_thoughts',{query:'OB1 ChatGPT connection',limit:1}],['search',{query:'OB1 ChatGPT connection'}]])await test(name,async()=>{const x=await read(name,args);if(name==='search')found=x.results[0]?.id;});
await test('fetch with citation URL omitted',async()=>{assert(found,'No search result for fetch');await read('fetch',{id:found});});
await test('five repeated adapter reads',async()=>{for(let i=0;i<5;i++)await read('list_thoughts',{limit:1});});
report.finished=new Date().toISOString();writeFileSync(process.env.OB1_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
