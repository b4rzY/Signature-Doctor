---
name: Signature Doctor
description: A charcoal operational workbench with restrained lime and precise data typography.
colors:
  primary: "#c2ee90"
  background: "#101112"
  sidebar: "#141516"
  surface: "#18191b"
  surface-raised: "#202224"
  border: "#303234"
  divider: "#27292b"
  text: "#eeeef0"
  muted: "#a7aaad"
  subtle: "#96999d"
  success: "#b8dca0"
  warning: "#e2bf84"
  error: "#ee9c95"
  ambiguity: "#c0b0e1"
typography:
  display:
    fontFamily: "Manrope, 'Segoe UI', sans-serif"
    fontSize: "30px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Manrope, 'Segoe UI', sans-serif"
    fontSize: "25px"
    fontWeight: 550
    lineHeight: 1.35
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Manrope, 'Segoe UI', sans-serif"
    fontSize: "23px"
    fontWeight: 600
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Manrope, 'Segoe UI', sans-serif"
    fontSize: "13px"
    lineHeight: 1.6
  data:
    fontFamily: "Consolas, monospace"
    fontSize: "10px"
rounded:
  chip: "5px"
  control: "7px"
  field: "8px"
  panel: "12px"
  dialog: "14px"
spacing:
  compact: "8px"
  regular: "12px"
  section: "24px"
  canvas: "36px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#233017"
    rounded: "{rounded.control}"
    padding: "8px 13px"
    height: "36px"
  button-secondary:
    backgroundColor: "#26282a"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
  input:
    backgroundColor: "#111315"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "9px 10px"
  navigation:
    backgroundColor: "#293122"
    textColor: "{colors.primary}"
    rounded: "{rounded.control}"
    padding: "10px 13px"
  status:
    backgroundColor: "#293326"
    textColor: "{colors.success}"
    rounded: "{rounded.chip}"
    padding: "3px 6px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
---

# Design System: Signature Doctor

## Overview

**Creative North Star: "Keep noir, elevate the craft"**

Keep noir, elevate the craft. A charcoal operational workbench uses quiet tonal layers, locally served Manrope, and restrained lime to make actions and selected evidence easy to find. Monospace separates addresses, patterns, deltas, and counts from interface language.

This records the implemented source in public/styles.css and public/app.mjs. Desktop and mobile browser captures are available in .impeccable/review. This document records the final source changes; the final visual review verdict is tracked separately.

**Key Characteristics:**

- Charcoal tonal layers.
- Restrained lime actions and focus.
- Manrope interface language with monospace evidence.
- Dense operational layout with an adjacent inspector.

## Colors

The palette is low-chroma charcoal with a pale lime action accent and muted semantic status colors. The frontmatter records normative values.

### Primary

- **Signal Lime:** primary actions, focus outlines, selected navigation, and current addresses.

### Secondary

- **Sage, Amber, Rose, and Lavender:** success, movement/warnings, failures, and ambiguity respectively. These are evidence states, not competing brand accents.

### Neutral

- **Charcoal:** canvas and sidebar establish the persistent frame.
- **Graphite:** panel and raised surfaces create local grouping.
- **Soft Chalk:** main text; muted and subtle grays support metadata.
- **Graphite Rules:** borders and dividers separate dense information.

**The Evidence Color Rule.** Semantic colors must accompany a label or icon that identifies the underlying state.

## Typography

**Display Font:** locally served variable Manrope, with Segoe UI and sans-serif fallbacks.
**Body Font:** the same Manrope stack.
**Label/Mono Font:** Consolas, monospace for machine data.

The geometric sans brings clarity to the dark workbench; mono makes patterns, addresses, and numerical differences distinguishable.

### Hierarchy

- **Display:** page heading, with responsive variants from 28px to 34px.
- **Headline:** build summary narrative.
- **Title:** selected signature in the inspector.
- **Body:** base interface rhythm; descriptions use smaller local sizes and more generous leading.
- **Data:** addresses, patterns, counters, and keyboard hints. Deltas use tabular numerals.

