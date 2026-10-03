# garment3d-service

Two ways to get a photographed garment onto the avatar. **`bake_texture.py` is the one
the fitting room uses**; the InstantMesh server below is the older geometry-reconstruction
route, kept because it's the only path that can produce a garment-shaped mesh at all.

## `bake_texture.py`: photo-to-texture (current)

```bash
.venv/Scripts/python.exe bake_texture.py \
    --front photos/front.jpg --back photos/back.jpg --out baked.png
.venv/Scripts/python.exe preview_bake.py baked.png --out preview.png
```

Takes 2–4 flat-lay photos and bakes them into a 1024×1024 texture laid out in
`avatar-default.glb`'s `Wolf3D_Outfit_Top` UV atlas. The web viewer then swaps that
texture onto the avatar's own garment mesh (`GarmentViewer3D`'s `garmentTextureUrl`
prop), rather than adding a second mesh to the scene.

**Why this and not reconstruction.** Recovering a wearable garment mesh from a handful of
casual phone photos is ill-posed, and every InstantMesh attempt produced a blobby
silhouette which then had to be scaled and pinned to a bone, which never drapes, never
follows the pose, and never reads as worn. The avatar already wears a correctly shaped,
correctly rigged, correctly unwrapped garment. Only its *surface* is unknown, so only its
surface is estimated. Skinning, draping, fit and placement then come for free.

**The tradeoff, stated plainly:** silhouette comes from the avatar's stock garment. A
hoodie and a crop top render with the same outline. Only print, color and fabric read as
the real garment. This is why `avatar-default.glb` matters: it has to wear a plain
short-sleeve tee, not a coat (see `apps/api/prisma/seed.ts`'s `AVATAR_SOURCE_URL`).

**Photos.** Flat-lay, garment laid flat and shot straight down, one per side. Front and
back are the useful pair; `--left`/`--right` are accepted but a flat-lay has no real side
view, so leaving them off is normal, since unphotographed regions are filled by growing the
neighbouring fabric color inward. Background is removed automatically (`rembg`), so a
plain surface helps but isn't required. No angle rig, no 6-shot circle.

**Timing.** About 3 minutes for a two-photo bake on this CPU-only host, essentially all
of it background removal, while the geometry and projection work is ~18 seconds. `rembg` runs
on a downscaled copy (`MASK_INFERENCE_MAX`) precisely because it dominates; at full size
the same bake took 7.5 minutes. Still far quicker than the InstantMesh path below, which
runs 20+ minutes and produces a much worse result.

`preview_bake.py` software-renders the result on the same mesh and UVs the browser uses,
so a bake can be checked without booting the web stack. Run it with no texture argument
to see what shape of garment an avatar GLB actually ships with.

> **The service runs from a Docker image** (`COPY . .`), with only `garments/` and the model
> caches mounted. Editing any `.py` here does nothing to the running bake until you
> `docker compose -f infra/docker-compose.yml build garment3d-service && ... up -d`. This
> has already caused one silent regression where de-lighting appeared to do nothing on real
> uploads for a day, because the container still held the previous code.

### Hangers (`isolate_garment`, `drop_hanger`)

Garments shot on a hanger bring the hanger with them -- `rembg` segments the hook and
crossbar as foreground, because they are foreground. Two mechanisms remove it, and both
are needed:

- **`drop_hanger`** trims the run of narrow rows above the shoulders. This is the hook
  sticking up above the collar, and it is a row-wise test.
- **`isolate_garment`** keeps the largest connected component after an opening that severs
  anything thin enough to be wire, then extends that through the hanger's own colour into
  the part visible *through* the neck opening.

The row test alone is not enough, because it only looks upward. A hanger lying *beside*
the garment occupies the same rows, is never narrow, and survives it completely -- and
that is not cosmetic: everything downstream measures the garment against the cutout's
bounding box, so the box stretches sideways, `build_row_extents` reads the garment as
wider than it is, and `silhouette_centerline` (the single landmark the projection anchors
on) slides toward the hanger. On a real upload that inflated the bounding box by 22% and
pulled the print off centre. Conversely the component test alone cannot remove a hook that
rests *on* the shoulders, since that is one blob with the shirt until the wire is cut.

Adding the component pass also made `drop_hanger` much less destructive on hung shots: it
had been hacking **17% of garment height** off the top to reach the hook, shoulders
included, and now trims ~3% because the hanger is already gone.

The colour bleed is deliberately seeded only from pixels already confirmed to be hanger,
and grows only through matching colour. It asks "is this contiguous with, and the same
colour as, the hanger I just removed" rather than "does this look like hardware" --
because branded neck tape sits exactly where a hanger does, and a rule that removed dark
pixels near the collar would silently eat it on most tees. It bails when hanger and
garment colours are too close to separate (a navy hanger in a navy shirt stays) and when
the bleed would claim more than `HANGER_BLEED_MAX_AREA_FRACTION` of the garment.

**The one thing that can cost you real garment** is the opening in `isolate_garment`: it
removes any part of the silhouette too narrow to fit its disk, so spaghetti straps and
hanging ties are at some risk where a sleeve never is. `THIN_STRUCTURE_FRACTION` is set at
0.8% of the longest edge (~5mm of real garment) to stay under a wire and well under any
strap meant to hold weight, and a garment thinner than that throughout is returned
untouched rather than erased. If a strappy garment does come back clipped, that constant
is the knob.

A hanger whose wire crosses the fabric *and* matches its colour is not removable here and
will bake in. Shooting with the garment laid flat, hanger removed, avoids the whole class.

### Sideways photos (`orient.py`)

A garment spread on a bed is often shot along the bed rather than across it, so it arrives
lying on its side: hood pointing right, sleeves running up and down the frame. Everything
here reads photo rows as garment height, so such a bake smeared the hoodie across the atlas,
put its chest logo on the flank, and let `drop_hanger` trim the sleeve pointing up the frame
as if it were a hook.

`upright_turns` decides by symmetry, since any garment laid flat mirrors onto itself about
its own vertical centreline: upright photos mirror left-to-right, sideways ones top-to-bottom.
On 20 real flat-lays the sideways ones won that comparison by 0.24-0.30 IoU and upright ones
never by more than 0.04 (a sleeveless back comes closest), so `SIDEWAYS_MARGIN` is 0.15. Only
then is it asked which way is up: a top's hem is the full body width while its neck or hood
is narrower, and trousers are one piece of cloth at the waistband but two at the hems. A photo
that is merely upside down is left alone -- rare, and the up/down cue is weaker evidence.

It runs in `load_cutout` before hanger removal, and in `tryon.garment_cutout`, which turns
the photo and parses it again since the body parser only knows upright people.

### Neck labels (`remove_neck_label`)

The front flat-lay looks through the neck opening at the inside of the back panel, so it
photographs the care label sewn there, and the front view maps it onto the avatar's throat
as a white patch. On the front view only (the back's top centre is outside fabric, where a
printed logo is real), components that are much lighter than the fabric -- past halfway to
white, which keeps a polo's grey buttons on black pique -- small, and lying *entirely* inside
the top-centre window are repainted with `fill_uncovered`, so the patch carries the fabric's
grain rather than a flat blob. A print that merely reaches into the window is not a label and
is left alone; on the 10 front photos it was tested on, only the polo's label qualified.
It only runs for the profiles that ask for it (below): a hoodie's hood, and a henley's,
button-up's or zip-up's collar and placket fill that window with real cloth. A polo does
run it: its collar is geometry of its own (`COLLAR`), so what the photo shows in that
window is the label or a clipped-on size tag, which painted a white patch on the throat.

### Per-garment profiles (`garment_profiles.py`)

Every product goes through the same stages, because cutting out, de-lighting and
blending don't care what the garment is. What differs by kind lives in one table instead
of as special cases through the bake: whether the photo is matched to the mesh part by
part (tops) or by height alone (bottoms and dresses, until their parts get a detector),
and whether the neck opening shows a care label to paint out; for hoodies, too, whether
the photo's stitch lines are drawn darker (`seam_lines`) and its drawstrings painted out
(`drawstrings`, not on a zip-up, whose zip runs down the same window). A category's profile
(`HENLEY`, `BUTTON_UP`, `ZIP_UP`) refines its product type's. Pick the
category that matches the garment when creating the product -- a polo entered as a
`CREW_NECK` T-shirt gets its placket searched for a label.

### Part-to-part mapping (`layout.py`)

The height mapping put the photo's top row on the mesh's top row. A hoodie's hood lies
*above* the shoulders in a flat-lay but hangs down the back on the avatar, so the hood was
squeezed over the chest and upper back, and the logo and pocket slid down with it; and
sleeves spread sideways on a bed share no rows with A-posed sleeves, so sleeve seams were
painted across the body.

`layout.detect` reads the same landmarks off the photo cutout and off the mesh's own
front/back silhouette (`MeshSilhouette`): the shoulder line (first row about as wide as
the torso, so a hood or collar above it is excluded), the armpit, the hem, the torso's
columns, and one axis per sleeve. `map_points` then carries each mesh point to the same
place on the same part: torso by shoulder-line-to-hem height and its share of the torso's
width, sleeves by distance along their own axis and across it. The mesh's armpit comes
from its skin (`armhole_height`: the lowest edge between arm- and body-weighted vertices),
because its hanging sleeves touch the torso well below it in silhouette. It only splits
torso from sleeves; the torso's rows are not pinned to it, since a skinned armhole and a
sewn one aren't the same landmark. If either side doesn't read as a top, that view falls
back to the height mapping; a sleeve missing from the photo is left to the fill.

The shoulder line has two more guards. On a mesh, a hood worn up hangs round the head as
wide as the shoulders, and read as the shoulder line it put every hoodie's chest print and
pocket a hood's height too high (the Nike logo landed on the collarbone): the mesh's
shoulder line is looked for no higher than `SHOULDER_ABOVE_JOINT_M` (6.5 cm) above its
shoulder joints (`shoulder_crown`), which every tee, long sleeve and polo in the library
already sits below (4.5-5.8 cm), so only the two hoodies read differently. On a photo, a
hood standing up above the shoulders (a studio shot, a hanger) can be as wide as they are
too; it narrows into the neck before the shoulders spread out, so a row narrower than
`NECK_DIP` of the widest above it marks a neck, and the shoulder line is the next wide row
below the lowest one. And a top with no sleeves (a gilet, a tank) never has the torso's run
joined by anything, which used to make it unreadable and send it to the height mapping --
which painted a gilet's side panels and zips onto the library hoodie's sleeves. Its armpit
is now the first row as wide as the torso (`SLEEVELESS_FULL_WIDTH`), its shoulder line read
at a lower share (`SLEEVELESS_SHOULDER_WIDTH`, no sleeve head widening it), and the mesh's
sleeves, which the photo doesn't have, are left to the fill.

The torso's width, which everything above is measured against, is its *narrowest* run
over the lower 60% (`TORSO_WIDTH_SAMPLE`, 10th percentile), not the median. A fitted
women's tee narrows to ~520 px at the waist and flares back to ~710 at the hem; the median
read the flare, so its cap sleeves (710) never looked 1.2x wider than the torso, neither
view read as a top, and the print was stretched by the height mapping. Straight tees read
within a couple of percent of before.

### Leg to leg (`layout.detect_legs`)

Shorts and trousers used to map by height alone, and a row's outer width. A flat-lay's
crotch rarely sits where the mesh's does -- 33-39% of the way down a pair of joggers,
53% down the harem-pants mesh they're painted onto; 57% vs 65% on denim shorts -- so the
hip pockets, fly and logo slid down onto the thighs, and below the crotch a point on the
inner leg was placed across the full row, gap included. `detect_legs` finds the waistband,
the crotch (where the middle column empties and stays empty) and the hem on the photo and
on the mesh's silhouette; heights map through those three, columns across the body above
the crotch and across the *same leg* below it.

A gap that only opens in the bottom 30% (`LEG_MAX_CROTCH`) is two legs laid against each
other, not a crotch: the white Nike shorts read 78-91%, and squeezing that onto a mesh
crotch at 62% pushed the print up into the waistband. Such a view keeps the height
mapping, which matched it well.

### Background that came through with the garment (`drop_background_leaks`)

The segmentation keeps anything lying against the garment that looks like cloth. A second
blanket folded under a tee's back came through as one piece with it (so `isolate_garment`
kept it), was painted onto a sleeve and the hem, and widened the silhouette until the part
detector read it as a sleeve. The tell is that it matches the background *just outside*
the cutout -- it is that background -- and not the garment's own colours, read from the
middle of the silhouette. Pieces that match the first, not the second, and touch the
cutout's edge are dropped, capped at `LEAK_MAX_AREA` of the cutout. Across the 20 DOX
photos it removes the one blanket (13%) and nothing else.

