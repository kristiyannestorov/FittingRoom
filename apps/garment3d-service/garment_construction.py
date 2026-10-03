from __future__ import annotations

import io

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

import drape as cloth
import garment_pockets as pockets_spec
import layout

REFERENCE_SMOOTH_PASSES = 15
EDGE_SMOOTH_PASSES = 12
EDGE_FADE_PASSES = 4

CRUMPLE_FOLD_DEG = 110.0
CRUMPLE_GROW_PASSES = 4
CRUMPLE_SMOOTH_PASSES = 30

ARMPIT_ZONE_M = (0.07, 0.15)
ARMPIT_ITERATIONS = 400
ARMPIT_CLEARANCE_M = 0.012
ARMPIT_MIN_GAP_M = 0.016
ARMPIT_ALONG_ARM_M = 0.10

HOOD_SMOOTH_PASSES = 40
HOOD_WEIGHT_FULL = 0.45

SLEEVE_GAP_PROFILE = ((0.35, 0.030), (0.75, 0.031), (1.0, 0.030), (1.45, 0.021), (1.8, 0.016))
SLEEVE_SCALE_LIMITS = (0.55, 2.4)
SLEEVE_FROM = 0.25

STACK_AMPLITUDE_M = 0.0045
STACK_WAVELENGTH_M = 0.036
STACK_LENGTH_M = 0.13
ELBOW_CREASE_M = 0.0025
ELBOW_BAG_M = 0.004
ARMPIT_AMPLITUDE_M = 0.0045
ARMPIT_FOLDS = 5
ARMPIT_REACH_M = (0.02, 0.07, 0.17)
GATHER_AMPLITUDE_M = 0.0035
GATHER_WAVELENGTH_M = 0.055
GATHER_REACH_M = 0.07
LOWER_BACK_AMPLITUDE_M = 0.0022
LOWER_BACK_WAVELENGTH_M = 0.045
FOLD_GEOMETRY_PASSES = 3

POCKET_ABOVE_BAND_M = 0.012
POCKET_HEIGHT = 0.95
POCKET_HALF_BOTTOM = 0.68
POCKET_HALF_TOP = 0.45
POCKET_SEWN_SIDE = 0.24
POCKET_OPENING_BOW = 0.06
POCKET_STANDOFF_M = 0.0035
POCKET_SAG_M = 0.006
POCKET_GAPE_M = 0.013
POCKET_GRID = (36, 48)

WELT_GRID = (40, 6)
WELT_STANDOFF_M = 0.0025
WELT_GAPE_M = 0.0035
WELT_THICKNESS_M = 0.0035

ZIP_GRID = (60, 8)
ZIP_STANDOFF_M = 0.003
ZIP_TEETH_RISE_M = 0.0012
ZIP_THICKNESS_M = 0.0025
ZIP_TOOTH_PITCH_M = 0.004
ZIP_TEETH_HALF_M = 0.004
ZIP_TOOTH_M = 0.0007
ZIP_STITCH_IN_M = 0.002

FLEECE_THICKNESS_M = 0.0026
RIB_THICKNESS_M = 0.0042
HOOD_CHANNEL_THICKNESS_M = 0.0048
HOOD_CHANNEL_M = 0.028
POCKET_HEM_THICKNESS_M = 0.0040
POCKET_HEM_M = 0.02
INNER_CLEARANCE_M = 0.0015
CLOSURE_THICKNESS_M = 0.0006
CLOSURE_HALF_WIDTH_M = 0.055

AO_VOXEL_M = 0.004
AO_RAYS = 48
AO_REACH_M = 0.22
AO_START_M = 0.007
AO_FLOOR = 0.38
AO_GAMMA = 0.85

NORMAL_MAP_SIZE = 2048
NORMAL_MAP_QUALITY = 92
SEAM_GROOVE_M = (0.0006, 0.0012)
SEAM_PUFF_M = (0.0005, 0.0035, 0.002)
STITCH_M = (0.0003, 0.006, 0.0007, 0.004)
RIB_WALE_M = 0.0007
CHANNEL_RISE_M = 0.0012
EYELET_M = (0.0009, 0.0055, 0.0013)
FLEECE_MOTTLE_M = (0.00022, 0.016)

LAYER_COLUMN = 2
POCKET_COLUMN = 3

C_POS = slice(0, 3)
C_HOOD = 3
C_HOOD_EDGE = 4
C_POCKET_U = 5
C_POCKET_V = 6
C_POCKET = 7
C_COUNT = 8


def _smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def _adjacency(tris, weld, n):
    w = weld[tris]
    edges = np.concatenate([w[:, [0, 1]], w[:, [1, 2]], w[:, [2, 0]]])
    edges = np.concatenate([edges, edges[:, ::-1]])
    degree = np.bincount(edges[:, 0], minlength=n).astype(np.float64)
    return edges, degree


def _diffuse(field, edges, degree, weld, passes, pinned=None):
    field = field[weld].astype(np.float64)
    has = degree > 0
    keep = field.copy() if pinned is not None else None
    for _ in range(passes):
        total = np.zeros_like(field)
        np.add.at(total, edges[:, 0], field[edges[:, 1]])
        average = field.copy()
        average[has] = total[has] / degree[has].reshape(-1, *([1] * (field.ndim - 1)))
        field = (0.5 * field + 0.5 * average)[weld]
        if pinned is not None:
            field[pinned] = keep[pinned]
    return field


class ArmFrame:
    def __init__(self, rig, side: str):
        self.side = side
        self.shoulder = rig.head[f"{side}Arm"]
        self.elbow = rig.head[f"{side}ForeArm"]
        self.wrist = rig.head[f"{side}Hand"]
        self.upper = np.linalg.norm(self.elbow - self.shoulder)
        self.lower = np.linalg.norm(self.wrist - self.elbow)

    def __call__(self, points):
        u1 = (self.elbow - self.shoulder) / self.upper
        u2 = (self.wrist - self.elbow) / self.lower
        t1 = (points - self.shoulder) @ u1
        t2 = np.clip((points - self.elbow) @ u2, 0.0, None)
        f1 = self.shoulder + np.minimum(t1, self.upper)[:, None] * u1
        f2 = self.elbow + t2[:, None] * u2
        d1 = np.linalg.norm(points - f1, axis=1)
        d2 = np.linalg.norm(points - f2, axis=1)
        lower = (d2 < d1) & (t1 > 0.5 * self.upper)
        blend = _smoothstep((t1 - (self.upper - 0.04)) / 0.08)
        axis = u1[None, :] * (1 - blend[:, None]) + u2[None, :] * blend[:, None]
        axis /= np.linalg.norm(axis, axis=1, keepdims=True)
        s = np.where(lower, self.upper + t2, t1)
        foot = np.where(lower[:, None], f2, f1)
        radial = points - foot
        radial -= np.einsum("ij,ij->i", radial, axis)[:, None] * axis
        r = np.linalg.norm(radial, axis=1)
        up = np.array([0.0, 1.0, 0.0]) - axis[:, 1:2] * axis
        up /= np.maximum(np.linalg.norm(up, axis=1, keepdims=True), 1e-9)
        forward = np.cross(axis, up)
        forward *= np.sign(forward[:, 2:3] + 1e-12)
        theta = np.arctan2(np.einsum("ij,ij->i", radial, forward), np.einsum("ij,ij->i", radial, up))
        return s, r, theta, radial / np.maximum(r, 1e-9)[:, None]

    def share(self, s):
        return np.where(s < self.upper, s / self.upper, 1.0 + (s - self.upper) / self.lower)


def _torso_angle(points, rig):
    hips, chest = rig.head["Hips"], rig.head["Spine2"]
    t = np.clip((points[:, 1] - hips[1]) / (chest[1] - hips[1]), 0, 1)
    zc = hips[2] + t * (chest[2] - hips[2])
    return np.arctan2(points[:, 0] - hips[0], points[:, 2] - zc), np.hypot(points[:, 0] - hips[0], points[:, 2] - zc)


