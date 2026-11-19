'use strict';

const https = require('node:https');
const origin = 'https://simcardo.com';
const endpoint = origin + '/mcp-travel-esim';
const currencies = new Set('EUR USD GBP CZK JPY CHF CAD AUD PLN SEK DKK NOK'.split(' '));
const languages = new Set('ar cs da de el en es-419 es-ES fi fr he hi id it ja ko nb nl pl pt-BR pt-PT ru sk sv-SE th tr vi zh-CN zh-TW bg bn bs ca et fa fil gl hr hu lt lv mk ms mt ro sq sr-CS sw ta uk ur-PK'.split(' '));

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value ? value : '';
}

function locale(value) {
  const key = typeof value === 'string' ? value : '';
  const aliases = {es:'es-ES', pt:'pt-PT', br:'pt-BR', sv:'sv-SE', gr:'el', 'zh-Hans':'zh-CN', 'zh-Hant':'zh-TW'};
  if (languages.has(key)) return key;
  if (Object.hasOwn(aliases,key)) return aliases[key];
  const short = key.split('-')[0];
  return languages.has(short) ? short : 'en';
}

function defaults(trip) {
  return {
    startDate: date(trip?.start_date),
    endDate: date(trip?.end_date),
    currency: currencies.has(trip?.currency) ? trip.currency : 'EUR'
  };
}

function quoteInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Enter trip details.');
  const countries = typeof input.countries === 'string' && input.countries.length <= 48
    ? input.countries.trim().toUpperCase().split(/[\s,]+/).map(iso=>iso==='UK'?'GB':iso) : [];
  if (countries.length < 1 || countries.length > 8 || countries.some(iso => !/^[A-Z]{2}$/.test(iso))
    || new Set(countries).size !== countries.length) {
    throw new Error('Enter 1–8 different two-letter country codes, e.g. FR, DE, CZ.');
  }
  const start = date(input.startDate), end = date(input.endDate);
  if (!start || !end || end < start) throw new Error('Check the start and end dates.');
  const days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  if (days > 365) throw new Error('Choose a trip of up to 365 days.');
  if (!currencies.has(input.currency)) throw new Error('Choose a supported currency.');
  const args = {
    destination: countries[0], start_date: start, end_date: end,
    currency: input.currency, language: locale(input.language),
    hotspot_required: input.hotspot === true, include_regional: true
  };
  if (countries.length > 1) args.additional_destinations = countries.slice(1);
  if (input.dataGb !== '' && input.dataGb != null) {
    const value = Number(input.dataGb);
    if (!Number.isFinite(value) || value < 0.1 || value > 1000) throw new Error('Enter between 0.1 and 1,000 GB.');
    args.data_gb = value;
  } else {
    if (!['light','normal','heavy'].includes(input.profile)) throw new Error('Choose a data usage profile.');
    args.usage_profile = input.profile;
  }
  return args;
}

function trackedLink(value, sku) {
  const u = new URL(value);
  if (u.origin !== origin || u.username || u.password || u.hash
    || !/^\/[a-z][a-z0-9-]*\/esim\//i.test(u.pathname)
    || !sku || u.searchParams.getAll('sku').length !== 1 || u.searchParams.get('sku') !== sku) return null;
  u.searchParams.set('utm_source','mcp_registry');
  u.searchParams.set('utm_medium','mcp');
  u.searchParams.set('utm_campaign','travel_esim');
  u.searchParams.set('utm_content','trek_itinerary');
  return u.href;
}

