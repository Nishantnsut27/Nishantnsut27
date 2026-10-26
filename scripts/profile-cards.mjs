import { writeFile } from "node:fs/promises";

// Adapted from GreatNerve/scripts/profile-cards.mjs.
// Run with PROFILE_LOGIN=Nishantnsut27. GITHUB_TOKEN is optional and only used
// for public API reads. Without it, the public GitHub contribution calendar is used.
const LOGIN = process.env.PROFILE_LOGIN ?? "Nishantnsut27";
const TOKEN = process.env.GITHUB_TOKEN;
const PROFILE_FROM_YEAR = Number(process.env.PROFILE_FROM_YEAR ?? 2008);
const OUT = new URL("../assets/activity.svg", import.meta.url);
const LANGUAGE_COUNT = 5;
const RECENT_DAYS = 30;
const DEVICON = "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons";
const DEVICON_SLUGS = {
  TypeScript: "typescript", JavaScript: "javascript", Python: "python", Java: "java",
  "C++": "cplusplus", C: "c", "C#": "csharp", Go: "go", Rust: "rust", Kotlin: "kotlin",
  PHP: "php", Ruby: "ruby", Shell: "bash", PowerShell: "powershell", Dart: "dart",
  Swift: "swift", "Jupyter Notebook": "jupyter", Dockerfile: "docker", Vue: "vuejs",
  HTML: "html5", CSS: "css3",
};
const LANGUAGE_COLORS = {
  Python: "#3572A5", TypeScript: "#3178c6", CSS: "#563d7c", JavaScript: "#f1e05a",
  HTML: "#e34c26", Java: "#b07219", "C++": "#f34b7d", C: "#555555", Shell: "#89e051",
};
const DARK_FILLS = { bash: ["#293138"] };
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const C = { bg: "#0d1117", border: "#30363d", accent: "#58a6ff", text: "#c9d1d9", bright: "#e6edf3", muted: "#7d8590" };

async function getJson(url) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "profile-cards" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const response = await fetch(url, {
    headers,
  });
  if (!response.ok) {
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      throw new Error("GitHub REST rate limit reached. Set GITHUB_TOKEN or retry after the reset time.");
    }
    throw new Error(`GitHub REST request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function gql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "profile-cards" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (!response.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }));
  return out;
}

async function publicRepositories() {
  const repos = [];
  for (let page = 1; ; page += 1) {
    const batch = await getJson(`https://api.github.com/users/${LOGIN}/repos?per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter((repo) => !repo.private && !repo.fork && repo.name.toLowerCase() !== LOGIN.toLowerCase());
}

async function topLanguages() {
  const repos = await publicRepositories();
  const languageMaps = await mapLimit(repos, 4, (repo) => getJson(`https://api.github.com/repos/${LOGIN}/${encodeURIComponent(repo.name)}/languages`));
  const totals = new Map();
  for (const languages of languageMaps) {
    for (const [name, size] of Object.entries(languages)) totals.set(name, (totals.get(name) ?? 0) + size);
  }
  const totalBytes = [...totals.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (!totalBytes) throw new Error("No public repository language bytes were returned.");
  const all = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = all.slice(0, LANGUAGE_COUNT).map(([name, size]) => ({ name, size, percent: (size / totalBytes) * 100, color: LANGUAGE_COLORS[name] ?? C.accent }));
  const otherBytes = all.slice(LANGUAGE_COUNT).reduce((sum, [, bytes]) => sum + bytes, 0);
  if (otherBytes) top.push({ name: "Other", size: otherBytes, percent: (otherBytes / totalBytes) * 100, color: C.muted });
  return { languages: top, repositoryCount: repos.length };
}

async function contributionDaysFromGraphQL() {
  const { user } = await gql(`query($login: String!) { user(login: $login) { createdAt } }`, { login: LOGIN });
  const query = `query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar { weeks { contributionDays { date contributionCount } } }
      }
    }
  }`;
  const now = new Date();
  const created = new Date(user.createdAt);
  const days = new Map();
  for (let year = created.getUTCFullYear(); year <= now.getUTCFullYear(); year += 1) {
    const from = new Date(Math.max(created.getTime(), Date.UTC(year, 0, 1)));
    const to = new Date(Math.min(now.getTime(), Date.UTC(year, 11, 31, 23, 59, 59)));
    const data = await gql(query, { login: LOGIN, from: from.toISOString(), to: to.toISOString() });
    for (const week of data.user.contributionsCollection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) days.set(day.date, day.contributionCount);
    }
  }
  const today = now.toISOString().slice(0, 10);
  return {
    since: created.getUTCFullYear(),
    days: [...days.entries()].filter(([date]) => date <= today).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
  };
}

