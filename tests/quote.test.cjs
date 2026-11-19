const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaults,quoteInput,publicQuote,requestQuote } = require('../server/quote.js');

const input = {
  countries:'FR, DE, CZ',startDate:'2027-01-10',endDate:'2027-01-16',
  currency:'EUR',dataGb:'3',language:'cs',profile:'normal'
};
const args = quoteInput(input);
const plan = {
  sku:'SKU-01',market_name:'Europe',currency:'EUR',total_price:12,formatted_price:'€12.00',
  validity_days:15,data_gb:5,hotspot:null,activation_label:'On the first supported network',
  coverage:{country_codes:['FR','DE','CZ']},
  product_url:'https://simcardo.com/cs/esim/global/europe/15-days/5gb?sku=SKU-01&currency=EUR'
};

test('trip defaults omit all non-quote fields', () => {
  assert.deepEqual(defaults({id:3,title:'My trip',email:'unused',start_date:input.startDate,
    end_date:input.endDate,currency:'EUR'}),{startDate:input.startDate,endDate:input.endDate,currency:'EUR'});
});
test('validate country order, dates, GB choice, locale and field projection', () => {
  assert.deepEqual(args, {destination:'FR',additional_destinations:['DE','CZ'],start_date:input.startDate,
    end_date:input.endDate,currency:'EUR',language:'cs',hotspot_required:false,include_regional:true,data_gb:3});
  assert.equal(quoteInput({...input,countries:'UK',language:'__proto__',dataGb:''}).language,'en');
  assert.throws(()=>quoteInput({...input,countries:'UK, GB'}),/different/);
  assert.throws(()=>quoteInput({...input,startDate:'2027-02-29'}),/dates/);
  assert.throws(()=>quoteInput({...input,endDate:'2028-02-06'}),/365/);
  assert.throws(()=>quoteInput({...input,dataGb:'10e900'}),/GB/);
  const stripped = quoteInput({...input,email:'private',tripId:34,description:'private'});
  assert.deepEqual(stripped,args);
});

test('only matching plans with an exact Simcardo product URL have an itinerary CTA', () => {
  const q=publicQuote({status:'matched',plans:[plan,{...plan,product_url:plan.product_url.replace('simcardo.com','example.com')}]},args);
  assert.equal(q.plans.length,1);
  const url=new URL(q.plans[0].url);
  assert.equal(url.searchParams.get('sku'),plan.sku);
  assert.equal(url.searchParams.get('utm_content'),'trek_itinerary');
  assert.equal(url.searchParams.get('utm_medium'),'mcp');
  assert.equal(publicQuote({status:'matched',plans:[plan]}, {...args,hotspot_required:true}).status,'needs_verification');
  assert.equal(publicQuote({status:'matched',plans:[{...plan,validity_days:6}]},args).plans.length,0);
  assert.equal(publicQuote({status:'matched',plans:[{...plan,coverage:{country_codes:['FR','DE']}}]},args).plans.length,0);
  assert.equal(publicQuote({status:'matched',plans:[{...plan,product_url:plan.product_url.replace('sku=SKU-01','sku=different')}]},args).plans.length,0);
  assert.deepEqual(publicQuote({status:'no_match',plans:[plan]},args),{status:'no_match',plans:[]});
});

test('MCP handshake sends only quote fields and handles application status', async () => {
  const trace=[];
  const transport=async(url,opt)=>{
    assert.equal(url,'https://simcardo.com/mcp-travel-esim');
    const message=JSON.parse(opt.body);
    trace.push(message);
    if(message.method==='notifications/initialized') return new Response(null,{status:202});
    const result=message.method==='initialize' ? {serverInfo:{name:'com.simcardo/travel-esim'},protocolVersion:'2025-11-25'}
      : {structuredContent:{status:'matched',plans:[plan]}};
    return Response.json({id:message.id,jsonrpc:'2.0',result});
  };
  const result=await requestQuote(args,transport);
  assert.equal(result.status,'matched');
  assert.deepEqual(trace.map(x=>x.method),['initialize','notifications/initialized','tools/call']);
  assert.deepEqual(trace[2].params,{name:'quote_travel_esim',arguments:args});
});
