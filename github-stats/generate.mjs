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
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(query, variables, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
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
    } catch (err) {
      // Only retry transient network-level failures (timeouts, resets), not real
      // GraphQL errors, which mean the query itself is wrong and won't succeed
      // on retry. We hit this exact kind of transient failure once already while
      // testing this script, which is why it's worth guarding against here.
      const transient = err instanceof TypeError || /ETIMEDOUT|ECONNRESET|fetch failed/i.test(err.message || '');
      if (!transient || attempt >= retries) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
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

  for (const range of years) {
    const data = await gql(
      `query($login:String!, $from:DateTime!, $to:DateTime!){
        user(login:$login){
          contributionsCollection(from:$from, to:$to){
            contributionCalendar{
              totalContributions
              weeks{ contributionDays{ date contributionCount } }
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
  }

  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { total, days };
}

// Repo discovery via commitContributionsByRepository under contributionsCollection is
// subject to GitHub's "restricted contributions" gate and silently omits private-org
// repos even when the account's own privacy setting allows showing them. This direct
// connection is not gated the same way and reliably includes every repo, private or not.
async function getContributedRepoNames(viewerId) {
  const names = new Set();
  let cursor = null;
  for (let i = 0; i < 5; i++) { // safety cap: 5 pages * 100 = 500 repos
    const data = await gql(
      `query($login:String!, $cursor:String){
        user(login:$login){
          repositoriesContributedTo(first:100, after:$cursor, contributionTypes:[COMMIT], includeUserRepositories:true, isLocked:false){
            pageInfo{ hasNextPage endCursor }
            nodes{ nameWithOwner isFork }
          }
        }
      }`,
      { login: USER, cursor }
    );
    const conn = data.user.repositoriesContributedTo;
    for (const r of conn.nodes) if (!r.isFork) names.add(r.nameWithOwner);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return [...names];
}

// ---------- 2. streaks ----------
function computeStreaks(days) {
  let longest = 0, longestStart = null, longestEnd = null;
  let run = 0, runStart = null;

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
  const repoCommitCounts = new Map(); // nameWithOwner -> real commit count (for language weighting)
  const PAGE = 100;
  const MAX_PER_REPO = 500; // safety cap so one huge repo can't blow the run time/rate limit
  for (const nameWithOwner of repoNames) {
    const [owner, name] = nameWithOwner.split('/');
    let cursor = null;
    let fetched = 0;
    try {
      while (fetched < MAX_PER_REPO) {
        const data = await gql(
          `query($owner:String!, $name:String!, $authorId:ID, $cursor:String){
            repository(owner:$owner, name:$name){
              defaultBranchRef{
                target{
                  ... on Commit{
                    history(first:${PAGE}, after:$cursor, author:{id:$authorId}){
                      pageInfo{ hasNextPage endCursor }
                      nodes{ committedDate }
                    }
                  }
                }
              }
            }
          }`,
          { owner, name, authorId: viewerId, cursor }
        );
        const history = data.repository?.defaultBranchRef?.target?.history;
        const nodes = history?.nodes || [];
        for (const n of nodes) {
          const h = localDate(n.committedDate).getUTCHours();
          hours[h]++;
        }
        fetched += nodes.length;
        if (nodes.length > 0) repoCommitCounts.set(nameWithOwner, (repoCommitCounts.get(nameWithOwner) || 0) + nodes.length);
        if (!history?.pageInfo?.hasNextPage || nodes.length === 0) break;
        cursor = history.pageInfo.endCursor;
      }
    } catch {
      // skip repos we can't read (deleted, renamed, no access, etc.)
    }
  }
  return { hours, repoCommitCounts };
}

// Pull requests the user has opened, bucketed by hour. A direct top-level User
// connection, not gated by the "restricted contributions" visibility rule.
async function getPullRequestsByHour() {
  const hours = new Array(24).fill(0);
  let cursor = null;
  for (let i = 0; i < 10; i++) { // safety cap: 10 pages * 100 = 1000 PRs
    const data = await gql(
      `query($login:String!, $cursor:String){
        user(login:$login){
          pullRequests(first:100, after:$cursor, orderBy:{field:CREATED_AT, direction:DESC}){
            pageInfo{ hasNextPage endCursor }
            nodes{ createdAt }
          }
        }
      }`,
      { login: USER, cursor }
    );
    const conn = data.user.pullRequests;
    for (const n of conn.nodes) hours[localDate(n.createdAt).getUTCHours()]++;
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return hours;
}

// Issues the user has opened, bucketed by hour. Same direct, unrestricted pattern.
async function getIssuesByHour() {
  const hours = new Array(24).fill(0);
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const data = await gql(
      `query($login:String!, $cursor:String){
        user(login:$login){
          issues(first:100, after:$cursor, orderBy:{field:CREATED_AT, direction:DESC}){
            pageInfo{ hasNextPage endCursor }
            nodes{ createdAt }
          }
        }
      }`,
      { login: USER, cursor }
    );
    const conn = data.user.issues;
    for (const n of conn.nodes) hours[localDate(n.createdAt).getUTCHours()]++;
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return hours;
}

// Reviews the user has submitted, bucketed by hour. There's no direct "my reviews"
// connection on User, so this finds every PR the user has reviewed via search, then
// reads that PR's own review list and keeps only the ones this user actually wrote
// (a PR can have reviews from many people, and more than one review from the same
// person over time).
async function getReviewsByHour() {
  const hours = new Array(24).fill(0);
  let cursor = null;
  for (let page = 0; page < 10; page++) { // safety cap: 10 pages * 100 = 1000 reviewed PRs
    const data = await gql(
      `query($q:String!, $cursor:String){
        search(query:$q, type:ISSUE, first:100, after:$cursor){
          pageInfo{ hasNextPage endCursor }
          nodes{
            ... on PullRequest{
              reviews(first:50){ nodes{ author{ login } submittedAt } }
            }
          }
        }
      }`,
      { q: `is:pr reviewed-by:${USER}`, cursor }
    );
    const conn = data.search;
    for (const pr of conn.nodes) {
      for (const review of pr.reviews?.nodes || []) {
        if (review.author?.login === USER && review.submittedAt) {
          hours[localDate(review.submittedAt).getUTCHours()]++;
        }
      }
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return hours;
}

// ---------- 4. languages ----------
// Queries language breakdowns for an explicit list of repos (owned, org-owned, or
// collaborator repos alike) rather than only repos the account owns, so work done
// in organization repositories (e.g. a private employer repo) is represented too.
async function getLanguagesForRepos(repoNames) {
  const map = new Map(); // nameWithOwner -> effective language name
  for (const nameWithOwner of repoNames) {
    const [owner, name] = nameWithOwner.split('/');
    try {
      const data = await gql(
        `query($owner:String!, $name:String!){
          repository(owner:$owner, name:$name){
            primaryLanguage{ name }
            languages(first:10, orderBy:{field:SIZE, direction:DESC}){ edges{ size node{ name } } }
          }
        }`,
        { owner, name }
      );
      const repo = data.repository;
      if (!repo) continue;
      const edges = repo.languages?.edges || [];
      // GitHub's byte-count "primary language" misattributes Flutter/Dart projects to
      // whichever native platform embedder (C++/CMake) happens to be bigger in bytes,
      // even though that scaffolding is auto-generated and never hand-written. Any repo
      // with Dart in it is, for a developer's actual purposes, a Dart project.
      const hasDart = edges.some(e => e.node.name === 'Dart');
      const effective = hasDart ? 'Dart' : (edges[0]?.node.name || repo.primaryLanguage?.name);
      if (effective) map.set(nameWithOwner, effective);
    } catch {
      // skip repos we can't read
    }
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
  // streak flame icon (Heroicons "fire" path, visible glyph ~20 units tall in its 24x24 box)
  const FLAME_PATH = 'M12.963 2.286a.75.75 0 0 0-1.071-.136 9.742 9.742 0 0 0-3.539 6.176 7.547 7.547 0 0 1-1.705-1.715.75.75 0 0 0-1.152-.082A9 9 0 1 0 15.68 4.534a7.46 7.46 0 0 1-2.717-2.248ZM15.75 14.25a3.75 3.75 0 1 1-7.313-1.172c.628.465 1.35.81 2.133 1a5.99 5.99 0 0 1 1.925-3.546 3.75 3.75 0 0 1 3.255 3.718Z';
  const flame = (x, y, h, fill = 'url(#fireG)') => {
    const s = h / 20;
    return `<path d="${FLAME_PATH}" fill="${fill}" transform="translate(${(x - 2 * s).toFixed(1)},${(y - 2 * s).toFixed(1)}) scale(${s.toFixed(3)})"/>`;
  };
  // "on a streak" rocket icon (Heroicons "rocket-launch"), body + exhaust trail as separate
  // sub-paths so each can be colored like a real rocket: red body, orange exhaust.
  const ROCKET_BODY = 'M9.315 7.584C12.195 3.883 16.695 1.5 21.75 1.5a.75.75 0 0 1 .75.75c0 5.056-2.383 9.555-6.084 12.436A6.75 6.75 0 0 1 9.75 22.5a.75.75 0 0 1-.75-.75v-4.131A15.838 15.838 0 0 1 6.382 15H2.25a.75.75 0 0 1-.75-.75 6.75 6.75 0 0 1 7.815-6.666ZM15 6.75a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5Z';
  const ROCKET_TRAIL = 'M5.26 17.242a.75.75 0 1 0-.897-1.203 5.243 5.243 0 0 0-2.05 5.022.75.75 0 0 0 .625.627 5.243 5.243 0 0 0 5.022-2.051.75.75 0 1 0-1.202-.897 3.744 3.744 0 0 1-3.008 1.51c0-1.23.592-2.323 1.51-3.008Z';
  const rocket = (x, y, h, bodyFill = '#FF4D4D', trailFill = '#FFA23D') => {
    const s = h / 21;
    const tr = `translate(${(x - 1.5 * s).toFixed(1)},${(y - 1.5 * s).toFixed(1)}) scale(${s.toFixed(3)})`;
    return `<path d="${ROCKET_BODY}" fill="${bodyFill}" transform="${tr}"/><path d="${ROCKET_TRAIL}" fill="${trailFill}" transform="${tr}"/>`;
  };
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
  o += t(cx, cy + 9, d.current, 30, 'url(#fireG)', 700, 'middle');
  o += t(cx, cy + 26, 'days', 11, C.muted, 500, 'middle');
  o += flame(468, 146, 20);
  o += t(494, 162, 'Current streak', 17, C.text, 700);
  o += t(470, 186, d.currentRange, 12, C.cyan, 600);
  o += t(470, 208, d.current && d.current >= d.longest ? 'Matches the longest streak' : `Longest is ${d.longest} days`, 12, C.muted);

  // Longest streak
  o += card(688, 104, 280, 150);
  o += flame(710, 125, 17);
  o += t(733, 138, 'Longest streak', 14, C.muted);
  o += t(712, 206, d.longest, 58, 'url(#fireG)', 700, 'start', 'letter-spacing="-1.5"');
  o += t(788, 206, 'days', 18, C.muted);
  o += rocket(837, 187, 23);
  o += t(712, 234, d.longestRange, 12, C.cyan, 600);

  // Activity by hour: commits, PRs, reviews and issues stacked per hour
  const SERIES = [
    { key: 'commits', label: 'Commits', color: C.accent },   // #378ADD — the dashboard's anchor blue
    { key: 'prs', label: 'PRs', color: '#FFB020' },          // warm gold — echoes the streak flame/rocket
    { key: 'reviews', label: 'Reviews', color: '#2DD4BF' },  // teal — reads as "checked/approved"
    { key: 'issues', label: 'Issues', color: '#A78BFA' },    // violet — clearly distinct from the above three
  ];
  const totals = d.activity.commits.map((_, h) => SERIES.reduce((sum, s) => sum + d.activity[s.key][h], 0));

  o += card(32, 270, 936, 210);
  o += t(56, 302, 'Activity by hour', 15, C.text, 700);
  o += t(944, 302, `Hour of day → (UTC${OFFSET >= 0 ? '+' : ''}${OFFSET})`, 12, C.muted, 500, 'end');
  o += t(56, 320, 'Activity ↑', 10, C.muted, 600);
  let legendX = 150;
  for (const s of SERIES) {
    o += `<circle cx="${legendX}" cy="317" r="3.5" fill="${s.color}"/>`;
    o += t(legendX + 10, 320, s.label, 9.5, C.muted, 600);
    legendX += 18 + s.label.length * 6.2 + 20;
  }

  const maxVal = Math.max(1, ...totals);
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

  // best 3-consecutive-hour window, by combined activity
  let peakStart = 0, peakSum = -1;
  for (let h = 0; h <= 21; h++) {
    const sum = totals[h] + totals[h + 1] + totals[h + 2];
    if (sum > peakSum) { peakSum = sum; peakStart = h; }
  }
  const hourX = h => 88 + h * 36;
  const boxX = hourX(peakStart) - 8;
  const boxW = hourX(peakStart + 2) + 20 + 8 - boxX;
  o += `<rect x="${boxX}" y="318" width="${boxW}" height="138" rx="8" fill="${C.cyan}" fill-opacity="0.07" stroke="${C.cyan}" stroke-opacity="0.25"/>`;
  o += t(boxX + boxW / 2, 332, 'Peak hours', 11, C.cyan, 600, 'middle');

  for (let h = 0; h < 24; h++) {
    const x = hourX(h);
    if (totals[h] === 0) {
      o += `<rect x="${x}" y="449" width="20" height="3" rx="4" fill="${C.grid}"/>`;
    } else {
      const present = SERIES.filter(s => d.activity[s.key][h] > 0);
      let yCursor = 452;
      present.forEach((s, i) => {
        const v = d.activity[s.key][h];
        const segH = Math.max(1.5, v * scale);
        yCursor -= segH;
        const isTop = i === present.length - 1;
        o += `<rect x="${x}" y="${yCursor.toFixed(1)}" width="20" height="${segH.toFixed(1)}" rx="${isTop ? 4 : 0}" fill="${s.color}"/>`;
      });
    }
    if (totals[h] > 0) {
      const labelY = Math.max(328, 452 - totals[h] * scale - 6);
      const isPeak = h >= peakStart && h < peakStart + 3;
      o += t(x + 10, labelY, totals[h], 9, isPeak ? C.cyan : C.muted, 600, 'middle');
    }
    o += t(x + 10, 470, String(h).padStart(2, '0'), 8.5, C.muted, 500, 'middle');
  }

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
<linearGradient id="ringG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22D3EE"/><stop offset="0.5" stop-color="#378ADD"/><stop offset="1" stop-color="#85B7EB"/></linearGradient>
<linearGradient id="fireG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFB020"/><stop offset="1" stop-color="#FF4D4D"/></linearGradient>
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
  const { total, days } = await getContributionData(years);
  const streaks = computeStreaks(days);

  const repoNames = await getContributedRepoNames(user.id);
  const { hours: commitHours, repoCommitCounts } = await getCommitHours(user.id, repoNames);
  // These three are enhancements, not core data — if one fails even after gql()'s
  // own retries (a real outage, not a blip), that series renders as all-zero rather
  // than taking down the whole dashboard. Commits, streaks and total contributions
  // are the load-bearing numbers and are allowed to fail the run if they can't be
  // fetched, since the dashboard would be meaningless without them anyway.
  const safely = async (label, promise) => {
    try {
      return await promise;
    } catch (err) {
      console.error(`Warning: ${label} failed, showing as zero for this run:`, err.message || err);
      return new Array(24).fill(0);
    }
  };
  const [prHours, issueHours, reviewHours] = await Promise.all([
    safely('pull requests by hour', getPullRequestsByHour()),
    safely('issues by hour', getIssuesByHour()),
    safely('reviews by hour', getReviewsByHour()),
  ]);
  const activity = { commits: commitHours, prs: prHours, reviews: reviewHours, issues: issueHours };

  const repoLangs = await getLanguagesForRepos(repoNames);

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
    activity,
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
