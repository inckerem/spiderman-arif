# M13 design: map abstraction and the Istanbul map

Status: design only, for implementation agents. Code references are against commit `834a9ee` (M9). Coordinates use the code's convention: **x = east, z = south (north is -z), y = up**. Sea surface is at `tuning.world.waterLevel = -1.2`. Road level is the terrain base `H(x,z)` (it is 0 everywhere on Manhattan), and sidewalks are at `H + CURB` (0.15).

Binding decisions (from the user): the second map is "Istanbul", picked in the menu, with its own public room in M12, so `MapId` is a first-class concept. The scale is about 1.5 x 1.5 km. The geography is "compressed real": real relative positions and orientation with shorter distances. **Buildings are real size.** Precincts, open spaces, water widths and bridge spans are compressed. Map switching reloads the page.

---

## 1. Research: real dimensions

| Item | Value used | Status / source |
|---|---|---|
| Hagia Sophia | footprint 82 x 73 m; main dome Ø 31 m, crown 55.6 m above floor; 4 minarets, ~60 m (W pair by Sinan), E pair ~50 m | dome and footprint verified [1][2]. The minaret height comes from one weak source and is an **estimate** |
| Blue Mosque (Sultan Ahmed) | prayer hall 64 x 72 m, courtyard about as large; dome Ø 23.5 m, 43 m; **6 minarets 64 m** (4 at the hall with 3 şerefe, 2 at the courtyard with 2) | [3] |
| Süleymaniye | dome Ø 26.5–27.5 m (use 27), crown 53 m; 2 minarets 76 m with caps (63.8 m without, 3 şerefe), 2 minarets 56 m (2 şerefe); hall ~59 x 58 m | [4] |
| Yeni Cami (Eminönü) | ~41 m square hall, dome Ø 17.5 m, 36 m; 2 minarets 52 m with 3 şerefe; cascade of 66 domes and semi-domes | [5] |
| Ortaköy Mosque | prayer hall 12.25 m square; 2 minarets with 1 şerefe; dome ~Ø 12 m, ~25 m; minarets ~32 m | hall verified [6]. Heights are **estimates** |
| Galata Tower | 66.9 m overall, 62.59 m without the finial; observation balcony 51.65 m; outer Ø 16.45 m at the base, walls 3.75 m; base at ~35 m above sea level | [7] |
| Galata Bridge | 490 m long, 42 m wide, 80 m bascule main span; upper deck for road and tram, lower deck for walkway and restaurants (interrupted at the bascule) | [8]. Deck heights are **estimates** (upper deck top 9 m, lower walkway 1.5 m above the water) |
| Golden Horn Metro Bridge | cable-stayed, spans 45-45-180-45-45 m; pylons 65 m (Structurae says 75 m); total 936 m | [9] |
| 15 Temmuz Şehitler (Bosphorus) Bridge | towers 165 m; main span 1074 m; total 1560 m; deck 33.4 m wide; deck 64 m above sea level; Ortaköy to Beylerbeyi | [10] |
| Maiden's Tower | islet ~200 m off Salacak; tower ~23 m; 5 floors | distance verified [11]. Height is an **estimate** |
| Beyazıt Tower | 85 m fire-watch tower | [12] |
| Valens Aqueduct | 971 m originally (921 m survives), ~29 m high, 7.75–8.24 m wide | [13] |
| Topkapı | grounds 40–70 ha, four courts; Tower of Justice ~41 m | area from [14]. The tower height is an **estimate** |
| Bosphorus | 2.8 km at the southern entrance, 0.7 km at its narrowest | [15] |
| Golden Horn | 350–900 m wide | [15] (low-authority source) |
| Elevations | Taksim ~120 m (one source); Galata Tower base 35 m; Sultanahmet ~30–40 m | **estimates**. No authoritative figure was found for Sultanahmet |

Sources: [1] hagiasophia.com/architecture · [2] en.wikipedia.org/wiki/Hagia_Sophia · [3] en.wikipedia.org/wiki/Blue_Mosque,_Istanbul · [4] wikipedia.com/wiki/Suleymaniye, britannica.com/print/article/572389 · [5] kulturenvanteri.com/en/yer/yeni-cami, mcid.mcah.columbia.edu/node/4128 · [6] istanbul.com/blog/ortakoy-mosque · [7] en.wikipedia.org/wiki/Galata_Tower · [8] en.wikipedia.org/wiki/Galata_Bridge · [9] en.wikipedia.org/wiki/Golden_Horn_Metro_Bridge, hardestyhanover.com/projects/halic-metro-golden-horn-swing-bridge · [10] en.wikipedia.org/wiki/Bosphorus_Bridge, ice.org.uk (bosphorus-bridges) · [11] uskudar.bel.tr/en/main/pages/maidens-tower/307 · [12] en.wikipedia.org/wiki/Beyazıt_Tower · [13] en.wikipedia.org/wiki/Aqueduct_of_Valens · [14] archnet.org/sites/10498 · [15] en.wikipedia.org/wiki/Bosporus. Wikipedia pages were read through search results, because the sandbox cannot resolve wikipedia.org.

**Vertical rule.** Buildings and structures keep their real heights. Hills are scaled by about 0.45 because the horizontal distances are compressed by 0.2–0.45. At real hill heights the slopes would reach 25–30°. With the scaling, the maximum land slope is about 0.3 (17°), and the generator asserts this.

---

## 2. Compressed layout

### 2.1 Extents

- Hard bounds: `x ∈ [-780, 1000]`, `z ∈ [-980, 880]`. The soft boundary margin stays at 110.
- Collision grid: `[-1000, 1200] x [-1100, 1060]` (`MapDefinition.collisionExtent`).
- European land is about 1.2 x 1.65 km and the Asian strip is about 0.3 km wide. Water fills the rest.

### 2.2 Compression check

| Pair | Real | Map | Factor |
|---|---|---|---|
| Hagia Sophia ↔ Blue Mosque | ~0.46 km | 200 m | 0.44 |
| Galata Bridge length / Golden Horn width there | 490 m | 190 m | 0.39 |
| Hagia Sophia ↔ Süleymaniye | ~1.6 km | 380 m | 0.24 |
| Hagia Sophia ↔ Galata Tower | ~1.95 km | 575 m | 0.29 |
| Galata Tower ↔ Taksim | ~1.5 km | 340 m | 0.23 |
| Sarayburnu ↔ Salacak (Bosphorus) | ~1.9 km | 320 m | 0.17 |
| Bosphorus Bridge main span | 1074 m | 430 m | 0.40 |
| Maiden's Tower offshore distance | 200 m | 45 m | 0.22 |
| Taksim ↔ Levent | ~6 km | 300 m | 0.05 (the corner cluster) |