async function contributionDaysFromPublicCalendar() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const days = [];
  for (let year = PROFILE_FROM_YEAR; year <= now.getUTCFullYear(); year += 1) {
    const url = `https://github.com/users/${LOGIN}/contributions?from=${year}-01-01&to=${year}-12-31`;
    const response = await fetch(url, { headers: { "User-Agent": "profile-cards" } });
    if (!response.ok) throw new Error(`GitHub contribution calendar failed (${response.status}) for ${year}`);
    const html = await response.text();
    const heading = html.match(new RegExp(`<h2[^>]*>\\s*([\\d,]+)\\s+contributions?\\s+in\\s+${year}`, "s"));
    if (!heading) throw new Error(`Could not read the GitHub contribution total for ${year}`);
    const matches = [...html.matchAll(/data-date="(\d{4}-\d{2}-\d{2})"[^>]*>[\s\S]*?<\/td>\s*<tool-tip[^>]*>([\s\S]*?)<\/tool-tip>/g)];
    if (!matches.length) throw new Error(`Could not read contribution days for ${year}`);
    let yearTotal = 0;
    for (const match of matches) {
      const tooltip = match[2].replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim();
      const countMatch = tooltip.match(/([\d,]+) contribution/);
      const count = countMatch ? Number(countMatch[1].replaceAll(",", "")) : 0;
      yearTotal += count;
      if (match[1] <= today) days.push({ date: match[1], count });
    }
    const expectedTotal = Number(heading[1].replaceAll(",", ""));
    if (yearTotal !== expectedTotal) throw new Error(`Contribution day total did not match GitHub for ${year}`);
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  const firstActiveYear = days.find((day) => day.count > 0)?.date.slice(0, 4);
  return { since: Number(firstActiveYear ?? PROFILE_FROM_YEAR), days };
}

async function contributionDays() {
  return TOKEN ? contributionDaysFromGraphQL() : contributionDaysFromPublicCalendar();
}

function streaks(days) {
  const total = days.reduce((sum, day) => sum + day.count, 0);
  let longest = { length: 0, start: null, end: null };
  let run = { length: 0, start: null };
  for (const day of days) {
    if (day.count > 0) {
      if (!run.length) run.start = day.date;
      run.length += 1;
      if (run.length > longest.length) longest = { length: run.length, start: run.start, end: day.date };
    } else run = { length: 0, start: null };
  }
  let index = days.length - 1;
  if (index >= 0 && days[index].count === 0) index -= 1;
  const end = index >= 0 ? days[index].date : null;
  let length = 0;
  while (index >= 0 && days[index].count > 0) { length += 1; index -= 1; }
  return {
    total,
    longest,
    current: { length, start: length ? days[index + 1].date : null, end: length ? end : null },
  };
}