def closure_zone(points, rig) -> np.ndarray:
    hips, neck, chest = rig.head["Hips"], rig.head["Neck"], rig.head["Spine2"]
    across = 1.0 - _smoothstep((np.abs(points[:, 0] - hips[0]) - CLOSURE_HALF_WIDTH_M) / 0.03)
    height = _smoothstep((points[:, 1] - (chest[1] - 0.16)) / 0.04) * (1.0 - _smoothstep((points[:, 1] - (neck[1] + 0.03)) / 0.03))
    front = _smoothstep((points[:, 2] - neck[2]) / 0.03)
    return across * height * front


def _sides(rig):
    return [s for s in ("Left", "Right") if f"{s}Arm" in rig.head]


def _on_arm(points, rig):
    return cloth._on_arm(points, rig, "TOP")


def reference_positions(undraped, tris, weld) -> np.ndarray:
    edges, degree = _adjacency(tris, weld, len(undraped))
    return _diffuse(undraped, edges, degree, weld, REFERENCE_SMOOTH_PASSES)


def hood_weight(undraped, tris, weld, rig, body) -> np.ndarray:
    neck, chest = rig.head["Neck"], rig.head["Spine2"]
    offset, _, _ = body._offsets(undraped)
    radius = np.hypot(undraped[:, 0] - neck[0], undraped[:, 2] - neck[2])
    hood = (undraped[:, 1] > neck[1] + 0.01) & (undraped[:, 2] < neck[2] + 0.05)
    body_side = (
        (undraped[:, 1] < chest[1])
        | ((undraped[:, 2] > neck[2] + 0.06) & (undraped[:, 1] < neck[1] - 0.03))
        | ((offset < 0.012) & (radius < 0.13) & (undraped[:, 1] > neck[1] - 0.12))
    ) & ~hood
    edges, degree = _adjacency(tris, weld, len(undraped))
    h = hood.astype(np.float64)
    has = degree > 0
    for _ in range(400):
        total = np.zeros(len(h))
        np.add.at(total, edges[:, 0], h[edges[:, 1]])
        average = np.where(has, total / np.maximum(degree, 1), h)
        h = np.where(hood, 1.0, np.where(body_side, 0.0, average))[weld]
    return h


def smooth_hood(fitted, undraped, tris, weld, weight) -> np.ndarray:
    edges, degree = _adjacency(tris, weld, len(fitted))
    displacement = fitted - undraped
    broad = _diffuse(displacement, edges, degree, weld, HOOD_SMOOTH_PASSES)
    w = _smoothstep(weight / HOOD_WEIGHT_FULL)[:, None]
    out = fitted + w * (undraped + broad - fitted)
    moved = np.linalg.norm(out - fitted, axis=1)
    print(f"  smoothed the hood: {int((w[:, 0] > 0.5).sum())} vertices, {1000 * np.percentile(moved[w[:, 0] > 0.5], 90):.0f} mm p90 shift")
    return out[weld]


def _folded_vertices(positions, tris, weld, degrees: float) -> np.ndarray:
    w = weld[tris]
    n = np.cross(positions[tris[:, 1]] - positions[tris[:, 0]], positions[tris[:, 2]] - positions[tris[:, 0]])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    rows = [np.column_stack([np.sort(w[:, [a, b]], axis=1), np.arange(len(tris))]) for a, b in ((0, 1), (1, 2), (2, 0))]
    r = np.concatenate(rows)
    r = r[np.lexsort((r[:, 1], r[:, 0]))]
    same = (r[1:, 0] == r[:-1, 0]) & (r[1:, 1] == r[:-1, 1])
    f1, f2 = r[:-1][same, 2], r[1:][same, 2]
    sharp = (n[f1] * n[f2]).sum(axis=1) < np.cos(np.radians(degrees))
    return np.unique(w[np.concatenate([f1[sharp], f2[sharp]])])


def smooth_crumples(fitted, undraped, tris, weld, keep) -> np.ndarray:
    edges, degree = _adjacency(tris, weld, len(fitted))
    sharp = _folded_vertices(fitted, tris, weld, CRUMPLE_FOLD_DEG)
    seed = np.zeros(len(fitted))
    seed[sharp] = 1.0
    w = np.clip(_diffuse(seed[:, None], edges, degree, weld, CRUMPLE_GROW_PASSES)[:, 0] * 4.0, 0.0, 1.0) * (1.0 - keep)
    broad = _diffuse(fitted - undraped, edges, degree, weld, CRUMPLE_SMOOTH_PASSES)
    out = fitted + w[:, None] * (undraped + broad - fitted)
    after = len(_folded_vertices(out[weld], tris, weld, CRUMPLE_FOLD_DEG))
    print(f"  smoothed crumples: {len(sharp)} -> {after} vertices on a fold over {CRUMPLE_FOLD_DEG:.0f} deg")
    return out[weld]


def armpit_weight(points, rig) -> np.ndarray:
    w = np.zeros(len(points))
    hips = rig.head["Hips"]
    for side in _sides(rig):
        shoulder = rig.head[f"{side}Arm"]
        sign = np.sign(shoulder[0] - hips[0])
        pit = shoulder + np.array([-sign * 0.012, -0.085, 0.0])
        d = np.linalg.norm(points - pit, axis=1)
        inner, outer = ARMPIT_ZONE_M
        below = 1.0 - _smoothstep((points[:, 1] - (shoulder[1] + 0.01)) / 0.04)
        s, *_ = ArmFrame(rig, side)(points)
        along = 1.0 - _smoothstep((s - ARMPIT_ALONG_ARM_M) / 0.06)
        w = np.maximum(w, (1.0 - _smoothstep((d - inner) / (outer - inner))) * below * along)
    return w


def smooth_armpits(fitted, tris, weld, rig, skin, collide, floor) -> np.ndarray:
    w = armpit_weight(fitted, rig)
    if not (w > 0).any():
        return fitted
    edges, degree = _adjacency(tris, weld, len(fitted))
    before = len(_folded_vertices(fitted, tris, weld, CRUMPLE_FOLD_DEG))
    pinned = w < 0.05
    out = fitted.copy()
    has = degree > 0
    for _ in range(ARMPIT_ITERATIONS):
        total = np.zeros_like(out)
        np.add.at(total, edges[:, 0], out[edges[:, 1]])
        average = np.where(has[:, None], total / np.maximum(degree, 1)[:, None], out)
        out = np.where(pinned[:, None], fitted, average)[weld]
    offset, normals, near = skin._offsets(out)
    ring = (w > 0.05) & (w < 0.3) & near
    gap = max(float(np.median(offset[ring])) if ring.any() else 0.02, ARMPIT_MIN_GAP_M)
    out = out + normals * (np.where(near, np.maximum(gap - offset, 0.0), 0.0) * (w > 0.05))[:, None]
    unique = cloth._unique_edges(tris, weld)
    clear = np.maximum(floor, ARMPIT_CLEARANCE_M * (w > 0.05))
    for _ in range(6):
        out = collide(out, clear)
        out = cloth._smooth(out, unique, 0.5 * w, 2)[weld]
    out = collide(out, clear)
    after = len(_folded_vertices(out, tris, weld, CRUMPLE_FOLD_DEG))
    print(f"  rebuilt the armpits: {int((w > 0.5).sum())} vertices, {1000 * gap:.0f} mm off the body, folded {before} -> {after}")
    return out