### 2.3 ASCII map

Each column is 25 m and each row is 50 m. Legend: `~` water, `.` land below 12 m, `:` land at 12–28 m, `^` land above 28 m, `T` Levent towers, `*` park, `#` Valens Aqueduct, `|` Golden Horn bridges (from west: Atatürk at x=-500, Haliç Metro at x=-275, Galata at x=0), `=` 15 Temmuz Bridge.

Landmarks: A Hagia Sophia, B Blue Mosque, H Hippodrome, K Topkapı, G Gülhane, Y Yeni Cami/Eminönü, S Süleymaniye, Z Beyazıt Tower, V aqueduct, R Galata Tower, C cruise quay (Galataport), I İstiklal, X Taksim, P Gezi Park, D Dolmabahçe, O Ortaköy Mosque, U Üsküdar (Mihrimah), M Maiden's Tower.

```
        x=-780                        x=0                              x=1000
  -980 .........................:::^^^^^^^^^^^^^^^::....~~~~~~~~~~~~~~~~~......
  -930 ........................::^^TTTTTTTTTTTTTT^^::...~~~~~~~~~~~~~~~~~......
  -880 ........................::^^TTTTTTTTTTTTTT^^::...~~~~~~~~~~~~~~~~~......
  -830 .........................:::TTTTTTTTTTTTTT^::....~~~~~~~~~~~~~~~~~......
  -780 ............................::::^^^^^^::::.============================:
  -730 ..........:::::::...........:::^^^^^^^^^^:::.....~~~~~~~~~~~~~~~~~::::^^
  -680 .......::::^^^^^::::.......::^^^^^^*P**^^^^^^^::O~~~~~~~~~~~~~~~~::^^^^^
  -630 .....:::^^^^^^^^^^:::.....::^^^^^^^X^^^^^^^^^::~~~~~~~~~~~~~~~~~~:^^^^^^
  -580 .....::^^^^^^^^^^^^:::.....::^^^^^^^^^^^^^^::.~~~~~~~~~~~~~~~~~~:^^^^^^^
  -530 ....:::^^^^^^^^^^^^^::......::^^^^^^^^^^^^::..~~~~~~~~~~~~~~~~~~:^^^^^^^
  -480 ....:::^^^^^^^^^^^^^::........::::I::::::...D~~~~~~~~~~~~~~~~~~.:^^^^^^^
  -430 .....:::^^^^^^^^^^^::.......:::^^^^^^::......~~~~~~~~~~~~~~~~~~.::^^^^^^
  -380 ......::::^^^^^^::::.......::^^^^^^^^^::....~~~~~~~~~~~~~~~~~~...::^^^^^
  -330 .........:::::::::.........::^^^^^^^^^::....~~~~~~~~~~~~~~~~~.....:::^^^
  -280 ............................:::^R^^^^::.....~~~~~~~~~~~~~~~~~.......::::
  -230 ~~~...........................::::::::.....~C~~~~~~~~~~~~~~~............
  -180 ~~~~~~~~~~~|~~.............................~~~~~~~~~~~~~~~~~............
  -130 ~~~~~~~~~~~|~~~~~~~~|~~~~~............~~~~~~~~~~~~~~~~~~~~~.............
   -80 ...~~~~~~~~|~~~~~~~~|~~~~~~~~~||~~~~~~~~~~~~~~~~~~~~~~~~~~~.::::::::....
   -30 ............~~~~~~~~|~~~~~~~~~||~~~~~~~~~~~~~~~~~~~~~~~~~~.::::::::::...
    20 .....................~~~~~~~~~||~~~~~~~~~~~~~~~~~~~~~~~~~~.U::^^^^:::...
    70 ...............::::::::........|~~~~~~~~~~~~~~~~~~~~~~~~~..:::^^^^:::...
   120 ...:::::::...::::^^^^::::....Y......****G**~~~~~~~~~~~~~~..:::^^^^:::...
   170 .::::^^^:::::::^^^^S^^^:::.......:::********~~~~~~~~~.M~~..::::::::::...
   220 .:######V#######^^^^^^^^::::::.:::::::::::..~~~~~~~~~~~~~...::::::::....
   270 :::^^^^^^^:::::^^^^^^^^Z:::::::::A:::::::::.~~~~~~~~~~~~~.....::::......
   320 :::^^^^^^^::.:::^^^^^^::::::::::::::::::K::.~~~~~~~~~~~~~...............
   370 .:::^^^^::::...:::::::::::::::.::::::::::::~~~~~~~~~~~~~~~..............
   420 ..:::::::::.....................:::::::::..~~~~~~~~~~~~~~~..............
   470 ......:.......................H..B..:......~~~~~~~~~~~~~~~..............
   520 ..........................................~~~~~~~~~~~~~~~~..............
   570 .........................................~~~~~~~~~~~~~~~~~~.............
   620 ........................................~~~~~~~~~~~~~~~~~~~.............
   670 ...........~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~.............
   720 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~.............
   770 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~.............
   820 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~............
```

The script that generated this map from the polygons and hills below is at `asciimap.py` (next to this file). It is the reference implementation of the data; reuse it as a check.

### 2.4 Land polygons

Water is everything outside these land polygons. The vertices go into `maps/istanbul/data.ts`, and the sea level is -1.2.

```ts
// Historic Peninsula: Golden Horn south shore W→E, Sarayburnu, east coast, Marmara shore E→W
PENINSULA = [[-1000,-60],[-760,-70],[-500,-10],[-250,45],[-100,75],[0,95],[120,100],[230,110],[300,150],
  [335,205],[320,300],[300,420],[280,540],[235,640],[100,665],[-100,675],[-300,685],[-500,695],[-760,705],[-1000,705]];
// European north: Golden Horn north shore W→E, Karaköy, Bosphorus west bank to the north
EUROPE_N = [[-1000,-220],[-760,-215],[-500,-165],[-250,-122],[-100,-100],[0,-95],[120,-100],[230,-110],[290,-135],
  [310,-230],[330,-340],[345,-430],[360,-500],[380,-570],[400,-625],[445,-645],[445,-690],[433,-700],[435,-780],
  [450,-880],[460,-1100],[-1000,-1100]];
// Asian shore: Harem, Salacak, Üsküdar, Kuzguncuk, Beylerbeyi
ASIA = [[1300,960],[720,960],[690,600],[660,400],[640,260],[645,150],[660,40],[690,-80],[740,-250],[790,-420],
  [840,-580],[860,-700],[870,-800],[880,-1100],[1300,-1100]];
MAIDEN_ISLET = [[555,195],[595,195],[595,228],[555,228]];
```

