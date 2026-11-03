import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from './adapter.mjs';
const id='c54844b0-6e7b-4d55-8109-16157a934dcd';
const config={actionKey:'a'.repeat(40),upstreamKey:'secret',upstreamUrl:'https://ob1.example/mcp',publicUrl:'https://actions.example'};
const request=(path='/thoughts/'+id,method='GET')=>new Request('https://actions.example'+path,{method});
const result=text=>({content:[{type:'text',text:JSON.stringify({id,text,metadata:{people:['PRIVATE_PERSON']},title:'PRIVATE_TITLE',url:'https://private.example'})}]});
test('public detail escapes text, discards every other field, blocks active content and caching',async()=>{
 const seen=[];const handler=createHandler(config,async(_,name,args)=>{seen.push([name,args]);return result('<script>alert("x")</script> & <img src="https://evil.example">\nLine two');});
 const r=await handler(request());assert.equal(r.status,200);const html=await r.text();assert.match(html,/&lt;script&gt;/);assert.match(html,/&amp;/);assert.match(html,/Line two/);assert.doesNotMatch(html,/<script|<img|<a\b|PRIVATE_PERSON|PRIVATE_TITLE|https:\/\/private/);assert.deepEqual(seen,[['fetch',{id}]]);
 assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.get('referrer-policy'),'no-referrer');assert.match(r.headers.get('x-robots-tag'),/noindex/);assert.match(r.headers.get('content-security-policy'),/default-src 'none'/);
});
test('no index, enumeration, invalid UUID, methods, or query variants reach OB1',async()=>{
 let calls=0;const handler=createHandler(config,async()=>{calls++;return result('body');});
 for(const path of ['/thoughts','/thoughts/','/thoughts/nope','/thoughts/'+id+'/next','/thoughts/'+id+'?select=*','/thoughts/00000000-0000-0000-0000-000000000000']){const r=await handler(request(path));assert.equal(r.status,404);assert.match(await r.text(),/Not found\./);}
 assert.equal((await handler(request('/thoughts/'+id,'POST'))).status,404);assert.equal(calls,0);
});
test('missing, mismatched, malformed, and failed upstream rows share generic not-found response',async()=>{
 let reference;
 for(const invoke of [async()=>({isError:true}),async()=>({content:[{type:'text',text:'secret error'}]}),async()=>({content:[{type:'text',text:JSON.stringify({id:'different',text:'wrong row'})}]}),async()=>{throw Error('private database details');}]){const r=await createHandler(config,invoke)(request());assert.equal(r.status,404);const text=await r.text();reference??=text;assert.equal(text,reference);}
});
