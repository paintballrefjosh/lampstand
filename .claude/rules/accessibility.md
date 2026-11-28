---
paths:
  - "apps/web/src/**/*.tsx"
  - "apps/web/src/**/*.css"
  - "tests/e2e/tests/zz-accessibility.spec.ts"
---

# Accessibility (every screen)

Binding rules for this area, as binding as [CLAUDE.md](../../CLAUDE.md). Keep this current, and keep `paths` above covering the area's files.
A reference such as "see ## Search" means the section of that name in CLAUDE.md or in the rules file its index lists.

**Accessibility** (Part 2 item 10; sweep and keyboard tests in `tests/e2e/tests/zz-accessibility.spec.ts`, `@axe-core/playwright` pinned). The spec runs axe
(WCAG 2.2 AA + best practice) over every screen, a detail screen of each kind and the open menus/palette, in light and dark, desktop and 390 px, and **fails on any
violation**: a new screen cannot add one, and an exception goes in `ACCEPTED` with a reason. With a drop-down open, a page control flagged by target-size only because the menu partly covers it is left out (`menuOpen` in `scan`); nothing else is. Rules the code now follows: (1) *text colour pairs*: muted text is
`text-slate-500 dark:text-slate-400` (never `slate-400` alone on a light page, never `slate-500` alone on a dark one); links `text-brand-600 dark:text-brand-400`;
status colours `-700` in light with a `dark:` partner (`-600` on white fails); text on a `brand-50/100` tint uses `slate-600`; never dim text with `opacity-*`.
(2) *Every control has a name*: an icon-only button needs `aria-label` (say what it acts on: `Remove <thing>`), a blank table heading needs `sr-only` text (`Column.srLabel`
in `DataTable`), a form field needs a real `<label htmlFor>` (the Settings fields tie label, description and input together). (3) *Landmarks*: two `<nav>`s on a page need
different `aria-label`s; each page has one `<main>`; `SkipLink` (first Tab stop) focuses it. (4) *Hand-built dialogs* use `DialogFrame`/`useModal`
(`components/modal.tsx`): focus goes in, Tab stays in, Escape closes, focus returns to the opener; give the panel `role="dialog"`, `aria-modal` and a name. `DialogFrame` renders into `document.body`: the animated background gives cards a `backdrop-filter`, which traps a `fixed` overlay inside the card (a dialog opened from a card dimmed only that card and later cards drew over it), so every hand-built overlay or `fixed` popup (drawers, the wiki "Edit this page?" popup, the palette's toast) is portalled to `document.body` too. (5) A
horizontally scrolling table wrapper with nothing focusable inside needs `tabIndex={0} role="region" aria-label="..."`, or a keyboard user cannot scroll it. (6) Click
targets are at least 24 px (WCAG 2.2). (7) Ctrl+K belongs to the command palette alone (the top-bar search used to answer it too), and the palette hands focus back to
what had it. (8) A control that needs a sentence of explanation gets `HoverTip` (`components/hover-tip.tsx`: shows on hover and focus, `aria-describedby`, Escape dismisses, hangs off a wrapper so a disabled button still shows it; drawn in a portal with `position: fixed`, flips above the control when there is no room below; the device page's Apply / Update the agent / Set up again use it). (9) `prefers-reduced-motion` switches off the app's transitions and pulses (`globals.css`); spinners keep turning. axe finds about a third of real
problems: keyboard order, focus and what a screen reader says are checked by the keyboard tests and by hand, and no assistive technology was run against the app.
