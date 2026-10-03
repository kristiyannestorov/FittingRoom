import argparse
import hashlib
import json
import os

import numpy as np
import rembg
import trimesh
from PIL import Image, ImageOps
from scipy import ndimage
from scipy.cluster.vq import kmeans2
from skimage.color import rgb2lab

import fabric
import garment_details
import garment_pockets
import layout
from delight import convert_to_srgb, neutralize_illuminant
from delight import delight as delight_photo
from garment_profiles import profile_for
from orient import upright_turns

AVATAR_PATH = os.path.join(os.path.dirname(__file__), "avatar-default.glb")
GARMENT_MESH = "Wolf3D_Outfit_Top"

ATLAS_SIZE = 2048

PRODUCT_TYPE_MESH = {
    "T_SHIRT": "Wolf3D_Outfit_Top",
    "LONG_SLEEVE": "Wolf3D_Outfit_Top",
    "HOODIE": "Wolf3D_Outfit_Top",
    "SHORTS": "Wolf3D_Outfit_Bottom",
    "PANTS": "Wolf3D_Outfit_Bottom",
}


GARMENT_LIBRARY_DIR = os.path.join(os.path.dirname(__file__), "garments")

LIBRARY_GARMENT_MESH = "Garment"


def _mesh_names(glb_path: str) -> set[str]:
    with open(glb_path, "rb") as handle:
        handle.read(12)
        chunk_length = int.from_bytes(handle.read(4), "little")
        handle.read(4)
        header = json.loads(handle.read(chunk_length).decode("utf-8"))
    return {mesh.get("name") for mesh in header.get("meshes", [])}

GENDER_LIBRARY_DIR = {"FEMALE": "female"}


def garment_source(
    product_type: str, category: str | None = None, gender: str | None = None, product_slug: str | None = None
) -> tuple[str, str]:
    names = []
    pattern = garment_pockets.pattern_path(product_slug)
    if pattern:
        names.append(pattern)
    if category:
        names.append(f"{product_type.upper()}/{category.upper()}")
    names.append(product_type.upper())

    prefixes = []
    gendered = GENDER_LIBRARY_DIR.get((gender or "").upper())
    if gendered:
        prefixes.append(gendered)
    prefixes.append("")

    for prefix in prefixes:
        for name in names:
            parts = [prefix] if prefix else []
            library_path = os.path.join(GARMENT_LIBRARY_DIR, *parts, *f"{name}.glb".split("/"))
            if not os.path.exists(library_path):
                continue
            if LIBRARY_GARMENT_MESH in _mesh_names(library_path):
                return library_path, LIBRARY_GARMENT_MESH
            return library_path, mesh_for_product_type(product_type)
    return AVATAR_PATH, mesh_for_product_type(product_type)


def library_relative_path(source_path: str) -> str:
    relative = os.path.relpath(source_path, GARMENT_LIBRARY_DIR)
    if relative.startswith(".."):
        return os.path.basename(source_path)
    return relative.replace(os.sep, "/")


def mesh_for_product_type(product_type: str) -> str:
    mesh = PRODUCT_TYPE_MESH.get(product_type.upper())
    if mesh is None:
        raise ValueError(
            f"No avatar garment mesh for product type {product_type!r} "
            f"(supported: {', '.join(sorted(PRODUCT_TYPE_MESH))})"
        )
    return mesh

ROW_BANDS = 96

EXTENT_SMOOTH = 25


CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cutout-cache")

CUTOUT_CACHE_VERSION = 2

COLOR_MAX_DIMENSION = 1600

MASK_INFERENCE_MAX = 640

_REMBG_SESSION = None

DEFAULT_DELIGHT_STRENGTH = 1.0

DEFAULT_WHITE_BALANCE_STRENGTH = 1.0


def release_rembg_session() -> None:
    global _REMBG_SESSION
    _REMBG_SESSION = None


def _rembg_session():
    global _REMBG_SESSION
    if _REMBG_SESSION is None:
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.enable_cpu_mem_arena = False
        options.enable_mem_pattern = False
        _REMBG_SESSION = rembg.new_session(sess_opts=options)
    return _REMBG_SESSION


