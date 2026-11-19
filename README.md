# PR dashboard

A local page that shows the open pull requests that need your review, and your own pull requests as stacks.

## Requirements

- Node.js 22 or later.
- The GitHub CLI (`gh`), logged in with `gh auth login`. The default scopes are sufficient.
- A recent browser.

## Run

```bash
node pr-dashboard.mjs
```

Then open http://localhost:4477.

To use another port, pass it as an argument: `node pr-dashboard.mjs 4478`.

To restart the server on each change to `pr-dashboard.mjs`, run it with `node --watch pr-dashboard.mjs`.

The script has no dependencies and no install step. It reads GitHub through `gh api graphql` and writes the last read to `cache.json`.

## Adjust

- `pr-dashboard.mjs` contains the port and the GitHub searches. A change needs a restart.
- `page.html` contains the rules for sections, stacks and labels, and the refresh interval. A change needs a page reload.
