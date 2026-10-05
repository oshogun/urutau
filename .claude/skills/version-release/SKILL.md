---
name: version-release
description: Cut a new Urutau version. Pick the next semver from the commits since the last v* tag, bump the version in package.json and package-lock.json, commit, write the annotated tag (its subject and body become the GitHub Release title and notes), push, and watch CI's `release` and `publish-image` jobs publish the Release (with its bundle and installer assets) and the GHCR image. Use for "release", "cut a release", "tag a new version", "ship vX.Y.Z", "bump the version". Not for fixing the release jobs in .github/workflows/ci.yml (that's /update-ci).
---

You are running the **version-release** skill as the Orchestrator. This is
tier 1 work (`.claude/agents.md` § Cost discipline rule 6): no run id, no
sub-agents and no run clone.

The only change is the version field, in three places:
- `package.json` `.version`;
- `package-lock.json` `.version`;
- `package-lock.json` `.packages[""].version`.

Nothing in the app, the server or the Dockerfile reads them. This was checked
on 2026-10-04 with `grep -rn -E "npm_package_version|package\.json" server src scripts vite.config.ts Dockerfile`,
which matches only the Dockerfile's `COPY package.json package-lock.json`. So
the bump commit is made on `main` in the live checkout. It is the one exception
to the run-clone rule, and the bump commit stages only those two files.

Pushing a tag publishes a Release and an image that anyone can see. **Confirm
the version number and the notes with the user before pushing anything**
(step 5).

The full process, the version rules and the list of earlier versions are in
[`docs/release.md`](../../../docs/release.md). Read its "What the version number
means" section before step 3.

## How a release gets published

`.github/workflows/ci.yml` runs on pushes to `main`, on `v*` tag pushes and on
pull requests. Its `release` job runs only for `refs/tags/v*`, and only after
`check`, `databases`, `bundle`, `install-linux` and `install-windows` pass on
that commit. `bundle` builds the server bundle; the two install jobs run the
real installers against it, and the Windows one takes about 7 minutes (the
Linux one about 1.5), so the tag's run takes longer than it used to. Then the
`release` job:

1. fails unless the tag minus its `v` equals all three version fields;
2. skips the rest if a Release for the tag already exists;
3. fails unless the tag is annotated (`git cat-file -t refs/tags/vX.Y.Z` prints
   `tag`), has a non-empty message, and has a title on one line. Without these
   checks a lightweight tag would publish a Release titled after the tagged
   commit, because git's `%(contents:subject)` returns the commit's subject for
   a lightweight tag;
4. runs `gh release create` with the tag's **subject as the title** and its
   **body as the notes**, with `--prerelease` when the version contains a `-`,
   and with four files: `urutau-server-X.Y.Z.tar.gz`, its `.sha256`,
   `install.sh` and `install.ps1`. `gh` makes the Release a draft, uploads the
   files, then publishes it, so a published Release has all four;
5. on a re-run, when the Release exists, uploads the four files again with
   `--clobber` and publishes the Release if it was left as a draft.

`publish-image` then pushes `ghcr.io/oshogun/urutau` for linux/amd64 and
linux/arm64. The tags are `X.Y.Z`, `X.Y` and `latest`, plus `X` from 1.0.0 on.
A prerelease gets only its exact tag.

The tag message *is* the Release page. Write it for the people who run Urutau
for a team, not as a commit log.

## 1. Preflight

Run each command and stop on anything unexpected:

```bash
cd /home/guilherme/urutau/urutau
gh auth status                       # must be logged in (account oshogun)
git status -sb | head -1             # must be on main
git fetch -q origin --tags
git log main..origin/main --oneline  # must be empty; if not, ask the user before pulling
git status --short -- package.json package-lock.json
                                     # must be empty: never mix the bump with someone's WIP
gh run list --workflow CI --commit "$(git rev-parse HEAD)" --limit 5 \
  --json event,status,conclusion     # the commit you'll release on should be green
```

If HEAD's CI is red or still running, say so. Releasing on top of it means the
`release` job fails or waits. Let the user decide whether to wait.

The live checkout often holds uncommitted workflow edits from other sessions
(`git status`). That's fine: you stage only the two version files.

## 2. What's in this release

```bash
LAST=$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD); echo "$LAST"
git log "$LAST"..HEAD --no-merges --format='%h %ad %s' --date=short -- . ':!.claude'
git tag -l "$LAST" --format='%(contents)'   # style reference for the new message
```

The `':!.claude'` pathspec leaves out commits that touch only the agentic
workflow (`.claude/**`). Those never count toward the bump or the notes. If the
log is empty, there's nothing to release: say so and stop. Read the commit
bodies (`git show <sha> --stat`) for any commit whose subject doesn't make its
user-visible effect clear.

## 3. Pick the version

Use the rules in `docs/release.md` § What the version number means. In short:

- **While the major version is 0** (now): a breaking change bumps MINOR, and so
  does a new feature. A release with fixes only bumps PATCH.
- **From 1.0.0 on**: breaking bumps MAJOR, a feature or an additive change bumps
  MINOR, and fixes bump PATCH. Moving to 1.0.0 is the user's decision; never
  propose it on your own.

A change is breaking when a team's setup that worked stops working unless they
or their agents change something too. Examples:
- an `/api` or MCP tool name, schema or error code removed or renamed;
- a database migration that needs a manual step or can't be downgraded past
  (see README § Downgrading past the integrations);
