// Generates github-stats/dashboard.svg from live GitHub data.
// Env: GH_TOKEN (PAT with read:user + repo for private data), GH_USER, UTC_OFFSET (hours), SUBTITLE.
//
// Rewritten 2026-09-30 after the original script was lost (never committed to git).
// Reproduces the same visual template; data-fetching logic below is a fresh
// implementation against GitHub's GraphQL API, not a byte-for-byte restore.
import { writeFileSync, mkdirSync } from 'node:fs';

const USER = process.env.GH_USER || 'aminebenjebli';
const TOKEN = process.env.GH_TOKEN;
const OFFSET = Number(process.env.UTC_OFFSET ?? 1);
const SUBTITLE = process.env.SUBTITLE || 'Amine Ben Jebli · Software Engineer';

if (!TOKEN) {
  console.error('GH_TOKEN is required (PAT with read:user + repo scopes).');
  process.exit(1);
}

// ---------- GraphQL helper ----------
async function gql(query, variables) {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await r.json();
  if (json.errors) {
    throw new Error('GraphQL error: ' + JSON.stringify(json.errors));
  }
  return json.data;
}

// ---------- date helpers ----------
const MS_DAY = 86400000;
function toDateKey(d) {
  return d.toISOString().slice(0, 10);
}
function shortDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
// "local" day in the profile's UTC offset, for streaks / hour bucketing
function localDate(isoString) {
  const d = new Date(isoString);
  return new Date(d.getTime() + OFFSET * 3600000);
}

// ---------- 1. account + calendar years ----------
async function getUserMeta() {
  const data = await gql(
    `query($login:String!){ user(login:$login){ id createdAt } }`,
    { login: USER }
  );
  return data.user;
}

async function getContributionCalendarYears(createdAt) {
  const start = new Date(createdAt);
  const now = new Date();
  const years = [];
  for (let y = start.getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = new Date(Date.UTC(y, 0, 1, 0, 0, 0));
    let to = new Date(Date.UTC(y, 11, 31, 23, 59, 59));
    if (from < start) from.setTime(start.getTime());
    if (to > now) to.setTime(now.getTime());
    if (from >= to) continue;
    years.push({ from: from.toISOString(), to: to.toISOString() });
  }
  return years;
}

async function getContributionData(years) {
  let total = 0;
  const days = []; // { date: 'YYYY-MM-DD', count }
  const repoCommitCounts = new Map(); // nameWithOwner -> commit count

  for (const range of years) {
    const data = await gql(
      `query($login:String!, $from:DateTime!, $to:DateTime!){
        user(login:$login){
          contributionsCollection(from:$from, to:$to){
            contributionCalendar{
              totalContributions
              weeks{ contributionDays{ date contributionCount } }
            }
            commitContributionsByRepository(maxRepositories:100){
              repository{ nameWithOwner isFork }
              contributions{ totalCount }
            }
          }
        }
      }`,
      { login: USER, from: range.from, to: range.to }
    );
    const cc = data.user.contributionsCollection;
    total += cc.contributionCalendar.totalContributions;
    for (const w of cc.contributionCalendar.weeks) {
      for (const d of w.contributionDays) {
        days.push({ date: d.date, count: d.contributionCount });
      }
    }
    for (const repo of cc.commitContributionsByRepository) {
      if (repo.repository.isFork) continue;
      const key = repo.repository.nameWithOwner;
      repoCommitCounts.set(key, (repoCommitCounts.get(key) || 0) + repo.contributions.totalCount);
    }
  }

  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { total, days, repoCommitCounts };
}

