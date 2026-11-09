# tweetmd

Save X/Twitter posts, conversation context, media, and linked sources as Markdown
bundles. Optional Claude integration adds image transcription, diagram-to-Mermaid
conversion, descriptions, and topic categorization.

Capture runs in a local Playwright browser using your own X session. AI analysis
uses the separately installed Claude CLI and sends content to its configured
provider. This is an experimental CLI: X can change its endpoints, and a saved
capture may be incomplete.

## Install from source

Use Node.js 22 or newer and pnpm. A graphical browser is needed for the initial
X sign-in.

```bash
# From a clone of this repository:
pnpm install --frozen-lockfile
pnpm run build
npm link

tweetmd login
tweetmd https://x.com/example/status/1234567890
```

Installation downloads Playwright's Chromium through the `postinstall` script.
Run `pnpm run browsers` to reinstall the matching browser if needed. To run from
source without linking, use `pnpm run dev -- <url>`.

Optional tools:

- [Claude Code](https://code.claude.com/docs/en/overview), installed and
  authenticated, for image analysis and automatic categorization. To capture
  without AI calls, pass **both** `--no-enrich --no-categorize`.
- [mdcat](https://github.com/swsnr/mdcat) for `read` and `browse`; inline images
  need a compatible terminal.
- [termaid](https://github.com/fasouto/termaid) for terminal Mermaid rendering.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for public video captions when a
  caption track is not already exposed. Audio transcription is not supported.

## Capture and recover

```bash
# Capture without AI analysis:
tweetmd https://x.com/example/status/1234567890 --no-enrich --no-categorize

# Retry incomplete stages while retaining successful text and analysis:
tweetmd https://x.com/example/status/1234567890 --resume

# Process URLs or Markdown links from a text file:
tweetmd batch --file saved-links.txt --resume

# Watch the browser or choose a destination:
tweetmd https://x.com/example/status/1234567890 --headed --out ./captures
```

By default, bundles live in `~/.tweetmd/out/<handle>_<id>/`, independent of the
working directory. Override this with `--out <dir>` or `TWEETMD_OUT`.

```text
<handle>_<id>/
├── tweet.md          # author's post/thread, linked content, capture coverage
├── conversation.md   # replies, when present
├── thread.json       # structured capture and enrichment results
├── raw-thread.json   # initial parsed text checkpoint
├── capture.json      # stage outcomes and remaining gaps
├── CLAUDE.md         # orientation for an agent reading the bundle
├── media/            # images, video posters, and available captions
└── refs/             # linked documents and their assets
```

Text is checkpointed before optional processing. The coverage table distinguishes
saved content from missing or skipped stages. Exit codes are **0** for a complete
capture, **2** for a saved partial capture (including skipped stages), and **1**
for a fatal error. Reply completeness remains unknown even when other stages
succeed; engagement counts do not prove that all replies were loaded.

Re-capturing without `--resume` overwrites the existing bundle. Batch journals
under `<out>/.batches/` support recovery. Image analysis is cached by content hash;
`--no-cache` requests fresh analysis.

## Options

Run `tweetmd --help` for the full command list.

| Option | Effect |
| --- | --- |
| `--plain` | Use plain logs instead of the interactive display. |
| `--scrolls <n>` | Scroll for more replies; default: 6. |
| `--no-enrich` | Skip image analysis. Categorization is controlled separately. |
| `--no-categorize` | Skip automatic topic assignment. |
| `--category <topic>[/<subtopic>]` | Assign a topic manually. |
| `--model <id>` | Set the strong image model; default: `claude-sonnet-4-6`. |
| `--cheap-model <id>` | Set the first-pass/repair model; default: `claude-haiku-4-5`. |
| `--no-tiered` | Use the strong model for every analyzed image. |
| `--enrich-posters` | Include video/GIF poster frames in image analysis. |
| `--no-links` | Skip linked document fetching. |
| `--all-links` | Also follow general web links from replies. |
| `--no-transcripts` | Skip public video caption retrieval. |

Image models can also be set with `TWEETMD_ENRICH_MODEL` and
`TWEETMD_ENRICH_CHEAP_MODEL`; `TWEETMD_CATEGORIZE_MODEL` controls classification.
Model availability depends on your Claude provider access.

## Read and organize

```bash
tweetmd browse
tweetmd read example
tweetmd reindex
tweetmd archive example

# Prepare a review prompt from a topic, collection, URL, or bundle directory:
tweetmd prompt agents-and-coding/context-and-memory
tweetmd prompt collection/reading-list
tweetmd prompt ~/.tweetmd/out/example_1234567890
```

The reader uses `mdcat`. At its prompt, enter `c` to expand replies, Enter to
return, or `q` to quit. Mermaid diagrams default to local terminal rendering;
`--mermaid off` leaves the source, and `--mermaid image` uses the external
mermaid.ink service.

`reindex` renders saved `thread.json` files in the current Markdown format;
`reindex --reenrich` also retries missing image analysis. `archive` moves bundles
under `out/archive/`. `prompt` prints capture paths and also copies its output to
the clipboard on macOS.

Topics, collections, and tags are separate. Low-confidence classifications and
new topic proposals are marked for review. See [category and report
maintenance](reports/README.md) for manual assignments and report generation.

## Content coverage

- Posts, ancestors, replies, quotes, and native X Articles are parsed from the
  responses served to your logged-in browser. Author-linked posts are followed
  with a bounded one-hop traversal.
- Photos and linked article images can be transcribed or converted into tables
  and Mermaid diagrams. Small decorative assets and video posters are skipped
  by default. AI output can be inaccurate and needs review.
- GitHub files and READMEs, gists, npm/PyPI package descriptions, and readable
  web articles are saved as Markdown. General web links are followed from the
  author's content and quoted sources; repository and package links can also
  come from replies. Fetching uses size and traversal limits.
- Available public captions are saved with language, timing, and provenance.
  Missing captions, unavailable source content, unsupported assets, paywalls,
  and truncated results remain explicit gaps. Posters and captions are not a
  full audiovisual capture.

`--resume` retries incomplete work while retaining useful saved content. It
cannot recover content that the source does not make available.

## Privacy and data handling

- `~/.tweetmd/profile` contains the persistent browser session, including X
  cookies. Treat the whole `~/.tweetmd` directory as private; do not commit or
  share it. Captures can include content accessible only to your account.
- Image analysis sends image content and surrounding post text through Claude.
  Categorization sends post text and bounded excerpts of linked sources.
  Provider usage may incur charges. Use `--no-enrich --no-categorize` to disable
  these calls for a capture.
- Linked document, reference-image, and public article-caption requests resolve
  and validate every destination, reject non-public or mixed DNS answers, and
  pin each connection to a validated address. Only standard HTTP(S) ports and
  URLs without credentials are accepted.
- Link and caption retrieval contacts the source sites. Reader mode
  `--mermaid image` sends diagram content to mermaid.ink; use `ascii` or `off`
  when that is inappropriate.
- Captured text, pages, and images are untrusted input. Review them before
  handing a bundle to an agent with tools or executing anything it suggests.
- Generated reports, captures, environment files, and local automation state
  are ignored by Git. Custom output paths still need their own ignore rules.

Use the tool only for content you are authorized to access, and consider the
source's terms and content rights before redistributing a capture.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run guard:ts
```

`src/` contains the TypeScript CLI and capture pipeline; `scripts/` contains
maintenance commands and fixture tests. Build output goes into ignored `dist/`.
Tests use synthetic fixtures and do not require your X or Claude credentials.
Live capture requires a separate authenticated check. GitHub Actions runs these
checks, a compiled CLI smoke test, and a package preview on Node.js 22 and 24.

For contributions, describe the changed behavior and verification, keep changes
focused, and use synthetic or redacted examples. Never attach browser profiles,
credentials, or private captures to an issue or pull request. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). The software license does not grant rights to captured content.
