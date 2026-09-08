const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';
process.env.AI_CV_ACCESS_PLANS = 'carriere,carriere_coaching';
process.env.AI_COACH_ACCESS_PLANS = 'carriere_coaching';
const { isAiPlanAllowed } = require('../utils/aiAccess');
const usageApi = require('../utils/aiUsage');

function fakeClient(initial = {}) {
  const state = { usage:{cv_used:0,coach_used:0,extra_cv_credits:0,extra_coach_credits:0,...initial}, reservations:new Map(), events:[], filters:[] };
  let sequence=0;
  return { state, from(table) { return { select(){return this;}, eq(k,v){state.filters.push([table,k,v]);return this;}, async maybeSingle(){return {data:state.usage,error:null};} }; },
    async rpc(name,args) {
      if(name==='reserve_ai_usage') { const f=args.p_feature, reserved=[...state.reservations.values()].filter(x=>x.feature===f&&!x.finalized).length;
        if(state.usage[`${f}_used`]+reserved>=args.p_base_limit+state.usage[`extra_${f}_credits`]) return {data:null,error:null};
        const id=`r-${++sequence}`; state.reservations.set(id,{feature:f,finalized:false}); return {data:id,error:null}; }
      if(name==='release_ai_usage'){state.reservations.delete(args.p_reservation_id);return {data:true,error:null};}
      if(name==='finalize_ai_usage'){const r=state.reservations.get(args.p_reservation_id);if(!r)return {data:false,error:null};if(r.finalized)return {data:true,error:null};r.finalized=true;state.usage[`${r.feature}_used`]++;state.events.push(args);return {data:true,error:null};}
    } };
}

test('matrice commerciale IA',()=>{
  assert.deepEqual(usageApi.DEFAULT_QUOTAS.carriere,{cv:30,coach:0});
  assert.deepEqual(usageApi.DEFAULT_QUOTAS.carriere_coaching,{cv:50,coach:100});
  assert.equal(isAiPlanAllowed('freemium','cv'),false); assert.equal(isAiPlanAllowed('freemium','coach'),false);
  assert.equal(isAiPlanAllowed('carriere','cv'),true); assert.equal(isAiPlanAllowed('carriere','coach'),false);
  assert.equal(isAiPlanAllowed('carriere_coaching','cv'),true); assert.equal(isAiPlanAllowed('carriere_coaching','coach'),true);
});

test('dernier usage autorisé puis blocage avant provider',async()=>{
  const c=fakeClient({cv_used:29});let calls=0;const r=await usageApi.reserveUsage('a','carriere','cv',c);calls++;
  await usageApi.finalizeUsage(r,{input_tokens:100,output_tokens:200},'cv_analysis','00000000-0000-0000-0000-000000000001',c);
  await assert.rejects(async()=>{await usageApi.reserveUsage('a','carriere','cv',c);calls++;},e=>e.code==='AI_QUOTA_EXCEEDED');
  assert.equal(calls,1);assert.equal(c.state.usage.cv_used,30);
});

test('échecs provider et JSON ne consomment rien',async()=>{
  for(const code of ['AI_PROVIDER_ERROR','AI_INVALID_RESPONSE']){const c=fakeClient();const r=await usageApi.reserveUsage('a','carriere','cv',c);await usageApi.releaseUsage(r,c);assert.equal(c.state.usage.cv_used,0,code);}
});

test('réservations concurrentes ne dépassent pas le quota',async()=>{
  process.env.AI_QUOTA_CARRIERE_CV='1';const c=fakeClient();const x=await Promise.allSettled([usageApi.reserveUsage('a','carriere','cv',c),usageApi.reserveUsage('a','carriere','cv',c)]);
  assert.equal(x.filter(v=>v.status==='fulfilled').length,1);assert.equal(x.filter(v=>v.status==='rejected').length,1);delete process.env.AI_QUOTA_CARRIERE_CV;
});

test('crédits, reset et ownership lecture',async()=>{
  const c=fakeClient({cv_used:30,extra_cv_credits:2});assert.ok(await usageApi.reserveUsage('a','carriere','cv',c));
  const october=await usageApi.usageFor('a','carriere',fakeClient(),new Date('2026-10-01T00:00:00Z'));assert.equal(october.cv.used,0);assert.equal(october.cv.extra_credits,0);assert.equal(october.reset_at,'2026-11-01');assert.equal(october.period_end,'2026-11-01');
  assert.ok(c.state.filters.some(([,k,v])=>k==='user_id'&&v==='a'));
});

test('métrique sans contenu sensible',async()=>{
  const c=fakeClient();const r=await usageApi.reserveUsage('a','carriere','cv',c);await usageApi.finalizeUsage(r,{input_tokens:1321,output_tokens:2100},'cv_analysis','00000000-0000-0000-0000-000000000001',c);
  const e=c.state.events[0];assert.equal(e.p_input_tokens,1321);assert.equal(e.p_output_tokens,2100);assert.ok(e.p_estimated_cost_eur>0);assert.equal(/prompt|response|cv_text|content/.test(Object.keys(e).join(',')),false);
});

test('finalisation idempotente ne consomme exactement qu’une unité',async()=>{
  const c=fakeClient();const r=await usageApi.reserveUsage('a','carriere','cv',c);
  await usageApi.finalizeUsage(r,{input_tokens:10,output_tokens:20},'cv_analysis','00000000-0000-0000-0000-000000000001',c);
  await usageApi.finalizeUsage(r,{input_tokens:10,output_tokens:20},'cv_analysis','00000000-0000-0000-0000-000000000001',c);
  assert.equal(c.state.usage.cv_used,1);assert.equal(c.state.events.length,1);
});

test('finalisation réessaie uniquement le RPC après une erreur transitoire',async()=>{
  const c=fakeClient();const r=await usageApi.reserveUsage('a','carriere','cv',c);
  const rpc=c.rpc.bind(c);let transient=true;c.rpc=async(name,args)=>{
    if(name==='finalize_ai_usage'&&transient){transient=false;return {data:null,error:new Error('network')};}
    return rpc(name,args);
  };
  await usageApi.finalizeUsage(r,{input_tokens:10,output_tokens:20},'cv_analysis','00000000-0000-0000-0000-000000000001',c);
  assert.equal(c.state.usage.cv_used,1);assert.equal(c.state.events.length,1);
});
