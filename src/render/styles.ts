import { CHANNELS } from '../config/channels.ts';

/**
 * The whole stylesheet, inlined into every document.
 *
 * There is no external CSS file on purpose: the page must be useful after one
 * request, and a stylesheet link is a second round trip in front of first
 * paint. At a few kilobytes it is cheaper inline than referenced.
 *
 * Column order is a custom property per channel rather than markup order, so
 * the favourites script can reorder and hide columns by replacing one small
 * style block instead of moving DOM.
 */

/** Natural order, used when the visitor has chosen nothing and when JS is off. */
function defaultColumns(): string {
  return CHANNELS.map((channel, index) => `[data-ch="${channel.slug}"]{--c:${index + 2}}`).join('');
}

export const STYLES = `
:root{
  --bg:#fbfaf8; --fg:#16150f; --muted:#6b6559; --line:#e3ded4;
  --cell:#fff; --live:#b8331f; --now:#b8331f; --accent:#1f5c4a;
  --rail:64px; --col:minmax(9rem,1fr);
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#12120f; --fg:#ece7dd; --muted:#918a7c; --line:#2b2a25;
    --cell:#1a1a16; --live:#e8674e; --now:#e8674e; --accent:#6fbfa2;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
}
a{color:inherit;text-decoration:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

header{
  position:sticky;top:0;z-index:3;background:var(--bg);
  border-bottom:1px solid var(--line);padding:.6rem .8rem;
}
.bar{display:flex;gap:.75rem;align-items:baseline;flex-wrap:wrap}
h1{font-size:1rem;font-weight:600;margin:0;letter-spacing:.01em}
.days{display:flex;gap:.25rem;overflow-x:auto;padding-bottom:.1rem}
.days a{
  padding:.2rem .5rem;border-radius:.35rem;white-space:nowrap;
  font-variant-numeric:tabular-nums;color:var(--muted);
}
.days a:hover{background:var(--line)}
.days a[aria-current]{background:var(--fg);color:var(--bg);font-weight:600}

/* Filled by script from the grid itself, so it costs no extra payload. */
#now-strip{display:grid;gap:.4rem;grid-template-columns:repeat(auto-fill,minmax(11rem,1fr));padding:.6rem .8rem}
#now-strip:empty{display:none}
.nowcard{background:var(--cell);border:1px solid var(--line);border-radius:.5rem;padding:.45rem .55rem;min-width:0}
.nowcard b{display:block;font-size:.72rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.nowcard span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nowcard i{font-style:normal;color:var(--muted);font-size:.8rem;font-variant-numeric:tabular-nums}

.guide{
  display:grid;grid-template-columns:var(--rail) repeat(var(--cols),var(--col));
  align-items:stretch;padding:0 .8rem 3rem;column-gap:2px;
}
${defaultColumns()}

.head{
  position:sticky;top:2.6rem;z-index:2;grid-row:1;
  background:var(--bg);border-bottom:1px solid var(--line);
  padding:.35rem .4rem;font-size:.8rem;font-weight:600;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.head[data-ch]{grid-column:var(--c)}
.rail{grid-column:1;color:var(--muted);font-size:.72rem;font-variant-numeric:tabular-nums}
.rail span{display:block;padding-top:2px;border-top:1px solid var(--line)}

.p{
  grid-column:var(--c);background:var(--cell);border:1px solid var(--line);
  border-radius:.35rem;padding:.25rem .4rem;margin:1px 0;min-width:0;overflow:hidden;
  display:block;
}
.p time{display:block;font-size:.72rem;color:var(--muted);font-variant-numeric:tabular-nums}
.p b{font-weight:500;font-size:.82rem;display:block;overflow:hidden}
.p[data-live]{border-color:var(--live);box-shadow:inset 3px 0 0 var(--live)}
.p:hover{border-color:var(--accent)}
.p[hidden]{display:none}

/* Search dims rather than removes: display:none would collapse the row
   lattice and destroy the time alignment the grid exists for. */
.p[data-dim]{opacity:.22}

#nowline{
  grid-column:1/-1;position:relative;height:0;z-index:1;pointer-events:none;
  border-top:2px solid var(--now);
}
#nowline::after{
  content:attr(data-at);position:absolute;left:0;top:-.7em;
  background:var(--now);color:#fff;font-size:.66rem;padding:0 .25rem;border-radius:.2rem;
  font-variant-numeric:tabular-nums;
}

footer{padding:1rem .8rem 2rem;color:var(--muted);font-size:.78rem}
.stale{background:var(--live);color:#fff;padding:.4rem .8rem;font-size:.82rem}

@media (max-width:640px){
  :root{--rail:44px;--col:minmax(7.5rem,1fr)}
  body{font-size:14px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`.trim();
