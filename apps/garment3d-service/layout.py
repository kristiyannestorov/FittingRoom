from dataclasses import dataclass

import numpy as np
from scipy import ndimage

SHOULDER_WIDTH = 0.75

NECK_DIP = 0.88

ARMPIT_WIDEN = 1.2

TORSO_SAMPLE = (0.6, 0.9)

TORSO_WIDTH_SAMPLE = (0.4, 0.95)
TORSO_WIDTH_PERCENTILE = 10

SHOULDER_ABOVE_JOINT_M = 0.065

SLEEVELESS_FULL_WIDTH = 0.95
SLEEVELESS_SHOULDER_WIDTH = 0.6

ARMPIT_MARGIN = 0.15

EDGE_SMOOTH = 0.03

ARMPIT_SETTLE = 0.06

MIN_SLEEVE_AREA = 0.01

SLEEVE_BINS = 24

BACKGROUND, TORSO, LEFT_SLEEVE, RIGHT_SLEEVE, ABOVE_SHOULDERS = range(5)
SLEEVE_LABELS = {"left": LEFT_SLEEVE, "right": RIGHT_SLEEVE}


@dataclass
class Sleeve:
    origin: np.ndarray
    along: np.ndarray
    across: np.ndarray
    t0: float
    t1: float
    lo: np.ndarray
    hi: np.ndarray


@dataclass
class Layout:
    top: float
    armpit: float
    hem: float
    torso_lo: np.ndarray
    torso_hi: np.ndarray
    sleeves: dict[str, Sleeve]
    labels: np.ndarray


def _runs(row: np.ndarray) -> list[tuple[int, int]]:
    padded = np.concatenate([[False], row, [False]])
    edges = np.flatnonzero(np.diff(padded.astype(np.int8)))
    return list(zip(edges[::2], edges[1::2] - 1))


def _central_runs(mask: np.ndarray, center: int) -> tuple[np.ndarray, np.ndarray]:
    lo = np.full(mask.shape[0], np.nan)
    hi = np.full(mask.shape[0], np.nan)
    for r in range(mask.shape[0]):
        for a, b in _runs(mask[r]):
            if a <= center <= b:
                lo[r], hi[r] = a, b
                break
    return lo, hi


def _fill_nan(values: np.ndarray) -> np.ndarray:
    known = np.flatnonzero(~np.isnan(values))
    if len(known) == 0:
        return values
    return np.interp(np.arange(len(values)), known, values[known])


