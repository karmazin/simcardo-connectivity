'use strict';

const { definePlugin } = require('trek-plugin-sdk');
const { defaults, quoteInput, requestQuote } = require('./quote.js');

const json = (status, body) => ({
  status, headers:{'content-type':'application/json', 'cache-control':'no-store'}, body:JSON.stringify(body)
});

module.exports = definePlugin({
  routes: [
    {method:'POST', path:'/trip-defaults', auth:true, async handler(req,ctx) {
      const tripId = Number(req.body?.tripId);
      if (!Number.isSafeInteger(tripId) || tripId <= 0) return json(400,{error:'Open a trip first.'});
      const trip = await ctx.trips.getById(tripId);
      // TREK checks membership. Never return title, bookings, notes or identifiers.
      return json(200,defaults(trip));
    }},
    {method:'POST', path:'/quote', auth:true, async handler(req) {
      let args;
      try { args = quoteInput(req.body); }
      catch (error) { return json(400,{error:error.message}); }
      // No trip identifiers or personal details go into this anonymous request.
      try { return json(200,await requestQuote(args)); }
      catch { return json(502,{error:'Simcardo quote service is temporarily unavailable.'}); }
    }}
  ]
});
