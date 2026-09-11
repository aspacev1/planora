# Export fonts

Three Inter weights — the same family the interface is set in
(`@fontsource-variable/inter` in the frontend). A document must read as a
continuation of the screen rather than as a neighbouring product.

## Why they lie in the repository as files

ReportLab's built-in fonts are Latin-1. They have neither Cyrillic nor `ə`, `ğ`,
`ş`, `ı` — that is, they are no use for any of the product's three languages
except English. The font has to be embedded, and only a static TTF can be
embedded: ReportLab does not read variable fonts or woff2.

Downloading them at build time will not do: the export must work in the closed
network of a self-hosted deployment, where there is no access to Google Fonts
or npm.

## Where they came from

Neither Google Fonts nor `@fontsource/inter` hands out static TTFs: the first
returns EOT under a legacy `User-Agent`, the second only woff2 subsets by
script, which would have to be stitched together.

The working path is the full character set from the `inter-ui` npm package with
a one-off conversion:

```sh
npm pack inter-ui
tar -xzf inter-ui-*.tgz package/web/Inter-{Regular,SemiBold,Bold}.woff2 package/LICENSE.txt
python -c "
from fontTools.ttLib import TTFont
for n in ('Regular', 'SemiBold', 'Bold'):
    f = TTFont(f'package/web/Inter-{n}.woff2')
    f.flavor = None                      # woff2 -> plain sfnt
    f.save(f'Inter-{n}.ttf')
"
```

`fontTools` is needed only for this conversion and is not among the product's
dependencies: it is a one-off, and its result lies here.

## Licence

SIL Open Font License 1.1, full text in `OFL.txt`. It permits embedding in
documents.

## Coverage

Checked on all three weights: Cyrillic, `ə ğ ş ı İ ç ö ü`, `№`, `◆`. The
`tests/test_export_api.py` test holds this promise — it looks for these
characters in the font's cmap table rather than by eye in a finished file.