def detect(mask: np.ndarray, armpit: float | None = None, crown: float | None = None) -> Layout | None:
    mask = np.asarray(mask, bool)
    rows = np.flatnonzero(mask.any(axis=1))
    if len(rows) < 32:
        return None
    first, hem = int(rows[0]), int(rows[-1])
    height = hem - first + 1

    sample = mask[first + int(TORSO_SAMPLE[0] * height) : first + int(TORSO_SAMPLE[1] * height)]
    center = int(np.median(np.nonzero(sample)[1]))
    run_lo, run_hi = _central_runs(mask, center)
    widths = run_hi - run_lo + 1

    sampled = widths[first + int(TORSO_WIDTH_SAMPLE[0] * height) : first + int(TORSO_WIDTH_SAMPLE[1] * height)]
    if np.isnan(sampled).all():
        return None
    torso_width = float(np.nanpercentile(sampled, TORSO_WIDTH_PERCENTILE))

    extent = np.where(mask.any(axis=1), mask.shape[1] - mask[:, ::-1].argmax(axis=1) - mask.argmax(axis=1), 0)
    wide = np.flatnonzero(extent >= SHOULDER_WIDTH * torso_width)
    if crown is not None:
        wide = wide[wide >= crown]
    if len(wide) == 0:
        return None
    top = int(wide[0])
    reach = extent[top : hem + 1].astype(np.float64)
    spread = np.flatnonzero(reach >= torso_width)
    reach = reach[: spread[0]] if len(spread) else reach
    neck = np.flatnonzero(reach < NECK_DIP * np.maximum.accumulate(reach))
    if len(neck):
        below = wide[wide > top + neck[-1]]
        if len(below):
            top = int(below[0])

    smooth = max(int(EDGE_SMOOTH * height), 1)
    joined = np.nan_to_num(widths, nan=0.0) > ARMPIT_WIDEN * torso_width
    if armpit is None:
        trend = ndimage.median_filter(joined.astype(np.uint8), size=smooth, mode="nearest").astype(bool)
        start = np.flatnonzero(trend[top : hem + 1])
        if len(start) == 0:
            full = ndimage.median_filter(
                (np.nan_to_num(widths, nan=0.0) >= SLEEVELESS_FULL_WIDTH * torso_width).astype(np.uint8),
                size=smooth, mode="nearest",
            ).astype(bool)
            narrow = np.flatnonzero(extent >= SLEEVELESS_SHOULDER_WIDTH * torso_width)
            top = int(narrow[narrow >= crown][0] if crown is not None else narrow[0])
            reached = np.flatnonzero(full[top : hem + 1])
            if len(reached) == 0:
                return None
            armpit = top + int(reached[0])
        else:
            start = top + int(start[0])
            apart = np.flatnonzero(~trend[start : hem + 1])
            if len(apart) == 0:
                return None
            armpit = start + int(apart[0])
    armpit = int(round(armpit))
    span = hem - top
    if not (top + ARMPIT_MARGIN * span <= armpit <= hem - ARMPIT_MARGIN * span):
        return None

    settle = armpit + int(ARMPIT_SETTLE * span)
    alone = ~joined & ~np.isnan(widths)
    alone[:settle] = False
    if not alone.any():
        return None
    torso_lo = ndimage.median_filter(_fill_nan(np.where(alone, run_lo, np.nan)), size=smooth, mode="nearest")
    torso_hi = ndimage.median_filter(_fill_nan(np.where(alone, run_hi, np.nan)), size=smooth, mode="nearest")

    labels = np.zeros(mask.shape, np.uint8)
    cols = np.arange(mask.shape[1])[None, :]
    inside = (cols >= torso_lo[:, None]) & (cols <= torso_hi[:, None])
    body_rows = np.arange(mask.shape[0])[:, None] >= top
    labels[mask & ~body_rows] = ABOVE_SHOULDERS
    labels[mask & body_rows & inside] = TORSO

    sleeves = {}
    for side, outside in (("left", cols < torso_lo[:, None]), ("right", cols > torso_hi[:, None])):
        region = mask & body_rows & outside
        components, count = ndimage.label(region)
        if count == 0:
            continue
        areas = np.bincount(components.ravel())[1:]
        biggest = int(np.argmax(areas)) + 1
        if areas[biggest - 1] < MIN_SLEEVE_AREA * torso_width * span:
            continue
        sleeve_mask = components == biggest
        sleeve = _sleeve(sleeve_mask, outward=-1 if side == "left" else 1)
        if sleeve is None:
            continue
        sleeves[side] = sleeve
        labels[sleeve_mask] = SLEEVE_LABELS[side]

    return Layout(float(top), float(armpit), float(hem), torso_lo, torso_hi, sleeves, labels)


def _sleeve(mask: np.ndarray, outward: int) -> Sleeve | None:
    points = np.argwhere(mask).astype(np.float64)
    if len(points) < 16:
        return None
    origin = points.mean(axis=0)
    centered = points - origin
    _, vectors = np.linalg.eigh(centered.T @ centered)
    along = vectors[:, -1]
    if along[1] * outward < 0:
        along = -along
    across = np.array([-along[1], along[0]])
    if across[0] > 0:
        across = -across

    t = centered @ along
    s = centered @ across
    t0, t1 = float(t.min()), float(t.max())
    if t1 - t0 < 4:
        return None
    bins = np.clip(((t - t0) / (t1 - t0) * SLEEVE_BINS).astype(int), 0, SLEEVE_BINS - 1)
    lo = np.full(SLEEVE_BINS, np.nan)
    hi = np.full(SLEEVE_BINS, np.nan)
    for b in range(SLEEVE_BINS):
        sel = s[bins == b]
        if len(sel):
            lo[b], hi[b] = sel.min(), sel.max()
    lo, hi = _fill_nan(lo), _fill_nan(hi)
    lo = ndimage.uniform_filter1d(lo, 3, mode="nearest")
    hi = ndimage.uniform_filter1d(hi, 3, mode="nearest")
    return Sleeve(origin, along, across, t0, t1, lo, hi)