Each shore has an 8 m flat quay (H = 0) with a seawall rendered from `H+CURB` down to -4. Piers are boxes, as in Manhattan.

### 2.5 Hills

The heightfield is baked on a 2 m grid with bilinear sampling:

`H(x,z) = smoothstep(8, 70, dShore) · max_k h_k·(1 − smoothstep(p_k, 1, r_k))`, where `r_k = |((x−cx)/rx, (z−cz)/rz)|`.

| Hill | (cx, cz) | (rx, rz) | h (m) | plateau p |
|---|---|---|---|---|
| First hill (Sultanahmet/Topkapı) | (140, 330) | (230, 240) | 26 | 0.35 |
| Third hill (Süleymaniye/Beyazıt) | (-300, 250) | (260, 260) | 32 | 0.30 |
| Fatih | (-620, 300) | (220, 280) | 30 | 0.30 |
| Divanyolu saddle | (-100, 320) | (200, 150) | 22 | 0.30 |
| Pera/Galata (Tünel ridge) | (60, -330) | (220, 230) | 36 | 0.25 |
| Taksim plateau | (120, -600) | (300, 220) | 46 | 0.40 |
| Kasımpaşa/Okmeydanı | (-450, -500) | (300, 300) | 40 | 0.30 |
| Levent plateau | (100, -880) | (350, 200) | 46 | 0.40 |
| Yıldız | (330, -640) | (120, 90) | 30 | 0.30 |
| Üsküdar | (820, 100) | (200, 300) | 28 | 0.30 |
| Beylerbeyi/Çamlıca foot | (1000, -500) | (250, 350) | 45 | 0.30 |

Valleys (Kasımpaşa, Dolapdere, the Atatürk Bulvarı valley at x=-500) come from the gaps between the hills.

### 2.6 Districts and landmarks

Positions may be adjusted by ±10 m to resolve overlaps. The generator asserts that no landmark footprint overlaps another landmark, a road or water. Each "ground" value is the terrain at the landmark's base. Each landmark sits on a flat plinth at `max(H)` over its footprint.

| Landmark | Map footprint / position | Real-size parts |
|---|---|---|
| Hagia Sophia | x 19..101, z 280..353 | dome Ø31 crowning at base+55.6, E and W semi-domes, buttress blocks; 4 minarets at the corners (2 x 60, 2 x 50) |
| Sultanahmet Park | x 10..130, z 380..418 | fountain, plane trees |
| Blue Mosque | courtyard x 28..92, z 420..484; hall z 484..556 | dome Ø23.5 to 43 m, 4 semi-domes, 6 minarets 64 m |
| Hippodrome | x -50..10, z 400..620 | obelisks: Theodosius ~25 m, Walled 32 m, Serpent Column 5 m |
| Topkapı precinct | x 140..300, z 215..450 (courts compressed ~0.5) | Bab-ı Hümayun at (150, 300); Gate of Salutation with twin conical towers ~20 m; Tower of Justice 41 m at (240, 270); first court full of plane trees |
| Gülhane + Sarayburnu Park | x 130..320, z 115..205, plus the shore strip around the tip | plane trees 22–32 m, cypresses |
| Yeni Cami + Eminönü | hall x -65..-24, z 130..171; courtyard to the west; Spice Bazaar L-block x -30..60, z 175..195 | dome Ø17.5 to 36 m, 2 minarets 52 m |
| Süleymaniye | hall x -329..-271, z 171..229; courtyard z 125..171; külliye x -380..-220, z 110..300 | dome Ø27 to 53 m, minarets 2 x 76 + 2 x 56; medreses with rows of small domes |
| Beyazıt Tower / Grand Bazaar | tower (-200, 300); bazaar x -150..-50, z 230..310 | tower 85 m; bazaar 10 m high with a domed roofscape |
| Valens Aqueduct | x -720..-380 along z = 260 | 8 m wide, 2 arch tiers, level top 29 m above the valley floor at x = -500 (Atatürk Blvd passes under) |
| Galata Bridge | x -21..21, z -95..95 (axis N–S) | upper deck 42 m wide, y 6..9; lower walkways x ±(13..21) at y 1.5 with restaurants; no lower level in the 80 m bascule middle |
| Haliç Metro Bridge | axis x = -275, deck 14 m wide at y 13; pylons at z 52 and -128 (180 m span at real size) | twin-leg pylons 65 m, stays in planes x = -281 and x = -269 |
| Atatürk Bridge | axis x = -500, 25 m wide, deck y 6 | carries cars |
| Galata Tower | centre (40, -255), ground ~22 | r 8.23 to 51.65, balcony ring, drum, cone to 62.6, finial to 66.9 |
| Karaköy / Galataport | piers at (150, -110..-150); cruise quay x 290..315, z -330..-150 | moored cruise ship 250 x 32 m, deck tiers to 45 m |
| İstiklal Avenue | x = 70, z -320..-560 (N–S, 14 m, pedestrian, nostalgic tram) | the real street runs NNE; axis-aligned here (see 2.7) |
| Taksim Square / Gezi | square x 40..170, z -620..-560; Gezi x 100..190, z -680..-620 | Republic Monument 11 m; AKM box 30 m |
| Dolmabahçe | x 320..355, z -540..-420 (facade compressed) | 2 floors ~20 m; clock tower ~27 m at (330, -410) |
| Ortaköy Mosque | jetty x 420..460, z -680..-635; hall at (440, -655) | hall 12.25 m, dome ~25 m, 2 minarets ~32 m |
| 15 Temmuz Bridge | axis z = -740, deck z -756.7..-723.3; towers at x 440 and 870; anchorages at x 300 and 990 | towers 165 m, deck top 64 m, main span **430 m** (real 1074) |
| Levent | x -80..260, z -940..-780 | 12–16 towers 120–240 m (one ~238 m with a 23 m spire), plazas |
| Üsküdar | Mihrimah Mosque (700, 60); Şemsi Paşa (660, 170); pier (650, 30) | dome ~Ø 18 m; 2 minarets ~50 m (estimate) |
| Maiden's Tower | islet x 555..595, z 195..228 | base block 22 x 14 x 9 m; tower 7 x 7 m to 18 m; cap to 23 m; lantern |

Building districts (4–8 floors at 3.1 m per floor; shop ground floor 4.0 m; adjacent buildings differ by ±1–2 floors):

