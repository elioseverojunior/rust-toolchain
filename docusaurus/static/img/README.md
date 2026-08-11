<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Site images

Every image here is generated from a committed SVG source. The PNGs are build
outputs that happen to be tracked, because `docusaurus.config.ts` references
them by path and GitHub's Open Graph crawler cannot run a build step.

## Files

| File                   | Referenced by                    | Source                 |
| ---------------------- | -------------------------------- | ---------------------- |
| `favicon.svg`          | `config.favicon`                 | hand-written, original |
| `favicon.ico`          | fallback for older browsers      | hand-written, original |
| `apple-touch-icon.png` | the `head` `apple-touch-icon`    | `apple-touch-icon.svg` |
| `social-card.png`      | `themeConfig.image` (Open Graph) | `social-card.svg`      |

## Regenerating

```sh
cd docusaurus/static/img
rsvg-convert -w 180 -h 180 apple-touch-icon.svg -o apple-touch-icon.png
rsvg-convert -w 1200 -h 630 social-card.svg -o social-card.png
```

`rsvg-convert` comes from `librsvg` (`brew install librsvg`). ImageMagick's
`magick` also works, but it rasterises SVG through its own renderer and
produces noticeably softer text, so prefer `rsvg-convert`.

Commit the regenerated PNG alongside the SVG it came from. A source and an
output that disagree is worse than either alone, because nothing checks them.

## Constraints worth knowing before editing

- **XML comments cannot contain `--`.** A double hyphen anywhere inside a
  `<!-- -->` block is a hard parse error, and `rsvg-convert` reports it as a
  line and column rather than as a comment problem. Use an em dash in prose.
- **Text is rasterised against the fonts of whoever runs the command.** These
  sources name `Helvetica, Arial, sans-serif` and deliberately reference no
  webfont: a webfont in an offline rasterisation silently falls back, so the
  committed PNG would depend on the machine that produced it.
- **The layer overlap is a function of render size, not a constant.**
  `favicon.svg` overlaps its two diamonds by about 17% of their height, tuned so
  they merge into a stack at 16px. At 180px and above that same ratio opens a
  visible gap and the lower apex protrudes as a notch, so the larger sources use
  roughly 35%. Re-verify by looking at the output at its real size after any
  change to the geometry.
- **The touch icon is deliberately square.** iOS masks and rounds it itself, so
  a source with its own rounded corners is rounded twice and shows a pale seam.

## Palette

Taken from the mark, and shared with `action.yml`'s `branding.color` and the
site's `theme-color`.

| Role                     | Value     |
| ------------------------ | --------- |
| Field / background       | `#1f5572` |
| `registry` layer, accent | `#f0883e` |
| `build` layer            | `#7cc0e8` |