def _piecewise(x: np.ndarray, src: tuple[float, ...], dst: tuple[float, ...]) -> np.ndarray:
    src, dst = np.asarray(src, float), np.asarray(dst, float)
    out = np.interp(x, src, dst)
    head = x < src[0]
    out[head] = dst[0] + (x[head] - src[0]) * (dst[1] - dst[0]) / max(src[1] - src[0], 1e-6)
    tail = x > src[-1]
    out[tail] = dst[-1] + (x[tail] - src[-1]) * (dst[-1] - dst[-2]) / max(src[-1] - src[-2], 1e-6)
    return out

LEG_SEARCH_FROM = 0.15
LEG_SPLIT_ROWS = 0.02
LEG_MIN_LENGTH = 0.08
LEG_MAX_CROTCH = 0.7


@dataclass
class Legs:
    top: float
    crotch: float
    hem: float
    lo: np.ndarray
    hi: np.ndarray
    split: np.ndarray
    left: tuple[np.ndarray, np.ndarray]
    right: tuple[np.ndarray, np.ndarray]


def detect_legs(mask: np.ndarray) -> Legs | None:
    mask = np.asarray(mask, bool)
    present = mask.any(axis=1)
    rows = np.flatnonzero(present)
    if len(rows) < 32:
        return None
    top, hem = int(rows[0]), int(rows[-1])
    height = hem - top
    lo = np.where(present, mask.argmax(axis=1), np.nan).astype(float)
    hi = np.where(present, mask.shape[1] - 1 - mask[:, ::-1].argmax(axis=1), np.nan).astype(float)

    need = max(3, int(LEG_SPLIT_ROWS * height))
    crotch, run = None, 0
    for r in range(top + int(LEG_SEARCH_FROM * height), hem + 1):
        middle = int((lo[r] + hi[r]) / 2) if present[r] else 0
        run = run + 1 if present[r] and not mask[r, middle] else 0
        if run >= need:
            crotch = r - run + 1
            break
    if crotch is None or hem - crotch < LEG_MIN_LENGTH * height or crotch - top > LEG_MAX_CROTCH * height:
        return None

    split = np.full(mask.shape[0], np.nan)
    for r in range(crotch, hem + 1):
        runs = _runs(mask[r])
        if len(runs) >= 2:
            gaps = [(runs[i + 1][0] - runs[i][1], (runs[i][1] + runs[i + 1][0]) / 2) for i in range(len(runs) - 1)]
            split[r] = max(gaps)[1]
    split[:crotch] = np.nan
    below = np.arange(mask.shape[0]) >= crotch
    known = np.flatnonzero(~np.isnan(split))
    if len(known) == 0:
        return None
    split[below] = np.interp(np.flatnonzero(below), known, split[known])

    smooth = max(int(EDGE_SMOOTH * height), 1)
    sides = {}
    for side, pick in (("left", lambda c, s: c < s), ("right", lambda c, s: c > s)):
        s_lo = np.full(mask.shape[0], np.nan)
        s_hi = np.full(mask.shape[0], np.nan)
        for r in range(crotch, hem + 1):
            cols = np.flatnonzero(mask[r])
            cols = cols[pick(cols, split[r])]
            if len(cols):
                s_lo[r], s_hi[r] = cols[0], cols[-1]
        if np.isnan(s_lo).all():
            return None
        sides[side] = tuple(
            ndimage.median_filter(_fill_nan(v), size=smooth, mode="nearest") for v in (s_lo, s_hi)
        )
    lo, hi = (ndimage.median_filter(_fill_nan(v), size=smooth, mode="nearest") for v in (lo, hi))
    return Legs(float(top), float(crotch), float(hem), lo, hi, split, sides["left"], sides["right"])