At mobile widths, status labels, deltas, item details, and panel footers use 10px type; signature names use 12px. Names, details, statuses, and deltas wrap within fixed table columns. Other compact metadata sizes remain local implementation details rather than a recommended minimum for future surfaces.

**The Data Voice Rule.** Use mono for machine evidence and the sans family for human instructions.

## Layout

The desktop shell has a fixed sidebar (232px), a thin topbar (65px), and a content maximum (1680px). Default canvas padding is 34px vertically at the top and 36px horizontally. The results/inspector grid uses a flexible primary column and a 302px inspector with a 22px gap. The coverage map uses nine columns.

At 1550px and wider, margins and the inspector grow. At 1250px and below, the sidebar contracts to 208px and secondary table detail reduces. At 1000px and below, summary, inspector, history, and exports stack. At 700px and below, a 240px off-canvas sidebar replaces persistent navigation; canvas padding becomes 16px horizontally and form grids stack. Tables retain horizontal overflow, while selected less-critical columns hide.

At mobile widths, table columns use 44%, 34%, and 22% proportions for names, status, and delta. On screens up to 1000px, selecting a signature reveals and focuses its inspector; Back to results restores focus to the selected signature and scrolls to the catalog.

## Elevation & Depth

Persistent surfaces are flat and separated by tone and thin borders. Overlays use soft shadow and backdrop dimming. The dialog's effective shadow is `0 24px 80px #0008`; the toast uses `0 8px 35px #0006`.

**The Quiet Surface Rule.** Use tonal layers and rules for persistent workspace depth; reserve the implemented shadows for overlays.

## Shapes

Controls have compact softened corners; panels are more rounded and dialogs rounder again. Thin borders define most interactive and grouped surfaces. Small round status markers and a repeated rectangular signature map provide the recurring geometry. Exact recurring radii are in frontmatter.

## Components

### Buttons

Compact, restrained controls. Primary buttons use Signal Lime with dark text; secondary buttons use graphite, and ghost buttons preserve the underlying surface. Hover changes color and border over 160ms using `cubic-bezier(.16,1,.3,1)`. Disabled buttons use 45% opacity and a disabled cursor. Keyboard focus uses a lime 2px outline with 3px offset.

### Chips

Semantic status chips combine a dot, written status, tinted surface, and muted status color. Filter tabs use a neutral selected fill, so filtering is distinct from evidence status.

### Cards / Containers

Panels use a graphite surface and a thin border. Header and body padding vary around 18–23px. History and export containers share the panel radius. No persistent card shadow is implemented.

### Inputs / Fields

Inset dark fields use a thin stroke and the field radius. Focus retains the global visible outline; search groups receive an explicit focus-within ring. Error copy uses the error color. Search and command inputs inherit their enclosing surface.

### Navigation

A quiet fixed rail uses icons, sentence-case labels, and a lime-tinted active item. Navigation hover uses a neutral brighter surface. On small screens the rail slides into view over a dimmed scrim in 220ms. While open, the main content is inert and keyboard focus stays within drawer controls. Closing restores focus to the menu trigger; command and slash-search entry points close the drawer before moving focus.

### Resolution Map and Inspector

Each map cell represents one signature with a status icon and accessible name. Selection adds an outline; hover brightens the cell. The inspector combines a pattern block, vertical trace, validation checks, address comparison, and review action. Technical strings wrap in detail areas. At stacked widths, selection reveals and focuses the inspector, and Back to results returns to the selected result.

### Dialogs and Feedback

Dialogs enter with an 8px upward settle from 98% scale over 220ms. Toasts settle with opacity and translation over 180ms. Reduced-motion preference removes animations and transitions. These are interaction cues, not decorative sequences.

## Do's and Don'ts

### Do:

- Do reserve lime for primary actions, focus, selection, and current evidence.
- Do use monospace for machine data and Manrope for interface language.
- Do pair status color with a label or icon.
- Do retain the reduced-motion override and visible keyboard focus.

### Don't:

- Don't use status colors as decorative accents.
- Don't present simulated data as live evidence.
- Don't treat source inspection as a successful visual review.