const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fullDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const number = new Intl.NumberFormat("en-US");
function dateRange(start, end, withYear) {
  if (!start) return "no active streak";
  const first = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  if (start === end) return (withYear ? fullDate : shortDate).format(first);
  return `${shortDate.format(first)} to ${(withYear ? fullDate : shortDate).format(last)}`;
}
const esc = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function languageIcon(name) {
  const slug = DEVICON_SLUGS[name];
  if (!slug) return null;
  const response = await fetch(`${DEVICON}/${slug}/${slug}-original.svg`).catch(() => null);
  if (!response?.ok) return null;
  let body = (await response.text()).match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1];
  if (!body) return null;
  const ids = [...new Set([...body.matchAll(/id="([^"]+)"/g)].map((match) => match[1]))].sort((a, b) => b.length - a.length);
  for (const id of ids) {
    const next = `lang-${slug}-${id}`;
    body = body.replaceAll(`id="${id}"`, `id="${next}"`).replaceAll(`url(#${id})`, `url(#${next})`).replaceAll(`href="#${id}"`, `href="#${next}"`);
  }
  for (const dark of DARK_FILLS[slug] ?? []) body = body.replaceAll(`fill="${dark}"`, `fill="${C.text}"`);
  return body;
}

function render(languages, activity) {
  const { total, longest, current } = streaks(activity.days);
  const parts = [];
  parts.push(`<text x="64" y="40" font-family="${MONO}" font-size="12" fill="${C.muted}">top languages</text>`);
  const rounded = languages.map((language) => ({ ...language, shown: Number(language.percent.toFixed(1)) }));
  if (rounded.length) rounded[rounded.length - 1].shown = Number((100 - rounded.slice(0, -1).reduce((sum, language) => sum + language.shown, 0)).toFixed(1));
  rounded.forEach((language, index) => {
    const y = 76 + index * 26;
    parts.push(`<rect x="64.5" y="${y - 17}" width="25" height="22" rx="6" fill="#161b22" stroke="${C.border}"/>`);
    if (language.icon) parts.push(`<svg x="68" y="${y - 14}" width="18" height="18" viewBox="0 0 128 128">${language.icon}</svg>`);
    parts.push(`<text x="102" y="${y}" font-family="${MONO}" font-size="11" fill="${C.text}">${esc(language.name)}</text>`);
    parts.push(`<rect x="204" y="${y - 8}" width="180" height="6" rx="3" fill="#21262d"/>`);
    parts.push(`<rect x="204" y="${y - 8}" width="${(180 * language.percent / 100).toFixed(1)}" height="6" rx="3" fill="${language.color}"/>`);
    parts.push(`<text x="436" y="${y}" text-anchor="end" font-family="${MONO}" font-size="11" fill="${C.muted}">${language.shown.toFixed(1)}%</text>`);
  });
  parts.push(`<text x="564" y="40" font-family="${MONO}" font-size="12" fill="${C.muted}">GitHub activity</text>`);
  const stats = [
    { x: 564, value: number.format(total), label: "contributions", sub: `since ${activity.since}`, color: C.bright },
    { x: 688, value: current.length, label: "current streak", sub: dateRange(current.start, current.end, false), color: C.accent },
    { x: 812, value: longest.length, label: "longest streak", sub: dateRange(longest.start, longest.end, true), color: C.bright },
  ];
  for (const stat of stats) {
    parts.push(`<text x="${stat.x}" y="94" font-family="${SANS}" font-size="30" font-weight="700" fill="${stat.color}">${esc(stat.value)}</text>`);
    parts.push(`<text x="${stat.x}" y="116" font-family="${MONO}" font-size="11" fill="${C.text}">${stat.label}</text>`);
    parts.push(`<text x="${stat.x}" y="134" font-family="${MONO}" font-size="10" fill="${C.muted}">${esc(stat.sub)}</text>`);
  }
  const recent = activity.days.slice(-RECENT_DAYS);
  const peak = Math.max(1, ...recent.map((day) => day.count));
  parts.push(`<text x="564" y="170" font-family="${MONO}" font-size="10" fill="${C.muted}">last ${RECENT_DAYS} days</text>`);
  recent.forEach((day, index) => {
    const x = 564 + index * 12.4;
    if (!day.count) { parts.push(`<rect x="${x.toFixed(1)}" y="212" width="9" height="2" rx="1" fill="${C.border}"/>`); return; }
    const height = Math.max(4, 34 * day.count / peak);
    const opacity = (0.35 + 0.65 * day.count / peak).toFixed(2);
    parts.push(`<rect x="${x.toFixed(1)}" y="${(214 - height).toFixed(1)}" width="9" height="${height.toFixed(1)}" rx="2" fill="${C.accent}" fill-opacity="${opacity}"/>`);
  });
  const summary = `${languages.map((language) => `${language.name} ${language.percent.toFixed(1)}%`).join(", ")}. ${number.format(total)} GitHub contributions since ${activity.since}. Current streak ${current.length} days. Longest streak ${longest.length} days.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="250" viewBox="0 0 1000 250" role="img" aria-labelledby="title desc">
  <title id="title">GitHub language and activity dashboard</title>
  <desc id="desc">${esc(summary)}</desc>
  <rect x="0.5" y="0.5" width="999" height="249" rx="14" fill="${C.bg}" stroke="${C.border}"/>
  <path d="M500 32 V218" stroke="${C.border}"/>
  ${parts.join("\n  ")}
</svg>\n`;
}

const [{ languages: ranked }, calendar] = await Promise.all([topLanguages(), contributionDays()]);
const languages = await Promise.all(ranked.map(async (language) => ({ ...language, icon: await languageIcon(language.name) })));
await writeFile(OUT, render(languages, calendar), "utf8");
console.log(`Wrote ${OUT.pathname}`);