def smooth_open_edges(fitted, tris, weld, keep) -> np.ndarray:
    pairs = cloth._boundary_edges(tris, weld)
    if len(pairs) == 0:
        return fitted
    on_edge = np.zeros(len(fitted), bool)
    on_edge[pairs.ravel()] = True
    weight = np.where(on_edge, 0.5 * (1.0 - keep), 0.0)
    moved = cloth._smooth(fitted.copy(), pairs, weight, EDGE_SMOOTH_PASSES)
    shift = np.where(on_edge[:, None], moved - fitted, 0.0)
    edges, degree = _adjacency(tris, weld, len(fitted))
    spread = _diffuse(shift, edges, degree, weld, EDGE_FADE_PASSES, pinned=on_edge[weld] & on_edge)
    out = fitted + spread
    print(f"  smoothed the open edges: {int(on_edge.sum())} vertices, {1000 * np.linalg.norm(shift, axis=1).max():.0f} mm at most")
    return out[weld]


def hood_edge_distance(fitted, tris, weld, undraped, rig, limit: float = 0.08) -> np.ndarray:
    import refit_garments as rg

    loops = cloth._rim_loops(tris, weld)
    loop = max((l for l in loops if len(l) >= 30), key=lambda l: undraped[l, 1].mean())
    return rg._distance_up(fitted, tris, weld, loop, limit)


def shape_sleeves(fitted, tris, weld, rig, skin, rib) -> np.ndarray:
    out = fitted.copy()
    offset, normals, near = skin._offsets(fitted)
    arm = _on_arm(fitted, rig)
    band = rib[:, 0] < 1.0
    profile = np.array(SLEEVE_GAP_PROFILE)
    for side in _sides(rig):
        frame = ArmFrame(rig, side)
        sign = np.sign(frame.shoulder[0] - rig.head["Hips"][0])
        mine = arm & (np.sign(fitted[:, 0] - rig.head["Hips"][0]) == sign) & near & ~band
        if mine.sum() < 50:
            continue
        s, r, theta, radial = frame(fitted[mine])
        share = frame.share(s)
        bins = np.linspace(0.0, 2.0, 41)
        which = np.clip(np.digitize(share, bins) - 1, 0, len(bins) - 2)
        gap = offset[mine]
        median = np.full(len(bins) - 1, np.nan)
        for b in range(len(bins) - 1):
            if (which == b).sum() >= 8:
                median[b] = np.median(gap[which == b])
        known = ~np.isnan(median)
        centres = (bins[1:] + bins[:-1]) / 2
        median = ndimage.uniform_filter1d(np.interp(centres, centres[known], median[known]), 3, mode="nearest")
        target = np.interp(centres, profile[:, 0], profile[:, 1])
        scale = np.clip(target / np.maximum(median, 1e-3), *SLEEVE_SCALE_LIMITS)
        k = np.interp(share, centres, scale)
        blouse = np.where(rib[mine, 0] < 2.0, _smoothstep(rib[mine, 0] - 1.0), 1.0)
        fade = _smoothstep((share - SLEEVE_FROM) / 0.25) * blouse
        floor = 0.006
        new_gap = floor + (gap - floor) * (1.0 + (k - 1.0) * fade)
        out[mine] = fitted[mine] + radial * (new_gap - gap)[:, None]
        before = np.median(gap[(share > 0.4) & (share < 0.9)]), np.median(gap[(share > 1.2) & (share < 1.6)])
        after = np.median(new_gap[(share > 0.4) & (share < 0.9)]), np.median(new_gap[(share > 1.2) & (share < 1.6)])
        print(
            f"  shaped the {side.lower()} sleeve: upper arm {1000 * before[0]:.0f} -> {1000 * after[0]:.0f} mm, "
            f"forearm {1000 * before[1]:.0f} -> {1000 * after[1]:.0f} mm off the arm"
        )
    edges = cloth._unique_edges(tris, weld)
    moved = np.linalg.norm(out - fitted, axis=1) > 1e-5
    out = cloth._smooth(out, edges, 0.35 * moved, 2)
    return out[weld]


class FoldField:
    def __init__(self, rig, rib_points: np.ndarray, rib_values: np.ndarray):
        self.rig = rig
        self.arms = [ArmFrame(rig, side) for side in _sides(rig)]
        hips = rig.head["Hips"]
        seam = np.abs(rib_values[:, 0] - 1.0) < 0.12
        self.cuff_seam = {}
        for frame in self.arms:
            sign = np.sign(frame.shoulder[0] - hips[0])
            mine = seam & (np.sign(rib_points[:, 0] - hips[0]) == sign) & _on_arm(rib_points, rig)
            if mine.any():
                s, *_ = frame(rib_points[mine])
                self.cuff_seam[frame.side] = float(np.median(s))
        hem = seam & ~_on_arm(rib_points, rig) & (rib_points[:, 1] < rig.head["Spine"][1])
        if hem.any():
            angle, _ = _torso_angle(rib_points[hem], rig)
            bins = np.linspace(-np.pi, np.pi, 37)
            which = np.clip(np.digitize(angle, bins) - 1, 0, 35)
            heights = np.full(36, np.nan)
            for b in range(36):
                if (which == b).any():
                    heights[b] = np.median(rib_points[hem][which == b, 1])
            known = ~np.isnan(heights)
            centres = (bins[1:] + bins[:-1]) / 2
            self.hem_angles = centres
            self.hem_heights = np.interp(centres, centres[known], heights[known], period=2 * np.pi)
        else:
            self.hem_angles = None

    def __call__(self, points: np.ndarray) -> np.ndarray:
        h = np.zeros(len(points))
        rig = self.rig
        hips = rig.head["Hips"]
        arm = _on_arm(points, rig)
        for frame in self.arms:
            sign = np.sign(frame.shoulder[0] - hips[0])
            side_mask = np.sign(points[:, 0] - hips[0]) == sign
            mine = arm & side_mask
            if mine.any():
                h[mine] += self._sleeve(frame, points[mine])
            torso = ~arm & side_mask
            if torso.any():
                h[torso] += self._armpit(frame, points[torso], sign)
            under = mine
            if under.any():
                h[under] += self._armpit(frame, points[under], sign) * 0.6
        torso = ~arm
        if torso.any() and self.hem_angles is not None:
            h[torso] += self._waist(points[torso])
        return h

    def _sleeve(self, frame: ArmFrame, p):
        s, r, theta, _ = frame(p)
        h = np.zeros(len(p))
        seam = self.cuff_seam.get(frame.side)
        if seam is not None:
            up = seam - s
            phase = 0.9 * np.sin(theta) + 0.45 * np.sin(2 * theta + 1.0) + 0.25 * np.cos(3 * theta - 0.5)
            phase += 2.2 * _value_noise(p, 0.045, seed=5)
            wave = np.cos(2 * np.pi * up / STACK_WAVELENGTH_M + phase)
            wave = np.sign(wave) * np.abs(wave) ** 0.7
            wave *= np.clip(0.6 + 0.8 * _value_noise(p, 0.035, seed=9), 0.1, 1.2)
            envelope = _smoothstep(up / 0.012) * (1.0 - _smoothstep((up - 0.4 * STACK_LENGTH_M) / (0.6 * STACK_LENGTH_M)))
            h += STACK_AMPLITUDE_M * wave * envelope
        e = s - frame.upper
        inside = np.cos(theta - np.pi / 2) ** 2 * (np.cos(theta - np.pi / 2) > 0)
        creases = sum(
            np.exp(-(((e - c) / 0.0065) ** 2)) for c in (-0.022, 0.006, 0.032)
        ) * (1.0 + 0.3 * np.sin(3 * theta))
        h -= ELBOW_CREASE_M * creases * inside
        behind = np.cos(theta + np.pi / 2) ** 2 * (np.cos(theta + np.pi / 2) > 0)
        h += ELBOW_BAG_M * np.exp(-((e / 0.05) ** 2)) * behind
        return h

    def _armpit(self, frame: ArmFrame, p, sign):
        pit = frame.shoulder + np.array([-sign * 0.012, -0.085, 0.0])
        rel = p - pit
        lateral = np.array([sign, 0.0, 0.0])
        rel_plane = rel - (rel @ lateral)[:, None] * lateral
        d = np.linalg.norm(rel, axis=1)
        psi = np.arctan2(rel_plane[:, 2], -rel_plane[:, 1])
        near, peak, far = ARMPIT_REACH_M
        envelope = _smoothstep((d - near) / (peak - near)) * (1.0 - _smoothstep((d - peak) / (far - peak)))
        below = _smoothstep((pit[1] + 0.03 - p[:, 1]) / 0.04)
        wave = np.cos(ARMPIT_FOLDS * psi + 0.8 * np.sin(2 * psi)) * (1.0 - 0.35 * np.abs(np.sin(psi)))
        return ARMPIT_AMPLITUDE_M * wave * envelope * below

    def _waist(self, p):
        angle, radius = _torso_angle(p, self.rig)
        seam_y = np.interp(angle, self.hem_angles, self.hem_heights, period=2 * np.pi)
        up = p[:, 1] - seam_y
        h = np.zeros(len(p))
        above = up > 0
        count = max(round(2 * np.pi * 0.16 / GATHER_WAVELENGTH_M), 8)
        phase = count * angle + 1.3 * np.sin(3 * angle + 0.7) + 0.7 * np.sin(7 * angle)
        gathers = np.cos(phase) * np.exp(-np.maximum(up, 0) / GATHER_REACH_M) * _smoothstep(up / 0.008)
        h += GATHER_AMPLITUDE_M * gathers * above
        back = np.cos(angle - np.pi) ** 2 * (np.cos(angle - np.pi) > 0)
        rolls = np.cos(2 * np.pi * (up - 0.012) / LOWER_BACK_WAVELENGTH_M) * _smoothstep(up / 0.015) * (
            1.0 - _smoothstep((up - 0.06) / 0.1)
        )
        h += LOWER_BACK_AMPLITUDE_M * rolls * back * above
        return h


