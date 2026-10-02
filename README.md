# urutau

A simple kanban-style issue tracker for git. Point it at a GitHub repository and it turns the
issues into a kanban board, with customizable buckets and the repository's labels imported.

Built with React 19, TypeScript, Vite and IBM's [Carbon Design System](https://carbondesignsystem.com/).

## Features

- **Any GitHub repository.** Paste `owner/name` or a GitHub URL. Public repositories work without
  a token; private ones need a personal access token.
- **Customizable buckets.** Add, rename, reorder and delete buckets, and set an optional
  work-in-progress limit. A new board starts with *Backlog → To do → In progress → In review → Done*.
- **Imported labels.** Labels show on cards as Carbon tags, with a dot in the exact GitHub color.
  You can filter by label (with usage counts) and use labels as routing rules: open issues with a
  bucket's labels start in that bucket. Labels that look like workflow stages (`status: in
  progress`, `needs review`, …) are linked to the default buckets automatically.
- **Drag and drop.** Move cards within and between buckets with the mouse, touch or keyboard
  (Space/Enter on a card's handle, then the arrow keys). Each card also has a *Move to…* menu.
- **Closed issues.** Issues closed in the last 14 days (configurable) land in the bucket that
  collects closed issues.
- **Filters.** Search by title, number or author, and filter by label, assignee and milestone.
- **Light and dark themes** (Carbon White and Gray 100), following the system setting by default.
- **Export and import** of a board as JSON, to move it to another browser or share it. A board
  exported from another repository brings its buckets and rules, but not card positions.

The MVP is **read-only towards GitHub**: buckets, rules and card positions are saved in your
browser's local storage, and nothing is written back to the repository.

## Getting started

You need Node.js 24 (see `.nvmrc`).

```bash
nvm use        # or install Node 24 another way
npm ci
npm run dev    # http://localhost:5173
```

Enter a repository on the start page. Boards can be bookmarked; the URL looks like
`http://localhost:5173/?repo=owner/name`.

### GitHub token

Without a token, GitHub allows 60 API requests per hour per IP address. Loading a board takes
roughly 3–10 requests, depending on how many issues it has. A token raises the limit to 5,000 an
hour and is required for private repositories.

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
with access to the repositories you want, and these **read-only** permissions:

- Issues
- Metadata

Paste the token on the start page or in **Settings** (the gear icon). It is kept in this
browser's local storage and only sent to `api.github.com`. It is never included in board exports.
Anyone with access to your browser profile can read it, so use a read-only token.

## How issues are placed

Each issue's bucket is worked out every time the board renders (`resolveBuckets` in
[src/domain/board.ts](src/domain/board.ts)):

1. **Closed issues** always go to the bucket marked *Collect closed issues*. If no bucket is
   marked, they are hidden.
2. **Issues you moved** stay where you put them.
3. **Label rules.** Otherwise, an issue goes to the rightmost bucket that has one of its labels as a
   rule. On a workflow board, that is the most advanced stage.
4. **Everything else** goes to the first bucket.

Within a bucket, cards you have arranged keep their order. New issues appear below them, newest
first; closed issues are sorted by most recently closed. Deleting a bucket sends its issues back
through rules 3 and 4.

## Scripts

| Command             | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Start the dev server with hot reload           |
| `npm run build`     | Type-check and build to `dist/`                |
| `npm run preview`   | Serve the production build locally             |
| `npm test`          | Run the unit and component tests (Vitest)      |
| `npm run test:watch`| Run the tests in watch mode                    |
| `npm run typecheck` | Type-check only                                |
| `npm run lint`      | Lint with oxlint                               |

CI (`.github/workflows/ci.yml`) runs lint, type-check, tests and build on every push and pull request.

For headless, scripted checks (screenshots, drag and drop, fake GitHub data instead of the real
API) there is a Playwright harness. It is mostly used by AI coding agents; see
[.claude/skills/run-urutau/SKILL.md](.claude/skills/run-urutau/SKILL.md).

The build is static and uses relative asset paths, so `dist/` can be served from any host or
sub-path (GitHub Pages, S3, nginx, …).

## Project structure

```
src/
├── domain/        Provider-agnostic model and pure logic (placement, filters, label colors)
├── github/        GitHub REST client: pagination, error mapping, mapping to domain types
├── state/         Persisted Zustand stores: settings (token, theme) and boards
├── hooks/         Data fetching (TanStack Query), theme and URL helpers
├── board/         Board UI: buckets, cards, drag and drop, dialogs
├── components/    App shell: header, start page, settings
└── styles/        Global Carbon styles
```

The GitHub layer maps API payloads into the types in [src/domain/types.ts](src/domain/types.ts), and
the UI only uses those types. Adding another provider (GitLab, Gitea, …) means writing another
`fetchRepoSnapshot`.

## Notes on the stack

- **Carbon styles** are compiled from Sass (`sass-embedded`). Carbon's default font path uses
  webpack's `~` prefix, so [src/styles/index.scss](src/styles/index.scss) points `$font-path` at
  `@ibm/plex` for Vite to bundle the fonts. Carbon's own Sass deprecation warnings are silenced
  with `quietDeps`.
- **Theming.** The Carbon theme class (`cds--white` / `cds--g100`) goes on `<html>`, so menus
  and modals that Carbon renders in portals are themed as well. A small inline script in
  `index.html` applies the saved theme before first paint.
- **Data fetching.** TanStack Query caches the board snapshot for 5 minutes and doesn't refetch
  on window focus, to stay within the anonymous rate limit. Use **Refresh** to reload.
- **Limits.** At most 1,000 open and 1,000 recently closed issues are loaded per board; a warning
  is shown when a repository has more. Pull requests are filtered out.

## Roadmap ideas

- Two-way sync: apply a bucket's label (or close/reopen the issue) on GitHub when a card moves.
- Shared boards: store the board config in the repository (e.g. `.urutau.json`) or a small backend.
- Sign in with GitHub (OAuth/device flow) instead of pasting a token.
- UI copy in Portuguese as well as English.
- Issue detail panel with the rendered Markdown body and comments.
- Conditional requests (ETags) and virtualized columns for very large repositories.
- More providers: GitLab, Gitea/Forgejo.
- End-to-end tests with Playwright.

## License

[GPL-3.0](LICENSE)
