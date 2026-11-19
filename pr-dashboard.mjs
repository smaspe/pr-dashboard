#!/usr/bin/env node
// PR dashboard. Run `node pr-dashboard.mjs [port]`, then open http://localhost:4477.
// This file reads GitHub through `gh api graphql`. `gh auth login` is the only setup.
// page.html is the page: it contains the rules for sections, stacks and labels, and the filters.

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

// ---------- Configuration ----------

// `node pr-dashboard.mjs 4478` uses another port, so two instances can run at the same time.
const PORT = Number(process.argv[2] ?? 4477);

// Every search starts with these qualifiers. The searches are in `load`.
const BASE = 'is:pr is:open archived:false';

// The number of PRs in one request. GitHub answers 502 when one request reads too much.
const PAGE_SIZE = 50;

// ---------- GitHub ----------

const VIEWER_QUERY = `
query {
  viewer { login organizations(first: 100) { nodes { login } } }
}`;

const ACTOR = 'login __typename avatarUrl(size: 40)';

const SEARCH_QUERY = `
query ($q: String!, $after: String, $withStates: Boolean!) {
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt additions deletions mergeable
        mergeStateStatus @include(if: $withStates)
        statusCheckRollup @include(if: $withStates) { state }
        repository { name nameWithOwner owner { login avatarUrl(size: 40) } }
        author { ${ACTOR} }
        baseRefName headRefName headRefOid
        reviewRequests(first: 20) {
          nodes { requestedReviewer { __typename ... on User { login avatarUrl(size: 40) } } }
        }
        latestOpinionatedReviews(first: 20) {
          nodes { state author { ${ACTOR} } }
        }
        timelineItems(last: 100, itemTypes: [PULL_REQUEST_COMMIT, PULL_REQUEST_REVIEW, ISSUE_COMMENT]) {
          nodes {
            __typename
            ... on PullRequestCommit { commit { oid committedDate author { user { login avatarUrl(size: 40) } } } }
            ... on PullRequestReview { state submittedAt author { ${ACTOR} } }
            ... on IssueComment { createdAt author { ${ACTOR} } }
          }
        }
      }
    }
  }
}`;

const run = promisify(execFile);

async function graphql(query, variables = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    // `-F` sends a boolean as a boolean. `-f` sends a string as it is.
    if (value !== undefined) args.push(typeof value === 'boolean' ? '-F' : '-f', `${name}=${value}`);
  }
  const { stdout } = await run('gh', args, { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout).data;
}

// Reads every page of one search.
// The merge state adds about 5 seconds for 90 PRs, and the CI state adds about 2 seconds,
// so only the search for my PRs reads the two states.
async function search(q, withStates = false) {
  const prs = [];
  let after;
  do {
    const { search: page } = await graphql(SEARCH_QUERY, { q, after, withStates });
    prs.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined;
  } while (after);
  return prs;
}

async function load() {
  const startedAt = Date.now();
  const { viewer } = await graphql(VIEWER_QUERY);
  const owners = [viewer.login, ...viewer.organizations.nodes.map((organization) => organization.login)];

  // The timeline of a PR contains its last 100 events only,
  // so the three searches about me find my older comments and reviews. They read every repository.
  const [mine, reviewedByMe, commentedByMe, requestedFromMe, ...byOthers] = await Promise.all([
    search(`${BASE} author:@me`, true),
    search(`${BASE} -author:@me reviewed-by:@me`),
    search(`${BASE} -author:@me commenter:@me`),
    search(`${BASE} -author:@me user-review-requested:@me`),
    // Every open PR by another person in my account and in each of my organisations, except the drafts.
    // The page shows a draft by another person only when I am involved, and the three searches above find those.
    // One search for each owner: a search with two owner qualifiers returns nothing.
    ...owners.map((owner) => search(`${BASE} -author:@me draft:false user:${owner}`)),
  ]);

  const aboutMe = [...reviewedByMe, ...commentedByMe, ...requestedFromMe];
  const queue = new Map([...byOthers.flat(), ...aboutMe].map((pr) => [pr.url, pr]));
  return {
    me: viewer.login,
    fetchedAt: new Date().toISOString(),
    fetchSeconds: (Date.now() - startedAt) / 1000,
    queue: [...queue.values()],
    // The URLs of the PRs that the three searches about me returned.
    aboutMe: [...new Set(aboutMe.map((pr) => pr.url))],
    mine,
  };
}

// ---------- Server ----------

const PAGE_FILE = new URL('./page.html', import.meta.url);
// The last successful read of GitHub. The page shows it first, and keeps it when a read fails.
const CACHE_FILE = new URL('./cache.json', import.meta.url);

const routes = {
  '/': async () => ['text/html', await readFile(PAGE_FILE)],
  '/cached': async () => ['application/json', await readFile(CACHE_FILE)],
  '/fresh': async () => {
    const body = JSON.stringify(await load());
    await writeFile(CACHE_FILE, body);
    return ['application/json', body];
  },
};

createServer(async (request, response) => {
  const route = routes[request.url];
  if (!route) {
    response.writeHead(404).end();
    return;
  }
  try {
    const [type, body] = await route();
    response.writeHead(200, { 'content-type': `${type}; charset=utf-8` }).end(body);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(error.stderr || error.stack));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}`));