def add_folds(fitted, tris, weld, normals, field_values) -> tuple[np.ndarray, np.ndarray]:
    edges, degree = _adjacency(tris, weld, len(fitted))
    carried = _diffuse(field_values, edges, degree, weld, FOLD_GEOMETRY_PASSES)
    out = fitted + normals * carried[:, None]
    print(f"  folded: {int((np.abs(carried) > 0.001).sum())} vertices moved, {1000 * np.abs(carried).max():.1f} mm at most")
    return out[weld], carried


class MeshFrame:
    def __init__(self, positions, tris, armhole_y: float | None, crown_y: float | None):
        self.silhouette = layout.MeshSilhouette(positions, tris, "front")
        row = lambda y: self.silhouette.row_of(y) if y is not None else None
        self.layout = layout.detect(self.silhouette.mask, row(armhole_y), row(crown_y))
        if self.layout is None:
            raise ValueError("the garment's front doesn't read as a top, so its pockets can't be placed")

    def xy(self, points) -> np.ndarray:
        p = np.asarray(points, np.float64).reshape(-1, 2)
        lay, sil = self.layout, self.silhouette
        rows = lay.top + p[:, 1] * (lay.hem - lay.top)
        lo = np.interp(rows, np.arange(len(lay.torso_lo)), lay.torso_lo)
        hi = np.interp(rows, np.arange(len(lay.torso_hi)), lay.torso_hi)
        cols = lo + p[:, 0] * (hi - lo)
        x = ((cols - layout.SILHOUETTE_MARGIN) / sil.scale + sil.left) * sil.sign
        y = sil.ceiling - (rows - layout.SILHOUETTE_MARGIN) / sil.scale
        return np.column_stack([x, y])


def _along(points, s):
    seg = np.linalg.norm(np.diff(points, axis=0), axis=1)
    at = np.concatenate([[0.0], np.cumsum(seg)]) / max(seg.sum(), 1e-12)
    return np.column_stack([np.interp(s, at, points[:, k]) for k in range(points.shape[1])])


class _Outline:
    def __init__(self):
        self.a, self.b, self.opening, self.t_a, self.t_b = [], [], [], [], []

    def add(self, points, opening=False, t=None):
        points = np.asarray(points, np.float64)
        t = np.zeros(len(points)) if t is None else t
        for i in range(len(points) - 1):
            self.a.append(points[i])
            self.b.append(points[i + 1])
            self.opening.append(opening)
            self.t_a.append(t[i])
            self.t_b.append(t[i + 1])

    def __call__(self, u, v):
        p = np.column_stack([u, v])
        best = np.full(len(p), np.inf)
        opening = np.zeros(len(p), bool)
        t_open = np.zeros(len(p))
        inside = np.zeros(len(p), bool)
        for a, b, is_open, ta, tb in zip(self.a, self.b, self.opening, self.t_a, self.t_b):
            ab = b - a
            s = np.clip(((p - a) @ ab) / max(ab @ ab, 1e-18), 0.0, 1.0)
            d = np.linalg.norm(p - (a + s[:, None] * ab), axis=1)
            nearer = d < best
            best[nearer] = d[nearer]
            opening[nearer] = is_open
            t_open[nearer] = ta + s[nearer] * (tb - ta)
            crosses = (a[1] > p[:, 1]) != (b[1] > p[:, 1])
            x_at = a[0] + (p[:, 1] - a[1]) * ab[0] / (ab[1] if ab[1] != 0 else 1e-18)
            inside ^= crosses & (p[:, 0] < x_at)
        return np.where(inside, -best, best), opening, t_open


