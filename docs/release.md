# Release

Urutau uses [semantic versioning](https://semver.org/). Each release is an
annotated git tag `vX.Y.Z` on `main`, published as a
[GitHub Release](https://github.com/oshogun/urutau/releases) whose notes come
from the tag message. CI publishes the Release, with the server bundle and the installer scripts
attached, and pushes the container image to GHCR, once the tagged commit passes
every check.

## Versions so far

The history before the release job existed was tagged after the fact, at the
commit that closed each phase:

| Tag | Commit | Date | Theme |
|---|---|---|---|
| `v0.1.0` | `11fc926` | 2026-10-02 | Browser-only board |
| `v0.2.0` | `cbaa30d` | 2026-10-02 | Accounts, live boards and Keycloak |
| `v0.3.0` | `4df8c61` | 2026-10-03 | Creating issues |
| `v0.4.0` | `c06381b` | 2026-10-04 | AI agents over MCP |

`v0.5.0` is the first release published by CI. Its Release and image come from
the jobs described below. The four Releases above are published by hand with
`gh release create --verify-tag --latest=false`, because those commits predate
the release job. All four have `0.1.0` in `package.json`; that is fine because
the hand-made Releases skip the version check.

Each Release lists what changed. There is no `CHANGELOG.md`: the Releases page
is the changelog.

## What the version number means

The version tracks what someone running Urutau depends on:

- the web UI;
- the `/api` HTTP contract;
- the MCP tool contract that agent integrations use: tool names, input and
  output schemas, and error codes;
- the database people upgrade in place (the migrations in
  `server/db/migrations/`; see "Downgrading past the integrations" in the
  [README](../README.md#downgrading-past-the-integrations));
- board export files (`BoardConfig` version 1);
- environment variables;
- the install and run steps in the [README](../README.md).

A change is breaking when something that worked stops working unless the person
running Urutau, or an agent or script that calls it, changes too. That covers
removing or renaming an `/api` route or field, an MCP tool, argument or error
code, a board export that no longer imports, a migration that cannot be rolled
back or needs a manual step, a new required environment variable or the removal
of one, a new Node major version, and dropping a feature.

### Before 1.0.0 (now)

- **Minor** (`0.Y.0`): a breaking change or a new feature.
- **Patch** (`0.X.Z`): a release with fixes only, plus docs, CI, test and
  refactor changes that do not change behaviour.

Under `0.x` the minor version is the one to read before upgrading. The image
has no floating `0` tag, because a `0.Y` update can break compatibility.
`1.0.0` waits until the project is called stable.

### From 1.0.0 on

- **Major**: a breaking change, as defined above.
- **Minor**: a new feature, a new route, field or tool, or a migration that only
  adds.
- **Patch**: fixes only, plus docs, CI, test and refactor changes that do not
  change behaviour.

The Release notes for a major version start with a `BREAKING:` paragraph that
says what to do about each break.

## Upgrading an instance

Back up the database first, and read the Release notes for every version
between yours and the new one, looking for `BREAKING:`.

**Installer.** Run the install command again (see
[install.md](install.md#upgrading)). It copies the SQLite database to
`backups/` before it swaps the app, and restores the old version if the new one
does not start. Releases v0.1.0 to v0.5.0 have no bundle, so the installer
works from the first release that has one.

**Container image.** Pull and run the version you want:

```bash
docker run -p 127.0.0.1:8787:8080 -v urutau-data:/data ghcr.io/oshogun/urutau:X.Y.Z
```

The image is published as `X.Y.Z`, `X.Y`, `X` and `latest`. The `X` tag is not
published for `0.x` releases. Pin `X.Y.Z` if you want to choose when to upgrade.
Mount the volume the instance already uses: a `docker compose` install keeps
its data in `<project>_urutau-data` (`urutau_urutau-data` by default), so find
the name with `docker volume ls` and use it in place of `urutau-data`.

**Source checkout:**

```bash
git checkout vX.Y.Z
npm ci
npm run build
npm start
```

Migrations run when the server starts. An older server build refuses to start
on a database a newer one has migrated; restore the backup, or follow the
downgrade steps in the [README](../README.md#downgrading-past-the-integrations)
where one exists.

## The release bundle

Each Release carries four assets:

| Asset | What |
| --- | --- |
| `urutau-server-X.Y.Z.tar.gz` | the server bundle |
| `urutau-server-X.Y.Z.tar.gz.sha256` | its SHA-256 checksum |
| `install.sh` | `packaging/install.sh` from the tagged commit |
| `install.ps1` | `packaging/install.ps1` from the tagged commit |

`packaging/build-bundle.sh <version> <out-dir>` builds the bundle from a built
tree. The archive has one top-level directory, `urutau-server-X.Y.Z/`, with
exactly these entries: `dist/` (the built app), `server/`, `src/domain/`,
`src/github/api.ts`, `src/github/paging.ts`, `package.json`,
`package-lock.json`, `LICENSE` and `VERSION`. It is the list the `Dockerfile`
runs, without the test files, `server/testing/`, `server/oidc/support.ts`,
`server/oidc/fakeKeycloak.ts` and `server/db/connector.suite.ts`. There is no
`node_modules/`: the installer runs `npm ci --omit=dev`. The script checks the
entries before and after archiving and deletes the output when they do not match.

The build is reproducible: file times are the tagged commit's time, owner and
group are 0, entries are sorted, and `gzip -n` leaves out the name and time. Two
builds of the same commit give the same bytes.

The jobs `bundle`, `install-linux` and `install-windows` run on every pull
request and every push, not only on tags, and `release` needs all three. `bundle`
builds the bundle. `install-linux` and `install-windows` install it with the
real scripts (a pipe with no terminal, an upgrade, a rollback from a bundle that
does not start, uninstall and purge) against a local copy of the release layout.
`install-windows` takes about 7 minutes; `install-linux` about 1.5. A release is
therefore not published when an installer is broken.

The bundle is named after the version, and v0.1.0 to v0.5.0 have none. The first
packaged release is the first one whose assets include
`urutau-server-X.Y.Z.tar.gz`, whatever its number. The installer does not
depend on a number: it refuses the five known versions and answers any other
404 with a message.

## Prereleases

A version with a prerelease suffix, such as `1.2.0-beta.1`, is released the same
way, from a `v1.2.0-beta.1` tag. What differs:

- The GitHub Release is marked as a prerelease, so it never becomes "Latest".
- GHCR gets only `ghcr.io/oshogun/urutau:1.2.0-beta.1`. `latest`, `1` and `1.2`
  are not moved.

## Cutting a release

The version lives in `package.json` (the `version` field) and in both version
fields of `package-lock.json` (the top-level `version` and `packages[""].version`).
All three must match the tag.

Then:

1. Bump all three to the new version and commit that on `main`.
2. Tag it with an annotated tag (`git tag -a`). The first line of the message
   becomes the Release title and everything after the blank line becomes its
   notes, so write them for someone running Urutau. Keep the title on one line:
   git joins a title that wraps onto a second line into one line, and the
   release job rejects it.

   ```
   vX.Y.Z — <theme> (YYYY-MM-DD)

   BREAKING: <what breaks and what to do>      (breaking changes only)

   - <user-visible change>
   ```

3. Push `main`, then push the tag on its own: `git push origin vX.Y.Z`.

Pushing the tag starts a CI run on that commit. Its `release` job runs only for
tags that start with `v`, and only after `check`, `databases`, `bundle`,
`install-linux` and `install-windows` pass (see
[The release bundle](#the-release-bundle)). The job:

1. fails if the tag without its `v` differs from `version` in `package.json` or
   either version field in `package-lock.json`;
2. checks whether a Release for the tag already exists, and stops there if it
   does;
3. fetches the tag object and fails if it is a lightweight tag (made with plain
   `git tag`), if the message is empty, or if the title wraps onto a second
   line. A lightweight tag has no message of its own, and git would hand back
   the tagged commit's message instead, so the job refuses it rather than
   publish a Release titled after a commit;
4. creates the Release with `gh release create --verify-tag`, using the tag
   message's first line as the title and the text after the blank line as the
   notes. It adds `--prerelease` when the version contains `-`. The Release
   carries the four files in [The release bundle](#the-release-bundle). `gh`
   creates it as a draft, uploads the files and then publishes it, so a
   published Release always has all four.
5. When the Release already exists (a re-run), uploads the four files again with
   `gh release upload --clobber` and publishes the Release if a failed attempt
   left it as a draft. Replacing a file is safe because the bundle is
   reproducible and the scripts come from the tagged commit.

A `publish-image` job then runs after `release`. It builds the image for
`linux/amd64` and `linux/arm64` and pushes it to `ghcr.io/oshogun/urutau`,
tagged `X.Y.Z`, `X.Y`, `X` and `latest` (no `X` for `0.x`). It logs in with the
workflow's own `GITHUB_TOKEN`, so no secret needs setting up. `latest` follows
the most recently pushed release tag, so a patch release on an older line also
moves `latest`.

## When it goes wrong

If a check fails, nothing is published. Delete the tag
(`git push origin :refs/tags/vX.Y.Z` and `git tag -d vX.Y.Z`), fix the problem,
and tag again. Reusing the number is fine because no Release went out under it.

A failure after the Release exists, such as in `publish-image`, is different:
fix the cause and re-run the failed job from the Actions page. Do not re-tag,
since the Release is already public.

Push one tag at a time. GitHub starts no workflow runs at all when more than
three tags are pushed together. A tag on a commit that predates the `release`
job never triggers it either, because GitHub runs the workflow file as it was at
the tagged commit. Both are why the four tags above are published by hand.

In this repository's agentic workflow, `/version-release`
(`.claude/skills/version-release/SKILL.md`) runs this procedure.