def map_leg_points(src: Legs, dst: Legs, rows: np.ndarray, cols: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    rows = np.asarray(rows, np.float64)
    cols = np.asarray(cols, np.float64)
    out_rows = _piecewise(rows, (src.top, src.crotch, src.hem), (dst.top, dst.crotch, dst.hem))

    def across(c, src_lo, src_hi, dst_lo, dst_hi, r_src, r_dst):
        a, b = _sample_rows(src_lo, r_src), _sample_rows(src_hi, r_src)
        t = (c - a) / np.maximum(b - a, 1e-6)
        lo, hi = _sample_rows(dst_lo, r_dst), _sample_rows(dst_hi, r_dst)
        return lo + t * (hi - lo)

    out_cols = np.empty_like(cols)
    above = rows < src.crotch
    out_cols[above] = across(cols[above], src.lo, src.hi, dst.lo, dst.hi, rows[above], out_rows[above])
    left = ~above & (cols < _sample_rows(src.split, np.maximum(rows, src.crotch)))
    for side, sel in (("left", left), ("right", ~above & ~left)):
        r_src = np.maximum(rows[sel], src.crotch)
        r_dst = np.maximum(out_rows[sel], dst.crotch)
        out_cols[sel] = across(cols[sel], *getattr(src, side), *getattr(dst, side), r_src, r_dst)
    return out_rows, out_cols


def _sample_rows(values: np.ndarray, rows: np.ndarray) -> np.ndarray:
    return np.interp(rows, np.arange(len(values)), values)


def _sleeve_bins(sleeve: Sleeve, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    position = np.clip(t, 0.0, 1.0) * SLEEVE_BINS - 0.5
    grid = np.arange(SLEEVE_BINS)
    return np.interp(position, grid, sleeve.lo), np.interp(position, grid, sleeve.hi)


def map_points(src: Layout, dst: Layout, rows: np.ndarray, cols: np.ndarray):
    rows = np.asarray(rows, np.float64)
    cols = np.asarray(cols, np.float64)
    h, w = src.labels.shape
    r_idx = np.clip(np.round(rows).astype(int), 0, h - 1)
    c_idx = np.clip(np.round(cols).astype(int), 0, w - 1)

    _, (near_r, near_c) = ndimage.distance_transform_edt(src.labels == BACKGROUND, return_indices=True)
    part = src.labels[near_r[r_idx, c_idx], near_c[r_idx, c_idx]]

    out_r = np.zeros_like(rows)
    out_c = np.zeros_like(cols)
    valid = np.ones(len(rows), bool)

    body = (part == TORSO) | (part == ABOVE_SHOULDERS)
    if body.any():
        r = rows[body]
        dst_r = _piecewise(r, (src.top, src.hem), (dst.top, dst.hem))
        s_lo, s_hi = _sample_rows(src.torso_lo, r), _sample_rows(src.torso_hi, r)
        d_lo, d_hi = _sample_rows(dst.torso_lo, dst_r), _sample_rows(dst.torso_hi, dst_r)
        f = (cols[body] - s_lo) / np.maximum(s_hi - s_lo, 1.0)
        out_r[body] = dst_r
        out_c[body] = d_lo + f * (d_hi - d_lo)

    for side, label in SLEEVE_LABELS.items():
        on = part == label
        if not on.any():
            continue
        if side not in src.sleeves or side not in dst.sleeves:
            valid[on] = False
            continue
        a, b = src.sleeves[side], dst.sleeves[side]
        rel = np.stack([rows[on], cols[on]], axis=1) - a.origin
        t = (rel @ a.along - a.t0) / (a.t1 - a.t0)
        s = rel @ a.across
        s_lo, s_hi = _sleeve_bins(a, t)
        f = (s - s_lo) / np.maximum(s_hi - s_lo, 1.0)
        d_lo, d_hi = _sleeve_bins(b, t)
        along = b.t0 + t * (b.t1 - b.t0)
        across = d_lo + f * (d_hi - d_lo)
        point = b.origin + along[:, None] * b.along + across[:, None] * b.across
        out_r[on], out_c[on] = point[:, 0], point[:, 1]

    return out_r, out_c, valid

SILHOUETTE_HEIGHT = 800

SILHOUETTE_MARGIN = 4

ARM_WEIGHT = 0.5


class MeshSilhouette:
    def __init__(self, vertices: np.ndarray, faces: np.ndarray, view: str):
        from PIL import Image, ImageDraw

        self.sign = 1.0 if view == "front" else -1.0
        horizontal = vertices[:, 0] * self.sign
        self.left, self.ceiling = float(horizontal.min()), float(vertices[:, 1].max())
        self.scale = (SILHOUETTE_HEIGHT - 1) / max(float(np.ptp(vertices[:, 1])), 1e-6)

        rows, cols = self.project(vertices)
        size = (int(np.ceil(cols.max())) + SILHOUETTE_MARGIN + 1, int(np.ceil(rows.max())) + SILHOUETTE_MARGIN + 1)
        image = Image.new("1", size, 0)
        draw = ImageDraw.Draw(image)
        for a, b, c in faces:
            draw.polygon([(cols[a], rows[a]), (cols[b], rows[b]), (cols[c], rows[c])], fill=1)
        self.mask = np.asarray(image, bool)

    def project(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        rows = (self.ceiling - points[:, 1]) * self.scale + SILHOUETTE_MARGIN
        cols = (points[:, 0] * self.sign - self.left) * self.scale + SILHOUETTE_MARGIN
        return rows, cols

    def row_of(self, height: float) -> float:
        return (self.ceiling - height) * self.scale + SILHOUETTE_MARGIN


def armhole_lows(positions, faces, bones, weights, joint_names) -> dict[int, float]:
    arm = np.array(["Arm" in name or "Hand" in name for name in joint_names])
    on_arm = (weights * arm[bones]).sum(axis=1) >= ARM_WEIGHT * np.maximum(weights.sum(axis=1), 1e-9)
    edges = np.vstack([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    seam = np.unique(edges[on_arm[edges[:, 0]] != on_arm[edges[:, 1]]])
    center = float(np.median(positions[:, 0]))
    lowest = {}
    for sign in (-1, 1):
        side = seam[(positions[seam, 0] - center) * sign > 0]
        if len(side):
            lowest[sign] = float(positions[side, 1].min())
    return lowest


def crown_height(shoulder_joints) -> float | None:
    heights = [float(j[1]) for j in shoulder_joints if j is not None]
    return (sum(heights) / len(heights) + SHOULDER_ABOVE_JOINT_M) if heights else None


def shoulder_crown(glb_path: str) -> float | None:
    from refit_garments import Glb, Rig

    glb = Glb(glb_path)
    if not glb.gltf.get("skins"):
        return None
    head = Rig(glb).head
    return crown_height([head.get("LeftArm"), head.get("RightArm")])


def armhole_height(glb_path: str, mesh_name: str) -> float | None:
    from refit_garments import Glb

    glb = Glb(glb_path)
    gltf = glb.gltf
    for node in gltf["nodes"]:
        if "mesh" not in node or "skin" not in node:
            continue
        if gltf["meshes"][node["mesh"]].get("name") != mesh_name:
            continue
        joints = [gltf["nodes"][j].get("name", "") for j in gltf["skins"][node["skin"]]["joints"]]
        lowest: dict[int, float] = {}
        for prim in gltf["meshes"][node["mesh"]]["primitives"]:
            attributes = prim["attributes"]
            if "JOINTS_0" not in attributes or "WEIGHTS_0" not in attributes or "indices" not in prim:
                continue
            found = armhole_lows(
                glb.accessor(attributes["POSITION"]),
                glb.accessor(prim["indices"]).reshape(-1, 3).astype(int),
                glb.accessor(attributes["JOINTS_0"]).astype(int),
                glb.accessor(attributes["WEIGHTS_0"]).astype(np.float64),
                joints,
            )
            for sign, low in found.items():
                lowest[sign] = min(lowest.get(sign, np.inf), low)
        if len(lowest) == 2:
            return max(lowest.values())
    return None