def load_cutout(
    path: str,
    session_factory,
    cache: bool = True,
    delight_strength: float = DEFAULT_DELIGHT_STRENGTH,
    white_balance_strength: float = DEFAULT_WHITE_BALANCE_STRENGTH,
    product_type: str | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    key = None
    raw: np.ndarray | None = None
    if cache:
        stat = os.stat(path)
        identity = (
            f"{CUTOUT_CACHE_VERSION}|{os.path.abspath(path)}|{stat.st_size}|{int(stat.st_mtime)}"
        )
        key = hashlib.sha256(identity.encode()).hexdigest()[:16] + ".png"
        cached = os.path.join(CACHE_DIR, key)
        if os.path.exists(cached):
            raw = np.asarray(Image.open(cached).convert("RGBA")).astype(np.float32)

    if raw is None:
        im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
        if max(im.size) > COLOR_MAX_DIMENSION:
            im.thumbnail((COLOR_MAX_DIMENSION, COLOR_MAX_DIMENSION), Image.LANCZOS)

        small = im.copy()
        small.thumbnail((MASK_INFERENCE_MAX, MASK_INFERENCE_MAX), Image.LANCZOS)
        mask = rembg.remove(small, session=session_factory(), only_mask=True)
        mask = mask.resize(im.size, Image.BILINEAR)

        cut = im.convert("RGBA")
        cut.putalpha(mask)
        if key:
            os.makedirs(CACHE_DIR, exist_ok=True)
            cut.save(os.path.join(CACHE_DIR, key))
        raw = np.asarray(cut).astype(np.float32)

    with Image.open(path) as source:
        icc_profile = source.info.get("icc_profile")
    if icc_profile:
        raw = raw.copy()
        pixels = Image.fromarray(np.clip(raw[:, :, :3], 0, 255).astype(np.uint8))
        raw[:, :, :3] = np.asarray(convert_to_srgb(pixels, icc_profile), np.float32)

    if white_balance_strength > 0:
        raw = raw.copy()
        raw[:, :, :3] = neutralize_illuminant(
            raw[:, :, :3], raw[:, :, 3] / 255.0, white_balance_strength
        )

    raw = drop_background_leaks(raw)

    turns = upright_turns(isolate_garment(raw)[:, :, 3] > 127, product_type)
    if turns:
        print(f"{os.path.basename(path)} was shot sideways, turning it upright")
        raw = np.ascontiguousarray(np.rot90(raw, turns))

    rgb, alpha = _crop_to_garment(straighten_garment(remove_hanger(raw)), path)
    return delight_photo(rgb, alpha, delight_strength), alpha

LEAK_RING = (0.01, 0.04)
LEAK_BACKGROUND_COLOURS = 6
LEAK_GARMENT_COLOURS = 4
LEAK_GARMENT_MIN_SHARE = 0.15
LEAK_CORE = 0.6
LEAK_BACKGROUND_MATCH = 14.0
LEAK_GARMENT_MISMATCH = 28.0
LEAK_MIN_AREA = 0.01
LEAK_MAX_AREA = 0.35


def _palette(lab: np.ndarray, k: int, min_share: float = 0.0) -> np.ndarray:
    if len(lab) > 20000:
        lab = lab[np.random.default_rng(0).choice(len(lab), 20000, replace=False)]
    centers, labels = kmeans2(lab.astype(np.float64), k, minit="++", seed=0)
    share = np.bincount(labels, minlength=k) / len(labels)
    return centers[share >= min_share]


def _nearest(lab: np.ndarray, centers: np.ndarray) -> np.ndarray:
    return np.min(np.linalg.norm(lab[..., None, :] - centers, axis=-1), axis=-1)


def drop_background_leaks(raw: np.ndarray) -> np.ndarray:
    mask = raw[:, :, 3] > 127
    span = max(mask.shape)
    ring = ndimage.binary_dilation(mask, iterations=int(LEAK_RING[1] * span)) & ~ndimage.binary_dilation(
        mask, iterations=int(LEAK_RING[0] * span)
    )
    depth = ndimage.distance_transform_edt(mask)
    core = depth >= LEAK_CORE * depth.max()
    if ring.sum() < 1000 or core.sum() < 1000:
        return raw

    lab = rgb2lab(np.clip(raw[:, :, :3], 0, 255) / 255.0)
    background = _palette(lab[ring], LEAK_BACKGROUND_COLOURS)
    garment = _palette(lab[core], LEAK_GARMENT_COLOURS, LEAK_GARMENT_MIN_SHARE)
    looks_like_background = (
        mask
        & (_nearest(lab, background) < LEAK_BACKGROUND_MATCH)
        & (_nearest(lab, garment) > LEAK_GARMENT_MISMATCH)
    )
    looks_like_background = ndimage.binary_opening(looks_like_background, iterations=max(int(0.004 * span), 1))

    edge = ndimage.binary_dilation(~mask, iterations=2) & mask
    labels, count = ndimage.label(looks_like_background)
    leak = np.zeros_like(mask)
    for i in range(1, count + 1):
        piece = labels == i
        if piece.sum() >= LEAK_MIN_AREA * mask.sum() and (piece & edge).any():
            leak |= piece
    if not leak.any() or leak.sum() > LEAK_MAX_AREA * mask.sum():
        return raw
    print(f"Dropped {leak.sum() / mask.sum():.0%} of the cutout that matches the background around it")
    out = raw.copy()
    out[leak, 3] = 0
    return out


DEBRIS_MAX_AREA_FRACTION = 0.12

THIN_STRUCTURE_FRACTION = 0.008

MIN_RETAINED_FRACTION = 0.55

HANGER_COLOR_TOLERANCE = 70.0

HANGER_COLOR_SEPARATION = 45.0

HANGER_BLEED_MAX_AREA_FRACTION = 0.04


NECK_WINDOW_DEPTH = 0.14
NECK_WINDOW_HALF_WIDTH = 0.12


def remove_hanger(raw: np.ndarray) -> np.ndarray:
    out = drop_hanger(isolate_garment(raw))
    alpha = raw[:, :, 3] > 127
    kept = out[:, :, 3] > 127
    if kept.sum() == alpha.sum():
        return out

    window = None
    removed_rows = np.where((alpha & ~kept).any(axis=1))[0]
    kept_rows = np.where(kept.any(axis=1))[0]
    if len(removed_rows) and len(kept_rows) and removed_rows[0] < kept_rows[0]:
        hook_cols = np.where((alpha & ~kept)[: kept_rows[0]].any(axis=0))[0]
        if len(hook_cols):
            kept_cols = np.where(kept.any(axis=0))[0]
            pad = int(NECK_WINDOW_HALF_WIDTH * (kept_cols[-1] - kept_cols[0] + 1))
            depth = int(NECK_WINDOW_DEPTH * (kept_rows[-1] - kept_rows[0] + 1))
            window = np.zeros_like(alpha)
            window[
                kept_rows[0] : kept_rows[0] + depth,
                max(hook_cols[0] - pad, 0) : hook_cols[-1] + pad + 1,
            ] = True
    kept = _bleed_hanger_colour(raw, alpha, kept, window)
    if kept.sum() == (out[:, :, 3] > 127).sum():
        return out
    out = out.copy()
    out[~kept, 3] = 0
    return out


def isolate_garment(raw: np.ndarray) -> np.ndarray:
    alpha = raw[:, :, 3] > 127
    if not alpha.any():
        return raw

    radius = max(int(THIN_STRUCTURE_FRACTION * max(alpha.shape)), 1)
    cross = np.ones((3, 3), bool)

    core = ndimage.binary_erosion(alpha, cross, iterations=radius)
    if not core.any():
        return raw

    labels, _ = ndimage.label(core)

    areas = np.bincount(labels.ravel())
    areas[0] = 0
    keep = np.isin(labels, np.flatnonzero(areas >= DEBRIS_MAX_AREA_FRACTION * areas.max()))

    kept = ndimage.binary_dilation(keep, cross, iterations=radius) & alpha
    if kept.sum() < MIN_RETAINED_FRACTION * alpha.sum():
        return raw

    kept = _bleed_hanger_colour(raw, alpha, kept)

    out = raw.copy()
    out[~kept, 3] = 0
    return out


def _bleed_hanger_colour(
    raw: np.ndarray, alpha: np.ndarray, kept: np.ndarray, seed_window: np.ndarray | None = None
) -> np.ndarray:
    removed = alpha & ~kept
    if not removed.any() or not kept.any():
        return kept

    rgb = raw[:, :, :3]
    hanger = np.median(rgb[removed], axis=0)
    garment = np.median(rgb[kept], axis=0)
    if np.linalg.norm(hanger - garment) < HANGER_COLOR_SEPARATION:
        return kept

    to_hanger = np.linalg.norm(rgb - hanger, axis=2)
    to_garment = np.linalg.norm(rgb - garment, axis=2)
    similar = kept & (to_hanger < to_garment) & (to_hanger < HANGER_COLOR_TOLERANCE)

    seed = ndimage.binary_dilation(removed, np.ones((3, 3), bool), iterations=2) & similar
    if seed_window is not None:
        seed |= seed_window & similar
    if not seed.any():
        return kept

    bleed = ndimage.binary_propagation(seed, mask=similar)
    if bleed.sum() > HANGER_BLEED_MAX_AREA_FRACTION * kept.sum():
        return kept
    return kept & ~bleed


HANGER_MAX_WIDTH_FRACTION = 0.35

HANGER_MAX_HEIGHT_FRACTION = 0.30


def drop_hanger(raw: np.ndarray) -> np.ndarray:
    alpha = raw[:, :, 3] > 127
    present = alpha.any(axis=1)
    ys = np.where(present)[0]
    if len(ys) == 0:
        return raw

    first = alpha.argmax(axis=1)
    last = alpha.shape[1] - 1 - alpha[:, ::-1].argmax(axis=1)
    widths = np.where(present, last - first + 1, 0)

    narrow = widths < HANGER_MAX_WIDTH_FRACTION * widths.max()
    cut = int(np.argmin(narrow))

    top, bottom = int(ys[0]), int(ys[-1])
    if cut <= top or cut - top > HANGER_MAX_HEIGHT_FRACTION * (bottom - top + 1):
        return raw

    out = raw.copy()
    out[:cut, :, 3] = 0
    return out


EDGE_EROSION = 0.012

MAX_ROTATION_CORRECTION_DEG = 35.0

MIN_ROTATION_CORRECTION_DEG = 1.0


def _garment_tilt_degrees(mask: np.ndarray) -> float:
    ys, xs = np.where(mask)
    if len(xs) < 2:
        return 0.0

    x = xs - xs.mean()
    y = ys - ys.mean()
    cxx = np.mean(x * x)
    cyy = np.mean(y * y)
    cxy = np.mean(x * y)
    if cxx == cyy and cxy == 0:
        return 0.0

    axis_angle = 0.5 * np.degrees(np.arctan2(2 * cxy, cxx - cyy))
    tilt = axis_angle - 90.0
    return ((tilt + 90) % 180) - 90


def straighten_garment(raw: np.ndarray) -> np.ndarray:
    alpha = raw[:, :, 3] / 255.0
    tilt = _garment_tilt_degrees(alpha > 0.5)
    if abs(tilt) < MIN_ROTATION_CORRECTION_DEG or abs(tilt) > MAX_ROTATION_CORRECTION_DEG:
        return raw

    return ndimage.rotate(raw, tilt, axes=(1, 0), reshape=True, order=1, cval=0.0)


def _crop_to_garment(arr: np.ndarray, path: str) -> tuple[np.ndarray, np.ndarray]:
    alpha = arr[:, :, 3] / 255.0
    ys, xs = np.where(alpha > 0.5)
    if len(ys) == 0:
        raise ValueError(f"Background removal found no garment in {path}")
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    rgb = arr[y0 : y1 + 1, x0 : x1 + 1, :3].astype(np.uint8)
    alpha = alpha[y0 : y1 + 1, x0 : x1 + 1]

    margin = max(2, int(EDGE_EROSION * min(alpha.shape)))
    trusted = ndimage.binary_erosion(alpha > 0.9, iterations=margin, border_value=0)
    return rgb, np.where(trusted, alpha, 0.0)


EDGE_FEATHER = 0.012

FULL_CONFIDENCE_WEIGHT = 0.15


def _edge_feather(alpha: np.ndarray) -> np.ndarray:
    trusted = alpha >= 0.9
    ramp = max(EDGE_FEATHER * max(alpha.shape), 1.0)
    t = np.clip(ndimage.distance_transform_edt(trusted) / ramp, 0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).astype(np.float32)


def build_row_extents(mask: np.ndarray, bands: int) -> np.ndarray:
    h, w = mask.shape
    edges = np.linspace(0, h, bands + 1).astype(int)
    extents = np.full((bands, 2), np.nan)
    for i in range(bands):
        band = mask[edges[i] : max(edges[i + 1], edges[i] + 1)]
        cols = np.where(band.any(axis=0))[0]
        if len(cols):
            extents[i] = [cols.min() / max(w - 1, 1), cols.max() / max(w - 1, 1)]

    return smooth_extents(fill_empty_rows(extents))


def view_u(points: np.ndarray, view: str, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
    axis = 0 if view in ("front", "back") else 2
    u = (points[:, axis] - lo[axis]) / max(hi[axis] - lo[axis], 1e-6)
    return 1.0 - u if view in ("back", "left") else u


def view_v(points: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
    return 1.0 - (points[:, 1] - lo[1]) / max(hi[1] - lo[1], 1e-6)


def mesh_row_extents(
    surface: np.ndarray, view: str, lo: np.ndarray, hi: np.ndarray, bands: int
) -> np.ndarray:
    v = view_v(surface, lo, hi)
    u = view_u(surface, view, lo, hi)

    extents = np.full((bands, 2), np.nan)
    band_of = np.clip((v * bands).astype(int), 0, bands - 1)
    for i in range(bands):
        sel = u[band_of == i]
        if len(sel):
            extents[i] = [sel.min(), sel.max()]

    return smooth_extents(fill_empty_rows(extents))


def fill_empty_rows(extents: np.ndarray) -> np.ndarray:
    populated = np.where(~np.isnan(extents[:, 0]))[0]
    if len(populated) == 0:
        raise ValueError("Silhouette is empty")
    out = extents.copy()
    for i in range(len(out)):
        if np.isnan(out[i, 0]):
            out[i] = extents[populated[np.argmin(np.abs(populated - i))]]
    return out


def smooth_extents(extents: np.ndarray, width: int = EXTENT_SMOOTH) -> np.ndarray:
    kernel = np.ones(width) / width
    padded = np.pad(extents, ((width // 2, width // 2), (0, 0)), mode="edge")
    return np.stack([np.convolve(padded[:, c], kernel, mode="valid") for c in range(2)], axis=1)


def silhouette_centerline(extents: np.ndarray) -> float:
    mid = extents.mean(axis=1)
    return float(np.median(mid[len(mid) // 2 :]))


def sample_extents(extents: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    bands = len(extents)
    t = np.clip(v * (bands - 1), 0, bands - 1)
    lo_i = np.floor(t).astype(int)
    hi_i = np.minimum(lo_i + 1, bands - 1)
    f = (t - lo_i)[:, None]
    blended = extents[lo_i] * (1 - f) + extents[hi_i] * f
    return blended[:, 0], blended[:, 1]


def rasterize_atlas(
    uv: np.ndarray, faces: np.ndarray, verts: np.ndarray, normals: np.ndarray, size: int,
    extra: np.ndarray | None = None,
):
    pos_img = np.zeros((size, size, 3), np.float32)
    nrm_img = np.zeros((size, size, 3), np.float32)
    filled = np.zeros((size, size), bool)
    extra_img = None if extra is None else np.zeros((size, size, extra.shape[1]), np.float32)

    px = uv[:, 0] * (size - 1)
    py = (1.0 - uv[:, 1]) * (size - 1)

    for f in faces:
        a, b, c = f
        x0 = max(int(np.floor(min(px[a], px[b], px[c]))), 0)
        x1 = min(int(np.ceil(max(px[a], px[b], px[c]))), size - 1)
        y0 = max(int(np.floor(min(py[a], py[b], py[c]))), 0)
        y1 = min(int(np.ceil(max(py[a], py[b], py[c]))), size - 1)
        if x1 < x0 or y1 < y0:
            continue

        gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        d = (py[b] - py[c]) * (px[a] - px[c]) + (px[c] - px[b]) * (py[a] - py[c])
        if abs(d) < 1e-12:
            continue
        w0 = ((py[b] - py[c]) * (gx - px[c]) + (px[c] - px[b]) * (gy - py[c])) / d
        w1 = ((py[c] - py[a]) * (gx - px[c]) + (px[a] - px[c]) * (gy - py[c])) / d
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -0.002) & (w1 >= -0.002) & (w2 >= -0.002)
        if not inside.any():
            continue

        ys, xs = gy[inside], gx[inside]
        bw = np.stack([w0[inside], w1[inside], w2[inside]], axis=1)
        pos_img[ys, xs] = bw @ verts[[a, b, c]]
        nrm_img[ys, xs] = bw @ normals[[a, b, c]]
        if extra is not None:
            extra_img[ys, xs] = bw @ extra[[a, b, c]]
        filled[ys, xs] = True

    _pad_atlas(uv, faces, verts, normals, size, pos_img, nrm_img, filled, extra, extra_img)
    if extra is not None:
        return pos_img, nrm_img, filled, extra_img
    return pos_img, nrm_img, filled

ATLAS_PAD = 2.0


def _pad_atlas(uv, faces, verts, normals, size, pos_img, nrm_img, filled, extra=None, extra_img=None) -> None:
    px = uv[:, 0] * (size - 1)
    py = (1.0 - uv[:, 1]) * (size - 1)
    interior = filled.copy()
    best = np.full((size, size), np.inf, np.float32)
    reach = int(np.ceil(ATLAS_PAD))

    for f in faces:
        a, b, c = f
        x0 = max(int(np.floor(min(px[a], px[b], px[c]))) - reach, 0)
        x1 = min(int(np.ceil(max(px[a], px[b], px[c]))) + reach, size - 1)
        y0 = max(int(np.floor(min(py[a], py[b], py[c]))) - reach, 0)
        y1 = min(int(np.ceil(max(py[a], py[b], py[c]))) + reach, size - 1)
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        free = ~interior[y0 : y1 + 1, x0 : x1 + 1]
        if not free.any():
            continue
        gx, gy = gx[free], gy[free]

        tri = np.array([[px[a], py[a]], [px[b], py[b]], [px[c], py[c]]])
        bw = _closest_barycentric(np.stack([gx, gy], axis=1).astype(np.float64), tri)
        nearest = bw @ tri
        dist = np.hypot(gx - nearest[:, 0], gy - nearest[:, 1])
        take = (dist <= ATLAS_PAD) & (dist < best[gy, gx])
        if not take.any():
            continue
        gx, gy, bw = gx[take], gy[take], bw[take]
        best[gy, gx] = dist[take]
        pos_img[gy, gx] = bw @ verts[[a, b, c]]
        nrm_img[gy, gx] = bw @ normals[[a, b, c]]
        if extra is not None:
            extra_img[gy, gx] = bw @ extra[[a, b, c]]
        filled[gy, gx] = True


def _closest_barycentric(points: np.ndarray, tri: np.ndarray) -> np.ndarray:
    a, b, c = tri
    v0, v1 = b - a, c - a
    d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
    denom = d00 * d11 - d01 * d01
    rel = points - a
    if abs(denom) < 1e-12:
        nearest = np.argmin(np.linalg.norm(points[:, None, :] - tri[None], axis=2), axis=1)
        return np.eye(3)[nearest]
    d20, d21 = rel @ v0, rel @ v1
    v = (d11 * d20 - d01 * d21) / denom
    w = (d00 * d21 - d01 * d20) / denom
    weights = np.stack([1.0 - v - w, v, w], axis=1)
    outside = (weights < 0).any(axis=1)
    if outside.any():
        candidates = []
        for i, j in ((0, 1), (1, 2), (2, 0)):
            edge = tri[j] - tri[i]
            t = np.clip(((points[outside] - tri[i]) @ edge) / max(edge @ edge, 1e-12), 0.0, 1.0)
            bw = np.zeros((outside.sum(), 3))
            bw[:, i] = 1.0 - t
            bw[:, j] = t
            candidates.append(bw)
        stacked = np.stack(candidates)
        dists = np.linalg.norm(points[outside][None] - stacked @ tri, axis=2)
        weights[outside] = stacked[np.argmin(dists, axis=0), np.arange(outside.sum())]
    return weights


GRAIN_SCALE = 0.002

GRAIN_LIMIT = 4.0

DETAIL_FADE_DISTANCE = 0.035


def _downsample(a: np.ndarray) -> np.ndarray:
    h, w = a.shape[:2]
    h2, w2 = h // 2, w // 2
    a = a[: h2 * 2, : w2 * 2]
    if a.ndim == 3:
        return a.reshape(h2, 2, w2, 2, a.shape[2]).mean(axis=(1, 3))
    return a.reshape(h2, 2, w2, 2).mean(axis=(1, 3))


def _upsample(a: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    out = np.repeat(np.repeat(a, 2, axis=0), 2, axis=1)
    pad = [(0, max(shape[0] - out.shape[0], 0)), (0, max(shape[1] - out.shape[1], 0))]
    out = np.pad(out, pad + [(0, 0)] * (out.ndim - 2), mode="edge")[: shape[0], : shape[1]]
    size = (3, 3, 1) if out.ndim == 3 else 3
    return ndimage.uniform_filter(out, size=size, mode="nearest")


def _pyramid_fill(img: np.ndarray, known: np.ndarray) -> np.ndarray:
    values = [img * known[:, :, None]]
    weights = [known.astype(np.float32)]
    while min(values[-1].shape[:2]) > 2:
        values.append(_downsample(values[-1]))
        weights.append(_downsample(weights[-1]))

    out = values[-1] / np.maximum(weights[-1], 1e-6)[:, :, None]
    for level in range(len(values) - 2, -1, -1):
        weight = np.clip(weights[level], 0.0, 1.0)[:, :, None]
        here = values[level] / np.maximum(weights[level], 1e-6)[:, :, None]
        out = here * weight + _upsample(out, here.shape[:2]) * (1.0 - weight)
    return out


def fill_uncovered(img: np.ndarray, confidence: np.ndarray) -> np.ndarray:
    confidence = np.clip(np.asarray(confidence, np.float32), 0.0, 1.0)
    if (confidence >= 1.0).all():
        return img
    known = confidence >= 0.5
    if not known.any():
        known = confidence > 0.0

    base = _pyramid_fill(img, confidence)

    radius = max(int(GRAIN_SCALE * max(img.shape[:2])), 1)
    weight = known.astype(np.float32)
    local = ndimage.uniform_filter(
        img * weight[:, :, None], size=(2 * radius + 1, 2 * radius + 1, 1)
    ) / np.maximum(ndimage.uniform_filter(weight, size=2 * radius + 1), 1e-6)[:, :, None]
    grain = np.clip(img - local, -GRAIN_LIMIT, GRAIN_LIMIT)

    distance, nearest = ndimage.distance_transform_edt(
        ~known, return_distances=True, return_indices=True
    )
    drift = np.clip(distance / max(DETAIL_FADE_DISTANCE * max(img.shape[:2]), 1.0), 0.0, 1.0)

    radius = max(int(DETAIL_FADE_DISTANCE * max(img.shape[:2])), 2)
    plain = ndimage.uniform_filter(base, size=(2 * radius + 1, 2 * radius + 1, 1))
    fade = drift[:, :, None]
    out = base * (1.0 - fade) + plain * fade
    out = out + grain[nearest[0], nearest[1]] * (1.0 - fade)

    c = confidence[:, :, None]
    return img * c + out * (1.0 - c)


def paint_cloth(
    cloth: fabric.Cloth,
    ink_accum: np.ndarray,
    ink_weight: np.ndarray,
    detail_accum: np.ndarray,
    weight_sum: np.ndarray,
    confidence: np.ndarray,
) -> np.ndarray:
    share = np.divide(ink_weight, weight_sum, out=np.zeros_like(weight_sum), where=weight_sum > 1e-3)
    ink = np.clip(share * confidence, 0.0, 1.0)[:, :, None]
    ink_rgb = ink_accum / np.maximum(ink_weight, 1e-6)[:, :, None]
    detail = np.divide(detail_accum, weight_sum, out=np.zeros_like(weight_sum), where=weight_sum > 1e-3)
    plain = cloth.colour[None, None, :] * np.exp(detail * confidence)[:, :, None]
    return plain * (1.0 - ink) + ink_rgb * ink


HARMONIZE_CHROMA_RAMP = (0.08, 0.16)

MAX_HARMONIZE_GAIN = 1.25


def harmonize_views(
    cutouts: dict[str, tuple[np.ndarray, np.ndarray]],
) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    if len(cutouts) < 2:
        return cutouts

    medians = {}
    for name, (rgb, alpha) in cutouts.items():
        trusted = alpha >= 0.9
        if trusted.sum() < 256:
            return cutouts
        medians[name] = np.maximum(np.median(rgb[trusted], axis=0), 1.0)

    chroma = {k: m / m.mean() for k, m in medians.items()}
    spread = max(
        np.abs(chroma[a] - chroma[b]).max() for a in chroma for b in chroma if a < b
    )
    lo, hi = HARMONIZE_CHROMA_RAMP
    t = float(np.clip((hi - spread) / (hi - lo), 0.0, 1.0))
    if t <= 0.0:
        return cutouts

    target = np.exp(np.mean([np.log(m) for m in medians.values()], axis=0))
    out = {}
    for name, (rgb, alpha) in cutouts.items():
        gain = np.clip(
            (target / medians[name]) ** t, 1.0 / MAX_HARMONIZE_GAIN, MAX_HARMONIZE_GAIN
        )
        out[name] = (np.clip(rgb * gain, 0.0, 255.0), alpha)
    return out

LABEL_WINDOW_DEPTH = 0.16

LABEL_WINDOW_HALF_WIDTH = 0.14

LABEL_LIGHTNESS = 0.5

LABEL_MAX_AREA_FRACTION = 0.015

LABEL_MIN_AREA_FRACTION = 0.0002

LABEL_GROW = 0.006


def remove_neck_label(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    garment = alpha > 0.5
    rows = np.where(garment.any(axis=1))[0]
    if len(rows) < 2:
        return rgb
    h, w = garment.shape
    top, height = rows[0], rows[-1] - rows[0] + 1
    center = int(round(silhouette_centerline(build_row_extents(garment, ROW_BANDS)) * (w - 1)))
    half = int(LABEL_WINDOW_HALF_WIDTH * w)
    window = np.zeros_like(garment)
    window[top : top + int(LABEL_WINDOW_DEPTH * height), max(center - half, 0) : center + half + 1] = True

    rgb = np.asarray(rgb, np.float32)
    luminance = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    fabric = float(np.median(luminance[garment]))
    light = garment & (luminance > fabric + LABEL_LIGHTNESS * (255.0 - fabric))

    labels, count = ndimage.label(light, np.ones((3, 3), bool))
    area = garment.sum()
    region = np.zeros_like(garment)
    for index, box in enumerate(ndimage.find_objects(labels), start=1):
        component = labels[box] == index
        size = component.sum()
        if not LABEL_MIN_AREA_FRACTION * area <= size <= LABEL_MAX_AREA_FRACTION * area:
            continue
        if window[box][component].all():
            region[box] |= component
    if not region.any():
        return rgb

    grow = max(int(LABEL_GROW * max(h, w)), 1)
    region = ndimage.binary_dilation(region, np.ones((3, 3), bool), iterations=grow) & garment
    print(f"Painted over a neck label: {region.sum() / area:.2%} of the front photo's garment")
    filled = fill_uncovered(rgb, (garment & ~region).astype(np.float32))
    return np.where(region[:, :, None], filled, rgb)


def remove_drawstrings(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    top = layout.detect(alpha > 0.5)
    if top is None:
        return rgb
    rows = slice(int(top.armpit), int(top.hem))
    width = float(np.nanmedian(top.torso_hi[rows] - top.torso_lo[rows]))
    centre = float(np.nanmedian((top.torso_hi[rows] + top.torso_lo[rows]) / 2))
    region = garment_details.drawstring_mask(rgb, alpha, top.top, top.hem, centre, width)
    if not region.any():
        return rgb
    garment = alpha > 0.5
    print(f"Painted over the photo's drawstrings: {region.sum() / garment.sum():.2%} of the front photo's garment")
    filled = fill_uncovered(rgb, (garment & ~region).astype(np.float32))
    return np.where(region[:, :, None], filled, rgb)

PART_VIEWS = ("front", "back")


def _part_layouts(
    cutouts: dict[str, tuple[np.ndarray, np.ndarray]],
    vertices: np.ndarray,
    faces: np.ndarray,
    source_path: str,
    mesh_name: str,
) -> dict[str, tuple[layout.MeshSilhouette, layout.Layout, layout.Layout]]:
    armhole = layout.armhole_height(source_path, mesh_name)
    crown = layout.shoulder_crown(source_path)
    out = {}
    for view in PART_VIEWS:
        if view not in cutouts:
            continue
        photo = layout.detect(cutouts[view][1] > 0.5)
        silhouette = layout.MeshSilhouette(vertices, faces, view)
        mesh = layout.detect(
            silhouette.mask,
            silhouette.row_of(armhole) if armhole is not None else None,
            silhouette.row_of(crown) if crown is not None else None,
        )
        if photo is None or mesh is None:
            unread = "photo" if photo is None else "mesh"
            print(f"The {view} {unread} doesn't read as a top, mapping the {view} view by height")
            continue
        missing = sorted(set(mesh.sleeves) - set(photo.sleeves))
        print(
            f"Matching the {view} view part to part: shoulders at row {photo.top:.0f}, armpit "
            f"{photo.armpit:.0f}, hem {photo.hem:.0f}, sleeves {sorted(photo.sleeves)}"
            + (f" (no {' or '.join(missing)} sleeve found, it will be filled in)" if missing else "")
        )
        out[view] = (silhouette, mesh, photo)
    return out


def _leg_layouts(
    cutouts: dict[str, tuple[np.ndarray, np.ndarray]], vertices: np.ndarray, faces: np.ndarray
) -> dict[str, tuple[layout.MeshSilhouette, layout.Legs, layout.Legs]]:
    out = {}
    for view in PART_VIEWS:
        if view not in cutouts:
            continue
        photo = layout.detect_legs(cutouts[view][1] > 0.5)
        silhouette = layout.MeshSilhouette(vertices, faces, view)
        mesh = layout.detect_legs(silhouette.mask)
        if photo is None or mesh is None:
            unread = "photo" if photo is None else "mesh"
            print(f"The {view} {unread} has no legs to match, mapping the {view} view by height")
            continue
        share = lambda legs: (legs.crotch - legs.top) / max(legs.hem - legs.top, 1.0)
        print(
            f"Matching the {view} view leg to leg: crotch {share(photo):.0%} of the way down the "
            f"photo, {share(mesh):.0%} down the mesh"
        )
        out[view] = (silhouette, mesh, photo)
    return out

DEPTH_CELL = 0.01

HORIZONTAL_FACING_FLOOR = 0.3


def _outward_normals(pos_img: np.ndarray, nrm_img: np.ndarray, filled: np.ndarray) -> np.ndarray:
    p = pos_img[filled]
    lo = p[:, :2].min(axis=0)
    shape = tuple((np.ceil((p[:, :2].max(axis=0) - lo) / DEPTH_CELL)).astype(int) + 1)
    cells = lambda xy: tuple(np.clip(((xy - lo) / DEPTH_CELL).astype(int), 0, np.array(shape) - 1).T)

    near = np.full(shape, -np.inf)
    far = np.full(shape, np.inf)
    at = cells(p[:, :2])
    np.maximum.at(near, at, p[:, 2])
    np.minimum.at(far, at, p[:, 2])
    near = ndimage.maximum_filter(near, size=3)
    far = ndimage.minimum_filter(far, size=3)
    known = np.isfinite(near)
    _, (ni, nj) = ndimage.distance_transform_edt(~known, return_indices=True)
    middle = (near[ni, nj] + far[ni, nj]) / 2

    out = nrm_img.copy()
    n = out[filled]
    front = p[:, 2] > middle[cells(p[:, :2])]
    inward = (n[:, 2] > 0) != front
    n[inward] = -n[inward]
    out[filled] = n
    print(f"Turned {inward.mean():.0%} of the texels' normals outward (inner shell)")
    return out


def bake(
    photos: dict[str, str],
    out_path: str,
    size: int = ATLAS_SIZE,
    cache: bool = True,
    mesh_name: str = GARMENT_MESH,
    source_path: str = AVATAR_PATH,
    delight_strength: float = DEFAULT_DELIGHT_STRENGTH,
    white_balance_strength: float = DEFAULT_WHITE_BALANCE_STRENGTH,
    product_type: str | None = None,
    category: str | None = None,
    separate_cloth: bool = False,
) -> str:
    profile = profile_for(product_type, category)
    cutouts = {
        k: load_cutout(
            p,
            _rembg_session,
            cache=cache,
            delight_strength=delight_strength,
            white_balance_strength=white_balance_strength,
            product_type=product_type,
        )
        for k, p in photos.items()
    }

    cutouts = harmonize_views(cutouts)
    if "front" in cutouts and profile.neck_label:
        rgb, alpha = cutouts["front"]
        cutouts["front"] = (remove_neck_label(rgb, alpha), alpha)
    if "front" in cutouts and profile.drawstrings:
        rgb, alpha = cutouts["front"]
        cutouts["front"] = (remove_drawstrings(rgb, alpha), alpha)
    if profile.seam_lines:
        cutouts = {k: (garment_details.emphasize_seams(rgb, alpha), alpha) for k, (rgb, alpha) in cutouts.items()}
    cloth = fabric.analyse(cutouts) if separate_cloth else None

    scene = trimesh.load(source_path, process=False)
    if mesh_name not in scene.geometry:
        raise ValueError(
            f"{os.path.basename(source_path)} has no mesh {mesh_name!r} "
            f"(has: {', '.join(sorted(scene.geometry))})"
        )
    mesh = scene.geometry[mesh_name]
    uv = np.asarray(mesh.visual.uv)

    details = garment_details.read_attributes(source_path, mesh_name) if source_path != AVATAR_PATH else {}
    details = {k: v for k, v in details.items() if len(v) == len(mesh.vertices)}
    faces = garment_details.outside_faces(np.asarray(mesh.faces), details)
    detail_names = sorted(details)
    pos_img, nrm_img, filled, *detail_img = rasterize_atlas(
        uv, faces, np.asarray(mesh.vertices), np.asarray(mesh.vertex_normals), size,
        np.concatenate([details[k] for k in detail_names], axis=1) if details else None,
    )
    detail_maps = {}
    if detail_img:
        at = 0
        for k in detail_names:
            detail_maps[k] = detail_img[0][:, :, at : at + details[k].shape[1]]
            at += details[k].shape[1]
    print(f"Atlas texels covered by the UV layout: {filled.sum()}/{size * size}")

    view_axes = {
        "front": np.array([0.0, 0.0, 1.0]),
        "back": np.array([0.0, 0.0, -1.0]),
        "right": np.array([1.0, 0.0, 0.0]),
        "left": np.array([-1.0, 0.0, 0.0]),
    }

    verts = np.asarray(mesh.vertices)
    lo, hi = verts.min(axis=0), verts.max(axis=0)
    surface = pos_img[filled]
    nrm_img = _outward_normals(pos_img, nrm_img, filled)
    facing = nrm_img * np.array([1.0, 0.0, 1.0], np.float32)
    facing /= np.maximum(np.linalg.norm(facing, axis=2, keepdims=True), HORIZONTAL_FACING_FLOOR)
    part_views = (
        _part_layouts(cutouts, verts, faces, source_path, mesh_name)
        if profile.map_parts
        else {}
    )
    leg_views = _leg_layouts(cutouts, verts, faces) if profile.map_legs else {}

    accum = np.zeros((size, size, 3), np.float32)
    weight_sum = np.zeros((size, size), np.float32)
    ink_accum = np.zeros((size, size, 3), np.float32)
    ink_weight = np.zeros((size, size), np.float32)
    detail_accum = np.zeros((size, size), np.float32)

    for name, axis in view_axes.items():
        if name not in cutouts:
            continue
        rgb, alpha = cutouts[name]
        trusted_rows = np.where((alpha >= 0.9).any(axis=1))[0]
        if len(trusted_rows) < 2:
            continue

        w = np.clip(facing @ axis, 0, None) ** 1.5
        active = filled & (w > 1e-3)
        if not active.any():
            continue

        p = pos_img[active]
        valid = None
        if name in part_views:
            silhouette, mesh_layout, photo_layout = part_views[name]
            rows, cols = silhouette.project(p)
            photo_r, photo_c, valid = layout.map_points(mesh_layout, photo_layout, rows, cols)
            coords = np.stack([photo_r, photo_c])
        elif name in leg_views:
            silhouette, mesh_legs, photo_legs = leg_views[name]
            rows, cols = silhouette.project(p)
            coords = np.stack(layout.map_leg_points(mesh_legs, photo_legs, rows, cols))
        else:
            coords = _height_coords(p, name, alpha, trusted_rows, surface, lo, hi)
        sampled = np.stack(
            [
                ndimage.map_coordinates(rgb[:, :, c], coords, order=1, mode="nearest")
                for c in range(3)
            ],
            axis=1,
        ).astype(np.float32)
        feather = ndimage.map_coordinates(
            _edge_feather(alpha), coords, order=1, mode="constant", cval=0.0
        )

        wa = w[active] * feather
        if valid is not None:
            wa = wa * valid
        idx = np.where(active)
        accum[idx[0], idx[1]] += sampled * wa[:, None]
        weight_sum[idx[0], idx[1]] += wa
        if cloth is not None and name in cloth.views:
            layers = cloth.views[name]
            ink = ndimage.map_coordinates(layers.ink, coords, order=1, mode="constant") * wa
            ink_accum[idx[0], idx[1]] += sampled * ink[:, None]
            ink_weight[idx[0], idx[1]] += ink
            detail_accum[idx[0], idx[1]] += (
                ndimage.map_coordinates(layers.detail, coords, order=1, mode="constant") * wa
            )

    covered = weight_sum > 1e-3
    out = np.zeros((size, size, 3), np.float32)
    out[covered] = accum[covered] / weight_sum[covered, None]
    confidence = np.clip(weight_sum / FULL_CONFIDENCE_WEIGHT, 0.0, 1.0)
    print(
        f"Texels colored from photos: {covered.sum()}/{filled.sum()} covered by UV "
        f"({(confidence[filled] >= 1.0).mean():.0%} with full confidence)"
    )

    if cloth is not None:
        out = paint_cloth(cloth, ink_accum, ink_weight, detail_accum, weight_sum, confidence)
    else:
        out = fill_uncovered(out, confidence)
    if "_RIB" in detail_maps:
        out = garment_details.paint_ribs(out, detail_maps["_RIB"], filled)
    if "_PART" in detail_maps:
        out = garment_details.paint_cords(out, detail_maps["_PART"], pos_img, filled, confidence)
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(out_path)
    print(f"Wrote {out_path} (baked for {mesh_name} of {os.path.basename(source_path)})")
    return out_path


def _height_coords(
    p: np.ndarray,
    view: str,
    alpha: np.ndarray,
    trusted_rows: np.ndarray,
    surface: np.ndarray,
    lo: np.ndarray,
    hi: np.ndarray,
) -> np.ndarray:
    ph, pw = alpha.shape
    v_lo = trusted_rows[0] / max(ph - 1, 1)
    v_hi = trusted_rows[-1] / max(ph - 1, 1)

    photo_rows = build_row_extents(alpha > 0.5, ROW_BANDS)
    mesh_rows = mesh_row_extents(surface, view, lo, hi, ROW_BANDS)
    photo_center = silhouette_centerline(photo_rows)
    mesh_center = silhouette_centerline(mesh_rows)

    v = v_lo + view_v(p, lo, hi) * (v_hi - v_lo)
    u = view_u(p, view, lo, hi)

    m_lo, m_hi = sample_extents(mesh_rows, v)
    p_lo, p_hi = sample_extents(photo_rows, v)
    scale = (p_hi - p_lo) / np.maximum(m_hi - m_lo, 1e-6)
    u = photo_center + (u - mesh_center) * scale
    return np.stack([v * (ph - 1), u * (pw - 1)])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--front", required=True)
    ap.add_argument("--back")
    ap.add_argument("--left")
    ap.add_argument("--right")
    ap.add_argument("--out", default="baked-garment-texture.png")
    ap.add_argument("--size", type=int, default=ATLAS_SIZE)
    ap.add_argument(
        "--product-type",
        default="T_SHIRT",
        help=f"decides which avatar mesh is painted ({', '.join(sorted(PRODUCT_TYPE_MESH))})",
    )
    ap.add_argument("--category", help="preferred over --product-type when picking the shape")
    ap.add_argument(
        "--delight-strength",
        type=float,
        default=DEFAULT_DELIGHT_STRENGTH,
        help="how hard to flatten photographed folds and shadows: 0 disables, "
        "1 removes the full estimated field (default: %(default)s)",
    )
    ap.add_argument(
        "--white-balance-strength",
        type=float,
        default=DEFAULT_WHITE_BALANCE_STRENGTH,
        help="how hard to remove the light's own colour cast: 0 disables "
        "(default: %(default)s)",
    )
    ap.add_argument(
        "--separate-cloth",
        action="store_true",
        help="paint one cloth colour with the prints and fine detail laid over it "
        "(fabric.py), instead of the photos as they are",
    )
    args = ap.parse_args()

    photos = {k: getattr(args, k) for k in ("front", "back", "left", "right") if getattr(args, k)}
    source_path, mesh_name = garment_source(args.product_type, args.category)
    bake(
        photos,
        args.out,
        args.size,
        mesh_name=mesh_name,
        source_path=source_path,
        delight_strength=args.delight_strength,
        white_balance_strength=args.white_balance_strength,
        product_type=args.product_type,
        category=args.category,
        separate_cloth=args.separate_cloth,
    )


if __name__ == "__main__":
    main()
