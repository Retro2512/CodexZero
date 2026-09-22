# CodexZero icon

The logo is a vector. `assets/codexzero-mark.svg` is the single source; the PNG and ICO are generated from it.

## The mark

Two code brackets squeezing a zero — `>0<` — set inside a cloud.

- The zero is the product name and doubles as a programmer's zero.
- The brackets point inward, so the mark reads as compression at a glance.
- The cloud is a seven-lobe blob: one `<path>` built from arcs, no overlapping shapes, so it stays clean at any size and in any renderer.

Mark palette: cloud gradient `#b1adff` (top) to `#3a47ff` (bottom), vertical; glyph white.

The site and chart palette is unchanged: ink `#171713`, lime `#c9ff36`, cream `#f4f2e9`, coral `#ff7759`.

## Placement

Two lockups, chosen by what the mark sits on:

- **Gradient cloud, white glyph** — the default. Holds its silhouette on light and on ink. Used for the favicon, the app icon, and the social card.
- **White cloud, `#3a47ff` glyph** — reversed, for the indigo README hero, where the gradient's lower half would sink into the background.

The cloud reaches to 1..63 inside the 64 viewBox, so it drops into any container the old rounded-square tile fitted.

## Regenerate the raster files

Rasterise at the target resolution with `-density`. Do **not** use `-resize`: librsvg renders the SVG at its declared `width="64"` first, and `-resize` then upsamples that 64px bitmap, which is what made the previous icons soft. Density is `96 x target / 64`.

```sh
magick -background none -density 1536 assets/codexzero-mark.svg -depth 8 -strip PNG32:assets/codexzero.png
powershell -ExecutionPolicy Bypass -File scripts/build-codexzero-icon.ps1
```

The ICO packages sizes 16, 24, 32, 48, 64, 128, and 256.

The social card embeds the same geometry without a container, because that card already has a dark background. Its SVG declares 1200x630, so the default density renders it 1:1:

```sh
magick -background none -density 96 assets/social-card.svg -depth 8 -strip PNG32:assets/social-card.png
```

The README graphics carry the reversed lockup and are generated, not hand-edited:

```sh
python scripts/build-readme-svgs.py
```