It can't separate **see-through fabric from what shows through it**: lace lying on a brown
blanket has brown in every hole, so brown is a garment colour and the blanket beside it
stays. Shoot lace and mesh on a plain background that contrasts with them.

### De-lighting (`delight.py`)

Photos of cloth record the fabric's colour *multiplied by whatever the light was doing*,
but the atlas is used as a base-colour (albedo) map, which is supposed to hold only the
first of those. Left alone, every fold the garment happened to be lying in and every
shadow the room happened to cast gets baked in as if the cloth were dyed that way, and
then the renderer shades the mesh on top, so photographed creases darken *twice* and read
as lumps and stains rather than folds. `delight.py` divides the estimated lighting back
out before any pixel is sampled, and runs by default on every bake.

It separates light from dye using three cues: shading is smooth and large-scale where a
printed edge is a step; shading is fitted robustly, so a logo is progressively rejected
from its own estimate rather than dragging it; and shading is achromatic, so a pixel whose
*chromaticity* departs from its neighbours is a colour change, not a light change. The
correction is then clamped to a per-scale ceiling (`SCALES`), which is what makes it safe
on uploads nobody has inspected: a fit that goes wrong can only shift brightness by a
bounded amount, never flatten a print.

The third scale (0.015) exists for creases -- the narrow vertical streaks a shirt picks up
from being folded in a drawer. They run the full height of a panel and are only tens of
pixels wide, so the 0.045 kernel is about as wide as they are, follows them only partially,
and leaves them in the atlas: faint, but coherent and full-length, which is exactly the
shape the eye reads as a crease rather than as noise. Only a kernel small enough to sit
inside one removes it. Its ceiling is the tightest of the three and it inherits the coarser
passes' verdict on what counts as print, which is what stops a kernel that small mistaking
the inside of a logo for background.