| District | Region | Floors | Character |
|---|---|---|---|
| Sultanahmet/Cankurtaran | peninsula east of x = -60 | 2–5 | Ottoman wooden houses with cumba bays, small hotels |
| Eminönü/Tahtakale | x -250..130, z 100..250 | 4–7 | stone hans, shops |
| Süleymaniye/Fatih/Kumkapı | x < -150 | 3–6 | wooden and plastered houses, neighbourhood mosques |
| Karaköy/Galata | x -100..300, z -350..-90 | 6–8 | 19th-century stone, banks |
| Beyoğlu/Cihangir/Tarlabaşı | z -560..-300 | 5–8 | apartments with bay windows |
| Kasımpaşa/Okmeydanı | x < -150, north | 4–7 | dense apartments |
| Taksim/Beşiktaş/Ortaköy | z -760..-560 | 6–10 | apartments, hotels |
| Levent | corner | towers 120–240 m | the "downtown" for long swings |
| Üsküdar | Asian shore | 3–7 | mosques, timber houses on the shore |

Roofs are 55 % low hip tile roofs (22°) and 45 % flat terraces with water tanks and solar water heaters. Palette (hex): walls cream EFE3C8, ochre D9A65B, dusty rose D49A8A, terracotta B8613E, mint A9C7B0, warm grey C9C6BE, sand E2C99A, mustard E8CF7A, chalk F2EFE6, pastel blue 9EB9C9; tiles B24A2E / A8432A / C0603A; lead domes 8D9499; mosque stone E7E0D0; timber 7A5236.

### 2.7 Road network

**Constraint.** Building colliders must stay axis-aligned boxes. The player's wall crawl, ledges, vaults and mantles read box extents directly (`player.ts:563, 588, 1163, 1289, 1368`), so rotated buildings would mean rewriting the wall-movement code. **Decision:** every street that has buildings along it is axis-aligned. "Organic" comes from irregular partition, not from angles.

1. **Hand-laid skeleton** (`maps/istanbul/data.ts`), as polylines with a width and class:
   - Coastal roads may curve. They follow the shore polygons offset 22 m inland: Kennedy Cd around the peninsula, Abdülezel Paşa Cd along the Golden Horn's south shore, Tersane Cd along the north shore, Kemeraltı–Meclis-i Mebusan–Dolmabahçe–Çırağan to Ortaköy, and the Üsküdar shore road.
   - Inland arterials are axis-aligned with jogs:
     - Divanyolu/Ordu Cd (tram T1) at z = 370 from x 125 to -760, joined to Eminönü by Alemdar Cd at x = 118 and the shore road.
     - Atatürk Blvd at x = -500.
     - Galata Bridge at x = 0, linking to Yüksek Kaldırım at x = 40 (steep) and Tarlabaşı Blvd at x = -40.
     - İstiklal at x = 70 (pedestrian and tram).
     - Sıraselviler at x = 180.
     - Cumhuriyet Cd–Büyükdere at x = 90, from Taksim to Levent.
     - Barbaros: (380, -600) → (200, -600) → (200, -780).
     - Bridge approaches as elevated viaduct boxes.
2. **Seeded BSP local streets** (`maps/istanbul/streets.ts`). The skeleton cuts the land into superblock polygons. Each polygon's AABB is split recursively with axis-aligned cuts:
   - A cut lands at 35–65 % of the side, ±6 m.
   - Cuts stop at 30–90 m for historic blocks and 80–120 m in Levent.
   - Each cut becomes a street (11–14 m) or a lane (6–8 m, no cars).
   - Cuts in sibling cells land at different offsets. This gives T-junctions and staggered crossings.
   - 15 % of lanes stop short of the far edge (dead ends).
   - Leaf rectangles clipped by a curved boundary shrink to the largest inscribed rectangle. The leftover slivers become paved plazas with a plane tree or a fountain.
3. **Graph.** Skeleton and BSP segments are merged into `RoadNet` (nodes at intersections and ends, edges with a polyline, width, class and flags). Traffic runs only on edges of class street and above.

Parks and squares: Gülhane+Sarayburnu, Topkapı's first court, Sultanahmet Park, the Hippodrome, Eminönü square, Beyazıt square, Taksim+Gezi, Yıldız Park (x 230..390, z -700..-600, wooded), Üsküdar square and the shore promenades. Each is stored as a polygon with paths.

### 2.8 Bridges

- **15 Temmuz Bridge** has a **scaled span**: main span 430 m, side spans 140 m and 120 m. Its towers (165 m), deck height (64 m) and deck section (33.4 m) stay real. The axis runs along **X** at z = -740, so all its boxes are axis-aligned. The strait there is compressed to 430 m like every other water width.
  - I rejected placing a real 1074 m span at the north edge. It would need a 1 km wide strait next to a 320 m wide one at Üsküdar, and the Asian tower would end up about 600 m outside the playable area.
  - The main cable runs from 165 m at the towers down to 70 m at mid-span. This keeps the real look of the cable almost touching the deck in the middle.
  - Suspenders hang every 18 m. They are vertical, unlike the real inclined hangers, so that the visual matches the collider.
- **Haliç Metro Bridge** is real size (180 m main span), because the compressed Golden Horn is 172 m wide there. Its axis runs along **Z**.
- **Galata Bridge** and **Atatürk Bridge**: the length is compressed and the cross-section is real. Their axes run along Z.

---

## 3. Swing viability

The rules (`targeting.ts:214`, `tuning.ts:61`): a swing anchor is a point on an `F_ANCHOR` collider facing the player, at least 4 m above the feet, at least 12° above the hand, within 120 m, and with `ny < 0.7` (so not a roof top). Rope length is 12–70 m. Bots and test (c) search only within `assist.range` = 72 m.

| Area | Anchors per 100 x 100 m (estimate) | Risk | Fix |
|---|---|---|---|
| Low-rise street (4–8 floors, 12–26 m) | 40+ facade faces | street level is fine; swing arcs are short (rope ≤ 14 m) | trees on avenues; 30–40 m minarets about every 150 m |
| Rooftop of an 8-floor building | about 0–3 things above +4 m | **main risk for test c's `inRange > 400`** | neighbourhood mosques (1 minaret 30–40 m per ~3 superblocks); 10–12 floor hans/hotels at block corners on arterials (≤ 1 in 8 lots); uphill neighbours help |
| Parks (Gülhane, Gezi, Yıldız) | 15–30 trees | fine | plane trees 22–32 m spaced 9–16 m; cypress trunks |
| Open squares (Hippodrome, Taksim) | edge facades, obelisks | fine | obelisks and the monument are anchorable; trees around the edges |
| Golden Horn, 170–190 m of water | Haliç Metro: pylons + stays; Galata: lamp posts 7.2 m, catenary poles 8.5 m | **the city route must cross on the Haliç Metro Bridge** | stays modelled as anchorable cable chains (§4g); moored boats with 14 m masts at Eminönü and Karaköy |
| Bosphorus, 320–430 m | 15 Temmuz suspenders, deck sides, tower legs; cruise ship; Maiden's Tower | no test crosses it | the deck underside and sides are box faces, which allows swinging under the deck |
| Levent | towers | fine | Manhattan-like |

