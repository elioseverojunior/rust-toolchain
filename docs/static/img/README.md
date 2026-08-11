<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Site images

`logos/rust-toolchain-and-cache.svg` is the single source. Every other image
here is derived from it by `build-icons.sh` and should never be edited directly
— edit the logo, re-run the script, commit both.

The PNGs and the ICO are build outputs that happen to be tracked, because
`docusaurus.config.ts` references them by path and GitHub's Open Graph crawler
cannot run a build step.

## Files

| File                   | Kind      | Referenced by                    |
| ---------------------- | --------- | -------------------------------- |
| `logos/*.svg`          | source    | nothing directly; four variants  |
| `build-icons.sh`       | generator | run by hand                      |
| `social-card.svg`      | source    | the card's background and type   |
| `favicon.svg`          | generated | `config.favicon`                 |
| `favicon.ico`          | generated | fallback for older browsers      |
| `apple-touch-icon.png` | generated | the `head` `apple-touch-icon`    |
| `social-card.png`      | generated | `themeConfig.image` (Open Graph) |

`logos/` holds four variants of the mark. Only
`rust-toolchain-and-cache.svg` is wired up; the other three are alternates kept
for reference.

## Regenerating

```sh
cd docusaurus/static/img
./build-icons.sh
```

Needs `librsvg` and `imagemagick` (`brew install librsvg imagemagick`).
`rsvg-convert` does every rasterisation; ImageMagick only composites and packs
the ICO, because its own SVG renderer produces visibly softer edges on this
artwork.

## Constraints worth knowing before editing

- **The logo does not survive 16px.** Verified by rendering, not assumed: at
  16px it is a colourful blob, at 32px it is marginal — the gear teeth and the
  shield badge become noise — and only at 48px is it fully legible. `favicon.ico`
  still ships a 16px frame, because omitting it makes the browser downscale the
  32px one with a worse filter than `rsvg-convert` uses. If a crisp 16px icon
  matters more than one consistent mark, the fix is a **simplified 16px frame**
  — the three colour bands alone read well at that size — which means
  maintaining a second, reduced mark.
- **The generated images need an opaque light field.** The logo ships
  transparent with a near-black gear ring and a dark grey toolbox. Checked by
  rendering all three candidates side by side: on the site's `#1f5572` and on
  near-black, the ring merges into the background and the silhouette is lost.
  White is the only one that works, which is also why the social card puts the
  logo on a white panel rather than straight on the field.
- **`social-card.svg` is not the card.** It is the background and type only,
  with a panel reserved for the logo, which `build-icons.sh` composites in.
  Running `rsvg-convert` on it alone produces a card with a hole in it. The
  logo is roughly 1500 paths; inlining it would bury the layout.
- **The panel rect and the composite offset are two halves of one number.**
  `social-card.svg`'s panel is at `x=84 y=213` with a 12px inset; the script
  composites at `+96+225`. Nothing checks that they agree, and a mismatch shows
  up as the logo sitting off its panel.
- **XML comments cannot contain `--`.** A double hyphen anywhere inside a
  `<!-- -->` block is a hard parse error, and `rsvg-convert` reports it as a
  line and column rather than as a comment problem. Use an em dash in prose.
  This has bitten three separate edits to these files.
- **Text is rasterised against the fonts of whoever runs the script.**
  `social-card.svg` names `Helvetica, Arial, sans-serif` and deliberately
  references no webfont: a webfont in an offline rasterisation silently falls
  back, so the committed PNG would depend on the machine that produced it.
- **The touch icon is deliberately square.** iOS masks and rounds it itself, so
  a source with its own rounded corners is rounded twice and shows a pale seam.

## Palette

The field and accent are shared with `action.yml`'s `branding.color` and the
site's `theme-color`. The three layer colours are sampled from the rendered
logo, so the social card's legend and the bands it explains match exactly.

| Role               | Value     |
| ------------------ | --------- |
| Field / background | `#1f5572` |
| Accent rule        | `#f0883e` |
| `registry` layer   | `#f7ac2a` |
| `build` layer      | `#44c1a7` |
| `bin` layer        | `#3e86c8` |
