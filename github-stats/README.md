<div align="center">

<img src="./assets/sparkouk.webp" width="140" alt="Sparkouk, the GitHub Stats Dashboard mascot" />

# GitHub Stats Dashboard

**Meet Sparkouk.** ⚡ A tiny Node.js script that queries the GitHub GraphQL API
and draws your own contributions, streaks, hourly commit rhythm and top
languages into a single self-contained SVG, no third-party stat-card service
required.

[![Node](https://img.shields.io/badge/Node-20%2B-378ADD?style=for-the-badge&logo=node.js&logoColor=white&labelColor=042C53)](https://nodejs.org)
[![GitHub Actions](https://img.shields.io/badge/automated%20with-GitHub%20Actions-185FA5?style=for-the-badge&logo=githubactions&logoColor=white&labelColor=042C53)](https://github.com/features/actions)
[![GraphQL](https://img.shields.io/badge/GitHub-GraphQL%20API-22D3EE?style=for-the-badge&logo=graphql&logoColor=white&labelColor=042C53)](https://docs.github.com/en/graphql)

</div>

<br/>

## Who's behind this

I'm **[Amine Ben Jebli](https://github.com/aminebenjebli)**, a Software Engineer
at [Spark Talent Alliance](https://sparktalentalliance.com). This dashboard
lives inside [my GitHub profile repo](https://github.com/aminebenjebli/aminebenjebli)
and renders straight into my profile README. Sparkouk, the little lightbulb
up there, is Spark Talent Alliance's mascot, borrowed here as this tool's
persona because a script that lights up your profile deserves a face.

<br/>

## What it draws

A single SVG card, built entirely with server-side math, no headless browser,
no canvas, no external image service:

| Panel | What it shows |
|---|---|
| **Total contributions** | All-time count, from your account's join date to today |
| **Current / longest streak** | Consecutive-day streaks, computed from your real contribution calendar |
| **Commits by hour** | A 24-bar histogram of when you actually commit, with your best 3-hour window highlighted |
| **Top languages** | By repository count, and separately weighted by commit volume |

<br/>

## Stack

- **Runtime:** Node.js 20+, zero dependencies (uses the built-in `fetch`)
- **Data source:** [GitHub GraphQL API](https://docs.github.com/en/graphql) — contribution calendar, commit history, repository languages
- **Output:** hand-built SVG (gradients, arcs, bars) written straight to disk
- **Automation:** a [GitHub Actions workflow](../.github/workflows/stats-dashboard.yml) regenerates and commits the SVG on a daily cron

<br/>

## Clone it and run it yourself

```bash
git clone https://github.com/aminebenjebli/aminebenjebli.git
cd aminebenjebli/github-stats
```

No `npm install` needed, it's dependency-free. Generate a
[personal access token](https://github.com/settings/tokens) with `read:user`
and `repo` scopes, then run:

```bash
GH_TOKEN=ghp_yourTokenHere \
GH_USER=your-github-username \
UTC_OFFSET=1 \
node generate.mjs
```

That writes `dashboard.svg` right next to the script. Drop it into your own
profile README:

```markdown
<img src="./github-stats/dashboard.svg" width="100%" alt="GitHub stats dashboard" />
```

**Environment variables:**

| Variable | Required | Default | What it does |
|---|---|---|---|
| `GH_TOKEN` | yes | — | PAT with `read:user` + `repo` scopes |
| `GH_USER` | no | `aminebenjebli` | the GitHub username to report on |
| `UTC_OFFSET` | no | `1` | your timezone offset, used for streaks and the hourly chart |
| `SUBTITLE` | no | `Amine Ben Jebli · Software Engineer` | the small line under the "GitHub stats" heading |

<br/>

## Automating it on your own profile

Copy [`stats-dashboard.yml`](../.github/workflows/stats-dashboard.yml) into
your own repo's `.github/workflows/`, add a repository secret named
`GH_STATS_TOKEN` holding your token (**Settings → Secrets and variables →
Actions**), and it'll regenerate the dashboard every night on its own,
committing straight back to your branch.

<br/>

## Like it?

If Sparkouk earned a place on your profile too, a ⭐ on
[this repo](https://github.com/aminebenjebli/aminebenjebli) is always
appreciated, and feel free to open an issue or a PR if you build on it.

<div align="center">
<sub>Built by <a href="https://github.com/aminebenjebli">Amine Ben Jebli</a> · <a href="https://sparktalentalliance.com">Spark Talent Alliance</a></sub>
</div>
