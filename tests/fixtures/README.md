# Test fixtures

| File | Source | Used for |
|---|---|---|
| `happy-birthday.pgm`, `together-we-will-live-forever.pgm` | Screenshots supplied by the project owner (greyscale) | OMR regression tests |
| `happy-birthday.truth.json` | Hand-annotated | OMR accuracy floor |
| `maple-leaf-rag.mxl`, `clara-polonaise.mxl`, `lindenbaum.xml`, `bach-bwv66.mxl`, `dichterliebe-2.xml` | [music21](https://github.com/cuthbertLab/music21) corpus (BSD-3-Clause); public-domain compositions | MusicXML import, loop and repeat tests |
| `*.oracle.json` | Generated with music21 (independent reference parser) | Note-by-note comparison |
