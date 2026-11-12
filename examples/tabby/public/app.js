// Tabby: all money is handled in whole cents so shares always add up exactly.
(() => {
  const KEY = 'tabby:last';
  const $ = (id) => document.getElementById(id);
  const bill = $('bill');
  const people = $('people');
  const tips = [...document.querySelectorAll('input[name="tip"]')];
  const out = { tip: $('tip-amount'), total: $('total'), each: $('each'), shares: $('shares') };
  const msg = { bill: $('bill-msg'), people: $('people-msg') };

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

  const selectedTip = () => {
    const t = tips.find((r) => r.checked);
    return t ? Number(t.value) : 0;
  };

  function render() {
    const billCents = toCents(bill.value);
    const pct = selectedTip();
    const raw = people.value.trim();
    const n = raw === '' ? 0 : Number(raw);

    msg.bill.textContent = Number.isNaN(billCents) ? 'Enter a valid amount, like 42.50.' : '';
    let peopleError = '';
    if (!(n >= 1)) peopleError = 'Please enter at least one person.';
    else if (!Number.isInteger(n)) peopleError = 'People must be a whole number.';
    else if (n > 1000) peopleError = 'That is a lot of people. 1000 at most.';
    msg.people.textContent = peopleError;
    people.toggleAttribute('aria-invalid', !!peopleError);
    bill.toggleAttribute('aria-invalid', Number.isNaN(billCents));

    const safeBill = Number.isNaN(billCents) ? 0 : billCents;
    const tipCents = Math.round((safeBill * pct) / 100);
    const total = safeBill + tipCents;
    out.tip.textContent = fmt(tipCents);
    out.total.textContent = fmt(total);

    out.shares.replaceChildren();
    if (peopleError) {
      out.each.textContent = '—';
      return;
    }
    const shares = split(total, n);
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
      sum.lastChild.textContent = fmt(shares.reduce((a, b) => a + b, 0));
      out.shares.append(sum);
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ bill: bill.value, tip: selectedTip(), people: people.value }));
    } catch { /* storage unavailable: nothing to remember */ }
  }

  function restore() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!s) return;
      if (typeof s.bill === 'string') bill.value = s.bill;
      if (typeof s.people === 'string') people.value = s.people;
      tips.forEach((r) => { r.checked = Number(r.value) === s.tip; });
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

  function update() { render(); save(); }
  document.getElementById('form').addEventListener('input', update);
  document.getElementById('form').addEventListener('change', update);

  restore();
  render();
})();
