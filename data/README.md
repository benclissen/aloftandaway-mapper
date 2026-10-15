# Data

## land-10m.bin

Land outlines used by the sea router.

- **Source:** [Natural Earth](https://www.naturalearthdata.com/) v5.1.2, the `ne_10m_land` and
  `ne_10m_minor_islands` layers, from
  `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/`.
- **Licence:** public domain. No permission needed. Credit to Natural Earth is appreciated.
- **Precision:** 1e-4 degrees, about 11 m.
- **Format:** a compact varint stream, described in `src/core/land.ts` (`encodeLand` and
  `decodeLand`). Lakes are land: only the coastline layers are included.
- **Rebuild:** `npm run build:land` downloads the layers into a fresh temp folder, encodes them
  and rewrites this file.
