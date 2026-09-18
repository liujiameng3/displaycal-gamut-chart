# Method and style

## Calculation

Extract `FF_data_in` from the DisplayCAL measurement-report HTML. Locate patches by their RGB values rather than assuming fixed sample IDs:

- black: `0, 0, 0`
- red: `100, 0, 0`
- green: `0, 100, 0`
- blue: `0, 0, 100`

Subtract black XYZ component-wise from each primary before conversion. Convert corrected XYZ to CIE 1931 xy with:

`x = X / (X + Y + Z)` and `y = Y / (X + Y + Z)`.

Use these reference primaries:

| Gamut | R | G | B |
|---|---|---|---|
| sRGB | (0.640, 0.330) | (0.300, 0.600) | (0.150, 0.060) |
| DCI-P3 | (0.680, 0.320) | (0.265, 0.690) | (0.150, 0.060) |
| Adobe RGB | (0.640, 0.330) | (0.210, 0.710) | (0.150, 0.060) |

- Coverage (%) = area of the measured/reference triangle intersection ÷ reference-triangle area × 100.
- Volume (%) = measured-triangle area ÷ reference-triangle area × 100.

Round displayed percentages to one decimal place. Do not call area ratio “coverage”; out-of-reference portions count toward volume but not coverage.

This is a two-dimensional CIE 1931 xy triangle method, not an ICC-profile three-dimensional Lab gamut-volume calculation. Say so when the distinction matters.

## Visual specification

- Canvas: 1400 × 1400.
- Background: near-black navy with a subtle blue accent.
- Spectral locus: use `assets/CIE_cc_1931_2deg.csv`, CIE 1931 2° data at 1 nm. Preserve equal x/y scale.
- Chromaticity fill: continuous xy → XYZ → sRGB conversion, clipped to the locus and darkened. Do not use wavelength fan wedges or radial segments.
- Grid and locus outline: low-contrast blue-gray.
- Main boundary: white, approximately 6 px, subtle glow, no interior fill.
- Vertex labels: R/G/B in red/green/blue, coordinates in white monospace.
- Metric: small English text inside the axes at the lower-right.
- No cards, side panels, large percentage blocks, or extra reference triangles unless the user requests them.

The bundled CIE dataset is from the International Commission on Illumination dataset “CIE 1931 chromaticity coordinates of spectrum loci, 2 degree observer”; expected MD5: `3425c45ef187eaedcb14081e3f8b320a`.