class KangarooPocket:
    kind = "kangaroo"
    grid = POCKET_GRID
    bridge = (9, 3.0)

    def __init__(self, right, left, top, sewn, floor):
        lift = lambda pts: np.column_stack([pts[:, 0], np.maximum(pts[:, 1], floor(pts[:, 0]))])
        right, left = right.copy(), left.copy()
        right[0], left[0] = lift(right[:1])[0], lift(left[:1])[0]
        top_edge = np.concatenate([right[-1:], top, left[-1:]]) if len(top) else np.stack([right[-1], left[-1]])
        across = np.linspace(0.0, 1.0, 25)
        bottom = lift(right[0] + across[:, None] * (left[0] - right[0]))
        self.origin = np.array([(right[0, 0] + left[0, 0]) / 2, min(right[0, 1], left[0, 1])])
        self.sides, self.top_edge, self.bottom = (right, left), top_edge, bottom
        self.half_top = float(np.linalg.norm(left[-1] - right[-1]) / 2)
        self.half_bottom = float(np.linalg.norm(left[0] - right[0]) / 2)
        self.height = float(np.mean(top_edge[:, 1]) - self.origin[1])

        o = self.origin
        self.outline = _Outline()
        for side, pts in (("right", right), ("left", left)):
            seg = np.linalg.norm(np.diff(pts[sewn:], axis=0), axis=1)
            t = np.concatenate([[0.0], np.cumsum(seg)]) / max(seg.sum(), 1e-12)
            self.outline.add(pts[: sewn + 1] - o)
            self.outline.add(pts[sewn:] - o, opening=True, t=t)
        self.outline.add(top_edge - o)
        self.outline.add(bottom - o)

    def layout(self):
        rows, cols = self.grid
        a, b = np.linspace(0, 1, rows + 1), np.linspace(0, 1, cols + 1)
        right, left = _along(self.sides[0], a), _along(self.sides[1], a)
        top, bottom = _along(self.top_edge, b), _along(self.bottom, b)
        chord_top = right[-1] + b[:, None] * (left[-1] - right[-1])
        chord_bottom = right[0] + b[:, None] * (left[0] - right[0])
        A, B = np.meshgrid(a, b, indexing="ij")
        xy = right[:, None, :] + B[..., None] * (left - right)[:, None, :]
        xy += (1 - A[..., None]) * (bottom - chord_bottom)[None] + A[..., None] * (top - chord_top)[None]
        return xy, A, B

    def offset(self, xy, A, B):
        u, v = (xy - self.origin).T
        d, opening, t_open = self.outline(u, v)
        inside = np.clip(-d, 0.0, None)
        across = np.clip(1.0 - (2 * B.ravel() - 1) ** 2, 0.0, 1.0)
        sag = POCKET_SAG_M * _smoothstep(inside / 0.05) * across * (1.0 - 0.5 * A.ravel())
        gape = POCKET_GAPE_M * np.where(opening, np.sin(np.pi * t_open), 0.0) ** 1.2 * np.exp(-inside / 0.035)
        fold_axis = np.abs(u) - self.half_top * (1 - A.ravel()) * 0.7
        folds = 0.0018 * np.exp(-((fold_axis / 0.02) ** 2)) * _smoothstep(inside / 0.03)
        return POCKET_STANDOFF_M + sag + gape - folds, gape

    def chart(self, xy, positions, A, B):
        return xy - self.origin

    def thickness(self, u, v, t):
        d, opening, _ = self.outline(u, v)
        return np.where(opening & (-d < POCKET_HEM_M), POCKET_HEM_THICKNESS_M, t)

    def relief(self, u, v):
        d_out, opening, t_open = self.outline(u, v)
        inside = np.clip(-d_out, 0, None)
        along = np.where(opening, v, u + v)
        h = np.where(opening, 0.0, _seam_profile(inside, along) * 0.9)
        hem = opening & (inside < POCKET_HEM_M + 0.008)
        h[hem] += 0.0008 * (1.0 - _smoothstep((inside[hem] - (POCKET_HEM_M - 0.004)) / 0.005))
        h[opening] += _seam_profile(np.abs(inside[opening] - POCKET_HEM_M), v[opening]) * 0.9
        for end in (0.0, 1.0):
            tack = np.exp(-(((t_open - end) / 0.05) ** 2)) * np.exp(-((inside / 0.01) ** 2)) * opening
            h += 0.0009 * tack * (0.5 + 0.5 * np.cos(2 * np.pi * v / 0.0016))
        return h

    def describe(self, offset, gape):
        return (
            f"a kangaroo pocket, {200 * self.half_bottom:.0f} cm wide at the bottom and {200 * self.half_top:.0f} at the top, "
            f"{100 * self.height:.0f} cm deep, {1000 * offset.min():.1f}-{1000 * offset.max():.0f} mm off the front, "
            f"openings gape {1000 * gape.max():.0f} mm"
        )


class StripPocket:
    bridge = (3, 1.0)

    def __init__(self, kind, edge_a, edge_b):
        self.kind = kind
        self.grid = WELT_GRID if kind == "welt" else ZIP_GRID
        self.edges = (edge_a, edge_b)
        self.length = self.width = 0.0

    def layout(self):
        along, across = self.grid
        s, w = np.linspace(0, 1, along + 1), np.linspace(0, 1, across + 1)
        a, b = _along(self.edges[0], s), _along(self.edges[1], s)
        S, W = np.meshgrid(s, w, indexing="ij")
        return a[:, None, :] + W[..., None] * (b - a)[:, None, :], S, W

    def chart(self, xy, positions, S, W):
        along, across = self.grid
        grid = positions.reshape(along + 1, across + 1, 3)
        middle = grid[:, across // 2]
        run = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(middle, axis=0), axis=1))])
        self.length = float(run[-1])
        self.width = float(np.mean(np.linalg.norm(grid[:, -1] - grid[:, 0], axis=1)))
        u = np.repeat(run, across + 1)
        v = (W.ravel() - 0.5) * self.width
        return np.column_stack([u, v])

    def outline(self, u, v):
        half = self.width / 2
        ends = np.maximum(-u, u - self.length)
        d = np.maximum(ends, np.abs(v) - half)
        opening = (self.kind == "welt") & (-v - half >= ends) & (v < 0)
        return d, opening, np.clip(u / max(self.length, 1e-9), 0, 1)

    def offset(self, xy, S, W):
        s, w = S.ravel(), W.ravel()
        ends = _smoothstep(np.minimum(s, 1 - s) * self.grid[0] / 4)
        if self.kind == "welt":
            lift = WELT_STANDOFF_M + WELT_GAPE_M * (1 - w) ** 2 * ends
            return lift, lift - WELT_STANDOFF_M
        teeth = ZIP_TEETH_RISE_M * np.exp(-(((w - 0.5) / 0.2) ** 2))
        return ZIP_STANDOFF_M + teeth * ends, np.zeros_like(s)

    def thickness(self, u, v, t):
        return np.full_like(t, WELT_THICKNESS_M if self.kind == "welt" else ZIP_THICKNESS_M)

    def relief(self, u, v):
        d, opening, _ = self.outline(u, v)
        inside = np.clip(-d, 0, None)
        if self.kind == "welt":
            h = np.where(opening, 0.0006 * np.exp(-((inside / 0.003) ** 2)), _seam_profile(inside, u + v) * 0.9)
            for end in (0.0, self.length):
                h += 0.0009 * np.exp(-(((u - end) / 0.004) ** 2)) * (0.5 + 0.5 * np.cos(2 * np.pi * v / 0.0016))
            return h
        pitch, half_teeth = ZIP_TOOTH_PITCH_M, ZIP_TEETH_HALF_M
        side = np.where(v > 0, 0.5, 0.0)
        tooth = 0.5 + 0.5 * np.cos(2 * np.pi * (u / pitch + side))
        h = ZIP_TOOTH_M * tooth * np.exp(-(((np.abs(v) - half_teeth / 2) / (half_teeth / 2)) ** 4))
        h -= 0.0004 * np.exp(-((v / 0.0006) ** 2))
        h += _seam_profile(np.abs(np.abs(v) - (self.width / 2 - ZIP_STITCH_IN_M)), u) * 0.6
        return h

    def describe(self, offset, gape):
        what = "a welt pocket" if self.kind == "welt" else "a zipped pocket"
        return f"{what}, {100 * self.length:.0f} cm long and {1000 * self.width:.0f} mm wide, {1000 * offset.max():.1f} mm proud"


def _front_depth(fitted, tris, keep, x_range, y_range, step=0.002):
    xs = np.arange(x_range[0], x_range[1] + step, step)
    ys = np.arange(y_range[0], y_range[1] + step, step)
    depth = np.full((len(ys), len(xs)), -np.inf)
    for tri in tris[keep]:
        p = fitted[tri]
        i0, i1 = np.searchsorted(xs, [p[:, 0].min(), p[:, 0].max()])
        j0, j1 = np.searchsorted(ys, [p[:, 1].min(), p[:, 1].max()])
        if i1 <= i0 or j1 <= j0:
            continue
        gx, gy = np.meshgrid(xs[i0:i1], ys[j0:j1])
        (x0, y0), (x1, y1), (x2, y2) = p[0, :2], p[1, :2], p[2, :2]
        det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(det) < 1e-12:
            continue
        w0 = ((y1 - y2) * (gx - x2) + (x2 - x1) * (gy - y2)) / det
        w1 = ((y2 - y0) * (gx - x2) + (x0 - x2) * (gy - y2)) / det
        w2 = 1 - w0 - w1
        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        z = w0 * p[0, 2] + w1 * p[1, 2] + w2 * p[2, 2]
        block = depth[j0:j1, i0:i1]
        np.maximum(block, np.where(inside, z, -np.inf), out=block)
    known = np.isfinite(depth)
    _, (ni, nj) = ndimage.distance_transform_edt(~known, return_indices=True)
    return xs, ys, depth[ni, nj]


