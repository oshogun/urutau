# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Small software teams that work on one GitHub repository together and plan its
issues on a kanban board. They expect to share one board: the same buckets,
label rules and card positions for everyone on the team.

Today a board lives in one browser and is shared by exporting and importing a
JSON file. A board the whole team shares directly is a confirmed need that is
not met yet.

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

Writing back to GitHub is opt-in. Urutau only reads today. The confirmed
direction is two-way sync that each user turns on explicitly: moving a card
updates the issue's labels or its open/closed state on GitHub.

## Operating Context

- Data comes from the GitHub REST API: issues (pull requests excluded), labels,
  assignees and milestones.
- Public repositories work without a token, within GitHub's anonymous limit of
  60 API requests an hour. Private repositories and heavier use need the
  user's own personal access token, kept in their browser and sent only to
  GitHub.
- A board has buckets (by default Backlog, To do, In progress, In review and
  Done), work-in-progress limits, label rules that route issues into buckets, a
  bucket that collects closed issues, and filters by text, label, assignee and
  milestone.

## Capabilities and Constraints

- Today: read-only access to GitHub; board state stored per browser and shared
  through JSON export and import; cards move by mouse, touch or keyboard; light
  and dark themes; UI copy in English only.
- A static single-page app today (React, TypeScript, Vite). A backend is not
  ruled out; a board shared by a team may need one.
- Terms: a **bucket** is a kanban column; a **label rule** routes open issues
  with a given label into a bucket; a **board** is the buckets, rules and card
  positions for one repository.
- Open decisions:
  - How a team shares one board: a backend, a file in the repository, or
    GitHub's own Projects as storage.
  - The exact two-way sync behaviour: which buckets map to which labels or
    states, and what happens when GitHub changed in the meantime.

## Brand Commitments

- Name: Urutau.
- Visual language: the IBM Carbon design system, binding since the original
  brief.
- Free and open source under GPL-3.0, with no accounts and no tracking.
- UI copy in English and Portuguese.

## Evidence on Hand

The working app in this repository. There are no users, testimonials, metrics
or published screenshots yet; future work must not invent any.

## Product Principles

1. A repository name is all it takes to get a useful board.
2. GitHub stays the source of truth for issues. Urutau organizes them, and
   writes back only when a user opts in.
3. Built for a team: anything that works only in one person's browser is a
   stopgap.
4. Accessible and bilingual by default.
5. Free and private: no accounts, no tracking, and the user's token goes only
   to GitHub.

## Accessibility & Inclusion

WCAG 2.1 AA. Every action has a keyboard path, including moving cards between
buckets, and the UI copy is available in English and Portuguese.