- a board export that no longer imports;
- a new required environment variable;
- a Node major bump;
- a removed feature or sign-in method.

If *only* `.claude/**`, docs, tests or CI changed, suggest not releasing.

## 4. Draft the tag message

Match the existing tags exactly:

```
vX.Y.Z — <short theme, 2–5 words> (YYYY-MM-DD)

BREAKING: <one paragraph per breaking change, what to do about it>   ← first, only when breaking

- <user-visible change, present tense, one line>
- …
```

- Name the effect, not the implementation. Write "Issues can be closed and
  reopened from their details", not "add PATCH /api/github/issues".
- Group related commits into one bullet. Aim for 3 to 10 bullets. Leave out
  internal-only commits (tests, refactors, workflow).
- Say when a release adds a database migration, and whether a downgrade still
  works.
- The date is today's date, the release date.
- Keep the title on **one line**, followed by a blank line. The `release` job
  rejects a title that wraps.

## 5. Confirm with the user

Show the user, in one message:
- the proposed version and why that bump, quoting the breaking or feature
  commit;
- the full tag message;
- what the push will send: `git log origin/main..main --oneline` plus the new
  bump commit.

Wait for approval or edits. Don't proceed on silence.

## 6. Bump, commit, tag

```bash
cd /home/guilherme/urutau/urutau
source ~/.nvm/nvm.sh && nvm use >/dev/null
V=X.Y.Z   # no leading v
node -e '
const fs=require("fs"); const v=process.argv[1];
for (const f of ["package.json","package-lock.json"]) {
  const o=JSON.parse(fs.readFileSync(f,"utf8")); o.version=v;
  if (o.packages && o.packages[""]) o.packages[""].version=v;
  fs.writeFileSync(f, JSON.stringify(o,null,2)+"\n");
}' "$V"
git diff --stat -- package.json package-lock.json   # expect 2 files, 3 lines changed (1 + 2)
git add package.json package-lock.json
git commit -m "Release v$V" -m "<the attribution lines from the system reminder>"
git tag -a "v$V" -F <file-with-the-approved-message>   # write it under .claude/scratch/, delete after
git cat-file -t "refs/tags/v$V"                        # must print: tag
git tag -l "v$V" --format='%(contents:subject)'        # check the title came out right
```

Don't use `npm version`. It runs lifecycle scripts and makes its own commit and
tag, with a message you didn't write. The node one-liner keeps the files'
formatting: rewriting both files at their current version produces no diff
(checked 2026-10-04).

## 7. Push and watch

```bash
git push origin main
git push origin "v$V"
```

Push **one tag per push**. GitHub creates no workflow events when more than
three tags are pushed at once. A tag on a commit older than the `release` job
can't trigger it at all, because GitHub reads the workflow file from the tagged
commit. That kind of Release is made by hand:
`gh release create vX.Y.Z --verify-tag --latest=false --title <subject> --notes <body>`.

The tag push starts its own CI run on the same commit as the `main` run, with
the tag as `headBranch`:

```bash
gh run list --workflow CI --commit "$(git rev-parse HEAD)" --limit 5 \
  --json databaseId,headBranch,status,conclusion \
  --jq ".[] | select(.headBranch==\"v$V\")"
gh run watch <databaseId> --exit-status   # run_in_background: check, databases, release and the image build take several minutes
gh release view "v$V" --json name,url,isDraft,isPrerelease \
  --jq '{name,url,isDraft,isPrerelease}'
gh release view "v$V" --json assets --jq '[.assets[].name] | sort'
                                     # must equal ["install.ps1","install.sh","urutau-server-X.Y.Z.tar.gz","urutau-server-X.Y.Z.tar.gz.sha256"]
gh api repos/oshogun/urutau/releases/latest --jq .tag_name   # must print v$V (not for a prerelease)
docker manifest inspect "ghcr.io/oshogun/urutau:$V" >/dev/null && echo image published
```

Report the Release URL, the four asset names and the image reference. A missing asset
means the Release is incomplete: re-run the `release` job (step 8) rather than uploading by hand.

## 8. When it goes wrong

No Release exists until the `release` job succeeds, so a failed run before that
point publishes nothing. Deleting a pushed tag is outward-facing: **ask the
user first**, then:

- **Version mismatch** (`::error::Tag … does not match`): someone tagged
  without bumping. Delete the tag (`git push origin :refs/tags/vX.Y.Z` and
  `git tag -d vX.Y.Z`), run step 6's bump, and re-tag.
- **Lightweight tag, empty message or wrapped title**: delete the tag the same
  way and re-tag with `git tag -a "v$V" -F <message file>`.
- **`check`, `databases`, `bundle`, `install-linux` or `install-windows` failed**: the commit isn't releasable. Delete the
  tag the same way, fix the problem through the normal workflow, and run this
  skill again. Reusing the version number is fine, because nothing was
  published under it.
- **The `release` job errored after the Release exists, or `publish-image`
  failed**: don't re-tag, because the Release is already public. Fix the cause
  (CI work goes through `/update-ci`), then `gh run rerun <id> --failed`. The
  `release` job skips a Release that already exists, so a re-run is safe.
- **`docker pull` of the image is denied** when signed out: the GHCR package is
  private. Only the user can change that, in the package's settings on GitHub
  (Package settings → Change visibility).