// ---------- 2. streaks ----------
function computeStreaks(days) {
  let longest = 0, longestStart = null, longestEnd = null;
  let run = 0, runStart = null;
  let prevDate = null;

  for (const { date, count } of days) {
    if (count > 0) {
      if (run === 0) runStart = date;
      run++;
      if (run > longest) {
        longest = run;
        longestStart = runStart;
        longestEnd = date;
      }
    } else {
      run = 0;
    }
    prevDate = date;
  }

  // current streak: walk backward from the end; a zero-count *today* doesn't
  // break it (the day may not be over yet in the profile's timezone), but it
  // also isn't counted as part of the streak until it actually has activity.
  const todayKey = toDateKey(localDate(new Date().toISOString()));
  let current = 0, currentStart = null, currentEnd = null;
  for (let i = days.length - 1; i >= 0; i--) {
    const { date, count } = days[i];
    if (count > 0) {
      if (currentEnd === null) currentEnd = date; // most recent day with activity
      current++;
      currentStart = date;
    } else if (date === todayKey) {
      continue; // today just hasn't happened yet
    } else {
      break;
    }
  }

  return {
    longest,
    longestRange: longest ? `${shortDate(new Date(longestStart))} to ${shortDate(new Date(longestEnd))}` : '',
    current,
    currentRange: current ? `${shortDate(new Date(currentStart))} to ${shortDate(new Date(currentEnd))}` : '',
  };
}

// ---------- 3. commits by hour ----------
async function getCommitHours(viewerId, repoNames) {
  const hours = new Array(24).fill(0);
  for (const nameWithOwner of repoNames) {
    const [owner, name] = nameWithOwner.split('/');
    try {
      const data = await gql(
        `query($owner:String!, $name:String!, $authorId:ID){
          repository(owner:$owner, name:$name){
            defaultBranchRef{
              target{
                ... on Commit{
                  history(first:100, author:{id:$authorId}){
                    nodes{ committedDate }
                  }
                }
              }
            }
          }
        }`,
        { owner, name, authorId: viewerId }
      );
      const nodes = data.repository?.defaultBranchRef?.target?.history?.nodes || [];
      for (const n of nodes) {
        const h = localDate(n.committedDate).getUTCHours();
        hours[h]++;
      }
    } catch {
      // skip repos we can't read (deleted, renamed, no access, etc.)
    }
  }
  return hours;
}

// ---------- 4. languages ----------
async function getRepoLanguages() {
  const data = await gql(
    `query($login:String!){
      user(login:$login){
        repositories(first:100, ownerAffiliations:OWNER, isFork:false){
          nodes{ nameWithOwner primaryLanguage{ name } }
        }
      }
    }`,
    { login: USER }
  );
  const map = new Map(); // nameWithOwner -> language name
  for (const repo of data.user.repositories.nodes) {
    if (repo.primaryLanguage) map.set(repo.nameWithOwner, repo.primaryLanguage.name);
  }
  return map;
}

function topLanguages(counts, limit = 5) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count, pct: Math.round((count / total) * 100), frac: count / total }));
}

