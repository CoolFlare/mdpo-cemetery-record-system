'use strict';
// Lightweight offline charts - no external libraries
const Charts = {
  palette: ['#1e3a5f', '#35618f', '#c9a227', '#15803d', '#b45309', '#b91c1c', '#6d28d9', '#0e7490'],

  fmtNum(n) { return Number(n).toLocaleString('en-US'); },

  // Horizontal bar chart: data = [{label, value}]
  hbar(el, data, opts = {}) {
    if (!data.length) { el.innerHTML = '<p class="muted">No data available.</p>'; return; }
    const max = Math.max(...data.map(d => d.value), 1);
    el.innerHTML = data.map((d, i) => `
      <div class="hbar-row">
        <span class="hbar-label" title="${this.esc(d.label)}">${this.esc(d.label)}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(2, (d.value / max) * 100)}%;background:${this.palette[i % this.palette.length]}"></span></span>
        <span class="num">${opts.money ? Number(d.value).toLocaleString('en-US', { minimumFractionDigits: 2 }) : this.fmtNum(d.value)}</span>
      </div>`).join('');
  },

  // Vertical bar chart: data = [{label, value}]
  vbar(el, data, opts = {}) {
    if (!data.length) { el.innerHTML = '<p class="muted">No data available.</p>'; return; }
    const max = Math.max(...data.map(d => d.value), 1);
    el.innerHTML = `<div class="vbars">` + data.map(d => `
      <div class="vbar" title="${this.esc(d.label)}: ${opts.money ? Number(d.value).toLocaleString('en-US', { minimumFractionDigits: 2 }) : this.fmtNum(d.value)}">
        <span class="bar-val">${opts.compact ? this.compact(d.value) : ''}</span>
        <span class="bar" style="height:${Math.max(2, (d.value / max) * 100)}%"></span>
        <span class="bar-label">${this.esc(d.label)}</span>
      </div>`).join('') + `</div>`;
  },

  // Donut chart via SVG: data = [{label, value}]
  donut(el, data, opts = {}) {
    if (!data.length || data.every(d => !d.value)) { el.innerHTML = '<p class="muted">No data available.</p>'; return; }
    const total = data.reduce((a, d) => a + d.value, 0) || 1;
    const R = 54, C = 2 * Math.PI * R;
    let offset = 0;
    const circles = data.filter(d => d.value > 0).map((d, i) => {
      const frac = d.value / total;
      const dash = frac * C;
      const seg = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${this.palette[i % this.palette.length]}" stroke-width="26"
        stroke-dasharray="${dash} ${C - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)"><title>${this.esc(d.label)}: ${this.fmtNum(d.value)} (${(frac * 100).toFixed(1)}%)</title></circle>`;
      offset += dash;
      return seg;
    }).join('');
    const legend = data.map((d, i) => `<span><span class="sw" style="background:${this.palette[i % this.palette.length]}"></span>${this.esc(d.label)} — ${this.fmtNum(d.value)}</span>`).join('');
    el.innerHTML = `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
      <svg width="140" height="140" viewBox="0 0 140 140">${circles}
        <text x="70" y="66" text-anchor="middle" font-size="20" font-weight="700" fill="#1e3a5f">${this.fmtNum(total)}</text>
        <text x="70" y="84" text-anchor="middle" font-size="9" fill="#64748b">TOTAL</text></svg>
      <div class="legend" style="flex-direction:column;gap:6px">${legend}</div></div>`;
  },

  compact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
    return String(n);
  },

  esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
};
