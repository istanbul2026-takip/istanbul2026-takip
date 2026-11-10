// Works out a club's entries from the scraped data on every build, so the club page follows
// WDSF changes on its own. Rules (config in club/<slug>.json):
//  - teams whose name matches teamPattern, or is listed in extraTeams, are the club's teams;
//    their members (plus extraPeople) are the club's athletes;
//  - other teams with at least half club athletes also count;
//  - Turkish solos / duos with a club athlete count.
const stripTitle = n => n.replace(/\s*\([^)]*\)\s*$/, '').trim();
const people = n => stripTitle(n).split('/').map(s => s.trim()).filter(Boolean);
const given = full => { const p = full.split(/\s+/); return p.length > 1 ? p.slice(0, -1).join(' ') : full; };
const teamLabel = n => {
  const base = stripTitle(n);
  const m = base.match(/^(.*?)\s*-\s*Tarz\b/i);
  return (m ? m[1] : base).trim() || base;
};

export function clubFor(data, cfg) {
  const re = new RegExp(cfg.teamPattern, 'i');
  const extraTeams = new Set((cfg.extraTeams || []).map(s => s.toLowerCase()));
  const exclude = new Set(cfg.excludePeople || []);
  const P = data.P || {}, T = data.T || {};
  const isClubTeam = n => re.test(n) || extraTeams.has(stripTitle(n).toLowerCase());
  const members = new Set(cfg.extraPeople || []);
  for (const [cid, list] of Object.entries(P)) list.forEach(([n], i) => {
    if (isClubTeam(n) && T[cid] && T[cid][i]) T[cid][i].forEach(m => members.add(m));
  });
  exclude.forEach(m => members.delete(m));

  const entries = {};                     // compId -> [[entryName, label, [athletes]]]
  const add = (cid, n, label, who) => (entries[cid] = entries[cid] || []).push([n, label, who]);
  for (const [cid, list] of Object.entries(P)) list.forEach(([n, cty], i) => {
    const team = T[cid] && T[cid][i] && T[cid][i].length > 2 ? T[cid][i] : null;
    if (team) {
      const share = team.filter(m => members.has(m)).length / team.length;
      if (isClubTeam(n) || share >= 0.5) add(cid, n, teamLabel(n), team.filter(m => members.has(m)));
      return;
    }
    if (cty !== 'TUR') return;
    const who = people(n).filter(p => members.has(p));
    if (who.length) add(cid, n, people(n).map(given).join(' – '), who);
  });
  return { slug: cfg.slug, name: cfg.name, short: cfg.short, members: [...members].sort((a, b) => a.localeCompare(b, 'tr')), entries };
}