Hip-roof step boxes and terrace props carry `F_BUILDING|F_CAMERA` but **not** `F_ANCHOR`, so ledges on roofs never become anchors.

Expected test (c) on Istanbul: street ≈ 98 %, park ≈ 95 % and roof ≈ 75–85 % of positions in range, so `inRange ≈ 430/500`. The rate found/inRange stays ≥ 95 %, because the planner already handles CYL and ELL colliders. If roofs fall short, add minarets before raising building heights.

### What the drivers assume today, and how to generalise it

- `randomSpot` (`testDrivers.ts:131`) samples `L.land` (a rectangle) and `L.park`. Change it to `map.testSpots.street(rng)` (rejection sampling inside the land polygons and the core bounds; no water or building; y = `terrain.height + 0.5`) and `map.testSpots.park(rng)` (area-weighted over `layout.parks`).
- `cityRoute`/`parkRoute` (`:580`, `:594`) read the avenues, streets, park and pond. Change them to `map.routes.city(layout)` and `map.routes.park(layout)`, with expectations `{ minDistance, treeOnlyPark }`.
  - Istanbul city route: Blue Mosque (60, 470) → Süleymaniye (-300, 120) → Haliç Metro Bridge (-275, 52 → -128) → Şişhane (-150, -250) → Galata Tower (40, -300) → İstiklal (70, -560) → Taksim → Levent (100, -900). The route is about 1.75 km; assert `reached`, `groundFraction < 0.1` and `distance > 0.95 x routeLength`.
  - Istanbul park route: Gülhane (140, 160) → (305, 160) → Sarayburnu Park (318, 235), tree only.
- `lifeTest` (`:1440`) checks "on road" against the avenue and street strips and "pedestrian on road" with `y < 0.1`. Change both to use `terrain.isRoad` and `y < terrain.height + 0.1`.
- `Autopilot` (`autopilot.ts:698–830`):
  - Grid routing uses `L.avenues/streets`. Use `map.autopilot.route(a, b)` instead; Istanbul uses A* on `RoadNet` and inserts a bridge crossing whenever a leg crosses water.
  - `avoidPond` becomes `map.autopilot.avoid` (ellipses/polygons).
  - Waypoints come from `layout.parks` and `layout.promenade`.
  - The absolute altitudes `p.y < 30`, `< 4` and `< 14` (`:215, :234, :512`) become `alt = p.y − terrain.baseHeight(p.x, p.z)`.
- `targeting.ts:219,334` use `h.y <= 1.6`. Change to `h.y − terrain.baseHeight(h.x,h.z) <= 1.6`. Manhattan's `baseHeight` is the constant 0, so its results stay identical.

---

## 4. Engine changes, in order

### (a) Map registry and map id plumbing

Files: new `src/maps/ids.ts` (no imports, so the M12 server can import it safely), `src/maps/types.ts`, `src/maps/registry.ts` (simulation only), `src/maps/renderRegistry.ts`. Changes to `main.ts`, `app.ts`, `game.ts`, `ui/settings.ts`, `ui/ui.ts`, `i18n/tr.ts`, `debug/testApi.ts`.

```ts
// maps/ids.ts
export const MAP_IDS = ['manhattan', 'istanbul'] as const;
export type MapId = (typeof MAP_IDS)[number];
export const DEFAULT_MAP: MapId = 'manhattan';
export const isMapId = (v: unknown): v is MapId => typeof v === 'string' && (MAP_IDS as readonly string[]).includes(v);

// maps/types.ts (simulation side: no three.js rendering imports)
export interface MapDefinition {
  id: MapId;
  defaultSeed: number;
  bounds: Rect; collisionExtent: Rect;
  generate(seed: number): CityLayout;                       // pure data
  createTerrain(layout: CityLayout): TerrainModel;
  addColliders(w: CollisionWorld, layout: CityLayout): void; // landmarks, bridges, lighthouse…
  testSpots: { street(rng: Rng, L: CityLayout, t: TerrainModel): [number, number]; park(rng: Rng, L: CityLayout): [number, number] };
  routes: { city(L: CityLayout): Route; park(L: CityLayout): Route; expect: { minDistance: number; treeOnlyPark: boolean } };
  autopilot: { waypoints(L: CityLayout, t: TerrainModel): Waypoint[]; avoid: AvoidZone[]; route(L: CityLayout, a: XZ, b: XZ, out: XZ[]): number };
  ringRoutes(L: CityLayout): Array<{ id: string; pts: Array<[number, number, number]> }>;
}
// maps/renderRegistry.ts (render side)
export interface MapVisuals {
  buildExtras(L: CityLayout, cb: ChunkGetter): void;          // landmark and bridge geometry
  water: { kind: 'rects' } | { kind: 'sdf'; deep: number; shallow: number };
  paintMinimap(g: CanvasRenderingContext2D, L: CityLayout, px: number): void;
  backdrop(L: CityLayout): GeomBuilder;
  life?: (game: Game) => LifeExtras;                          // ferries, gulls, trams, fishermen
}
```

- **Map selection precedence:** the URL parameter `?harita=` (when valid) wins, then `settings.map`, then `DEFAULT_MAP`. An invalid value is ignored silently, so the console stays clean.
- **Settings:** `map: MapId` is added and validated with `isMapId`. The key stays `skythread.settings.v1`, since the field is additive with a default.
- **Menu:** the main menu gets a "Harita" button. It opens a card screen like the costume picker, with radio cards for Manhattan and İstanbul.
- **Switching:** picking a different map saves the settings and then calls `location.replace(url)`, where `url` is the current URL with `harita=<id>` (other parameters such as `seed` are kept). The loading screen shows `tr.maps.loading`.
- **Plumbing:** `App.boot(seed, mapId)` passes `GameOptions.mapId`; `Game.map` and `layout.mapId` are added.
- **Best times:** the best-times record keeps its key, and Istanbul route ids carry an `ist-` prefix, so stored Manhattan times are unaffected. `RouteInfo.id` widens to `string`.
- **Test API:** add `__game.mapId`; specs open `/?harita=istanbul`.
- **M12 hook:** rooms carry `mapId`. Public rooms are keyed `public:<mapId>:<n>`, and the server builds the world from `MAPS[mapId].generate(seed)`. Joining a room on another map goes through the same reload path with `?harita=&oda=`.
- **Risk: low.**