class Panel:
    def __init__(self, pocket, positions, normals, chart, tris, nearest):
        self.pocket, self.positions, self.normals, self.chart, self.tris, self.nearest = (
            pocket, positions, normals, chart, tris, nearest,
        )


def _build(pocket, fitted, tris, keep, front):
    from scipy.interpolate import RegularGridInterpolator

    xy, A, B = pocket.layout()
    rows, cols = xy.shape[0] - 1, xy.shape[1] - 1
    xy = xy.reshape(-1, 2)
    lo, hi = xy.min(axis=0) - 0.03, xy.max(axis=0) + 0.03
    xs, ys, depth = _front_depth(fitted, tris, keep, (lo[0], hi[0]), (lo[1], hi[1]))
    size, sigma = pocket.bridge
    depth = ndimage.gaussian_filter(ndimage.maximum_filter(depth, size=size), sigma)
    at = xy[:, ::-1]
    z = RegularGridInterpolator((ys, xs), depth, bounds_error=False, fill_value=None)(at)
    dzdy, dzdx = np.gradient(depth, ys, xs)
    gx = RegularGridInterpolator((ys, xs), dzdx, bounds_error=False, fill_value=None)(at)
    gy = RegularGridInterpolator((ys, xs), dzdy, bounds_error=False, fill_value=None)(at)
    normal = np.column_stack([-gx, -gy, np.ones_like(gx)])
    normal /= np.linalg.norm(normal, axis=1, keepdims=True)

    offset, gape = pocket.offset(xy, A, B)
    positions = np.column_stack([xy, z]) + normal * offset[:, None]
    chart = pocket.chart(xy, positions, A, B)

    grid = np.arange((rows + 1) * (cols + 1)).reshape(rows + 1, cols + 1)
    q00, q01, q10, q11 = grid[:-1, :-1].ravel(), grid[:-1, 1:].ravel(), grid[1:, :-1].ravel(), grid[1:, 1:].ravel()
    panel_tris = np.concatenate([np.column_stack([q00, q01, q11]), np.column_stack([q00, q11, q10])])
    face = np.cross(positions[panel_tris[:, 1]] - positions[panel_tris[:, 0]], positions[panel_tris[:, 2]] - positions[panel_tris[:, 0]])
    if np.einsum("ij,ij->i", face, normal[panel_tris[:, 0]]).mean() < 0:
        panel_tris = panel_tris[:, [0, 2, 1]]

    _, nearest = cKDTree(fitted[front]).query(positions)
    nearest = np.flatnonzero(front)[nearest]
    print(f"  sewed on {pocket.describe(offset, gape)}")
    return Panel(pocket, positions, normal, chart, panel_tris, nearest)


def add_pockets(fitted, tris, rib, part, rig, specs, armhole_y) -> list[Panel]:
    if not specs:
        return []
    frame = MeshFrame(fitted, tris, armhole_y, layout.crown_height([rig.head.get("LeftArm"), rig.head.get("RightArm")]))
    centre_x = rig.head["Hips"][0]
    arm = _on_arm(fitted, rig)
    front = (fitted[:, 2] > rig.head["Spine"][2]) & ~arm & (part[:, 0] < 0.5)
    seam = front & (np.abs(rib[:, 0] - 1.0) < 0.15) & (fitted[:, 1] < rig.head["Spine"][1])
    fit = np.polyfit(fitted[seam, 0] - centre_x, fitted[seam, 1], 2)
    floor = lambda x: np.polyval(fit, x - centre_x) + POCKET_ABOVE_BAND_M
    keep = front[tris].all(axis=1)

    panels = []
    for spec in specs:
        if isinstance(spec, pockets_spec.Kangaroo):
            pocket = KangarooPocket(
                frame.xy(spec.right), frame.xy(spec.left),
                frame.xy(spec.top) if spec.top else np.zeros((0, 2)), spec.sewn, floor,
            )
        elif isinstance(spec, pockets_spec.Welt):
            pocket = StripPocket("welt", frame.xy(spec.opening), frame.xy(spec.sewn))
        else:
            path = np.asarray(spec.path, np.float64)
            pocket = StripPocket("zip", frame.xy(path - [spec.width / 2, 0.0]), frame.xy(path + [spec.width / 2, 0.0]))
        panels.append(_build(pocket, fitted, tris, keep, front))
    return panels


def thickness(
    n: int, rib: np.ndarray, hood_edge: np.ndarray, pocket: np.ndarray, pocket_chart: np.ndarray,
    panels: list["Panel"], closure: np.ndarray,
) -> np.ndarray:
    t = np.full(n, FLEECE_THICKNESS_M)
    band = rib[:, 0] < 1.0
    t[band] = RIB_THICKNESS_M
    channel = np.isfinite(hood_edge) & (hood_edge < HOOD_CHANNEL_M)
    t[channel] = HOOD_CHANNEL_THICKNESS_M
    which = np.rint(pocket).astype(int)
    for i, panel in enumerate(panels):
        p = which == i + 1
        if p.any():
            t[p] = panel.pocket.thickness(pocket_chart[p, 0], pocket_chart[p, 1], t[p])
    t = t + (CLOSURE_THICKNESS_M - t) * np.where(pocket > 0.5, 0.0, closure)
    return t


def solidify(positions, normals, uvs, tris, weld, t, skin, skip):
    n = len(positions)
    offset, _, near = skin._offsets(positions)
    room = np.where(near, offset - INNER_CLEARANCE_M, np.inf)
    push = np.clip(t - room, 0.0, t)
    outer = positions + normals * push[:, None]
    solid_tris = tris[~skip[tris].any(axis=1)]
    used = np.unique(solid_tris)
    inner_index = np.full(n, -1, np.int64)
    inner_index[used] = n + np.arange(len(used))
    inner_pos = outer[used] - normals[used] * t[used, None]
    inner_tris = inner_index[solid_tris][:, [0, 2, 1]]

    w = weld[solid_tris]
    half = np.concatenate([solid_tris[:, [0, 1]], solid_tris[:, [1, 2]], solid_tris[:, [2, 0]]])
    third = np.concatenate([solid_tris[:, 2], solid_tris[:, 0], solid_tris[:, 1]])
    wkey = np.sort(np.concatenate([w[:, [0, 1]], w[:, [1, 2]], w[:, [2, 0]]]), axis=1)
    _, inv, counts = np.unique(wkey, axis=0, return_inverse=True, return_counts=True)
    open_edge = counts[inv.ravel()] == 1
    half, third = half[open_edge], third[open_edge]

    pa, pb, pc = outer[half[:, 0]], outer[half[:, 1]], outer[third]
    e = pb - pa
    nrm = (normals[half[:, 0]] + normals[half[:, 1]]) / 2
    out_dir = np.cross(e, nrm)
    out_dir /= np.maximum(np.linalg.norm(out_dir, axis=1, keepdims=True), 1e-12)
    flip = np.einsum("ij,ij->i", out_dir, pc - pa) > 0
    out_dir[flip] *= -1
    rim_vertices = np.unique(half)
    rim_index = np.full(n, -1, np.int64)
    first_rim = n + len(used)
    rim_index[rim_vertices] = first_rim + np.arange(len(rim_vertices))
    acc = np.zeros((n, 3))
    np.add.at(acc, half[:, 0], out_dir)
    np.add.at(acc, half[:, 1], out_dir)
    acc_w = np.zeros((n, 3))
    np.add.at(acc_w, weld[rim_vertices], acc[rim_vertices])
    acc = acc_w[weld]
    acc /= np.maximum(np.linalg.norm(acc, axis=1, keepdims=True), 1e-12)
    rv = rim_vertices
    rim_pos = outer[rv] - normals[rv] * (t[rv, None] / 2) + acc[rv] * (t[rv, None] * 0.55)
    a, b = half[:, 0], half[:, 1]
    ia, ib, ma, mb = inner_index[a], inner_index[b], rim_index[a], rim_index[b]
    rim_tris = np.concatenate([
        np.column_stack([b, a, ma]), np.column_stack([b, ma, mb]),
        np.column_stack([mb, ma, ia]), np.column_stack([mb, ia, ib]),
    ])
    all_pos = np.concatenate([outer, inner_pos, rim_pos])
    face = np.cross(all_pos[rim_tris[:, 1]] - all_pos[rim_tris[:, 0]], all_pos[rim_tris[:, 2]] - all_pos[rim_tris[:, 0]])
    centre = all_pos[rim_tris].mean(axis=1)
    mid_dir = np.concatenate([acc[b], acc[b], acc[b], acc[b]])
    wrong = np.einsum("ij,ij->i", face, mid_dir) < 0
    rim_tris[wrong] = rim_tris[wrong][:, [0, 2, 1]]

    all_normals = np.concatenate([normals, -normals[used], acc[rv]]).astype(np.float32)
    all_uvs = np.concatenate([uvs, uvs[used], uvs[rv]])
    layer = np.concatenate([np.zeros(n), np.ones(len(used)), np.full(len(rv), 2.0)])
    copy_of = np.concatenate([np.arange(n), used, rv])
    print(
        f"  gave it thickness: {len(used)} inner-shell vertices, {len(half)} open edges rimmed, "
        f"{1000 * t[used].min():.1f}-{1000 * t[used].max():.1f} mm, outside moved out {1000 * push.max():.1f} mm at most"
    )
    return all_pos, all_normals, all_uvs, np.concatenate([tris, inner_tris, rim_tris]), copy_of, layer


