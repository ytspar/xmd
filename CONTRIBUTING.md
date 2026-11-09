# Contributing

Use Node.js 22 or newer and install dependencies with
`pnpm install --frozen-lockfile`. The committed pnpm lockfile is the dependency
baseline. Source and tests are TypeScript; do not commit compiled `dist/` files.

Before submitting a focused pull request, run:

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm run guard:ts
```

GitHub Actions runs these checks on Node.js 22 and 24, plus a compiled CLI
smoke test and package preview. CI installs with `--ignore-scripts` because
fixture tests do not need the Chromium download or login credentials.

Describe the problem, resulting behavior, and relevant checks. Parser changes
should include a small synthetic fixture or a suitably redacted reproduction.
Report live capture results separately from fixture tests; a passing fixture does
not establish that X still serves the same response shape.

Keep credentials, cookies, browser profiles, personal paths, generated reports,
and account-only content out of source, logs, issues, and pull requests. Review
`git diff --cached` before committing. Optional local secret checks with
[Gitleaks](https://github.com/gitleaks/gitleaks):

```bash
gitleaks git . --redact=100 --log-opts="--all"
gitleaks dir src --redact=100
gitleaks dir scripts --redact=100
```

These checks detect known secret patterns; they do not guarantee that a change
contains no sensitive information. Manually review documentation and fixtures too.