// ---------- render (visual template, unchanged from the original design) ----------
function renderSVG(d) {
  const C = { text: '#E8F4FD', muted: '#8FAECF', light: '#85B7EB', cyan: '#22D3EE', accent: '#378ADD', navy: '#185FA5', stroke: '#16365F', grid: '#14304F' };
  const PAL = ['#378ADD', '#22D3EE', '#85B7EB', '#1E5FB0', '#6FA8F5', '#B9D3EA'];
  const F = `font-family="'Segoe UI',Inter,Helvetica,Arial,sans-serif"`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const card = (x, y, w, h, stroke = C.stroke, sw = 1) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="url(#cardG)" stroke="${stroke}" stroke-width="${sw}"/>`;
  const t = (x, y, s, size, fill, weight = 500, anchor = 'start', extra = '') => `<text x="${x}" y="${y}" ${F} font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" ${extra}>${esc(s)}</text>`;
  let o = '';

  o += t(32, 58, 'GitHub stats', 24, C.text, 700);
  o += t(32, 82, d.subtitle, 13, C.muted);

  // Total
  o += card(32, 104, 280, 150);
  o += t(56, 138, 'Total contributions', 14, C.muted);
  o += t(56, 206, d.total.toLocaleString('en-US'), 58, C.text, 700, 'start', 'letter-spacing="-1.5"');
  o += t(56, 234, d.totalRange, 12, C.cyan, 600);

  // Current streak
  const cx = 402, cy = 179, r = 46, circ = 2 * Math.PI * r;
  const frac = d.longest ? Math.min(1, d.current / d.longest) : 0;
  o += card(328, 104, 344, 150, C.navy, 1.5);
  o += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.grid}" stroke-width="9"/>`;
  o += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="url(#ringG)" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(circ * frac).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`;
  o += `<circle cx="${cx}" cy="${cy - r}" r="4" fill="${C.text}"/>`;
  o += t(cx, cy + 9, d.current, 30, C.text, 700, 'middle');
  o += t(cx, cy + 26, 'days', 11, C.muted, 500, 'middle');
  o += t(470, 162, 'Current streak', 17, C.text, 700);
  o += t(470, 186, d.currentRange, 12, C.cyan, 600);
  o += t(470, 208, d.current && d.current >= d.longest ? 'Matches the longest streak' : `Longest is ${d.longest} days`, 12, C.muted);

  // Longest streak
  o += card(688, 104, 280, 150);
  o += t(712, 138, 'Longest streak', 14, C.muted);
  o += t(712, 206, d.longest, 58, C.text, 700, 'start', 'letter-spacing="-1.5"');
  o += t(788, 206, 'days', 18, C.muted);
  o += t(712, 234, d.longestRange, 12, C.cyan, 600);

  // Commits by hour
  o += card(32, 270, 936, 210);
  o += t(56, 302, 'Commits by hour', 15, C.text, 700);
  o += t(944, 302, `UTC${OFFSET >= 0 ? '+' : ''}${OFFSET}`, 12, C.muted, 500, 'end');

  const maxVal = Math.max(1, ...d.hours);
  const niceMax = (() => {
    const raw = maxVal;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
    const n = raw / mag;
    const nice = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 3 ? 3 : n <= 4.5 ? 4.5 : n <= 6 ? 6 : 10;
    return Math.ceil(nice * mag / 3) * 3 || 3;
  })();
  const scale = 108 / niceMax; // 452 - 344 = 108px of chart height across the 3 top gridlines
  const gridYs = [452, 416, 380, 344];
  const gridVals = [0, niceMax / 3, (niceMax / 3) * 2, niceMax];
  gridYs.forEach((y, i) => {
    o += `<line x1="80" x2="944" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-dasharray="${i === 0 ? '' : '3 4'}"/>`;
    o += t(70, y + 4, Math.round(gridVals[i]), 10, C.muted, 500, 'end');
  });

  // best 3-consecutive-hour window
  let peakStart = 0, peakSum = -1;
  for (let h = 0; h <= 21; h++) {
    const sum = d.hours[h] + d.hours[h + 1] + d.hours[h + 2];
    if (sum > peakSum) { peakSum = sum; peakStart = h; }
  }
  const hourX = h => 88 + h * 36;
  const boxX = hourX(peakStart) - 8;
  const boxW = hourX(peakStart + 2) + 20 + 8 - boxX;
  o += `<rect x="${boxX}" y="318" width="${boxW}" height="138" rx="8" fill="${C.cyan}" fill-opacity="0.07" stroke="${C.cyan}" stroke-opacity="0.25"/>`;
  o += t(boxX + boxW / 2, 332, 'Peak hours', 11, C.cyan, 600, 'middle');

  d.hours.forEach((v, h) => {
    const x = hourX(h);
    const barH = Math.max(3, v * scale);
    const isPeak = h >= peakStart && h < peakStart + 3;
    o += `<rect x="${x}" y="${(452 - barH).toFixed(1)}" width="20" height="${barH.toFixed(1)}" rx="4" fill="url(#${isPeak ? 'peakG' : 'barG'})"/>`;
    if (h % 3 === 0) o += t(x + 10, 470, String(h).padStart(2, '0'), 10, C.muted, 500, 'middle');
  });

  // Language cards
  const donut = (list, cx, cy, r2, sw) => {
    const circ2 = 2 * Math.PI * r2;
    let s = `<circle cx="${cx}" cy="${cy}" r="${r2}" fill="none" stroke="${C.grid}" stroke-width="${sw}"/>`;
    let cum = 0;
    list.forEach((it, i) => {
      const len = it.frac * circ2;
      s += `<circle cx="${cx}" cy="${cy}" r="${r2}" fill="none" stroke="${PAL[i % PAL.length]}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(1)} ${circ2.toFixed(1)}" stroke-dashoffset="${(-cum).toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`;
      cum += len;
    });
    return s;
  };

  const langCard = (x, title, list) => {
    let s = card(x, 496, 452, 200);
    s += t(x + 24, 530, title, 15, C.text, 700);
    list.forEach((it, i) => {
      const y = 562 + i * 26;
      s += `<circle cx="${x + 30}" cy="${y}" r="5" fill="${PAL[i % PAL.length]}"/>`;
      s += t(x + 46, y + 4, it.name, 13, C.text, 500);
      s += t(x + 228, y + 4, `${it.pct}%`, 13, C.muted, 600, 'end');
    });
    const dcx = x + 348, dcy = 608;
    s += donut(list, dcx, dcy, 56, 22);
    const top = list[0];
    if (top) {
      s += t(dcx, dcy + 4, `${top.pct}%`, 22, C.text, 700, 'middle');
      s += t(dcx, dcy + 22, top.name, 11, C.muted, 500, 'middle');
    }
    return s;
  };

  o += langCard(32, 'Top languages by repository', d.langsByRepo);
  o += langCard(516, 'Top languages by commit', d.langsByCommit);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="728" viewBox="0 0 1000 728">