**Prints are left alone, not re-fitted.** Robust fitting gives a logo's pixels a
near-zero weight, never exactly zero -- and inside a print wider than the fine kernels
those are the only weights, so normalized convolution used to scale them straight back
up and fit the shading field *to the print*. On the adidas test tee that erased the
three stripes and the wordmark inside the badge and left nested bands in their place.
Each scale now abstains (field fades to zero, i.e. "no correction beyond the coarser
scales") wherever too few of the kernel's garment pixels are still voting
(`EVIDENCE_RAMP`), and the fit is centred on the fabric's own level so that zero really
means "lit like the rest of the garment". The smoothing kernel is three box passes
(≈Gaussian) rather than one square box, whose flat top and hard sides left rectangular
plateaus wherever it straddled a print edge. Fold removal on plain fabric is unchanged
(residual low-frequency shading 6.48 → 6.63 on `IMG_9358`, 2.20 → 2.22 on the adidas
back).

Cost is a few seconds per photo against the minutes `rembg` already spends, so it is free in
practice. It runs *after* the cutout cache, not into it, so retuning the strength takes
effect immediately instead of being frozen into cached PNGs.

```bash
# Dial it back, or off, for one bake:
.venv/Scripts/python.exe bake_texture.py --front f.jpg --back b.jpg     --out baked.png --delight-strength 0.5   # 0 disables entirely

# Inspect what it thinks the lighting is, for one photo:
.venv/Scripts/python.exe delight.py photos/front.jpg --out check.png
```

That second command writes `check-delit.png` (the corrected photo) and
`check-shading.png` (the field being removed, 128 = no correction). **The shading image is
the one to look at when something seems off:** it should be soft clouds. If you can make
out the artwork in it, the fit is eating the print, and the fix is a lower
`--delight-strength` or a tighter ceiling in `SCALES`, not a better photo.

### White balance (`neutralize_illuminant`)

De-lighting divides out *how much* light reached each part of the garment. This divides
out *what colour* that light was. Without it the warm cast of an ordinary indoor bulb is
recorded as dye, and since the atlas is an albedo the renderer then lights the
already-warm fabric with its own lamps: a white t-shirt is shown to the customer as cream.
On a real upload the garment, the background and the garment's own specular highlights all
carried the same +37 red-minus-blue bias -- when three unrelated surfaces agree on a cast,
that is the room's light, not pigment.

Separating "white shirt under warm light" from "cream shirt under neutral light" is
genuinely ill-posed from one photograph (it is the colour-constancy problem). So two cues
are combined and neither is trusted alone: **specular highlights**, because cloth is a
dielectric and its specular component keeps the illuminant's colour rather than the dye's;
and the **background**, as corroboration of *direction only*. A brown bedspread under warm
light is far more saturated than the light is, so matching its magnitude would
over-correct wildly -- but its hue still correctly says "the light in this room is warm".
Agreement is the cosine between the two casts, and the correction scales by it.

Verified against synthetic scenes: a white garment under warm light is corrected; a red
garment under neutral light is left *bit-identical*; a red garment under warm light keeps
its red while losing the cast; and **a cream garment under neutral light is left
untouched** -- the case that matters, since it shows this is not simply bleaching
everything. Luminance is restored afterwards, so this changes hue and never exposure.

Its weakness is a garment photographed against a background of its own colour, which looks
exactly like a colour cast. `MAX_WHITE_BALANCE_GAIN` bounds that to a mild shift rather
than a ruined colour; shoot on a neutral surface and it cannot arise.

**It only trusts the highlights of near-neutral cloth.** A red fleece has no sheen to
speak of: its brightest 1% is simply its brightest red, which read as a lamp of chromaticity
(1.86, 0.65, 0.49) -- no real bulb is that colour -- and the correction ran to its limit on
a real upload. The red went brick (192,42,27 to 154,53,34) and the white Nike logo on it
went cyan. `CLOTH_SATURATION_RAMP` fades the correction out as the cloth's own colour moves
away from grey (white, grey, black and cream uploads measure 0.02-0.19; that red, 1.5).
Highlights are also only looked for among pixels near the cloth's own colour
(`HIGHLIGHT_CLOTH_ANGLE`): the brightest 1% of a black polo was its orange logo.

### Cloth, prints and fine detail (`fabric.py`)

De-lighting corrects the photo; it cannot make it into an albedo. On a real hoodie upload
the atlas still carried the shadow across the back, the folds along the hem, the
drawstrings as broken dark scribbles across the chest and smeared patches where the fill
met the photo, and the renderer then shaded all of that a second time. On saturated colour
de-lighting barely acts at all, since a red in shadow is a deeper red and its chroma test
reads that as a different dye.

**Off by default since 2026-09-28** (`--separate-cloth` turns it on). Side by side, the
photo painted as is (de-lit and white-balanced) read as real fabric -- the denim's fading
and wear, the fleece, how a pocket and hem sit -- where one flat cloth colour read as
plastic. The jeans and T-shirts baked that way were the look the user asked for on every
garment, and side by side on the red hoodie, black polo and black adidas tee it matched or
beat the cloth path (the polo's buttons and placket show clearly instead of faintly). What follows is how the path works when it is switched on.

Most garments are one dyed cloth with something printed on it, and for those the bake
can paint the cloth instead of the photo. `fabric.analyse` asks each photo three things it can answer
reliably, and the atlas is painted from the answers:

- **The cloth's colour**: the median of the plain cloth in linear light, across all views.
  Folds and shadows are outvoted instead of baked in.
- **Where the prints are**: a colour change, or a lightness change larger than light could
  make (`PRINT_CONTRAST`), against the surrounding cloth. Colour is compared with what
  *this* cloth looks like at the pixel's own lightness (`_cloth_curve`, learned from the
  photo), because a phone renders a red in shadow deeper and slightly shifted, and against
  one reference colour those shadows read as print. Print is taken from the photo as is.
- **Fine detail**: lightness relative to a blur a few pixels wide, clamped to +-10%
  (`DETAIL_LIMIT`). Seams, ribbing and the pocket's outline pass; a fold's broad
  slope does not, and a crease's sharp ridge stays a faint line. Lightness is read along
  the cloth's own colour rather than as luma, since luma leans on green and a saturated
  red's green channel is near zero and nearly all JPEG noise: on the red Nike hoodie that
  was 2.5x the noise and baked in as mottling all over the garment. What remains of the
  grain is then cored off (`DETAIL_CORE` times the view's own robust detail level), since
  at a flat-lay's ~1 mm a pixel fleece and knit are not resolved and only read as blotches.
  Grey, white and black cloth come out as before (the black polo's buttons and placket
  still show, a little softer).

`paint_cloth` then lays the cloth colour everywhere, modulated by the detail, with the
prints on top. Where the photos grow unsure (the sides, what no photo saw) detail and print
fade into plain cloth, so there is nothing to invent and no seam where the fill meets the
photo. On the four garments with cached uploads (red hoodie, white tee with a red print,
black polo, black tee with a blue trefoil) every logo and print was kept and no shadow was
taken for print. Dark-on-dark details (the polo's brown buttons) survive only as detail,
i.e. faintly, and a label right at the photo's edge is lost to the edge feather.

A garment that is mostly "print" -- stripes, camouflage, an all-over pattern -- has no one
cloth colour. Below `MIN_CLOTH_SHARE` of plain cloth in any view, `analyse` returns None
and the photos are painted as before (`fill_uncovered` below still applies there).


### Sampling and blending the views

- **Bilinear sampling.** Photo pixels are interpolated, not truncated to a pixel corner,
  which was aliasing print edges into staircases.
- **Edge feathering and soft coverage.** Each view's weight ramps up from zero at the
  trusted cutout's edge over `EDGE_FEATHER`, and a texel is only fully "photographed"
  once its summed weight reaches `FULL_CONFIDENCE_WEIGHT`; below that it is blended
  with the fill. Previously the last pixel before the edge counted in full and was
  smeared across every texel of a surface turning away from the camera (streaks down
  the sides), and each view cut off in one step (a hard seam where front met back).
- **Cross-view colour harmonisation** (`harmonize_views`). Each photo is shot with its
  own exposure and white balance, so the same grey marl tee baked magenta on the front
  and neutral on the back, 11% apart in brightness, with a colour step down each side.
  The views' median fabric colours are pulled to their shared mean, bounded by
  `MAX_HARMONIZE_GAIN`, and fade out when the views' chromaticities differ enough
  (`HARMONIZE_CHROMA_RAMP`) that the panels are probably genuinely different colours.
- **Hanger crossbar in the neck opening** (`remove_hanger`). The bar usually reappears
  below the neck tape without touching the trimmed hook, so the colour bleed is also
  seeded from a small window under the hook (`NECK_WINDOW_*`), with all of
  `_bleed_hanger_colour`'s colour and area guards unchanged.
- **Weights by facing *around* the body.** A texel's share of each photo goes by its
  normal's horizontal direction, so a fold's slope tilted up or down -- in plain view of a
  flat-lay -- isn't scored as grazing and handed to the fill.
- **Inner shells face outward** (`_outward_normals`). Draped garments have an inner shell
  facing the other way; by its own normal the inside of the front panel took the back
  photo, and the viewer (which draws both sides) showed it wherever the shells cross. A
  texel now faces forward in the front half of the garment's depth and backward in the back.
- **Padded atlas** (`_pad_atlas`). Sliver faces cover no texel centre and bilinear
  filtering reads past every island's edge; texels within `ATLAS_PAD` of a triangle take
  its nearest point, so they are sampled from the photo instead of filled from a neighbour.

### UV re-unwrap (`pack_uv.reunwrap`)

Refitting and draping move a garment's geometry and leave its UVs alone, so any region
they stretch keeps the atlas space it had before. `HEM_LEVEL` lengthens the tee's hem
by several centimetres, and those centimetres shared one or two texel rows: the bake
smeared a single photo row down the whole band, which rendered as vertical streaks along
the hem. No bake-side change can put detail into texels that don't exist.

`reunwrap` re-flattens each UV island against the garment's *current* shape with ARAP
(as-rigid-as-possible), starting from the island's own layout so seams, orientation and
winding are kept, then packs the islands at one uniform density (squared up to their
tightest bounding box, when that packs better). A conformal map (LSCM) was tried first
and rejected: it keeps triangle shapes but lets area drift several-fold along a long
panel -- trouser legs lost 5x density. `best_layout` keeps a re-unwrap only when it
wins overall (`REUNWRAP_MIN_SCORE`, `REUNWRAP_MIN_MEDIAN`). `refit_garments.py` runs
it on every refit, and `pack_uv.py garments/*.glb` applies it to an existing library.
On the current library (texel density of the worst 5% of fabric / typical fabric):

| Garment | Worst 5% | Median |
|---|---|---|
| T_SHIRT | x2.48 | x0.98 |
| HOODIE | x3.17 | x0.89 |
| LONG_SLEEVE | x1.31 | x1.03 |
| SHORTS | x1.31 | x1.03 |
| DRESS | x1.35 | x1.05 |
| PANTS | left as authored (would be x1.11 / x0.91) |

A layout change scrambles every texture baked against the old one. After running it:
upload the library (`upload-garment-library.ts`), re-bake products with stored photos
(`rebake-library-garments.ts`; `--slug <slug>` re-bakes just one), and carry hand-attached textures across with
`remap_texture.py`, which resamples a texture from the old layout into the new one
using the (unchanged) surface -- then attach the result with `attach-baked-garment.ts`.

### Filling what the photos never saw

This applies to patterned garments; a solid cloth is filled with its own colour (above).

A flat-lay photographs the *top* of a sleeve and never its underside, and the avatar's
sleeves reach wider than the photographed garment's. On a real two-photo bake **~12% of
the garment is seen by no view at all**, concentrated in the sleeves and along the hem --
exactly the regions that get reported as "looking fake".

`fill_uncovered` used to be a single nearest-known lookup. For a few texels of edge bleed
that is fine; across a whole sleeve it is not, because "nearest" partitions an empty
region into Voronoi cells, one per boundary texel, each a single flat colour. The sleeve
came back as a fan of hard-edged polygonal facets that rendered as visibly faceted
plastic. The two jobs are now split between the two things that are good at them: colour
comes from a **pull-push pyramid**, smooth by construction and drawing on every texel
around a hole instead of one; **grain** -- the weave and photographic noise that makes
fabric read as fabric -- is still carried from the nearest photographed texel, because
nearest-neighbour's failure mode is hard edges between flat cells and neither is visible
in high-frequency noise.

Note the tent filter in `_upsample`. Doubling by plain pixel replication makes every
pyramid level contribute its own grid of hard 2^level squares, which survive to the bottom
and reproduce the very faceting this replaced nearest-neighbour to remove.

Two things the fill gets deliberately wrong-on-purpose. `GRAIN_LIMIT` is small (4 units)
because the entire luminance spread across an invented sleeve is under 20 units -- grain
allowed anywhere near that stops decorating and starts dominating, and its
nearest-neighbour source map becomes visible as radial spokes. And `DETAIL_FADE_DISTANCE`
fades invented regions to plain fabric as they get further from real data: pull-push is
smooth, but smooth is not featureless, and far from any photographed texel it still
resolves whatever the coarse pyramid levels held, which on a sleeve came out as broad
facets with hard edges. Nobody photographed the underside of a sleeve, so there is no
honest detail to put there -- plain cloth reads better than invented structure. The fade
is by distance rather than flat across the whole hole because the boundary still has to
continue the photograph seamlessly.

Separately, the mesh's vertical span is now mapped onto the photo's **trusted** rows
rather than the full image. `_crop_to_garment` crops tight and then erodes the rembg
fringe with `border_value=0`, so the top and bottom rows of that tight crop -- where the
garment genuinely reaches the edge -- come back empty. Aiming the mesh's hem at erased
rows cost 44% of the texels below v=0.95, i.e. the entire hem. Fixing it took invented
area from 14.3% to 11.9%.

De-lighting corrects; it does not rescue. A crease blown out to white or crushed to black
has lost the fabric underneath it, and dividing light out of a clipped pixel yields flat
grey, not the print that was hiding there. It also does not touch geometry: folds in the
*silhouette* come from the avatar's own garment mesh and are not this module's to remove.

### Ribs, drawstrings and seams (`garment_details.py`)

Some of a garment is there in the photos but doesn't survive being painted onto the mesh,
and some is on the mesh but not where the photo has it. On a library garment that says
where its details are (`_RIB`, `_PART`, written by `refit_garments.py`; `rasterize_atlas`
interpolates them per texel with its `extra` argument), and for hoodies by profile:

- **Rib.** A flat-lay shows a cuff's rib as a faint texture that de-lighting and the
  atlas's resolution wash out. `paint_ribs` knits the wales round each band (lighter rib,
  darker purl, `RIB_CONTRAST`), shades the band a little darker and its folded edge darker
  still, and draws the seam where it joins the body (`BAND_SEAM_*`).
- **Drawstrings.** The mesh hangs its cords straight down, but what the photo has at a
  cord's place is the chest behind it. `paint_cords` paints them in the cloth's median
  colour a shade darker, with their stitched tips (`CORD_TIP_M`) and an eyelet where each
  comes out of the cloth. The photo's own strings, lying across the chest wherever they
  fell, would otherwise be painted there as well: `remove_drawstrings` finds them
  (`drawstring_mask`: thin dark lines in the cloth's own colour, followed by hysteresis
  along their faint stretches, at least `STRINGS_MIN_LENGTH` of the torso wide, in a
  window below the neck, away from anything that isn't cloth-coloured, like the logo) and
  paints them out of the front photo before it is sampled.
- **Seams.** A kangaroo pocket is the same cloth as the body; only its stitch lines show
  it, and spread over the atlas they were hard to make out on the avatar.
  `emphasize_seams` finds thin dark ridges in the photo (a Sato ridge filter at
  `SEAM_SIGMAS`, between the `SEAM_RANGE` percentiles of its response) on cloth-coloured
  pixels only, so a print's linework is left alone, and draws them `SEAM_DARKEN` darker.
  The pocket stays flat, just visible; relief is `pockets.py`'s, and not wired in.

### The garment library (`garments/`)

By default every product is painted onto the *default avatar's* own clothing, which is
why a HOODIE currently renders as a t-shirt: the avatar owns exactly two garment meshes,
a short-sleeve tee and full-length trousers, and no texture can add a hood or a cuff.

To give a product its real shape, put a Ready Player Me avatar export **wearing that
garment** into `garments/`:

```bash
# 1. Build an avatar wearing the garment at https://readyplayer.me and download the GLB
# 2. Check it's usable, then install it
.venv/Scripts/python.exe check_garment.py ~/Downloads/avatar.glb --product-type HOODIE --install

# ...or scope it to one category, so only zip-ups use this shape
.venv/Scripts/python.exe check_garment.py ~/Downloads/zip.glb     --product-type HOODIE --category ZIP_UP --install
```

Shapes resolve most specific first: **category, then product type, then the default
avatar**. A category's shape lives under its product type, because one category can
belong to several types (a LONG_SLEEVE polo must not get the short-sleeved one):

| Product | Looks for | Falls back to |
|---|---|---|
| T_SHIRT / POLO | `garments/T_SHIRT/POLO.glb` | `garments/T_SHIRT.glb`, then the avatar's tee |
| LONG_SLEEVE / POLO | `garments/LONG_SLEEVE/POLO.glb` | `garments/LONG_SLEEVE.glb`, then the avatar's tee |
| HOODIE / ZIP_UP | `garments/HOODIE/ZIP_UP.glb` | `garments/HOODIE.glb`, then the avatar's tee |

Category first because that is what distinguishes shapes *within* a type: a V_NECK and a
CREW_NECK are both T_SHIRT but have different necklines. One type-level entry is usually
enough, so add a category entry only when a particular cut is worth distinguishing.

The category cuts shipped today (`refit_garments.CATEGORY_CUTS`), and what each is made of:

| Cut | Source | Notes |
|---|---|---|
| `T_SHIRT/V_NECK` | the tee | V cut into the crew neck (`PLACKET`), `Underlay` behind it |
| `T_SHIRT/POLO` | the tee | collar grown out of the neckline (`COLLAR`); closed placket from the photo |
| `LONG_SLEEVE/BUTTON_UP` | `elvs_male_shirt_untucked_bd1` | collar, button placket, shirt-tail hem |
| `PANTS/DENIM` | `punkduck_male_classic_jeans` | five-pocket jeans, closer cut than the wool trousers |
| `PANTS/ATHLETIC` | `toigo_harem_pants` | loose leg gathered at the ankle, like a jogger |
| `SHORTS/DENIM` | the jeans above | cut off above the knee like `SHORTS` |
| `SHORTS/ATHLETIC` | `mindfront_male_swimming_trunks_01` | loose board-short leg |
| `DRESS/BODYCON` | `punkduck_black_cocktail_dress` | fitted, sleeveless |
| `DRESS/A_LINE` | `mindfront_f_dress_02` | flared from the waist |
| `DRESS/MAXI` | `punkduck_evening_gown` | floor length |
| `DRESS/BALL_GOWN` | `mindfront_f_dress_03` | full skirt |

Everything else (CREW_NECK, GRAPHIC, HENLEY, WAFFLE_KNIT, PULLOVER, CHINO, SHIFT, ...) is
its type's own mesh. Several sources are CC-BY and must be credited: `garments/CREDITS.md`.
They come from the MakeHuman community asset packs (shirts02/03, pants02/03, dress02/03,
installed under `<makehuman-data>/mpfb-data/data/clothes`), built by
`generate_makehuman_garments.py` into `garments-source/<TYPE>/<CATEGORY>.glb`, then:

```bash
.venv/Scripts/python.exe refit_garments.py --src ... --source-body ... --out garments
# one cut:            --only DRESS --category MAXI
# just the plain types: --types-only
```

Which category a product is entered with is no longer left to the form: the admin form
sends the main photo to `POST /classify` (`garment_classifier.py`, Marqo-FashionSigLIP
zero-shot) and pre-selects the category it names, so a "Pique Polo T-shirt" gets the polo
shape even when a catalogue calls it a CREW_NECK.

#### The women's half of the library (`garments/female/`)

Every shape above is fitted to `avatar-default.glb`, which is a male body. Worn by
`avatar-female.glb` the same mesh hangs wrong: it is cut for a longer torso and a
straighter chest and hip line, so a FEMALE product resolves against `garments/female/`
first and only falls through to the default cut if that body has no entry:

| Product | Looks for, in order |
|---|---|
| FEMALE T_SHIRT / GRAPHIC | `female/GRAPHIC.glb`, `female/T_SHIRT.glb`, `GRAPHIC.glb`, `T_SHIRT.glb`, then the avatar's tee |
| MALE T_SHIRT / GRAPHIC | `GRAPHIC.glb`, `T_SHIRT.glb`, then the avatar's tee |

The gender comes from the product row and reaches the service as the `gender` form field
on `/bake`; the bake records the path it used (`female/T_SHIRT.glb`), which is also the
storage key the viewer loads the mesh from. Build that half the same way as the default
one, pointing `--avatar` at the other body:

```bash
.venv/Scripts/python.exe refit_garments.py \
    --src <makehuman-data>/garments-source \
    --source-body <makehuman-data>/staging/avatar-makehuman.glb \
    --avatar avatar-female.glb --out garments/female
cd ../api && npx tsx prisma/upload-garment-library.ts   # walks sub-directories
```

**Both bodies share one UV layout per cut.** The fitting room lets a shopper switch between
the men's and the women's avatar, and a product has one baked texture. So `garments/female/X.glb`
is built with the *same triangles and UVs* as `garments/X.glb` (`--uvs-from`, which defaults
to `garments/` for any avatar but the default one), and the API serves both
(`Garment3DView.textureMeshUrls`); the viewer loads the one for the body on show and the
texture fits either. Build the default body's library first. For that to be possible nothing
may decide the *topology* from the fitted body: `_drop_loose_trim` groups by the source's
welded positions and the polo/V-neck opening (`_cut_placket`) is measured on the source
garment, so both bodies drop and cut the same triangles; `_template_uvs` refuses to write a
garment whose triangles differ. Textures baked against an older layout are carried over with
`remap_texture.py` (triangle for triangle, or `--by-surface` where the triangles changed).

Note that the two avatars do **not** carry identical skeletons: the female body has no
fingertip or `HeadTop_End` bones. Garments keep the 67-bone skeleton of the body they were
refitted against, and the viewer binds a missing bone to its nearest present ancestor
(`rebindToAvatarSkeleton`), and those bones carry no garment weight, so the fit is unchanged.
Before that fallback existed, a single missing bone made the viewer skip the garment
entirely, and every library garment silently failed to render on the female avatar.

`check_garment.py` verifies the things that otherwise fail silently much later: that the
expected mesh exists and wasn't merged into a single `Wolf3D_Avatar` by export
optimisation, that it has UVs to bake into, and that its skeleton matches the default
avatar's bone names. It also prints the garment's proportions against the default's, so
you can sanity-check that a hoodie hangs lower than the tee it replaces.

The whole avatar GLB is stored, not an extracted mesh, since `trimesh` discards skinning
weights on export, so extracting would strip the rig that makes the garment drape. The
named mesh is simply read out of it. This works across avatars because every Ready Player
Me export shares one skeleton.

Nothing in `garments/` is required; each entry only overrides the default for its own
product type.

The entries shipped today (T_SHIRT, LONG_SLEEVE, HOODIE, SHORTS, PANTS, DRESS) are
MakeHuman CC0/CC-BY garment shapes refitted onto `avatar-default.glb` by
`refit_garments.py`: retargeted bone by bone onto this avatar's skeleton, reshaped from
the MakeHuman body onto this one, pushed clear of it, and then **draped** (see below).
Their MakeHuman originals and the body they were fitted over live outside the repo, in
a separate data folder (`<makehuman-data>/` below).

```bash
.venv/Scripts/python.exe refit_garments.py \
    --src <makehuman-data>/garments-source \
    --source-body <makehuman-data>/staging/avatar-makehuman.glb \
    --out garments
cd ../api && npx tsx prisma/upload-garment-library.ts
```

UVs and vertex order are preserved, so existing bakes keep fitting after a refit.

#### Cloth simulation (`drape.py`)

Refitting alone puts a garment *on* the body: every vertex a fixed 6 mm off the skin,
which is a second skin with a photo on it. Clothing is not that shape: it is cut larger
than the body, held up at the shoulders or a waistband, and everywhere else it hangs. So
after the refit each garment is draped:

- **Ease.** Each vertex gets a target standoff from the body and a matching fabric
  surplus, derived from `CATEGORY_EASE` in `packages/contracts/src/sizing.ts`, the same
  centimetres the size recommender already promises the customer, divided by 2π to get a
  radius. A `CREW_NECK` tee's 10 cm of chest ease becomes a 16 mm gap; a `PULLOVER`
  hoodie's 16 cm becomes 25 mm; `DENIM`'s 2 cm at the waist becomes 3 mm, because jeans
  really are cut that close. The table is mirrored into `drape.CATEGORY_EASE_CM` and
  checked against the contract on every run, so the two cannot drift apart silently.
- **Fabric.** `drape.FABRIC` gives each product type a mass, thickness, stretch and
  bending stiffness, friction and damping, plus the two measurements a size chart has no
  opinion about: the armhole (what keeps a sleeve off the armpit and a short leg off the
  thigh) and the hem flare (what opens a leg opening). Fleece is heavy and stiff, jersey
  light and soft, denim stiff and barely stretchy, and they hang differently because of
  it. Which limbs the armhole applies to is `drape.LIMBS`, per slot, and a `FULL_BODY`
  garment needs the legs listed there as well as the arms: without them a skirt gets no
  standoff where it crosses the thighs, so the solve walks it into the gap between them
  and the dress renders as a pair of trousers.
- **The solve.** Position-based dynamics over the garment's own vertices: gravity, seam
  constraints at the eased rest length, bend constraints between neighbouring triangles,
  and the avatar as a collision body with friction. Because there is more fabric than the
  body needs and it cannot stretch flat, the surplus buckles into folds; gravity decides
  where. Vertices are tethered to where the refit put them: outward, as far as the ease
  they are short of plus one fold depth; sideways, barely at all. That asymmetry is what
  lets a garment lift and crease without either sliding off the shoulder, growing 6 cm
  longer, or ballooning past the ease it was cut to.

- **Cling.** `Fabric.cling` takes the ease back off the chest, back and shoulders, so a
  tee sits close there and only stands off at the sleeves and, by `Fabric.release`,
  towards the hem. A clinging garment is also pulled *in* to its standoff before the
  solve: the MakeHuman tee was cut over a fuller chest and otherwise arrives with its
  front 15-20 mm proud, which reads as a bust. Afterwards the free hem is smoothed
  level, since per-vertex collision leaves it a zigzag.

  **Every garment that hangs off the shoulders wants some cling.** Leaving it at 0
  stands a garment off its full ease everywhere at once, which is inflation, not
  drape -- the hoodie shipped that way and came back at 38 mm against the 25 mm its
  own ease asks for, reading as a puffer jacket with a shredded hem. `check_drape.py`
  is how you catch it: a gap well above the one `refit_garments.py` solved for.

  How far out the pre-pass still trusts a vertex is `Fabric.cap_bulge`. A garment cut
  over a much fuller chest than this avatar's arrives past the default 35 mm, and
  capping only the part of the bust that falls under the threshold embosses blobs into
  it while its neighbours get pulled in -- which is why `DRESS` raises it to 55 mm.
- **Neckline.** `refit_garments.NECKLINE` pulls a collar in to a few millimetres off the
  neck. The avatar's torso is hollow under its own (hidden) tee, so any gap at the collar
  shows as a hole in the body. Measured against the head mesh only, because that is where
  the neck skin lives, and lifted to that skin's lower edge -- which is 3 cm higher at the
  nape than at the front, where the source collar was level.
- **Hem length.** `HEM_LEVEL` stretches a top below the waist so its hem runs level just
  below the trousers' waistband. The source tee stopped at the waistband and rose towards
  the back, so from behind it stood out over the waistband like a ledge.
- **Hoodie front.** The MakeHuman hoodie is cut as an open slot from the throat to
  mid-chest (15 cm), which a pullover's hood doesn't have and which showed straight into
  the hollow avatar. `CLOSE_FRONT` gathers both sides onto the centre line before the
  drape, crossing the wearer's left edge over the right, and closes the drawstrings in with
  the edges they hang from, keeping them `CLOSE_FRONT_STRINGS_M` apart; a second pass after
  the drape re-closes the top 3 cm, which the drape eases back open. The source's loose tab
  at the slot's point is dropped (`LOOSE_TRIM_SHARE`).
- **Hoodie closure, rebuilt.** The drape eases that closure back open (4 cm at its widest)
  and crumples the V's rolled edge bands and facings up into the gap, which rendered as a
  tangle of flaps down the throat. Ironing it, pressing it flat and re-gathering it after
  the drape were all tried and each came back crumpled or opened a slit onto the hollow
  body, so `_rebuild_closure` rebuilds it instead: the chest either side of the V is
  gathered shut on the *source*, where it lies flat and a monotone shift can't fold it,
  and laid onto the draped chest by a thin-plate spline fitted to the chest from
  `CLOSURE_REBUILD_M` to `CLOSURE_ANCHOR_M` out from the edges. The edges overlap by
  `CLOSE_FRONT_OVERLAP_M`, the wearer's left one nearly flush on top; the facings and
  rolled bands (read off the source: inside the V, or facing sideways within
  `CLOSURE_ROLL_M` of it) lie `CLOSURE_LAYERS_M` behind as a backing. It fades into the
  drape at the sides and into the throat over the top `CLOSURE_THROAT_M`.
- **Drawstrings.** The source's strings are two round tubes, which the closure and the
  drape crumpled into the tangle too. `_source_strings` finds them on the source (small UV
  islands in `SOURCE_STRINGS`'s box, narrower than `STRING_MAX_WIDTH_M`) and
  `_hang_strings` hangs each one again as a flat cord `CORD_LENGTH_M` straight down the
  chest from its eyelet, `CORD_SPACING_M` off the centre line, splaying out a little at the
  tip. The tube's own cross-section is kept, flattened to `CORD_HALF_WIDTH_M` by
  `CORD_HALF_THICKNESS_M`, so the triangles and UVs stay the source's. Which vertices are
  cord, and how far down it, is written into the GLB as `_PART` for the bake.
- **Ribbed bands.** A sweatshirt's cuffs and hem are elastic rib, snug to the wrist and the
  hip with the body bloused over them; the MakeHuman hoodie ended each sleeve in an open
  bell running onto the hand and hung its hem as loose as the body. `RIB_BANDS` gives the
  band lengths (6.5 cm each) and `_gather_bands` draws them in: each cuff back to
  `CUFF_SHORT_OF_WRIST_M` short of the wrist (the length it loses stacks up in the sleeve
  above over `CUFF_STACK_M`) and onto the skin's own cross-section plus `CUFF_EASE_M`,
  measured by distance along the forearm and direction round it (`CUFF_GIRTH_BINS`: a
  wrist is half again as wide as it is deep, so a round cuff was loose on two sides); the
  hem band onto the hips and trousers plus `HEM_BAND_EASE_M`. Above each band the fabric
  widens back out over `BAND_BLOUSE_M`, standing out by `BAND_BLOUSE_GAIN`. Each band
  vertex's distance up the band, direction round it and wale count (`RIB_PITCH_M`) go into
  the GLB as `_RIB`, which the bake knits into the texture. Custom attributes are VEC4
  only: Blender's glTF importer fails on custom attributes of mixed widths.
  The hem band is measured *up the body* from its edge, not over the surface: the front
  comes out of the drape tapering in and crumpled, and measured over that the band was
  half as tall in front as behind. The open edge itself zigzagged with teeth reaching 3 cm
  up into the band (a torn-looking hem), so the band is laid out by a harmonic field, 0 on
  the edge and its true height a band's length up, which can't fold.
- **Hoodie front fit.** The drape left the hoodie's front 5-6 cm off the body from chest
  to hem, twice the 25 mm its `PULLOVER` ease asks for, which from the side read as a bust
  and a paunch pushing forward below the pocket. `_settle_front` brings the front in to
  `SETTLE_FRONT_M` off the body (keeping `SETTLE_KEEP` of the excess, so folds survive),
  and `_hang_front` then lets it fall straight from the chest's most forward point
  (`HANG_FROM_CHEST`, metres in per metre down) instead of following the body in under it,
  which matters on the women's body. The hem band eases in over `HEM_TAPER_M` rather than
  the cuffs' short `BAND_BLOUSE_M`, which pouched the front out over the band. The cords
  are hung after all of this, lying on the settled front `CORD_STANDOFF_M` off it.
- **Polo collar.** A polo is the tee with a collar grown out of its neckline (`COLLAR`,
  `_add_collar`): a 28 mm stand, a fold, and a fall lying over the shoulders, held 3 mm
  clear of the shirt, with points at the front. It's ordered around the neck on the
  *source* garment so both bodies build the same triangles, takes its skin weights from
  the neckline it grows from, and gets its own UV island at the shirt's texel density. The
  front stays closed and the photo supplies the placket and buttons. It replaced an open V
  (below) that had no collar at all and showed skin where a buttoned placket should be;
  the MakeHuman polo was tried again first and still has no collar that survives the
  refit (it rolls into a cord at the neck) and still drapes with a bust.
- **V-neck placket.** `PLACKET` (by category) opens a V at the front of the collar;
  `--only T_SHIRT --category V_NECK` writes `garments/T_SHIRT/V_NECK.glb`. The cut
  runs along exact lines (`_split_along`), since the tee is too coarse (~24 mm edges) for
  whole triangles to make a clean V. Behind the opening the avatar is hollow, so the
  avatar's own tee, clipped to the V plus a margin, ships in the same GLB as an `Underlay`
  mesh that the viewer paints in the avatar's skin tone. Keeping the whole tee on as skin
  instead (what `AVATAR_CLOTHING_WORN_AS_SKIN` does for hoodies) pokes out above a tee's
  collar, below its hem and at the sleeves.
- **Ironing.** The drape folded thin flaps of the hoodie flat back on themselves along
  the side and underarm seams, which rendered as shredded cloth. `IRON_FOLDS` smooths
  faces folded past `IRON_FOLD_DEG` below the shoulders only, since the hood's rolled edge
  above them is a real fold. `PANTS/ATHLETIC` is ironed too: the drape pushes the harem
  pants' dropped crotch up into the waist, which folded into spikes standing up along the
  waistband and a torn fly (2 folded faces at the waist before the drape, 339 after), and
  so are `SHORTS/ATHLETIC` and the jeans behind both denim cuts, whose waistbands spiked the
  same way (folded vertices 67 -> 0 on the trunks, roughly halved on denim). Each
  entry says how wide a strip down the centre line to leave alone -- the hoodie's closure,
  but none on the joggers, whose damage *is* the centre.
- **Sleeve hems.** `FLAT_CUFFS` lays the tee's sleeve hem band flat. The source models it
  as five rows of vertices stacked in a centimetre, which drape into a ridge that reads as
  a strap tied round the sleeve.

UV seams are stored as duplicate vertices, and only one of each set takes part in the
constraints; the solve copies it back onto the others every step. Without that the copies
fell on their own and every garment tore open along its seams (2,567 vertices on the
hoodie, up to 13 cm apart).

The result is checked two ways. `refit_garments.py` prints the gap it solved for and how
far the seams ended up from the length they were asked to hold; `check_drape.py` measures
the gap actually achieved:

```
draped BUTTON_UP in a regular fit: 18 mm mean gap, 24 mm at its widest,
                                   seams within 2% (45% at worst)
```

A median seam strain of a few percent means the solve converged. A large one means the
fabric was pulled apart rather than draped: gravity or a collision winning against
constraints that are not being iterated enough, so `drape`'s `iterations`, not the
fabric profile, is what wants raising. The 99th-percentile tail is normally where a
collision forced a vertex out against its neighbours, since the body always wins.

Separately, if `check_drape.py`'s gap comes back well above the gap `refit_garments.py`
solved for, the garment is inflated rather than draped, and the fabric's `fold` is the
number to look at.

Beware of judging this by comparing seam lengths before and after a refit: most of that
difference is the ease inflation doing its job, not the solver failing. Measure against
the rest length, which is what the printed strain does.

```bash
# looser or tighter than the category's own cut
.venv/Scripts/python.exe refit_garments.py ... --fit OVERSIZED
# drape to a specific cut rather than the product type's plainest
.venv/Scripts/python.exe refit_garments.py ... --only HOODIE --category ZIP_UP
# skip the drape entirely (fast, and the old second-skin result)
.venv/Scripts/python.exe refit_garments.py ... --drape-steps 0
```

The drape costs roughly 20 seconds per thousand vertices (the hoodie, at 13k, is the slow
one at about three minutes), so a full library refit is eight to ten minutes rather than
one. It only moves positions: topology, UVs, vertex order and
skin weights are untouched, so bakes keep fitting and the garment still poses with the
avatar's skeleton.

`check_drape.py` is how you tell whether it worked, because a render won't:

```bash
.venv/Scripts/python.exe check_drape.py garments/T_SHIRT.glb --plot drape.png
```

It prints the garment-to-body gap and draws horizontal cross-sections through the chest,
waist, hip, thigh and hem with the body outline behind them. A draped garment's outline
stands off the body's; a second skin traces it. Pass two GLBs to see before and after in
one figure.

**It only measures against `avatar-default.glb`, so it cannot check `garments/female/`.**
There is no `--avatar` flag. Pointed at a women's garment it reports roughly 40% of the
vertices "inside the body" and a p05 gap of -50 mm or worse, because it is holding a
garment fitted to one body against a different one. That number is an artefact, not a
finding, so judge the women's half by rendering it until this grows the flag.

**What this does not do: react to movement.** The drape is solved once, offline, in the
avatar's rest pose, and the result is a static mesh skinned to the skeleton. The fitting
room's avatar doesn't move: it has no animation clips and the viewer runs no per-frame
simulation, only orbit controls, so there is nothing to react to, and an offline solve
run to convergence is strictly better looking than a real-time one would be. If the
avatar is ever animated, the garments will follow it by linear blend skinning like any
other clothing: correct silhouette, but no secondary motion, no swing at the hem, and
folds frozen in the rest pose. That is the point at which a runtime solver in the viewer
starts being worth its cost.

**SHORTS is the exception: it is the trousers, cut off above the knee.** The MakeHuman
shorts asset is a briefs shell: waistband to hip, a pointed crotch, no leg tubes, so it
rendered as underwear no matter how well it was refitted. `refit_garments.py` builds
SHORTS from `PANTS.glb` instead (`SOURCE_FOR_TYPE`), cutting it at `TRIM_TO_HEM`'s
fraction of the hip-to-knee distance and splitting the straddling triangles so the hem is
a straight edge. Lower that fraction for a shorter cut. Because SHORTS now inherits the
trousers' UVs and vertex order, bakes made against the old shorts do not fit it and must
be re-baked.

#### Construction (`garment_construction.py`)

The drape gets the silhouette and the gap to the body, but on one paper-thin sheet at
~15 mm resolution: no thickness, a hood crumpled by the solve, sleeves that balloon to the
cuff, no pocket, none of the seams and rib a sweatshirt is recognised by. For the cuts in
`refit_garments.CONSTRUCTION` (the hoodie), `refit` adds them back after the drape:

- **Hood.** `hood_weight` finds the hood (harmonic: it runs down into the front opening, so
  no cut separates it) and `smooth_hood` keeps the hood as cut, moved by the drape's broad
  fall (its displacement low-passed over `HOOD_SMOOTH_PASSES`) without the crumple.
  `smooth_crumples` does the same round any other face folded past `CRUMPLE_FOLD_DEG`
  (a small effect: most of those folds were in the source already), and
  `smooth_open_edges` runs the hood's opening, hem and cuffs smooth along themselves.
- **Armpits.** A sleeve cut for arms hanging forward, raised into the women's T-pose,
  crushed its underarm into shards turned inside out with a hole to the skin.
  `smooth_armpits` replaces the hollow under each arm (`ARMPIT_ZONE_M`, not past
  `ARMPIT_ALONG_ARM_M` down the sleeve) with the harmonic surface over its rim, at least
  `ARMPIT_MIN_GAP_M` off the body. Better, not perfect: the women's front shoulder still
  shows some faceting from the same stretch.
- **Sleeves.** `shape_sleeves` scales each sleeve's gap to the arm, by its median at each
  point along it, to `SLEEVE_GAP_PROFILE`: ~3 cm round the upper arm with a little bag at
  the elbow, ~2 cm round the forearm, closing to the cuff; the drape's folds keep their
  relief and the shoulder and cuff blouse are faded out of it.
- **Folds.** `FoldField` is a height field over the undraped garment of the folds a hoodie
  really makes: rings stacked above each cuff (wandering, some running out), creases
  inside the elbow, drag lines fanning out of the armpits, gathers above the hem band and
  soft rolls on the lower back. The mesh takes it low-passed to what ~15 mm triangles can
  carry (`add_folds`); the normal map takes the remainder. Nothing folds on the throat
  closure or the cords (`closure_zone`).
- **Pockets.** `add_pockets` sews on the cut's or the product's own pockets
  (`garment_pockets`, below), each a panel of its own over the front: a fixed grid, its
  own UV island, laid on the front's depth map. A kangaroo pouch stands
  `POCKET_STANDOFF_M` off the front at its sewn edges, sags in the middle and gapes at the
  hand openings, its bottom edge never lower than `POCKET_ABOVE_BAND_M` above the band's
  seam; a welt's lip stands proud of its slit (`WELT_*`); a zip's tapes lie flat with the
  teeth raised between them (`ZIP_*`). A grid rather than a cut through the front, so
  every body keeps identical triangles.
- **The source's own pocket.** The MakeHuman hoodie is a zip-up with a split pouch: at
  each hand opening its front tucks in on itself in a Z. Draped, the tucks came out as
  creases up the front and flanks, a second, old pocket beside the new one.
  `_iron_source_pleats` rebuilds the cloth in `IRON_SOURCE_PLEATS`' boxes as the harmonic
  membrane over its rim, on the source, before anything else runs.
- **Thickness.** `solidify` gives the cloth an inner shell `thickness` behind it and a
  rounded rim on every open edge: 2.6 mm of fleece, 4.2 mm at the folded rib bands, 4.8 mm
  at the hood's drawstring channel, 4 mm at a pouch's hems and 3.5 mm in a welt's lip, but only 0.6 mm on the
  throat closure, whose facings sit 3 mm apart. The inner shell shares the outside's
  texels and is marked in `_PART`'s third column; the bake skips it
  (`garment_details.outside_faces`).
- **Occlusion.** `occlusion` marches rays through a voxel grid of the garment and the body
  under it, per vertex, into `COLOR_0`; the viewer multiplies it into the cloth, so the
  inside of the hood, the armpits and the pocket mouth darken under its direct lights.
- **Normal map.** `normal_map` bakes the seams (shoulder, set-in armhole, sleeve underarm,
  side, hood centre, neckline, band joins) with a groove, the seam allowance's puff and
  dashed topstitching, the rib's wales, the hood's drawstring channel, eyelets, each
  pocket's topstitching, folded hems and bartacks (and a zip's teeth), the folds the mesh couldn't carry and a
  faint unevenness in the fleece, into a 2048 px tangent-space JPEG in the GLB's material
  (glTF convention, +Y up the image). Seams are laid out on the undraped garment smoothed
  (`reference_positions`) so they follow the cloth without wandering with its wrinkles.
  The material's `roughnessFactor` is `FABRIC_ROUGHNESS` (0.85).

The viewer (`GarmentViewer3D.clothMaterial`) blends a tiling knit-and-fibre detail map
(`fabric_maps.py` writes `apps/web/public/fabric/fleece-*.jpg`, roughness 0.86 on average)
over the garment's own normal map, multiplies in the occlusion and adds a sheen tinted by
the cloth's colour. The hoodie GLB is ~4 MB with all of this.

#### Each product's own pockets (`garment_pockets.py`)

The library used to carry one kangaroo pocket for every hoodie, and every product baked
onto it wore that pocket: the gilet's zipped hip pockets and the jacket's welt pockets
came out as a hoodie's pouch, and hoodies whose photo shows a different pouch came out
with two -- the photo's own, painted on by the bake, and the library's, sewn on somewhere
else.

A pocket is now written in the bake's own terms, measured off the product's photo: for a
point on the torso, `f` its share across the torso's width on its row and `t` its share of
the way from the shoulder line to the hem, read from `layout.detect` on the photo's cutout.
The bake paints the photo's (f, t) wherever the mesh's layout puts (f, t), and
`garment_construction.MeshFrame` runs the same detector on the same silhouette of the
fitted garment, so the pocket is built exactly where its painted outline lands: one pocket.

- `CUT_POCKETS`: a cut's own pockets (the hoodie: `KANGAROO`, the Nike Club pouch made
  symmetric).
- `PATTERNS`: a product's pockets where they differ: `Kangaroo` (each side from its bottom
  corner up, sewn then open), `Welt` (the slit and the lip's sewn edge), `Zip` (its centre
  line). Each is built as `products/<pattern>.glb` (and `female/products/<pattern>.glb`)
  from its cut: `refit_garments.py ... --only HOODIE --patterns` (or `--pattern NAME`,
  `--patterns-only`).
- `PRODUCT_PATTERNS`: which products (by slug) bake onto which pattern. The API sends the
  slug with the photos (`product_slug`) and `bake_texture.garment_source` picks the pattern
  first; the product's `textureMeshSource` then names it, and the shop loads it like any cut.

To give a new product its own pockets: cut its front photo out as the bake does
(`load_cutout`), read the outline's (f, t) against `layout.detect`'s `torso_lo`/`torso_hi`,
`top` and `hem`, add a pattern and the slug, build the pattern for both bodies, upload the
library and rebake the product. A product with no pattern gets its cut's pockets.

### Pockets (`pockets.py`): analysis built, detection not yet trustworthy

**Not wired into the bake.** Nothing in this section changes what `bake_texture.py`
currently produces. Read the caveat at the end before enabling it. What hoodies get
instead is their seams drawn a little darker (`garment_details.emphasize_seams`), and a
their pockets sewn onto the mesh where the photo shows them (`garment_pockets`, above).

A pocket is not a colour, and this pipeline bakes colour. A pocket is a second layer
of cloth: it stands proud, its stitch line sits in a groove, its opening is a free hem
that catches light and drops a shadow. The mesh has none of that, so the photograph's
shading is the only pocket the renderer could ever have, and `delight.py` correctly
removes exactly that shading, because leaving it in the albedo would get it lit twice.
The garment silently loses the feature either way.

`pockets.py` closes that gap by giving the geometry somewhere to go: the shading that
says "pocket" becomes *relief*: a height field, then a tangent-space normal map the
renderer lights for itself from whatever angle the avatar is standing at.

The **construction** half works and is demonstrable: `relief_height` builds the raised
panel, the groove the stitching pulls it into, and the lifted lip along the opening;
`height_to_normal` converts it. Given a pocket mask, a pocket appears in the render
that was nowhere in the albedo.

The **detection** half is not usable yet, and the reason is worth recording.

  - Where the evidence is: a stitch line is *thinner* than delight's finest kernel
    (0.015 of the span), so no smooth field can follow it and it stays in the residual.
    On a marl jersey that residual is speckle of the same width and depth, measured as a
    10% groove against 15% grain, so the seam cannot be found directly. What *is*
    fittable is the broad step between one layer of cloth and two, which is why
    detection works off `offset_map` (the fitted field) and uses `seam_evidence` only
    to corroborate a region that already looks like a pocket.
  - Why it is currently silent: on the only garment photos this repo has, natural
    creasing produces shading offsets *larger* than a pronounced pocket's. On
    `IMG_9358`, 18% of the pocketless garment exceeds the step a 3x-exaggerated
    synthetic pocket makes. No threshold on that signal separates the two, and every
    relative threshold tried (percentile, robust-sigma) promoted the brightest folds
    into pockets instead.

So it is tuned to the safe end of that trade: zero detections on all six real photos
and on the PLAIN/PRINT/FOLD cases, and zero on synthetic pockets up to 4x strength. A
false pocket embosses a rectangle into a garment that hasn't got one and nothing
downstream can tell that it did; a missed pocket is the behaviour we already have.

```bash
.venv/Scripts/python.exe pockets.py photo.jpg --debug out.png --normal relief.png
.venv/Scripts/python.exe check_pockets.py ../../testimg/IMG_9358.jpg --sweep
```

`check_pockets.py` composites four cases onto a real cutout: a pocket (shading step,
no colour change), a print (colour change, no shading step), a fold (smooth unbounded
valley) and the bare garment, and `--sweep` reports the strength at which detection
starts. The two negatives are the ones that matter; a print is what a naive detector
calls a pocket.

**What it needs:** photographs of garments that actually have pockets: a hoodie with a
kangaroo pocket, jeans or shorts with back and side pockets, shot as proper flat-lays,
front and back. The thresholds above are guesses about how strongly a real pocket marks
a photo, and that is the one thing no amount of work on synthetic data can settle.
Until then the alternative worth considering is an operator-marked pocket region in the
admin upload flow: the merchant knows where the pockets are, the relief stage is
already built, and it carries none of the detection risk.

### The avatars (`avatar-default.glb`, `avatar-female.glb`)

Two bodies, one per gender, both wearing a plain short-sleeve tee. The API serves both
(`AVATAR_IDS` in `products.service.ts`) and the viewer toggles between them.

`avatar-female.glb` was not usable as downloaded. Ready Player Me ships avatars in two
shapes, and this one came *merged*: a single `Wolf3D_Avatar` mesh whose parts all sample
one packed atlas. Nothing here can address that, since `bake_texture.py` paints into
`Wolf3D_Outfit_Top`'s atlas, and the viewer hides and retextures meshes by name, so one
mesh means painting a t-shirt across the face.

`split_merged_avatar.py` undoes the merge:

```bash
.venv/Scripts/python.exe split_merged_avatar.py avatar-female-merged.glb --out avatar-female.glb
```

It works because the merge is not a repack. The four per-part atlases are pasted into the
four quadrants of one image at half scale and the UVs halved to match, so cropping a
quadrant and doubling the UVs inside it recovers the original atlas *exactly*. That is
what makes a texture baked against `avatar-default.glb` land correctly on the feminine
avatar with no re-bake, since the two share one UV layout. Connected components are sorted
into parts by which quadrant their UVs fall in, with the shared bottom-right quadrant
(eyes, teeth, footwear, hair, the body's flat skin patch) resolved by position on the
body instead. Skinning is copied through, so the result still poses and still anchors
garments by bone name.

The materials are rebuilt rather than copied: the merged source is `KHR_materials_unlit`,
which three.js loads as `MeshBasicMaterial`, and both the viewer's material upgrades and
its garment retexturing skip anything that isn't a `MeshStandardMaterial`.

Check a split with a render before trusting it: every part should be on the body it
belongs to, and a known bake should still land on the chest:

```bash
.venv/Scripts/python.exe preview_bake.py baked-tee.png --avatar avatar-female.glb --dressed
```

## `tryon.py`: photo try-on (`POST /tryon`)

```bash
.venv/Scripts/python.exe tryon.py person.jpg out.jpg tee.jpg:T_SHIRT jeans.jpg:PANTS
```

Puts one product, or a whole outfit, on a customer's own photo with CatVTON (`catvton.py`),
a diffusion try-on model that takes the person and the garment as two separate inputs. Only
the garment region is regenerated and `paste_back` composites it into the untouched
original, so face, hair, hands, shoes and background are the customer's own pixels. An
outfit is dressed one garment per pass, dress, then bottoms, then tops, so a T-shirt hangs
over the new jeans' waistband. The endpoint takes repeated `garment` + `product_type` fields.

**Masks come from body parsing, not from the clothes already worn.** `human_parsing.py`
runs `mattmdjaga/segformer_b2_clothes` (ONNX, ~2 s) and labels face, hair, arms, legs,
shoes and each kind of clothing. `COVERAGE` then says what each product type may paint:
what it replaces, and how far along the arms and legs it can reach, measured in "face
heights" by geodesic distance from the clothing so a bent arm is measured along the arm.
Pants reach the whole leg, shorts to about the knee, long sleeves the whole arm, a T-shirt
just past its sleeve. Hands and feet (the far end of each limb), face, hair and shoes are
never painted. Masking only the current garment was the original bug: shorts could never
become jeans, and the result always had the silhouette of what the customer already wore.

Three details decide whether trousers come out as trousers:

- The lower body is masked as a convex hull per leg. The parser misreads bits of leg (a
  dark chair behind the calves did it on the test photo), and any unmasked patch of bare
  skin inside the region makes the model end the garment above it, i.e. draw shorts.
- The mask is padded like the photo. When the crop runs past the photo edge the photo is
  edge-extended; a mask padded with zeros there showed stretched skin below the frame,
  which also produced shorts.
- The crop sits flush with a photo edge the body runs off, instead of centring and padding
  past it, where the model otherwise finished the hem.

**Long sleeves are hung before the garment reaches the model** (`hang_sleeves`). The
checkpoints learned from product shots with the sleeves beside the body. A hoodie spread
arms-out on a bed is 1.7x as wide as it is tall, so in the model's 3:4 frame it filled a
third of the height and its torso a few latent pixels. On a real upload the model all but
ignored it and painted a black T-shirt (continuing the dark shorts below) with bare arms,
over a white polo, with the sampler changed or not. `layout.detect`, the bake's own
sleeve finder, gives each sleeve's axis; a sleeve at least half as long as the body is
swung about its shoulder to hang `SLEEVE_HANG_DEGREES` off vertical, and the torso and hood
are laid back over its root. T-shirt sleeves are short and stay as photographed.

**Checkpoint and sampler, measured on this 4-core CPU (11.5 s per UNet pass at 384×512).**
CatVTON's `mix-48k-1024` was trained at 768×1024 and produces striped patchwork at the
384×512 this host can afford; the 512 checkpoints match it (`vitonhd-16k-512` for
short-sleeved tops, `dresscode-16k-512` for long sleeves, bottoms and dresses). The
original sampler, DDIM for 30 steps with guidance, cost 60 UNet passes (~13 minutes). Now:

| garment | checkpoint | sampler | UNet passes | why |
| --- | --- | --- | --- | --- |
| T-shirts | vitonhd | `hybrid`: LCM draft, then guided DPM-Solver++ from 40% | 26 | LCM alone drew cream, wrinkle-free tops that looked pasted on |
| long sleeves, hoodies | dresscode | `dpm`: guided DPM-Solver++ from noise | 26 | VITON-HD is nearly all short sleeves: it cut a hoodie off at the elbow and painted the forearms as skin. The LCM draft ignores the garment's colour and the refine keeps the draft's |
| bottoms, dresses | dresscode | `hybrid` | 26 | LCM alone drew generic denim; DPM alone copied the flat-lay layout |

A T-shirt on the test photo took 112 s with LCM and 339 s with `hybrid`; a hoodie takes about
6 minutes with `dpm`. `hybrid` was chosen on a white tee over a white polo, where a draft
that ignores the garment's colour happens to be right. A red hoodie over the same polo came
out as a black T-shirt with bare arms.

The LCM-LoRA (`latent-consistency/lcm-lora-sdv1-5`) is merged into every UNet layer except
CatVTON's own `attn1`, which carry the garment transfer, and is unmerged for DPM passes
(`catvton.LoRA`). `TRYON_UPPER_SAMPLER` / `TRYON_UPPER_LONG_SAMPLER` / `TRYON_LOWER_SAMPLER`
/ `TRYON_FULL_SAMPLER` switch between `lcm`, `hybrid`, `dpm` and `ddim`, and the matching
`TRYON_*_ATTENTION` variables pick the checkpoint.

**Colour.** The model under-paints saturated colour: the red hoodie, sRGB (209, 8, 3) in its
product photo, came out of it as (85, 19, 10), maroon, before any correction had run.
`match_fabric_colour` moves the whole painted garment in CIELAB by the difference between
its median and the product's plain cloth: hue and saturation all the way, lightness halfway
(`COLOUR_MATCH_LIGHTNESS`), because the photo's exposure is set by its own scene and the
model darkening a garment in front of white walls is partly right. A shift rather than a
gain keeps every fold as much darker than its surroundings as the model drew it;
per-channel gains flattened the red to neon. The model's own print moves with it and is
then replaced by `restore_print`.

Photos are converted from the colour profile they carry to sRGB on the way in
(`delight.convert_to_srgb`, in the bake too). iPhones shoot Display P3, which read as if it
were sRGB turned that same red into a duller (190, 41, 25).

**Debugging a result.** Set `TRYON_DEBUG_DIR` (e.g. through a compose override) and every
stage of the next try-on is written there: the model's person crop, mask and garment, its
raw output, and each correction after it. Copy them out with `docker cp`.

**Relighting.** The model paints the garment roughly as the product photo was lit, so after
compositing, `transfer_shading` gives it the room's light instead. It takes the broad
shading of the garment the customer was actually wearing (log luminance blurred over
~0.3 face heights, relative to its well lit parts, with prints left out as pixels far from
the garment's median brightness) and swaps it for the generated garment's own broad shading.
Folds finer than the blur are the model's and stay. Then `cast_hem_shadow` darkens the
kept waistband just under a top's hem.

**Licences.** CatVTON's weights are CC BY-NC-SA 4.0 and the parser is trained on the ATR
dataset (research use). Both need clearing before this runs for paying customers.

**Model files.** The container reads weights from the named volumes
`infra_garment3d-huggingface-cache` and `infra_garment3d-rembg-models`. Bind-mounting them
from a Windows drive sent every read through Docker Desktop's Windows file share and a cold start
spent minutes loading ~4 GB. To add a model, download it inside the container (it lands in
the volume) or copy it in with a throwaway container.

## InstantMesh server (retired path)

> **`apps/api` no longer calls this.** The `LOCAL_MULTIVIEW` provider that drove the
> `/generate` endpoint has been removed, along with the paid `TRIPO3D` cloud provider.
> Only `/bake` (above) and the `MANUAL` GLB upload remain wired up. The endpoint and its
> vendored model are kept here, unused, in case mesh reconstruction is revisited; the
> rest of this section describes it as it was.

Self-hosted, multi-view image-to-3D generation. Wraps [InstantMesh](https://github.com/TencentARC/InstantMesh)
(vendored under `vendor-instantmesh/`, with patches, see below) behind a small FastAPI
server, reachable over HTTP. No external account, no API key, no per-generation cost.

## Why this exists

This service was the free, self-hosted way to turn several of your own angle photos of a
real garment into an actual 3D mesh.

This replaces an earlier version of this service that wrapped TripoSR. TripoSR is a
*single-image* reconstruction model: architecturally, it has no way to combine multiple
photos, so extra uploads were silently ignored. InstantMesh's reconstruction model is a
*sparse-view* transformer instead: normally it's fed 6 views synthesized by a diffusion
model (Zero123++) from one input photo, but the transformer is just as happy to take your
own real photos directly, which is what this service does, so the diffusion stage (and its
GPU-hungry dependencies: `diffusers`, `xformers`, `bitsandbytes`) is skipped entirely.

## How many photos, and from what angles

Upload **exactly 6 photos** (4 also works, at lower quality) of the garment, shot roughly
matching the camera rig InstantMesh was trained on: 6 positions spaced 60° apart in a full
circle around the garment, alternating slightly above eye-level and slightly below it.
Concretely, walking around the garment in one direction:

1. Photo 1: slightly above, garment's front-ish
2. Photo 2: slightly below, 60° further around
3. Photo 3: slightly above, 120° around
4. Photo 4: slightly below, 180° around (back)
5. Photo 5: slightly above, 240° around
6. Photo 6: slightly below, 300° around

You don't need a protractor: "roughly evenly spaced around, alternating a bit above and
a bit below" gets you most of the benefit. The closer the real angles match the training
distribution, the better the reconstruction; wildly uneven or repeated angles will still
run but produce a worse mesh. Use a plain, well-lit background, since the service removes it
automatically (`rembg`), same as the previous single-image version did.

If you only have 4 usable photos, the service accepts that too (front, ~90°, ~180°/back,
~270°), dropping 2 of the 6 canonical angles, so expect lower quality than the full 6.

**On a RAM-constrained host (16GB or less shared with other apps), start with 4 photos,
not 6.** The reconstruction transformer's cost scales roughly with (view count × tokens
per view)², so 6 views can peak around 9GB of RAM for a single generation on CPU. On a
16GB machine also running Docker, browsers, and this project's own dev servers, that's
enough to occasionally destabilize the OS network stack mid-generation (observed as the
Node backend getting a bare "fetch failed" even though this service finished and
responded 200 OK, a timing/memory-pressure race, not a logic bug). 4 views cuts token
count by a third and the attention cost roughly in half. If generations are failing with
"Could not reach garment3d-service" on your machine, drop to 4 photos or free up RAM
(close other apps) before generating.

## Constraints (read before debugging something that "should just work")

- **CPU-only.** This host has no CUDA-capable GPU (AMD, not NVIDIA), so inference runs on
  CPU. A single generation is considerably slower than the old single-image TripoSR
  service's "a few minutes": expect it to take a good while longer, since InstantMesh's
  transformer processes 6 full views instead of 1 and runs a heavier reconstruction
  pipeline. This is expected; the tradeoff for actually fusing multiple angles.
- **No `nvdiffrast` / `xatlas`.** InstantMesh's own code imports both at module load time
  in a few files, but only *uses* them for UV texture-map baking (`extract_mesh(...,
  use_texture_map=True)`), a code path this service never calls. Both packages need a
  CUDA/C++ build toolchain to install, which this host doesn't have set up. `patches/
  patch_instantmesh.py` wraps those imports in `try/except ImportError` so the modules
  load fine without them; `server.py` uses `extract_mesh(..., use_texture_map=False)`
  (vertex-colored GLB export) instead, matching InstantMesh's own supported fallback mode.
- **No Zero123++ diffusion stage.** `server.py` never loads `diffusers`'s
  `DiffusionPipeline`: real uploaded photos stand in for the views that stage would
  otherwise synthesize from a single photo. This also means `xformers` and `bitsandbytes`
  (only used by that pipeline) aren't installed.
- **`instant-mesh-base`, not `-large`.** Smaller checkpoint (~1.25GB vs ~1.5GB), less
  compute per generation. Swap `CONFIG_PATH`/`CHECKPOINT_FILE` in `server.py` to
  `instant-mesh-large.yaml` / `instant_mesh_large.ckpt` if you want to trade more CPU time
  for a (likely) better mesh.
- **`grid_res` reduced to 64 (config default is 128).** The mesh-extraction grid
  resolution isn't a learned parameter, just an extraction-time sampling density, but at
  128 it queries ~2.2M points through the geometry MLP in a single uncheckpointed forward
  pass (`get_sdf_deformation_prediction` has no batching), which reliably hard-crashes the
  process on this host's 16GB RAM with no Python traceback, just an OS-level kill. 64
  queries ~275K points (8x fewer) and fits comfortably. If you're running this on a
  machine with more RAM, bump `GRID_RES` in `server.py`'s `load_model()` back toward 128
  for a denser mesh.

## Setup

```bash
cd apps/garment3d-service
./setup.sh
```

This clones InstantMesh into `vendor-instantmesh/` (gitignored, since it's upstream code, not
ours), applies the `try/except` import patches described above, and creates `.venv` with
all dependencies. Re-run any time `vendor-instantmesh/` is missing or the patch needs
reapplying.

Downloaded checkpoints (the ~1.25GB base model, plus `facebook/dino-vitb16`) go to the
Hugging Face cache. Set `HF_HOME` to put that cache on a drive with room for it.

## Running

```bash
cd apps/garment3d-service
.venv/Scripts/activate
uvicorn server:app --host 127.0.0.1 --port 8100
```

First request after a fresh venv triggers a ~1.25GB checkpoint download from Hugging Face
(`TencentARC/InstantMesh`) into the Hugging Face cache; subsequent requests reuse it.

`apps/api`'s `.env` should point `GARMENT3D_SERVICE_URL` at this service and set a
generous `GARMENT3D_SERVICE_TIMEOUT_MS` given the CPU generation time above.