function publicQuote(body, args) {
  if (!['matched','no_match','needs_verification'].includes(body?.status)) throw new Error('Invalid quote service response.');
  if (body.status !== 'matched') return {status:body.status, plans:[]};
  const days = (Date.parse(args.end_date) - Date.parse(args.start_date)) / 86400000 + 1;
  const countries = [args.destination, ...(args.additional_destinations || [])];
  const plans = (Array.isArray(body.plans) ? body.plans : []).slice(0,3).flatMap((p) => {
    if (!Number.isInteger(p?.validity_days) || p.validity_days < days || p.currency !== args.currency
      || typeof p.total_price !== 'number' || !(p.total_price > 0) || !Number.isFinite(p.total_price)
      || typeof p.formatted_price !== 'string' || typeof p.activation_label !== 'string'
      || (!p.unlimited && !(p.data_gb > 0))
      || (args.hotspot_required && p.hotspot !== true)
      || !Array.isArray(p.coverage?.country_codes)
      || !countries.every(code => p.coverage.country_codes.includes(code))) return [];
    let url;
    try { url = trackedLink(p.product_url,p.sku); } catch { return []; }
    if (!url) return [];
    return [{sku:p.sku, name:String(p.market_name || '').slice(0,100),
      price:p.formatted_price.slice(0,50), days:p.validity_days, dataGb:p.data_gb,
      unlimited:p.unlimited === true, hotspot:p.hotspot === true ? true : p.hotspot === false ? false : null,
      activation:p.activation_label.slice(0,450), url}];
  });
  return {status:plans.length ? 'matched' : 'needs_verification', plans};
}

// Keep network access inside TREK's standard per-host egress guard. This
// endpoint returns JSON only; no redirect, decompression or cookie handling.
function httpsTransport(url, opt) {
  return new Promise((resolve,reject) => {
    const req = https.request(url,{method:opt.method,headers:{
      ...opt.headers,'Content-Length':Buffer.byteLength(opt.body)
    },signal:opt.signal}, res => {
      const status = res.statusCode;
      const chunks = [];
      let size = 0;
      res.on('error',reject);
      res.on('data',chunk => {
        size += chunk.length;
        if (size > 128 * 1024) res.destroy(new Error('Quote service response is too large.'));
        else chunks.push(chunk);
      });
      res.on('end',() => resolve({status,ok:status >= 200 && status < 300,
        async json(){return JSON.parse(Buffer.concat(chunks).toString('utf8'));}}));
    });
    req.on('error',reject);
    req.end(opt.body);
  });
}

async function requestQuote(args, transport = httpsTransport) {
  // The public Simcardo endpoint uses stateless JSON responses over Streamable HTTP.
  const protocolVersion = '2025-11-25';
  const signal = AbortSignal.timeout(9000);
  async function post(message, version) {
    const headers = {'Content-Type':'application/json','Accept':'application/json, text/event-stream'};
    if (version) headers['MCP-Protocol-Version'] = version;
    const response = await transport(endpoint, {
      method:'POST', headers, body:JSON.stringify({jsonrpc:'2.0', ...message}), redirect:'error', signal
    });
    if (!response.ok) throw new Error('Quote service unavailable.');
    if (message.id === undefined) {
      if (response.status !== 202) throw new Error('Invalid quote service acknowledgement.');
      return;
    }
    const rpc = await response.json();
    if (rpc.id !== message.id || rpc.jsonrpc !== '2.0' || rpc.error) throw new Error('Invalid quote service response.');
    return rpc.result;
  }
  const init = await post({id:1, method:'initialize', params:{
    protocolVersion, capabilities:{}, clientInfo:{name:'simcardo-trek-connectivity', version:'0.1.0'}
  }});
  if (init?.serverInfo?.name !== 'com.simcardo/travel-esim' || init.protocolVersion !== protocolVersion)
    throw new Error('Could not connect to the Simcardo quote service.');
  await post({method:'notifications/initialized'},protocolVersion);
  const result = await post({id:2, method:'tools/call', params:{name:'quote_travel_esim', arguments:args}},protocolVersion);
  if (result?.isError) return {status:'invalid_input',plans:[]};
  return publicQuote(result?.structuredContent,args);
}

module.exports = {defaults, quoteInput, requestQuote, publicQuote};
