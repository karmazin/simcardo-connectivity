'use strict';

const form = document.querySelector('#form');
const button = document.querySelector('#search');
const statusLine = document.querySelector('#status');
const results = document.querySelector('#results');
let currentTrip;
let revision = 0;
let waiting = false;

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

function renderOffers(offers) {
  for (const offer of offers) {
    const url = new URL(offer.url);
    if (url.origin !== 'https://simcardo.com' || url.searchParams.get('sku') !== offer.sku) continue;
    const li = node('li','','trek-card trek-stack');
    li.append(node('h2',offer.name || 'Travel eSIM','trek-title'));
    li.append(node('p',[(offer.unlimited ? 'Unlimited data (fair-use terms apply)' : offer.dataGb + ' GB'),
      offer.days + (offer.days === 1 ? ' day' : ' days'), offer.price].join(' · ')));
    li.append(node('p',offer.hotspot === true ? 'Hotspot verified' : offer.hotspot === false ? 'Hotspot not supported' : 'Hotspot not verified','trek-muted small'));
    li.append(node('p',offer.activation,'trek-muted small'));
    const cta = node('button','Open plan on Simcardo','trek-btn trek-btn--secondary');
    cta.type = 'button';
    cta.addEventListener('click',() => trek.openExternal(url.href));
    li.append(cta);
    results.append(li);
  }
}

trek.onContext(async ctx => {
  const id = ctx.tripId;
  if (!id || id === currentTrip) return;
  currentTrip = id;
  const seq = ++revision;
  waiting = false;
  button.disabled = false;
  form.reset();
  results.replaceChildren();
  statusLine.textContent = '';
  try {
    const d = await trek.invoke('/trip-defaults',{method:'POST',body:{tripId:id}});
    if (seq !== revision || waiting) return;
    if (!form.elements.startDate.value && d.startDate) form.elements.startDate.value = d.startDate;
    if (!form.elements.endDate.value && d.endDate) form.elements.endDate.value = d.endDate;
    if (d.currency && form.elements.currency.value === 'EUR') form.elements.currency.value = d.currency;
  } catch {
    if (seq === revision && !waiting) statusLine.textContent = 'Trip dates could not be read. You can enter them manually.';
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (waiting) return;
  const seq = ++revision;
  waiting = true;
  button.disabled = true;
  results.replaceChildren();
  statusLine.textContent = 'Checking current Simcardo plans…';
  const data = Object.fromEntries(new FormData(form));
  try {
    const res = await trek.invoke('/quote',{method:'POST',body:{
      countries:data.countries,startDate:data.startDate,endDate:data.endDate,profile:data.profile,
      currency:data.currency,dataGb:data.dataGb,hotspot:data.hotspot === 'on',language:trek.context?.locale
    }});
    if (seq !== revision) return;
    const labels = {
      no_match:'No Simcardo plan matches all the selected requirements.',
      needs_verification:'No plan can be confirmed from current catalogue data. No unverified offers are shown.',
      invalid_input:'Check your dates, countries, currency and data needs. Use two-letter country codes.'
    };
    if (res.status === 'matched') {
      renderOffers(res.plans);
      statusLine.textContent = results.childElementCount
        ? 'Matching plans. Recheck price and terms on Simcardo before buying.'
        : 'Could not verify a direct plan link.';
    } else statusLine.textContent = labels[res.status] || 'Could not check current plans.';
  } catch (error) {
    if (seq === revision) statusLine.textContent = error.code === 400
      ? 'Check your dates, countries, currency and data needs.'
      : 'The quote service did not respond. Please try again later.';
  } finally {
    if (seq === revision) { waiting = false; button.disabled = false; }
  }
});
