export default async (page, ctx) => {
  const sets = (ctx.opt('sets', '0,1,2,3,4,5,6,7')).split(',').map(Number), u = ctx.opt('u', '0.5');
  for (const s of sets) {
    await page.evaluate((s, u) => { const L = window.__lineup; L.sel.value = s; document.getElementById('play').checked = false; document.getElementById('u').value = u; }, s, u);
    await ctx.sleep(1200); await ctx.shot(`lineup_${s}_u${u}`);
  }
  return 'ok';
};
