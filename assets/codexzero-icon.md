# CodexZero icon

The logo is a vector. `assets/codexzero-mark.svg` is the single source; the PNG and ICO are generated from it.

## The mark

Two code brackets squeezing a zero: `>0<`.

- The zero is the product name and doubles as a programmer's zero.
- The brackets point inward, so the mark reads as compression at a glance.
- The left bracket is cream (the output Codex would have received) and the right bracket is coral (what CodexZero sends instead).

Palette matches the site: ink `#171713`, lime `#c9ff36`, cream `#f4f2e9`, coral `#ff7759`.

## Regenerate the raster files

```sh
magick -background none assets/codexzero-mark.svg -resize 1024x1024 -depth 8 -strip PNG32:assets/codexzero.png
powershell -ExecutionPolicy Bypass -File scripts/build-codexzero-icon.ps1
```

The ICO packages sizes 16, 24, 32, 48, 64, 128, and 256.

The social card embeds the same geometry without the tile, because that card already has a dark background. Regenerate it with:

```sh
magick -background none assets/social-card.svg -resize 1200x630 -depth 8 -strip PNG32:assets/social-card.png
```
