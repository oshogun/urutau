# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Small software teams that work on one GitHub repository together and plan its
issues on a kanban board. They expect to share one board: the same buckets,
label rules and card positions for everyone on the team.

A team runs one urutau server. Everyone signs in to it and sees the same
boards, and a teammate's change appears on an open board within a second or
two. Boards can still be exported and imported as JSON files.

Besides people, a team can connect AI agents. The admin creates an agent
integration account for each; agents never sign in to the board, they reach it
through Urutau's MCP server, and their changes show as Agent on the board.

## Product Purpose

Urutau turns a GitHub repository's issues into a kanban board for agile
planning: point it at a repository, and its issues and labels appear in
buckets the team can customize. The work stays where the team already keeps
it (issues, labels, assignees and milestones on GitHub), and urutau gives it a
board.

## Positioning

Lighter than GitHub's own Projects boards: there is no project to create and
no fields to configure. Any repository's issues, with its labels imported,
become a board straight away.

The goal is to create and manage a repository's issues entirely from
urutau. Writing to GitHub is off until the team's admin turns it on for the
whole server. The first write is creating an issue, with a title and a body,
from a bucket: the card lands in that bucket, and no labels are sent, because
buckets are internal to urutau and never label issues on GitHub.

## Operating Context

- Data comes from the GitHub REST API: issues (pull requests excluded), labels,
  assignees and milestones. When the admin has turned GitHub writes on, issues
  are created through the same API, with the same token that reads them.
- Public repositories work without a token, within GitHub's anonymous limit of
  60 API requests an hour. Private repositories and heavier use need a GitHub
  token: either the user's own personal access token, kept in their browser
  and sent only to GitHub, or, for teams that sign in through Keycloak with
  GitHub as a brokered identity provider, the token Keycloak stores, which
  urutau's server uses to read from GitHub, and to create issues, on the
  user's behalf. Creating issues needs a token with Issues write permission.
  A third token belongs to agents: an agent integration's token, which the
  admin stores on the server, encrypted, and which the server uses only to
  read issues for that integration.
- The server is self-hosted by the team. It stores accounts and boards in
  SQLite by default, or in PostgreSQL or MariaDB.
- A board has buckets (by default Backlog, To do, In progress, In review and
  Done), work-in-progress limits, label rules that route issues into buckets, a
  bucket that collects closed issues, and filters by text, label, assignee and
  milestone.

## Capabilities and Constraints

- Today: reads from GitHub, and creates issues from a bucket once the admin
  turns GitHub writes on; boards stored on the team's server and
  shared by every signed-in user, with live updates and a refusal (and notice)
  when two people save the same board at once; local accounts, where the first
  account is the admin and invites the others by link, and Keycloak sign-in;
  JSON export and import; cards move by mouse, touch or keyboard; light and
  dark themes; UI copy in English only; an MCP server for AI agents: read
  boards as JSON, move and reorder cards; agents never write to GitHub.
- A single-page app (React, TypeScript, Vite) served by a Node server, which
  needs a host that runs Node 24 or the container image; a static host alone
  is no longer enough.
- Terms: a **bucket** is a kanban column; a **label rule** routes open issues
  with a given label into a bucket; a **board** is the buckets, rules and card
  positions for one repository.
- Settled: a team shares boards through a self-hosted backend (2026-10-02).
- Settled: writing to GitHub is turned on for the whole server by the admin,
  not per user (2026-10-03).
- Settled: agents act as admin-created integration accounts; their GitHub
  token is stored per integration, encrypted, and used only to read
  (2026-10-03).
- Open decisions:
  - Which other writes come next (editing, closing, labelling, assigning,
    commenting), and what happens when GitHub changed in the meantime.
    Buckets do not map to labels: they are internal to urutau (2026-10-03).

## Brand Commitments

- Name: Urutau.
- Visual language: the IBM Carbon design system, binding since the original
  brief.
- Free and open source under GPL-3.0, with no tracking. Accounts exist only on
  the team's own server (local, or through the team's Keycloak), never with a
  third party.
- UI copy in English and Portuguese.

## Evidence on Hand

The working app in this repository. There are no users, testimonials, metrics
or published screenshots yet; future work must not invent any.

## Product Principles

1. A repository name is all it takes to get a useful board.
2. GitHub stays the source of truth for issues. Urutau organizes them, and
   writes to GitHub only after the admin has turned writes on for the server.
3. Built for a team: anything that works only in one person's browser is a
   stopgap.
4. Accessible and bilingual by default.
5. Free and private: self-hosted accounts only, no tracking, and GitHub tokens
   are sent only to GitHub. An agent integration's GitHub token is kept on the
   team's own server, encrypted: the admin's browser sends it there once, and
   from then on only that server sends it, only to GitHub.

## Accessibility & Inclusion

WCAG 2.1 AA. Every action has a keyboard path, including moving cards between
buckets, and the UI copy is available in English and Portuguese.
