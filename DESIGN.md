---
name: Urutau
description: A kanban board over a GitHub repository's issues, built on IBM Carbon (White and Gray 100 themes)
colors:
  interactive-blue: "#0f62fe"
  interactive-blue-hover: "#0050e6"
  interactive-blue-dark: "#4589ff"
  link-blue-dark: "#78a9ff"
  text-on-color: "#ffffff"
  canvas: "#ffffff"
  canvas-dark: "#161616"
  bucket-surface: "#f4f4f4"
  bucket-surface-dark: "#262626"
  card-surface: "#ffffff"
  card-surface-dark: "#393939"
  card-hover: "#e8e8e8"
  card-hover-dark: "#474747"
  header-surface: "#161616"
  text-primary: "#161616"
  text-primary-dark: "#f4f4f4"
  text-secondary: "#525252"
  text-secondary-dark: "#c6c6c6"
  text-helper: "#6f6f6f"
  text-helper-dark: "#a8a8a8"
  border-subtle: "#e0e0e0"
  border-subtle-dark: "#393939"
  border-strong: "#8d8d8d"
  border-strong-dark: "#6f6f6f"
  focus-dark: "#ffffff"
  drop-highlight: "#d0e2ff"
  drop-highlight-dark: "#001d6c"
  over-limit-red: "#da1e28"
  over-limit-red-dark: "#fa4d56"
typography:
  display:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 400
    lineHeight: 1.25
  headline:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: 1.28572
  title:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.28572
    letterSpacing: "0.16px"
  body-large:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.42857
    letterSpacing: "0.16px"
  body-compact:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.28572
    letterSpacing: "0.16px"
  label:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33333
    letterSpacing: "0.32px"
rounded:
  none: "0px"
  pill: "16px"
spacing:
  "02": "0.25rem"
  "03": "0.5rem"
  "04": "0.75rem"
  "05": "1rem"
  "06": "1.5rem"
  "07": "2rem"
  "09": "3rem"
  "10": "4rem"
components:
  button-primary:
    backgroundColor: "{colors.interactive-blue}"
    textColor: "{colors.text-on-color}"
    typography: "{typography.body-compact}"
    rounded: "{rounded.none}"
    height: "40px"
    padding: "0 63px 0 15px"
  button-primary-hover:
    backgroundColor: "{colors.interactive-blue-hover}"
  button-ghost:
    textColor: "{colors.interactive-blue}"
    typography: "{typography.body-compact}"
    rounded: "{rounded.none}"
    height: "32px"
  field:
    backgroundColor: "{colors.bucket-surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body-compact}"
    rounded: "{rounded.none}"
    height: "40px"
    padding: "0 16px"
  tag-label:
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: "18px"
    padding: "0 8px"
  bucket:
    backgroundColor: "{colors.bucket-surface}"
    rounded: "{rounded.none}"
    width: "16rem"
  issue-card:
    backgroundColor: "{colors.card-surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.none}"
    padding: "8px 12px 12px"
  issue-card-hover:
    backgroundColor: "{colors.card-hover}"
  header:
    backgroundColor: "{colors.header-surface}"
    textColor: "{colors.text-primary-dark}"
    height: "48px"
---

# Design System: Urutau

## Overview

**Creative North Star: "The Night Watch"**

The urutau (the common potoo) is a night bird that sits still on a branch and
watches. The interface does the same: it stays quiet and still, is as
comfortable in the dark theme as in the light one, and spends attention only on
what changed or needs action. Calm and utilitarian, it is IBM Carbon used the
way Carbon ships it: the White and Gray 100 themes, IBM Plex Sans, square
corners, tonal layers.

Color belongs to the work, not to the interface. A card's GitHub labels, its
closed or not-planned state, and a bucket that is over its work-in-progress
limit are the only colored things on the board; everything around them stays in
Carbon's grays, with one blue for what can be acted on. Components are
Carbon's, out of the box. The one project-specific behavior is depth: an issue
card lifts when it is hovered or focused, so the thing you can pick up stands
out from the flat board around it.

**Key Characteristics:**
- Carbon White (light) and Gray 100 (dark), switched on `<html>`; the header is always Gray 100.
- Neutral interface; color comes from labels and statuses.
- Flat tonal layers: canvas, then bucket, then card.
- Cards lift on hover and focus; menus and the dragged card float.
- Square corners everywhere except tags, which are pills.
- IBM Plex Sans on Carbon's productive type scale; working text is 12–14px.

## Colors

Carbon's grays for every surface and text role, one interactive blue, and red
only for a bucket over its limit. Every role has a light (White) and a dark
(Gray 100) value; the `-dark` tokens are the Gray 100 values.

