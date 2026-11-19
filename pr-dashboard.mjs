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

// The time limit for one `gh` command, in seconds.
// A command that does not end fails, so it cannot block the reads that come after it.
const GH_TIMEOUT_SECONDS = 30;

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
        number title url isDraft isCrossRepository createdAt additions deletions mergeable
        mergeStateStatus @include(if: $withStates)
        statusCheckRollup @include(if: $withStates) { state }
        repository { name nameWithOwner owner { login avatarUrl(size: 40) } }
        author { ${ACTOR} }
        baseRefName headRefName headRefOid
        reviewRequests(first: 20) {
          nodes { requestedReviewer { __typename ... on User { login avatarUrl(size: 40) } ... on Team { name } } }
        }
        latestOpinionatedReviews(first: 20) {
          nodes { state author { ${ACTOR} } }
        }
        timelineItems(last: 100, itemTypes: [PULL_REQUEST_COMMIT, PULL_REQUEST_REVIEW, ISSUE_COMMENT]) {
          nodes {
            __typename
            ... on PullRequestCommit { commit { oid committedDate author { user { login avatarUrl(size: 40) } } } }
            ... on PullRequestReview { state submittedAt commit { oid } author { ${ACTOR} } }
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
  const options = { maxBuffer: 64 * 1024 * 1024, timeout: GH_TIMEOUT_SECONDS * 1000 };
  const { stdout } = await run('gh', args, options).catch((error) => {
    // `killed` is true when the time limit stopped the command.
    throw error.killed ? new Error(`gh did not answer in ${GH_TIMEOUT_SECONDS} seconds`) : error;
  });
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

// The read of GitHub that is in progress. A request that arrives during a read gets the result of that read.
let pendingRead;

function freshRead() {
  pendingRead ??= load()
    .then(async (read) => {
      const body = JSON.stringify(read);
      await writeFile(CACHE_FILE, body);
      return body;
    })
    .finally(() => {
      pendingRead = undefined;
    });
  return pendingRead;
}

const routes = {
  '/': async () => ['text/html', await readFile(PAGE_FILE)],
  '/cached': async () => ['application/json', await readFile(CACHE_FILE)],
  '/fresh': async () => ['application/json', await freshRead()],
};

// A browser sends the host of the address bar in the `Host` header.
// A request for another host name that resolves to this machine gets the status 403.
const HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];

// A browser sends `Sec-Fetch-Site` with each request. The value is `same-origin` for a request by the dashboard page,
// and `none` for an address that the user types. A page of another site gets the dashboard page only, not the PRs.
function fromOtherSite(request) {
  const site = request.headers['sec-fetch-site'];
  return request.url !== '/' && site !== undefined && site !== 'same-origin' && site !== 'none';
}

createServer(async (request, response) => {
  const route = routes[request.url];
  if (!route) {
    response.writeHead(404).end();
    return;
  }
  if (!HOSTS.includes(request.headers.host) || fromOtherSite(request)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const [type, body] = await route();
    response.writeHead(200, { 'content-type': `${type}; charset=utf-8` }).end(body);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(error.stderr || error.stack));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}`));