### (b) Manhattan on the abstraction, with zero behaviour change

- Move `world/cityGen.ts` to `maps/manhattan/gen.ts`. Keep a re-export at the old path during the move, then delete it.
- `LIGHTHOUSE` and the bridge collider code from `cityCollision.ts` move into `maps/manhattan/colliders.ts` via `addColliders`. `buildCollisionWorld(layout, map)` keeps the generic loops for buildings, trees and props in the same order. **Collider insertion order must not change**, because the grid order affects the raycast tie-break.
- The current code moves into the `MapDefinition` hooks:
  - routes come from today's `cityRoute`/`parkRoute`
  - test spots come from `randomSpot`
  - waypoints and pond avoidance come from the `Autopilot`
  - ring routes come from `RingRaces.buildRoutes`
  - the minimap painter is today's `paintBase`
  - the water material keeps the `rects` path
- `CityLayout` gains `mapId` plus the generic fields listed in (c)–(e). Manhattan fills them by deriving from its own data: `parks = [{ rect: park, ponds: [pond], paths }]`, `land = [rect(land), rect(islet)]`, `roads` from avenues × streets, `bridges = [bridge]`, `promenade` from the land rectangle inset by 45 m. The Manhattan-only fields move under `layout.grid?: { avenues, streets, land, islet, park, pond }`, which only Manhattan code reads.
- **Gate: a golden digest**, captured *before* the refactor in chunk C0. It is a hash of:
  - the layout JSON
  - the collider arrays (`kind, flags, surface, owner, p`)
  - the outputs of `fuzz(1, 30)`, `anchorAvailability(2024, 200)`, `cityBot(120)` and `parkBot(90)`
  - 2 minutes of `attractTest`

  The hash must match exactly after the change, and specs a–j must pass.
- **Risk: medium** (breadth of the change). The digest catches any drift.

### (c) Heightfield terrain

