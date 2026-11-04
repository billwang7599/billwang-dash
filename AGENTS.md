# billwang-dash

An AI-only project: agents write, review, merge and deploy all of it. The user tries the result on the live site.

- Merge continuously. Once a PR's diff is reviewed and the checks below pass, merge it yourself
  (`gh pr merge --rebase --delete-branch`, or `gh stack merge <stack> --rebase --yes` for a stack) without asking,
  then `npm run deploy` and smoke-check https://dash.billwang.dev (`/` is 200, `/cli/tools` is 401, `dash help` works).
- There's no CI; the local checks are the gate: `npm run build` (type check and Vite), then `npm test`. Tests need
  the built `dist/`.
- A fresh worktree needs `npm ci` and a copy of `.dev.vars` from the main checkout.