<defs>
<linearGradient id="bgG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#071630"/><stop offset="1" stop-color="#04101E"/></linearGradient>
<radialGradient id="glow" cx="0.15" cy="0" r="0.8"><stop offset="0" stop-color="#185FA5" stop-opacity="0.35"/><stop offset="1" stop-color="#185FA5" stop-opacity="0"/></radialGradient>
<radialGradient id="glow2" cx="1" cy="1" r="0.6"><stop offset="0" stop-color="#22D3EE" stop-opacity="0.12"/><stop offset="1" stop-color="#22D3EE" stop-opacity="0"/></radialGradient>
<linearGradient id="cardG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0D2546" stop-opacity="0.9"/><stop offset="1" stop-color="#081A33" stop-opacity="0.9"/></linearGradient>
<linearGradient id="barG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5B9BE8"/><stop offset="1" stop-color="#1E4F8F"/></linearGradient>
<linearGradient id="peakG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22D3EE"/><stop offset="1" stop-color="#378ADD"/></linearGradient>
<linearGradient id="ringG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22D3EE"/><stop offset="0.5" stop-color="#378ADD"/><stop offset="1" stop-color="#85B7EB"/></linearGradient>
</defs>
<rect width="1000" height="728" rx="20" fill="url(#bgG)"/>
<rect width="1000" height="728" rx="20" fill="url(#glow)"/>
<rect width="1000" height="728" rx="20" fill="url(#glow2)"/>
<rect x="0.5" y="0.5" width="999" height="727" rx="20" fill="none" stroke="#0C447C"/>
${o}
</svg>`;
}

// ---------- main ----------
async function main() {
  const user = await getUserMeta();
  const years = await getContributionCalendarYears(user.createdAt);
  const { total, days, repoCommitCounts } = await getContributionData(years);
  const streaks = computeStreaks(days);

  const repoNames = [...repoCommitCounts.keys()];
  const hours = await getCommitHours(user.id, repoNames);

  const repoLangs = await getRepoLanguages();

  const byRepoCounts = new Map();
  for (const lang of repoLangs.values()) {
    byRepoCounts.set(lang, (byRepoCounts.get(lang) || 0) + 1);
  }

  const byCommitCounts = new Map();
  for (const [repo, commits] of repoCommitCounts.entries()) {
    const lang = repoLangs.get(repo);
    if (!lang) continue;
    byCommitCounts.set(lang, (byCommitCounts.get(lang) || 0) + commits);
  }

  const d = {
    subtitle: SUBTITLE,
    total,
    totalRange: `${shortDate(new Date(user.createdAt))}, ${new Date(user.createdAt).getFullYear()} to present`,
    current: streaks.current,
    currentRange: streaks.currentRange,
    longest: streaks.longest,
    longestRange: streaks.longestRange,
    hours,
    langsByRepo: topLanguages(byRepoCounts, 5),
    langsByCommit: topLanguages(byCommitCounts, 5),
  };

  const svg = renderSVG(d);
  mkdirSync('github-stats', { recursive: true });
  writeFileSync('github-stats/dashboard.svg', svg);
  console.log('dashboard.svg updated');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
