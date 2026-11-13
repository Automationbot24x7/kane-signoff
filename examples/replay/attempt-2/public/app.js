// Tabby: all money is handled in whole cents so shares always add up exactly.
(() => {
  const KEY = 'tabby:last';
  const COUPONS = { WELCOME10: { percent: 10 } };
  const GST_PERCENT = 5;
  const $ = (id) => document.getElementById(id);
  const bill = $('bill');
  const people = $('people');
  const coupon = $('coupon');
  const gst = $('gst');
  const roundUp = $('round-up');
  const tips = [...document.querySelectorAll('input[name="tip"]')];
  const out = {
    discountRow: $('discount-row'), discount: $('discount'),
    gstRow: $('gst-row'), gst: $('gst-amount'),
    tip: $('tip-amount'), total: $('total'), each: $('each'), shares: $('shares'),
    link: $('share-link'),
  };
  const msg = { bill: $('bill-msg'), people: $('people-msg'), coupon: $('coupon-msg') };

  const fmt = (cents) => '$' + (cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  // Parse a decimal string into integer cents without floating-point drift.
  function toCents(text) {
    const s = String(text).trim();
    if (s === '') return 0;
    const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (m[1] === '' && !m[2])) return NaN;
    const frac = ((m[2] || '') + '000').slice(0, 3);
    let cents = Number(m[1] || 0) * 100 + Number(frac.slice(0, 2));
    if (Number(frac[2]) >= 5) cents += 1; // round half up at the third decimal
    return Number.isSafeInteger(cents) ? cents : NaN;
  }

  // Split total into n integer-cent shares that sum to total exactly.
  function split(total, n) {
    const base = Math.floor(total / n);
    const extra = total - base * n; // first `extra` people pay one more cent
    return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
  }

  // Round an amount in cents up to the next whole dollar.
  const ceilDollar = (cents) => Math.ceil(cents / 100) * 100;

  const selectedTip = () => {
    const t = tips.find((r) => r.checked);
    return t ? Number(t.value) : 0;
  };

  // The coupon that is actually applied: the last valid code entered ('' for none).
  // An invalid entry leaves it unchanged, so it changes nothing.
  let applied = '';

  function refreshCoupon() {
    const code = coupon.value.trim().toUpperCase();
    const valid = code !== '' && Object.hasOwn(COUPONS, code);
    if (code === '') applied = '';
    else if (valid) applied = code;
    msg.coupon.textContent = code !== '' && !valid ? 'That code is not valid.' : '';
    coupon.toggleAttribute('aria-invalid', code !== '' && !valid);
  }

  // Current settings as strings, used for both localStorage and the share link.
  function state() {
    return {
      bill: bill.value,
      tip: String(selectedTip()),
      people: people.value,
      gst: gst.checked ? '1' : '0',
      coupon: applied,
      round: roundUp.checked ? '1' : '0',
    };
  }

  // Apply any settings present in `p`; keys that are absent are left alone.
  function applyParams(p) {
    if (p.has('bill')) bill.value = p.get('bill');
    if (p.has('people')) people.value = p.get('people');
    if (p.has('coupon')) coupon.value = p.get('coupon');
    if (p.has('tip')) {
      const t = Number(p.get('tip'));
      tips.forEach((r) => { r.checked = Number(r.value) === t; });
    }
    if (p.has('gst')) gst.checked = p.get('gst') === '1';
    if (p.has('round')) roundUp.checked = p.get('round') === '1';
  }

  function render() {
    const billCents = toCents(bill.value);
    const badBill = Number.isNaN(billCents);
    const base = badBill ? 0 : billCents;
    msg.bill.textContent = badBill ? 'Enter a valid amount, like 42.50.' : '';
    bill.toggleAttribute('aria-invalid', badBill);

    // Order: coupon off the bill, GST on the discounted bill, tip on the discounted bill before GST.
    refreshCoupon();
    const offer = applied ? COUPONS[applied] : null;

    const discount = offer ? Math.round((base * offer.percent) / 100) : 0;
    const discounted = base - discount;
    const gstCents = gst.checked ? Math.round((discounted * GST_PERCENT) / 100) : 0;
    const tipBase = Math.round((discounted * selectedTip()) / 100);
    const beforeRound = discounted + gstCents + tipBase;

    const raw = people.value.trim();
    const n = raw === '' ? 0 : Number(raw);
    let peopleError = '';
    if (!(n >= 1)) peopleError = 'Please enter at least one person.';
    else if (!Number.isInteger(n)) peopleError = 'People must be a whole number.';
    else if (n > 1000) peopleError = 'That is a lot of people. 1000 at most.';
    msg.people.textContent = peopleError;
    people.toggleAttribute('aria-invalid', !!peopleError);

    // Shares are computed first; with round-up, each share goes to the next dollar and the extra joins the tip.
    let shares = [];
    let total = beforeRound;
    if (!peopleError) {
      shares = split(beforeRound, n);
      if (roundUp.checked) shares = shares.map(ceilDollar);
      total = shares.reduce((a, b) => a + b, 0);
    }
    const tipCents = tipBase + (total - beforeRound);

    out.discountRow.hidden = discount === 0;
    out.discount.textContent = '−' + fmt(discount);
    out.gstRow.hidden = !gst.checked;
    out.gst.textContent = fmt(gstCents);
    out.tip.textContent = fmt(tipCents);
    out.total.textContent = fmt(total);

    out.shares.replaceChildren();
    if (peopleError) {
      out.each.textContent = '—';
      return;
    }
    const lo = shares[shares.length - 1];
    const hi = shares[0];
    out.each.textContent = hi === lo ? fmt(hi) : `${fmt(lo)} – ${fmt(hi)}`;
    if (n > 1) {
      // Group identical shares to keep the list short for large groups.
      const groups = new Map();
      shares.forEach((c) => groups.set(c, (groups.get(c) || 0) + 1));
      let from = 1;
      for (const [cents, count] of groups) {
        const li = document.createElement('li');
        const who = count === 1 ? `Person ${from}` : `People ${from}–${from + count - 1}`;
        li.innerHTML = `<span></span><strong></strong>`;
        li.firstChild.textContent = count === 1 ? who : `${who} (${count} × ${fmt(cents)})`;
        li.lastChild.textContent = fmt(cents) + (count === 1 ? '' : ' each');
        out.shares.append(li);
        from += count;
      }
      const sum = document.createElement('li');
      sum.className = 'sum';
      sum.innerHTML = '<span>Together</span><strong></strong>';
      sum.lastChild.textContent = fmt(total);
      out.shares.append(sum);
    }
  }

  function updateLink() {
    const u = new URL(location.href);
    u.search = new URLSearchParams(state()).toString();
    u.hash = '';
    out.link.href = u.href;
    out.link.textContent = u.href;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state()));
    } catch { /* storage unavailable: nothing to remember */ }
  }

  function restore() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!s || typeof s !== 'object') return;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === 'string' || typeof v === 'number') p.set(k, String(v));
      }
      applyParams(p);
    } catch { /* ignore corrupt state */ }
  }

  // Clicking the selected tip again clears it (no tip).
  tips.forEach((r) => {
    r.closest('label').addEventListener('pointerdown', () => { r.dataset.was = r.checked ? '1' : ''; });
    r.addEventListener('click', () => {
      if (r.dataset.was === '1') r.checked = false;
      r.dataset.was = '';
      update();
    });
  });

  function update() { render(); save(); updateLink(); }
  document.getElementById('form').addEventListener('input', update);
  document.getElementById('form').addEventListener('change', update);

  $('copy').addEventListener('click', async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(out.link.href);
      ok = true;
    } catch { /* clipboard unavailable */ }
    $('copy-msg').textContent = ok ? 'Link copied.' : 'Could not copy. Select the link and copy it.';
  });

  restore();
  // A link opened with settings in its address takes those settings over the saved ones.
  if (location.search) applyParams(new URLSearchParams(location.search));
  render();
  updateLink();
})();