def occlusion(positions, normals, tris, occluders: list[tuple[np.ndarray, np.ndarray]]) -> np.ndarray:
    from numba import njit, prange

    parts = [(positions, tris)] + occluders
    lo = positions.min(axis=0) - AO_REACH_M * 0.5
    hi = positions.max(axis=0) + AO_REACH_M * 0.5
    shape = np.ceil((hi - lo) / AO_VOXEL_M).astype(int) + 1
    grid = np.zeros(shape, np.bool_)
    rng = np.random.default_rng(7)
    for p, f in parts:
        a, b, c = p[f[:, 0]], p[f[:, 1]], p[f[:, 2]]
        area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
        count = np.maximum((area / (AO_VOXEL_M * AO_VOXEL_M) * 4).astype(int), 1)
        idx = np.repeat(np.arange(len(f)), count)
        r1, r2 = rng.random(len(idx)), rng.random(len(idx))
        s = np.sqrt(r1)
        pts = a[idx] * (1 - s)[:, None] + b[idx] * (s * (1 - r2))[:, None] + c[idx] * (s * r2)[:, None]
        pts = np.concatenate([pts, p[np.unique(f)]])
        cell = np.floor((pts - lo) / AO_VOXEL_M).astype(int)
        ok = np.all((cell >= 0) & (cell < shape), axis=1)
        grid[cell[ok, 0], cell[ok, 1], cell[ok, 2]] = True

    k = np.arange(AO_RAYS) + 0.5
    r = np.sqrt(k / AO_RAYS)
    phi = k * np.pi * (3 - np.sqrt(5))
    local = np.column_stack([r * np.cos(phi), r * np.sin(phi), np.sqrt(1 - r * r)])

    @njit(parallel=True, cache=False)
    def march(pos, nrm, grid, lo, voxel, local, reach, start):
        n = pos.shape[0]
        out = np.zeros(n)
        steps = int(reach / (voxel * 0.7))
        for i in prange(n):
            z = nrm[i]
            helper = np.array([1.0, 0.0, 0.0]) if abs(z[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
            x = np.cross(helper, z)
            x /= np.sqrt((x * x).sum())
            y = np.cross(z, x)
            seen = 0.0
            for j in range(local.shape[0]):
                d = local[j, 0] * x + local[j, 1] * y + local[j, 2] * z
                hit = 1.0
                for s in range(steps):
                    t = start + s * voxel * 0.7
                    p = pos[i] + d * t
                    cx = int((p[0] - lo[0]) / voxel)
                    cy = int((p[1] - lo[1]) / voxel)
                    cz = int((p[2] - lo[2]) / voxel)
                    if cx < 0 or cy < 0 or cz < 0 or cx >= grid.shape[0] or cy >= grid.shape[1] or cz >= grid.shape[2]:
                        break
                    if grid[cx, cy, cz]:
                        hit = (t / reach) ** 0.5
                        break
                seen += hit
            out[i] = seen / local.shape[0]
        return out

    ao = march(positions.astype(np.float64), normals.astype(np.float64), grid, lo, AO_VOXEL_M, local, AO_REACH_M, AO_START_M)
    return ao


def occlusion_colours(ao: np.ndarray, tris, weld) -> np.ndarray:
    edges, degree = _adjacency(tris, weld, len(ao))
    ao = _diffuse(ao, edges, degree, np.arange(len(ao)), 2)
    shade = AO_FLOOR + (1 - AO_FLOOR) * np.clip(ao, 0, 1) ** AO_GAMMA
    return np.column_stack([shade, shade, shade, np.ones_like(shade)]).astype(np.float32)


def _value_noise(points: np.ndarray, scale: float, seed: int = 3) -> np.ndarray:
    q = points / scale
    base = np.floor(q).astype(np.int64)
    f = q - base
    f = f * f * (3 - 2 * f)
    out = np.zeros(len(points))
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                c = base + np.array([dx, dy, dz])
                h = (c[:, 0] * 73856093) ^ (c[:, 1] * 19349663) ^ (c[:, 2] * 83492791) ^ seed
                h = (h * 2654435761) & 0xFFFFFFFF
                val = (h / 0xFFFFFFFF) * 2 - 1
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out += w * val
    return out


def _seam_distance(field: np.ndarray, valid: np.ndarray) -> np.ndarray:
    sign = field > 0
    edge = np.zeros(field.shape, bool)
    for axis in (0, 1):
        a = np.swapaxes(sign, 0, axis)
        v = np.swapaxes(valid, 0, axis)
        cross = (a[1:] != a[:-1]) & v[1:] & v[:-1]
        e = np.swapaxes(edge, 0, axis)
        e[1:] |= cross
        e[:-1] |= cross
    if not edge.any():
        return np.full(field.shape, np.inf)
    return ndimage.distance_transform_edt(~edge)


def _seam_profile(d, along):
    depth, width = SEAM_GROOVE_M
    puff, puff_at, puff_width = SEAM_PUFF_M
    s_depth, s_at, s_width, pitch = STITCH_M
    h = -depth * np.exp(-((d / width) ** 2))
    h += puff * np.exp(-(((d - puff_at) / puff_width) ** 2))
    dash = 0.5 + 0.5 * np.tanh(4 * np.cos(2 * np.pi * along / pitch))
    h -= s_depth * np.exp(-(((d - s_at) / s_width) ** 2)) * dash
    return h


def normal_map(
    positions, normals, uvs, tris, layer, construction, rib, part, rig, fold: "FoldField", carried, panels: list["Panel"],
    size=NORMAL_MAP_SIZE,
) -> bytes:
    from bake_texture import rasterize_atlas
    from PIL import Image

    outside = layer[tris].max(axis=1) == 0
    faces = tris[outside]
    extra = np.column_stack([construction, rib, part, carried[:, None]])
    flipped = np.column_stack([uvs[:, 0], 1.0 - uvs[:, 1]])
    pos_img, nrm_img, filled, extra_img = rasterize_atlas(flipped, faces, positions, normals, size, extra)
    c = extra_img[..., :C_COUNT]
    rib_img = extra_img[..., C_COUNT : C_COUNT + 4]
    part_img = extra_img[..., C_COUNT + 4 : C_COUNT + 8]
    carried_img = extra_img[..., C_COUNT + 8]

    dx = np.linalg.norm(np.diff(pos_img, axis=1), axis=2)
    both = filled[:, 1:] & filled[:, :-1]
    texel = float(np.median(dx[both & (dx > 0)]))
    print(f"  normal map: {size} px, {1000 * texel:.2f} mm per texel")

    idx = np.flatnonzero(filled.ravel())
    U = c.reshape(-1, C_COUNT)[idx, C_POS].astype(np.float64)
    hood = c.reshape(-1, C_COUNT)[idx, C_HOOD]
    hood_edge = c.reshape(-1, C_COUNT)[idx, C_HOOD_EDGE]
    which = np.rint(c.reshape(-1, C_COUNT)[idx, C_POCKET]).astype(int)
    pocket = which > 0
    pu = c.reshape(-1, C_COUNT)[idx, C_POCKET_U]
    pv = c.reshape(-1, C_COUNT)[idx, C_POCKET_V]
    rib_f = rib_img.reshape(-1, 4)[idx]
    cord = part_img.reshape(-1, 4)[idx, 0] > 0.5
    final = pos_img.reshape(-1, 3)[idx].astype(np.float64)

    def image(values, fill=np.nan):
        out = np.full(size * size, fill)
        out[idx] = values
        return out.reshape(size, size)

    hips, neck = rig.head["Hips"], rig.head["Neck"]
    arm = _on_arm(U, rig)
    body = ~pocket & ~cord

    seams = []
    for side in _sides(rig):
        frame = ArmFrame(rig, side)
        sign = np.sign(frame.shoulder[0] - hips[0])
        mine = np.sign(U[:, 0] - hips[0]) == sign
        s, r, theta, _ = frame(U)
        top = frame.shoulder + np.array([sign * 0.04, 0.05, 0.0])
        pit = frame.shoulder + np.array([sign * 0.0, -0.085, 0.0])
        ahead = frame.shoulder + np.array([sign * 0.025, -0.02, 0.07])
        normal = np.cross(pit - top, ahead - top)
        normal *= np.sign(normal[0] * sign) / np.linalg.norm(normal)
        f = (U - top) @ normal
        valid = mine & body & (np.abs(f) < 0.03) & (np.linalg.norm(U - frame.shoulder, axis=1) < 0.2) & (hood < 0.3)
        seams.append((f, valid, theta * 0.06))
        f = r * np.sin(np.angle(np.exp(1j * (theta - (np.pi - 0.35)))))
        valid = mine & body & arm & (np.abs(f) < 0.03) & (np.cos(theta - (np.pi - 0.35)) > 0.5) & (rib_f[:, 0] > 1.0)
        seams.append((f, valid, s))
    angle, radius = _torso_angle(U, rig)
    for seam_angle in (np.pi / 2 + 0.1, -np.pi / 2 - 0.1):
        delta = np.angle(np.exp(1j * (angle - seam_angle)))
        f = radius * np.sin(delta)
        pit = rig.head["LeftArm"][1] - 0.085
        valid = body & ~arm & (np.abs(delta) < 0.5) & (U[:, 1] < pit) & (rib_f[:, 0] > 1.0)
        seams.append((f, valid, U[:, 1]))
    shoulder_z = rig.head["LeftShoulder"][2] - 0.004
    f = U[:, 2] - shoulder_z
    valid = body & ~arm & (U[:, 1] > rig.head["LeftArm"][1] - 0.06) & (hood < 0.25) & (np.abs(f) < 0.03)
    seams.append((f, valid, U[:, 0]))
    f = U[:, 0] - hips[0]
    valid = body & (hood > 0.5) & (np.abs(f) < 0.03) & (U[:, 2] < neck[2] + 0.03)
    seams.append((f, valid, U[:, 1] - U[:, 2]))
    f = hood - 0.1
    radius = np.hypot(U[:, 0] - neck[0], U[:, 2] - neck[2])
    valid = body & (U[:, 1] > neck[1] - 0.07) & (radius < 0.13) & (np.abs(f) < 0.2)
    seams.append((f, valid, np.arctan2(U[:, 0] - neck[0], U[:, 2] - neck[2]) * 0.08))
    f = rib_f[:, 0] - 1.0
    valid = body & (np.abs(f) < 0.5)
    seams.append((f, valid, np.arctan2(rib_f[:, 2], rib_f[:, 1]) * 0.1))

    h = np.zeros(len(idx))
    for f, valid, along in seams:
        d = _seam_distance(image(f, 0.0), image(valid.astype(float), 0.0) > 0.5)
        d_m = d.reshape(-1)[idx] * texel
        near = valid & (d_m < 0.012)
        h[near] += _seam_profile(d_m[near], along[near])

    band = body & (rib_f[:, 0] >= 0) & (rib_f[:, 0] < 1.0)
    wave = np.cos(np.arctan2(rib_f[band, 2], rib_f[band, 1]) * rib_f[band, 3])
    h[band] += RIB_WALE_M * np.tanh(2.5 * wave) / np.tanh(2.5)

    channel = body & np.isfinite(hood_edge) & (hood_edge < HOOD_CHANNEL_M + 0.01)
    e = hood_edge[channel]
    h[channel] += CHANNEL_RISE_M * (1.0 - _smoothstep((e - (HOOD_CHANNEL_M - 0.004)) / 0.006)) * _smoothstep(e / 0.004)
    h[channel] += _seam_profile(np.abs(e - HOOD_CHANNEL_M), U[channel, 0] + U[channel, 2]) * 0.8

    part = part_img.reshape(-1, 4)[idx]
    if cord.any():
        tops = []
        for sign in (-1, 1):
            mine = cord & (np.sign(final[:, 0] - hips[0]) == sign)
            if mine.any():
                tops.append(final[mine][np.argmin(part[mine, 1])])
        for top in tops:
            rho = np.linalg.norm(final - top, axis=1)
            ring_h, ring_r, ring_w = EYELET_M
            near = ~cord & (rho < 0.015)
            h[near] += ring_h * np.exp(-(((rho[near] - ring_r) / ring_w) ** 2)) - 0.0012 * np.exp(-((rho[near] / 0.003) ** 2))

    for i, panel in enumerate(panels):
        mine = which == i + 1
        if mine.any():
            h[mine] += panel.pocket.relief(pu[mine], pv[mine])

    folded = ~cord & ~pocket
    calm = 1.0 - closure_zone(U[folded], rig)
    h[folded] += (fold(U[folded]) - carried_img.reshape(-1)[idx][folded]) * calm
    amp, scale = FLEECE_MOTTLE_M
    h += amp * (_value_noise(U, scale) + 0.5 * _value_noise(U, scale / 2.3, seed=11))
    H = image(h, 0.0)

    _, (ni, nj) = ndimage.distance_transform_edt(~filled, return_indices=True)
    H = H[ni, nj]
    d_col = np.gradient(H, axis=1) / texel
    d_row = np.gradient(H, axis=0) / texel
    n = np.stack([-d_col, d_row, np.ones_like(H)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    rgb = np.clip((n * 0.5 + 0.5) * 255 + 0.5, 0, 255).astype(np.uint8)
    rgb[~filled] = rgb[ni, nj][~filled]
    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, "JPEG", quality=NORMAL_MAP_QUALITY, subsampling=0)
    tilt = np.degrees(np.arccos(n[..., 2][filled]))
    print(f"  normal map: {len(buffer.getvalue()):,} bytes, tilt p50 {np.median(tilt):.1f} deg, p99 {np.percentile(tilt, 99):.1f} deg")
    return buffer.getvalue()