Files: `physics/terrain.ts` (interface plus `FlatGridTerrain`, which is the current class verbatim), new `physics/heightfield.ts`, `physics/waterMask.ts`, `physics/roadIndex.ts`. Changes to `physics/collision.ts` (the raycast's terrain block moves into `terrain.rayIntersect`, op for op for the flat case), `player/player.ts` (water respawn), `player/targeting.ts`, `player/autopilot.ts`, `world/render/groundGeo.ts` plus a new `world/render/terrainGeo.ts`, and `world/render/buildingsGeo.ts`.

```ts
export interface TerrainModel {
  readonly flat: boolean; readonly minY: number; readonly maxY: number;
  baseHeight(x: number, z: number): number;    // road level (0 on Manhattan)
  height(x: number, z: number): number;        // walkable ground: base + CURB off-road; bed −12 over water
  isWater(x: number, z: number): boolean;
  waterLevelAt(x: number, z: number): number;
  isRoad(x: number, z: number): boolean;
  surfaceAt(x: number, z: number): number;
  inPark(x: number, z: number): boolean;
  /** Writes t and whether the hit is water; false when nothing is hit before maxT. */
  rayIntersect(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, inflate: number, out: TerrainHit): boolean;
  nearestLand(x: number, z: number, out: { x: number; z: number }): void; // water respawn target
}
```

- **`HeightfieldTerrain`:**
  - `Float32Array` of base heights on a 2 m grid over the collision extent (1100 x 1080 cells, 4.8 MB), plus a 16 m max mip.
  - Rays: clip to the slab `[minY, maxY + CURB]`, walk the 16 m mip cells with DDA, and skip a cell when the ray's lowest y in that cell is above the cell maximum. Inside a candidate cell, march in 1 m steps and bisect 8 times on a sign change.
  - Water is hit when the ray reaches the water level at an `isWater` point first. The `dy < 0` shortcut no longer holds, because rising rays can hit uphill ground.
  - Normals use central differences.
- **`WaterMask`:** land polygons with 16 m bucket cells. Each cell is classified as land, water, or mixed with a list of edges; mixed cells use an exact crossing test. `nearestLand` uses the bucket edges.
- **`RoadIndex`:** road-edge segments bucketed in 16 m cells; a point is on a road when `dist(point, segment) ≤ width / 2`. Bridge decks are excluded, because they are colliders.
- **Buildings on slopes:**
  - Sample H at the corners, edge midpoints and centre to get `lo` and `hi`.
  - `baseY = hi + CURB`. A stone plinth volume (role 0, `noWindows` style flag) runs from `lo − 1` to `baseY`.
  - If `hi − lo > 6`, split the lot.
  - `buildingsGeo.ts:145 isGround` changes to `v.minY <= bld.volumes[0].minY + 0.01` for the storefront band.
  - Trees, props and lamp pools take `y` from the terrain; `cityRender.ts:235` currently uses `CURB`.
- **Ground mesh** for the heightfield:
  - a 4 m grid coloured by class (grass, dirt, paving)
  - roads as draped ribbons sampled every 4 m (decal builder, `polygonOffset` as today)
  - blocks as draped slabs at `H + CURB` with curb strips
  - shore seawalls along the polygon edges
- **Player:**
  - `respawnFromWater` uses `terrain.nearestLand`, then `findSafeSpot(tx, terrain.height(tx, tz) + 0.5, tz)`.
  - Snapping (`ground.snapDown`) already handles slopes up to about 20°.
  - Feet IK already samples per foot.
- **Risk: high.** The raycast is the hottest path, and the extra terrain march can break the sim budget (≤ 1 ms per tick). Measure `msPerTick` in fuzz on Istanbul. If it is too slow, cache the ray's mip result per tick for LOS bundles. Slopes may also expose gait or camera issues; fuzz b runs on Istanbul.

### (d) General water mask

- Water lives in `layout.water = { level: -1.2, land: Polygon[], ponds: Pond[] }`. `terrain.isWater` reads it (via `WaterMask`), and so do respawn, the minimap and the shader.
- **Shader:** `waterMaterial` gets a `SHORE_SDF` define with uniforms `uShoreSdf: sampler2D` and `uShoreExtent: vec4`. The SDF is a 1024² signed distance texture (about 2.2 m per texel), built at load time with a Felzenszwalb EDT on the rasterised land mask (about 30 ms). Foam is `1 − smoothstep(0, 2.6 + wobble, sdf)`. Manhattan keeps the rectangle uniforms unchanged.
- **Water colours** are per map: the Bosphorus is deeper teal (deep 0x1d5a78, shallow 0x3a9aa8).
- **Risk: low.**

### (e) Lane graph and sidewalk loops from any road graph

```ts
interface RoadNode { x: number; z: number; edges: number[] }
interface RoadEdge { a: number; b: number; pts: Array<[number, number]>; width: number; cls: 0 | 1 | 2 | 3; oneWay: boolean; cars: boolean; tram?: boolean; deckY?: number }
interface RoadNet { nodes: RoadNode[]; edges: RoadEdge[] }
```

- **`life/traffic.ts`:**
  - Links become polylines with cumulative lengths, offset to the right by the lane offset. Cars move by arc length.
  - Turns are classified by heading change: straight within ±30°, then right, then left, then a U-turn at dead ends. The quadratic Bézier turns stay.
  - Signals are placed at nodes with degree ≥ 3 where two edges have class ≥ 1. The phase group is NS or EW by the entry heading's dominant axis.
  - Car `y` comes from `terrain.baseHeight` or `deckY`, and pitch from the slope.
  - Manhattan builds its `RoadNet` from the grid with the same node and link counts. Traffic is visual, so its RNG stream may change; spec h stays green.
- **`life/pedestrians.ts`:** loops from `layout.blocks` (rects, as today), park paths, promenade polylines and bridge walkways. `y` already comes from `groundY`.
- **Risk: medium.** Polyline cars on the curved coastal roads at the curves.

### (f) Ring routes and minimap per map

- `RingRaces.buildRoutes` uses `map.ringRoutes(layout)`; the clear-disc placement logic is unchanged. Istanbul has three routes:
  - `ist-minare`: 7 rings slaloming the Hagia Sophia and Blue Mosque minarets at 30–45 m
  - `ist-halic`: Galata Tower → Karaköy → over the Galata Bridge → Yeni Cami courtyard (6 rings)
  - `ist-bogaz`: Dolmabahçe → Beşiktaş → Ortaköy → under the 15 Temmuz deck between the towers (7 rings)
- **Minimap:** `Minimap.setLayout` calls `visuals.paintMinimap`. Istanbul uses a generic painter: water background, land polygons, parks, road edges stroked at their width, buildings by height, landmark glyphs (hall rectangle, dome circle, minaret dots), bridge decks and piers. The minimap extent comes from `layout.bounds`.
- `app.ts:395` (park ambience) uses the nearest park in `layout.parks`.
- **Risk: low.**

### (g) Collision for landmarks (existing kinds only)

New `maps/common/prims.ts`. Each landmark builds a spec once; collision and visuals are both derived from that spec, so they agree within 0.3 m.

```ts
interface MinaretSpec { x: number; z: number; baseY: number; height: number; shaftR: number; serefe: number[]; capH: number }
interface DomeSpec { x: number; z: number; springY: number; r: number; rise: number; drumH: number; semi?: 'N'|'S'|'E'|'W' }
function addDome(w: CollisionWorld, d: DomeSpec, owner: number): void;          // ellipsoid (r, rise, r); lower half buried in drum/hall
function addMinaret(w: CollisionWorld, m: MinaretSpec, owner: number): void;    // pedestal box, shaft cyl, şerefe ring cyl (r+1.0, 1.2 m), cap cone
function addCone(w: CollisionWorld, x: number, z: number, y0: number, y1: number, r0: number, r1: number, steps: number, f: number, s: number, o: number): void; // stacked cyls, step ≤ 1.5 m
function addRoundTower(w: CollisionWorld, t: RoundTowerSpec, owner: number): void; // Galata: shaft, balcony ring, drum, cone, finial
function addCableChain(w: CollisionWorld, pts: Array<[number, number, number]>, r: number, f: number, s: number): void;
function addSuspensionBridge(w: CollisionWorld, b: SuspensionBridgeSpec): void;   // X-aligned
function addCableStayedBridge(w: CollisionWorld, b: CableStayedSpec): void;       // Z-aligned
```

- **Domes** are ellipsoids (`rx = rz = r`, `ry = rise`). Their lower half sits inside a drum cylinder (`r + 0.4`) and the hall box.
- **Semi-domes** are full ellipsoids centred on the springing point. The inward half is buried inside a "pendentive block" box that sits between the hall top and the main drum.
- **Flags:**
  - minarets, domes and towers: `F_BUILDING|F_ANCHOR|F_CAMERA`, without `F_CLIMB`, because climbing needs boxes
  - landmark hall boxes: `F_CLIMB` as well
  - şerefe rings: standable
- **`addCableChain`** handles each segment as follows:
  - If the segment's horizontal direction lies along X or Z (within 1e-3), it becomes thin AABBs with half-thickness `r ≥ 0.25` (the tunnelling floor). The step is chosen so each box's y-span is ≤ 0.5 m, with Δ between 0.5 and 6 m.
  - Otherwise it becomes vertical cylinders, each covering ≤ 1.0 m of rise. This is good for steep segments only, so keep cables in axis planes.
  - Flags: `F_BRIDGE|F_ANCHOR`, without `F_CAMERA`.
- **15 Temmuz Bridge:** a deck box with side rails; tower legs as boxes (5 x 7 m) at z = ±19, with portal beams at 100 m and 160 m; main cables at z = ±14; suspender cylinders every 18 m. Expect about 2,500 colliders.
- **Galata Bridge:** an upper deck box, lower walkway boxes and restaurant boxes, lamp cylinders (`F_ANCHOR`) and catenary poles.
- **Hip roofs:** stepped boxes, each 0.6 m tall and inset by 1.5 m (≤ 0.3 m error), flagged `F_BUILDING|F_CAMERA`.
- **Ships:** moored ships are boxes plus mast cylinders. Moving ferries are visual only, because the collision world is static.
- **Risk: medium.** Collider count (estimate about 45k, which grows the capacity), LOS blocked by cable chains, and camera jitter around minarets. Fuzz and tunnel tests run on Istanbul.

### (h) Rendering

New files under `world/render/`:

- **`mosqueGeo.ts`:** hall with arcade and arched-window bands (new window atlas entry 8); corner weight turrets; drum with windows; lead-grey dome (24 x 10 segments) with an alem finial; semi-domes and exedrae; cascading porch domes along courtyard arcades; minarets as 16-gon shafts with şerefe rings (railing plus a muqarnas cone underneath) and pencil caps.
- **`roofGeo.ts`:** hip tile roofs (4 faces, 0.3 m eave, ridge line) and terraces with solar heaters.
- **`ottomanHouse`:** a style variant in `buildingsGeo.ts`. Cumba bay boxes on upper floors (which are also colliders), clapboard colours and wide eaves.
- **`towerGeo.ts`:** Galata Tower and Maiden's Tower.
- **`bridgeGeo.ts`:** suspension bridge (portal towers, tube cables, LED strip glow driven by `uNight` with a slow colour cycle, navigation lights); Galata Bridge (two levels, restaurant awnings, lamps, catenary); Haliç Metro Bridge.
- **`ship.ts`:** cruise ship and moored vapur.
- **Trees:** new species `TREE_PLANE` (çınar, broad layered canopy 20–32 m), `TREE_CYPRESS` (columnar, `rx = 0.09h`) and `TREE_STONEPINE` (umbrella), in `treeRender.ts`. `makeTree` gets the matching collision proportions.
- **Life** (`life/`, all visual and instanced):
  - `ferries.ts`: vapur on water polylines (Eminönü–Üsküdar, Karaköy–south edge, Beşiktaş–Üsküdar), docking for 20 s
  - `gulls.ts`: 60–120 V-wings with a shader flap, circling over piers and following ferries
  - `trams.ts`: T1 along Divanyolu and the Galata Bridge; the red nostalgic tram on İstiklal
  - `fishermen.ts`: static figures with rods along both Galata Bridge rails
- **Backdrop:** Istanbul hills with minaret silhouettes and the Çamlıca hill on the Asian side.
- **Budgets:** draw calls ≤ 600, triangles ≤ 2 M; landmarks are merged into the existing 240 m chunks.
- **Risk: medium.** Recognisability and triangle count of the domes. Rely on the screenshot review.

---

## 5. Implementation checklist

Every chunk ends with `npm run typecheck && npm run build`, then the listed specs, then the full suite before the commit.

| # | Chunk | Done when |
|---|---|---|
| C0 | Add `__game.goldenDigest()` (layout, collider and driver-output hash). Commit `tests/golden/manhattan.json` from **unchanged** code. Add `tests/golden.spec.ts`. | the golden spec passes on the current code |
| C1 | (a) Map ids, settings field, URL `?harita=`, `App.boot(seed, mapId)`, "Harita" menu screen (İstanbul card disabled), reload switching, i18n strings. | g/ui specs pass; new `map-switch.spec.ts` (see below) passes for the precedence rules; golden passes |
| C2 | (b) Manhattan behind `MapDefinition`: generator, colliders, routes, spots, waypoints, rings, minimap, water `rects`. | golden is identical; a–j pass |
| C3 | (c, part 1) `TerrainModel` interface, `FlatGridTerrain.rayIntersect` (code moved), `nearestLand`, relative altitude checks in targeting and autopilot via `baseHeight`. | golden is identical; a–j pass |
| C4 | (c, part 2) `HeightfieldTerrain`, `WaterMask`, `RoadIndex` plus the in-page `terrainSelfTest()`: 20k random rays checked against brute-force 0.05 m marching (hit t within 0.1 m); `isWater` checked against plain point-in-polygon on 100k points; slope ≤ 0.3. | `terrain.spec.ts` passes |
| C5 | Istanbul greybox: `maps/istanbul/{data,gen,streets}.ts`, terrain, skeleton and BSP roads, blocks, plain box buildings on plinths, trees and lamps, terrain ground mesh, picker enabled. | `smoke` on `?harita=istanbul`; `fuzz` (b) on Istanbul (4 seeds x 2 min: never below ground, never inside geometry); generation < 2 s |
| C6 | (g) Landmark specs and colliders with greybox visuals (domes, minarets, towers, three Golden Horn bridges, 15 Temmuz, aqueduct, moored ships). | b and b2 tunnelling on Istanbul, including 95 m/s impacts into minarets and cable chains; collider count logged; `msPerTick` ≤ 1 ms |
| C7 | Generalise the drivers and autopilot (§3). Add `anchors-istanbul.spec.ts` (c: 500 spots, `inRange > 400`, `rate ≥ 0.95`) and `traversal-istanbul.spec.ts` (d: city route via Haliç Metro, park route via Gülhane, tree only). Tune anchors (mosques, hans, trees). | both pass; Manhattan c and d unchanged |
| C8 | (e) `RoadNet` traffic and pedestrians on both maps; generalised `lifeTest`. | h-life on both maps: cars on roads and on slopes, nothing NaN, pedestrians off the carriageway |
| C9 | (d, f) SDF water and foam, generic minimap painter, Istanbul ring routes and best-time ids. | h-rings on Istanbul (routes clear and reachable); ui spec checks minimap pixels are water-coloured at Bosphorus coordinates |
| C10 | (h) Istanbul buildings: palette, hip roofs with step colliders, terraces, cumba bays, plinths; the plane, cypress and stone pine species. | c and d Istanbul still pass; triangle and draw-call budget logged |
| C11 | (h) Full landmark geometry and night lighting. `istanbul-landmarks.spec.ts`: fixed camera poses for 12 landmarks (Hagia Sophia, Blue Mosque, Süleymaniye, Topkapı, Yeni Cami, Galata Tower, Galata Bridge, Haliç Metro, 15 Temmuz, Ortaköy, Maiden's Tower, Levent) at noon and at night. PNGs go to `test-results/istanbul/`. | each shot has pixel variance above a threshold, with draw calls ≤ 600 and triangles ≤ 2 M; screenshots reviewed by a person |
| C12 | Ferries, gulls, trams, fishermen. Run soak (e) on Istanbul for 10 minutes. | clean console, no heap or GPU-resource trend |
| C13 | Attract mode on Istanbul (`attract.spec` j1 with `?harita=istanbul`, 3 minutes); update README, ARCHITECTURE and DECISIONS (axis-aligned streets, scaled bridge span, hill scaling). | full suite passes on both maps |

**`map-switch.spec.ts`:**
- Default boot is Manhattan.
- Picking İstanbul in the menu reloads the page; then `__game.mapId === 'istanbul'`, settings have `map = 'istanbul'`, and the URL has `harita=istanbul`.
- A plain reload stays on Istanbul.
- `?harita=manhattan` overrides the setting.
- `?harita=xyz` falls back with a clean console.
- `?seed=` is kept across a switch.
- Ring best times are not shared between maps.

## 6. Open items and risks

- **Unverified figures:** the heights of the Hagia Sophia minarets, the Ortaköy Mosque, the Maiden's Tower and the Tower of Justice, the Galata Bridge deck heights, and the hill elevations. The design uses the estimates above; replace them if the user has better data.
- **Axis-aligned streets distort some orientations:** İstiklal runs N–S instead of NNE, and the mosque qiblas are snapped. A yaw-rotated box collider would remove this, but it would mean rewriting the player's wall movement (`player.ts`). It is deferred.
- **15 Temmuz Bridge:** the scaled 430 m span is the one deliberate departure from "real size". The towers, deck height and deck width stay real.
- **Rooftop anchors on low-rise roofs** are the most likely failure of test c. Mitigate with neighbourhood minarets first.