### Primary
- **Interactive Blue** (#0f62fe; hover #0050e6): primary buttons ("Open board",
  "Add bucket", dialog confirms), ghost-button text, links, the focus ring and
  selected states in the light theme. In the dark theme focus borders and
  interactive accents use Interactive Blue Dark, links use Link Blue Dark, and
  the focus ring turns white (Focus Dark). Primary buttons keep #0f62fe in both
  themes.

### Secondary: status
- **Over-Limit Red** (#da1e28 / dark #fa4d56): a bucket's top border and count
  tag when it holds more open issues than its work-in-progress limit. Nothing
  else on the board is red except a label whose GitHub color is red.
- **Drop Highlight** (#d0e2ff / dark #001d6c): the card list of the bucket a
  dragged card is over.

### Neutral
- **Canvas** (#ffffff / dark #161616): the page behind the board.
- **Bucket Surface** (#f4f4f4 / dark #262626): bucket columns, the start page's
  form tile, and fields that sit on the canvas.
- **Card Surface** (#ffffff / dark #393939): issue cards, which sit one Carbon
  layer above their bucket; also fields inside a tile.
- **Card Hover** (#e8e8e8 / dark #474747): a card's background under the pointer.
- **Header Surface** (#161616 in both themes): the UI shell header.
- **Text Primary** (#161616 / dark #f4f4f4): titles and body text.
- **Text Secondary** (#525252 / dark #c6c6c6): counts, descriptions, card meta.
- **Text Helper** (#6f6f6f / dark #a8a8a8): helper text and empty-bucket messages.
- **Border Subtle** (#e0e0e0 / dark #393939): a bucket's top border. This is
  Carbon's contextual subtle border at the canvas layer; Carbon steps it one
  shade darker inside layers.
- **Border Strong** (#8d8d8d / dark #6f6f6f): field underlines. Inside a
  bucket's card list (one layer up) it renders #8d8d8d in both themes, which is
  the dashed outline of an empty bucket.

### Named Rules
**The Data Owns Color Rule.** Color on the board comes from the work: label
tags, the Closed and Not planned tags, and Over-Limit Red. Surfaces, borders and
text stay in Carbon's grays. Never add a decorative hue.

**The One Blue Rule.** Interactive Blue marks what can be acted on (buttons,
links, focus, selection) and nothing else.

**The Theme Token Rule.** Component styles use Carbon theme tokens (`$layer`,
`$text-secondary`, `var(--cds-…)`), never hex values, so the White and Gray 100
themes both stay correct. The only literal colors are GitHub's label colors,
which come from the data.

## Typography

**Display Font:** IBM Plex Sans (with system-ui, sans-serif)
**Body Font:** IBM Plex Sans (with system-ui, sans-serif)

**Character:** One family on Carbon's productive scale. Headings are regular
weight; semibold is kept for the compact titles that name a bucket or an issue.

### Hierarchy
- **Display** (400, 2rem/32px, line-height 40px): the start page heading.
- **Headline** (400, 1.75rem/28px, line-height 36px): the repository name above the board.
- **Title** (600, 14px, line-height 18px, 0.16px): bucket titles and issue card titles.
- **Body Large** (400, 16px, line-height 24px): the start page's lead paragraph.
- **Body** (400, 14px, line-height 20px, 0.16px): the repository description and dialog text.
- **Body Compact** (400, 14px, line-height 18px, 0.16px): buttons and fields.
- **Label** (400, 12px, line-height 16px, 0.32px): card meta (number and age), counts,
  helper text, the bucket rules row, and tags.

### Named Rules
**The Carbon Scale Rule.** Text sizes come from Carbon's type styles
(`@include type.type-style(...)`), never ad-hoc font sizes.

**The Semibold Titles Rule.** Weight 600 marks bucket and card titles only.
Headings stay regular, and numbers are never bold.

## Layout

A full-height board under the 48px header. From the top: the board header
(repository name and description on the left; counts, Refresh and Board
settings on the right), a filter toolbar (search, labels, assignee, milestone,
and Add bucket pushed to the right), then the board itself.

Buckets share the width, each between 16rem and 24rem. When they do not fit,
the board scrolls horizontally and each bucket scrolls its own cards
vertically, so the toolbar and headers stay in place. Page gutters are 2rem,
dropping to 1rem below Carbon's `md` breakpoint (672px), where the toolbar's
fields stack to full width. Buckets are 1rem apart and cards 0.5rem apart.
All spacing comes from Carbon's scale (`$spacing-02` to `$spacing-10`).

Copy must leave room to grow: the UI is committed to English and Portuguese,
and Portuguese strings run longer.

## Elevation & Depth

Depth is tonal by default: canvas, bucket and card are Carbon's layers 0, 1 and
2 (the `<Layer>` component switches the tokens). Shadows mark what can be picked
up or what floats: an issue card lifts when hovered or keyboard-focused, the
card being dragged floats, and Carbon's menus float.

### Shadow Vocabulary
- **Menu float** (`box-shadow: 0 2px 6px 0 rgba(0, 0, 0, 0.3)`): Carbon's own
  shadow on overflow menus and list boxes.
- **Drag float** (`box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3)`): the copy of a card
  that follows the pointer while it is dragged.
- **Card lift** (value not set yet; lighter than Drag float): a hovered or focused
  card. Decided on 2026-10-02; the current cards change only their background on
  hover, and adding the lift is pending.

### Named Rules
**The Lift Means Grabbable Rule.** Only things that can be picked up, or that float
above the board, cast a shadow: hovered or focused cards, the dragged card, and
menus. Buckets, the header and the toolbar stay flat.

## Shapes

Square corners (0px) for buttons, fields, tiles, buckets and cards, as Carbon
ships them. The one rounded shape is the tag: label and count tags are pills
(16px radius, 18px tall). Each bucket has a 3px top border in Border Subtle,
which turns Over-Limit Red when the bucket is over its limit. An empty bucket
shows a 1px dashed Border Strong outline. Label dots and assignee avatars are
circles.

## Components

Carbon's components as they ship; nothing is restyled beyond layout. The
project-specific pieces are the issue card and the bucket.

### Buttons
- **Shape:** square (0px).
- **Primary:** Interactive Blue with white text, 40px (`md`), for the one main
  action of a view: "Open board", "Add bucket", a dialog's confirm.
- **Hover / Focus:** Carbon's: Interactive Blue Hover background; a 2px focus ring
  (Interactive Blue, white in the dark theme).
- **Ghost:** 32px (`sm`) with Interactive Blue text, for toolbar actions such as
  Refresh, Board settings and Clear filters. **Danger** confirms a destructive
  action (Delete bucket); **Tertiary** holds secondary dialog actions (Export and
  Import board).

### Chips (tags)
- **Style:** Carbon's small tag, a pill 18px tall with Label type.
- **Label tags:** the Carbon tag palette nearest to the GitHub label's color, plus an
  8px dot in the label's exact color, ringed in 40% of the tag's text color so
  very light or very dark labels stay visible.
- **Count tags:** cool gray; red when the bucket is over its limit.
- **State tags:** purple "Closed", gray "Not planned".

### Cards / Containers
- **Corner Style:** square (0px).
- **Background:** Card Surface; Card Hover under the pointer.
- **Shadow Strategy:** flat at rest, Card lift when hovered or focused, Drag float
  while dragged (see Elevation & Depth).
- **Border:** none.
- **Internal Padding:** 8px top, 12px sides and bottom.

### Inputs / Fields
- **Style:** Carbon's fields: 40px tall, square, a 1px Border Strong underline,
  Bucket Surface background on the canvas and Card Surface inside a tile.
- **Focus:** a 2px Interactive Blue outline (white in the dark theme).
- **Error / Disabled:** Carbon's invalid state, with red text and an icon under
  the field.

### Navigation
- **Style:** Carbon's UI shell header, always Gray 100 and 48px tall: the product
  name (which leads back to the start page) on the left, icon buttons with 20px
  icons on the right (theme toggle, settings), and Carbon's tooltips.

### Issue card (signature)
A Carbon tile on Card Surface. Its top row has a drag handle (16px Draggable
icon), the issue number and age in Label type, and an overflow menu with
"Move to …" entries. Below that comes the title, a link to GitHub in Title type,
then the label tags, then a footer with the milestone, the comment count and up
to three assignee avatars (20px circles with a 2px ring in the card's color).
While a card is dragged, its place stays visible at 40% opacity and a floating
copy follows the pointer.

### Bucket (signature)
A Bucket Surface column with a 3px top border. Its header holds the title in
Title type, a count tag and an overflow menu. An optional rules row shows the
label tags routed into the bucket, and a "Closed issues" note when the bucket
collects closed issues. The card list scrolls on its own, and fills with Drop
Highlight while a card is dragged over it.

## Do's and Don'ts

### Do:
- **Do** build with `@carbon/react` components and Carbon tokens, as they ship.
- **Do** check every change in both the White and Gray 100 themes.
- **Do** let labels and statuses carry the color (The Data Owns Color Rule).
- **Do** keep text contrast at WCAG 2.1 AA; Carbon's text and layer tokens meet it in both themes.
- **Do** give every action a keyboard path; moving a card has a drag handle and a "Move to" menu.
- **Do** leave room in layouts for Portuguese copy, which runs longer than English.

### Don't:
- **Don't** hard-code colors, font sizes or spacing in component styles; GitHub label colors are the only literal colors.
- **Don't** round corners on anything but tags.
- **Don't** put shadows on static surfaces (buckets, the header, the toolbar).
- **Don't** add a second accent color or decorative gradients.
- **Don't** restyle Carbon components beyond layout.
