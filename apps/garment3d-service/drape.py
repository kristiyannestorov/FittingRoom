import os
import re
from dataclasses import dataclass

import numpy as np
from scipy.spatial import cKDTree

GRAVITY = np.array([0.0, -9.81, 0.0])


@dataclass(frozen=True)
class Fabric:
    mass: float
    thickness: float
    armhole: float
    hem_flare: float
    fold: float
    stretch: float
    bend: float
    friction: float
    damping: float
    cling: float = 0.0
    release: float = 1.0
    cap_bulge: float = 0.035


FABRIC = {
    "T_SHIRT": Fabric(
        mass=0.18, thickness=0.0010, armhole=0.018, hem_flare=1.0, fold=0.006,
        stretch=0.55, bend=0.12, friction=0.40, damping=0.06, cling=0.8, release=0.35,
    ),
    "LONG_SLEEVE": Fabric(
        mass=0.22, thickness=0.0014, armhole=0.022, hem_flare=1.4, fold=0.010,
        stretch=0.80, bend=0.30, friction=0.42, damping=0.07, cling=0.6, release=0.7,
    ),
    "HOODIE": Fabric(
        mass=0.38, thickness=0.0032, armhole=0.034, hem_flare=0.8, fold=0.010,
        stretch=0.45, bend=0.45, friction=0.50, damping=0.10, cling=0.35, release=0.8,
    ),
    "PANTS": Fabric(
        mass=0.42, thickness=0.0018, armhole=0.016, hem_flare=1.3, fold=0.012,
        stretch=0.85, bend=0.50, friction=0.45, damping=0.10,
    ),
    "SHORTS": Fabric(
        mass=0.24, thickness=0.0014, armhole=0.034, hem_flare=2.4, fold=0.014,
        stretch=0.60, bend=0.20, friction=0.38, damping=0.07,
    ),
    "DRESS": Fabric(
        mass=0.16, thickness=0.0009, armhole=0.026, hem_flare=2.0, fold=0.010,
        stretch=0.60, bend=0.10, friction=0.35, damping=0.05, cling=0.5, release=0.9,
        cap_bulge=0.055,
    ),
}

CATEGORY_EASE_CM = {
    "BODYCON": (-4, -4, -3),
    "A_LINE": (4, 3, 10),
    "WRAP": (5, 4, 8),
    "MAXI": (4, 4, 9),
    "SLIP": (2, 3, 4),
    "BALL_GOWN": (3, 2, 25),
    "SHIFT": (6, 10, 8),
    "CREW_NECK": (10, 14, 14),
    "V_NECK": (9, 13, 13),
    "GRAPHIC": (12, 16, 16),
    "POLO": (10, 12, 12),
    "HENLEY": (9, 12, 12),
    "WAFFLE_KNIT": (6, 8, 8),
    "BUTTON_UP": (8, 10, 10),
    "PULLOVER": (16, 20, 20),
    "ZIP_UP": (15, 18, 18),
    "CHINO": (0, 4, 6),
    "DENIM": (0, 2, 4),
    "ATHLETIC": (0, 8, 10),
}

DEFAULT_CATEGORY = {
    "T_SHIRT": "CREW_NECK",
    "LONG_SLEEVE": "BUTTON_UP",
    "HOODIE": "PULLOVER",
    "PANTS": "DENIM",
    "SHORTS": "CHINO",
    "DRESS": "A_LINE",
}

BODY_CM = (88.0, 70.0, 96.0)

FIT = {"SLIM": 0.55, "REGULAR": 1.0, "RELAXED": 1.5, "OVERSIZED": 2.1}

LANDMARK_BONES = ("Spine2", "Spine", "Hips")


def _check_contract(sizing_ts: str) -> None:
    if not os.path.exists(sizing_ts):
        return
    with open(sizing_ts, encoding="utf-8") as f:
        source = f.read()
    block = re.search(r"CATEGORY_EASE[^{]*\{(.*?)\n\};", source, re.S)
    if block is None:
        raise SystemExit(f"{sizing_ts}: cannot find CATEGORY_EASE; drape.py's mirror cannot be checked")
    found = {
        name: (int(bust), int(waist), int(hips))
        for name, bust, waist, hips in re.findall(
            r"(\w+):\s*\{\s*bustCm:\s*(-?\d+),\s*waistCm:\s*(-?\d+),\s*hipsCm:\s*(-?\d+)\s*\}",
            block.group(1),
        )
    }
    if found != CATEGORY_EASE_CM:
        differing = sorted(set(found) ^ set(CATEGORY_EASE_CM)) + sorted(
            k for k in set(found) & set(CATEGORY_EASE_CM) if found[k] != CATEGORY_EASE_CM[k]
        )
        raise SystemExit(
            f"drape.CATEGORY_EASE_CM no longer matches {sizing_ts}: {', '.join(differing)}.\n"
            "Copy the contract's values across: the fitting room must show the fit the size guide promises."
        )


SUPPORT = {
    "TOP": (("LeftShoulder", "RightShoulder", "Neck"), 0.10),
    "FULL_BODY": (("LeftShoulder", "RightShoulder", "Neck"), 0.10),
    "BOTTOM": (("Hips",), 0.055),
}

LIMBS = {
    "TOP": (("LeftArm", "LeftForeArm"), ("RightArm", "RightForeArm")),
    "FULL_BODY": (
        ("LeftArm", "LeftForeArm"),
        ("RightArm", "RightForeArm"),
        ("LeftUpLeg", "LeftLeg"),
        ("RightUpLeg", "RightLeg"),
    ),
    "BOTTOM": (("LeftUpLeg", "LeftLeg"), ("RightUpLeg", "RightLeg")),
}
LIMB_FALLOFF_M = 0.09

CLING_RELEASE = (0.6, 1.0)

HEM_SMOOTH_FROM = 0.82
HEM_SMOOTH_PASSES = 12

CAP_MAX_SLEEVE_M = 0.06

SLIDE_M = 0.008
FLOOR_M = 0.006
SLIDE_HEM_M = 0.022
MAX_SPEED = 1.5


def _unique_edges(tris: np.ndarray, weld: np.ndarray) -> np.ndarray:
    w = weld[tris]
    pairs = np.concatenate([w[:, [0, 1]], w[:, [1, 2]], w[:, [2, 0]]])
    pairs = np.sort(pairs, axis=1)
    return np.unique(pairs[pairs[:, 0] != pairs[:, 1]], axis=0)


def _bend_pairs(tris: np.ndarray, weld: np.ndarray) -> np.ndarray:
    w = weld[tris]
    rows = []
    for a, b, c in ((0, 1, 2), (1, 2, 0), (2, 0, 1)):
        key = np.sort(w[:, [a, b]], axis=1)
        rows.append(np.column_stack([key, w[:, c]]))
    table = np.concatenate(rows)
    order = np.lexsort((table[:, 2], table[:, 1], table[:, 0]))
    table = table[order]
    same = (table[:-1, 0] == table[1:, 0]) & (table[:-1, 1] == table[1:, 1])
    pairs = np.column_stack([table[:-1, 2][same], table[1:, 2][same]])
    return pairs[pairs[:, 0] != pairs[:, 1]]


def _vertex_areas(positions: np.ndarray, tris: np.ndarray, weld: np.ndarray) -> np.ndarray:
    a, b, c = positions[tris[:, 0]], positions[tris[:, 1]], positions[tris[:, 2]]
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
    out = np.zeros(len(positions))
    for k in range(3):
        np.add.at(out, weld[tris[:, k]], area / 3)
    return out[weld]


def _segment_distance(positions: np.ndarray, head: np.ndarray, tail: np.ndarray) -> np.ndarray:
    axis = tail - head
    length2 = float(axis @ axis)
    if length2 < 1e-12:
        return np.linalg.norm(positions - head, axis=1)
    t = np.clip((positions - head) @ axis / length2, 0.0, 1.0)
    return np.linalg.norm(positions - (head + t[:, None] * axis), axis=1)


def _limb_blend(positions: np.ndarray, rig, slot: str) -> np.ndarray:
    near = np.full(len(positions), np.inf)
    for chain in LIMBS.get(slot, ()):
        bones = [b for b in chain if b in rig.head]
        for head, tail in zip(bones, bones[1:]):
            near = np.minimum(near, _segment_distance(positions, rig.head[head], rig.head[tail]))
    if not np.isfinite(near).any():
        return np.zeros(len(positions))
    return np.clip(1.0 - near / LIMB_FALLOFF_M, 0.0, 1.0)


def _hang(positions: np.ndarray, rig, slot: str) -> np.ndarray:
    bones, _ = SUPPORT[slot]
    support_y = max(rig.head[b][1] for b in bones if b in rig.head)
    hem_y = float(positions[:, 1].min())
    span = max(support_y - hem_y, 1e-3)
    return np.clip((support_y - positions[:, 1]) / span, 0.0, 1.0)


def _support_weight(positions: np.ndarray, rig, slot: str) -> np.ndarray:
    bones, fade = SUPPORT[slot]
    support_y = max(rig.head[b][1] for b in bones if b in rig.head)
    below = support_y - positions[:, 1]
    return np.clip(1.0 - below / fade, 0.0, 1.0) ** 2


def _by_height(positions: np.ndarray, rig, values: tuple[float, float, float]) -> np.ndarray:
    heights = [rig.head[b][1] for b in LANDMARK_BONES]
    order = np.argsort(heights)
    return np.interp(positions[:, 1], np.array(heights)[order], np.array(values)[order])


def _looseness(hang: np.ndarray, limb: np.ndarray, fabric: Fabric) -> np.ndarray:
    lo, hi = CLING_RELEASE
    t = np.clip((hang - lo) / (hi - lo), 0.0, 1.0)
    lower = t * t * (3 - 2 * t)
    return np.full_like(hang, 1.0) - fabric.cling * (1.0 - fabric.release * lower)


def _ease_fields(positions: np.ndarray, rig, slot: str, fabric: Fabric, category: str, fit: float, gap: np.ndarray):
    allowance = np.array(CATEGORY_EASE_CM[category], dtype=np.float64) / 100 * fit
    radius = _by_height(positions, rig, tuple(allowance / (2 * np.pi)))
    body_radius = _by_height(positions, rig, tuple(np.array(BODY_CM) / 100 / (2 * np.pi)))

    hang = _hang(positions, rig, slot)
    limb = _limb_blend(positions, rig, slot)
    loose = _looseness(hang, limb, fabric)
    flared = radius * loose * (1.0 + (fabric.hem_flare - 1.0) * hang**2)
    ease = np.maximum(flared, fabric.armhole * fit * limb)
    ease = np.maximum(ease, 0.0) + fabric.thickness

    slack = np.clip((ease - gap) / np.maximum(body_radius, 1e-3), 0.0, 0.30)
    return ease, slack, loose


def _boundary_edges(tris: np.ndarray, weld: np.ndarray) -> np.ndarray:
    w = weld[tris]
    pairs = np.sort(np.concatenate([w[:, [0, 1]], w[:, [1, 2]], w[:, [2, 0]]]), axis=1)
    pairs = pairs[pairs[:, 0] != pairs[:, 1]]
    unique, count = np.unique(pairs, axis=0, return_counts=True)
    return unique[count == 1]


def _rim_loops(tris: np.ndarray, weld: np.ndarray) -> list[np.ndarray]:
    edges = _boundary_edges(tris, weld)
    parent = {int(v): int(v) for v in np.unique(edges)}

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b in edges:
        parent[root(int(a))] = root(int(b))
    loops: dict[int, list[int]] = {}
    for v in parent:
        loops.setdefault(root(v), []).append(v)
    return [np.array(sorted(vs)) for vs in loops.values()]


def _on_arm(points: np.ndarray, rig, slot: str) -> np.ndarray:
    arm = np.full(len(points), np.inf)
    for chain in LIMBS.get(slot, ()) if slot != "BOTTOM" else ():
        bones = [b for b in chain if b in rig.head]
        for head, tail in zip(bones, bones[1:]):
            arm = np.minimum(arm, _segment_distance(points, rig.head[head], rig.head[tail]))
    torso = np.full(len(points), np.inf)
    for a, b in (("Hips", "Spine"), ("Spine", "Spine1"), ("Spine1", "Spine2"), ("Spine2", "Neck")):
        if a in rig.head and b in rig.head:
            torso = np.minimum(torso, _segment_distance(points, rig.head[a], rig.head[b]))
    return arm < torso


def _smooth(points: np.ndarray, pairs: np.ndarray, weight: np.ndarray, passes: int) -> np.ndarray:
    both = np.concatenate([pairs, pairs[:, ::-1]])
    degree = np.bincount(both[:, 0], minlength=len(points))[:, None]
    has = degree[:, 0] > 0
    for _ in range(passes):
        total = np.zeros_like(points)
        np.add.at(total, both[:, 0], points[both[:, 1]])
        average = np.where(has[:, None], total / np.maximum(degree, 1), points)
        points = points + (average - points) * weight[:, None]
    return points


def _cap_standoff(points, weld, tree, body_points, body_normals, cap, edges, trust, rounds: int = 6):
    for _ in range(rounds):
        _, nearest = tree.query(points, workers=-1)
        normal = body_normals[nearest]
        gap = np.einsum("ij,ij->i", points - body_points[nearest], normal)
        excess = np.maximum(gap - cap, 0.0) * trust
        if excess.max() < 5e-4:
            break
        points = points - normal * excess[:, None]
        points = _smooth(points, edges, (excess > 0) * 0.5, 1)[weld]
    return points


def _inflate(positions: np.ndarray, normals: np.ndarray, shortfall: np.ndarray, pin: np.ndarray) -> np.ndarray:
    return positions + normals * (shortfall * (1.0 - pin))[:, None]


def drape(
    positions: np.ndarray,
    tris: np.ndarray,
    weld: np.ndarray,
    normals: np.ndarray,
    rig,
    slot: str,
    fabric: Fabric,
    category: str,
    body,
    collide,
    fit: float = 1.0,
    steps: int = 260,
    iterations: int = 20,
    dt: float = 1 / 180,
):
    body_points, body_normals = body
    tree = cKDTree(body_points)
    edges = _unique_edges(tris, weld)
    if fabric.cling > 0:
        _, nearest = tree.query(positions, workers=-1)
        gap = np.einsum("ij,ij->i", positions - body_points[nearest], body_normals[nearest])
        ease, _, loose = _ease_fields(positions, rig, slot, fabric, category, fit, gap)
        cap = ease + fabric.fold * loose * fit + FLOOR_M
        facing = np.einsum("ij,ij->i", normals, body_normals[nearest])
        on_torso = np.clip(1.0 - _limb_blend(positions, rig, slot) * 4.0, 0.0, 1.0) * (gap < fabric.cap_bulge)
        on_sleeve = _on_arm(body_points[nearest], rig, slot) * (gap < CAP_MAX_SLEEVE_M)
        trust = np.maximum(on_torso, on_sleeve) * np.clip((facing - 0.5) / 0.3, 0.0, 1.0)
        capped = _cap_standoff(positions, weld, tree, body_points, body_normals, cap, edges, trust)
        positions = collide(capped, ease)[weld]

    _, nearest = tree.query(positions, workers=-1)
    gap = np.einsum("ij,ij->i", positions - body_points[nearest], body_normals[nearest])

    ease, slack, loose = _ease_fields(positions, rig, slot, fabric, category, fit, gap)
    pin = _support_weight(positions, rig, slot)
    hang = _hang(positions, rig, slot)
    tether = np.maximum(ease - gap, 0.0) + fabric.fold * (1.0 + hang) * fit * loose
    slide = (SLIDE_M + SLIDE_HEM_M * hang) * fit
    outward = body_normals[nearest]

    anchor = positions
    x = _inflate(positions, normals, np.maximum(ease - gap, 0.0), pin)[weld]

    bends = _bend_pairs(tris, weld)
    edge_slack = slack[edges].mean(axis=1)
    rest_edge = np.linalg.norm(x[edges[:, 0]] - x[edges[:, 1]], axis=1) * (1.0 + edge_slack)
    rest_bend = np.linalg.norm(x[bends[:, 0]] - x[bends[:, 1]], axis=1)

    area = _vertex_areas(positions, tris, weld)
    inv_mass = np.where(area > 0, 1.0 / np.maximum(area * fabric.mass, 1e-6), 0.0)
    inv_mass = inv_mass * (1.0 - pin)
    free = inv_mass > 0

    counts = np.bincount(edges.ravel(), minlength=len(x)) + np.bincount(bends.ravel(), minlength=len(x))
    divisor = np.maximum(counts, 1).astype(np.float64)[:, None]

    def project(points: np.ndarray, pairs: np.ndarray, rest: np.ndarray, stiffness: float, out: np.ndarray):
        delta = points[pairs[:, 0]] - points[pairs[:, 1]]
        length = np.linalg.norm(delta, axis=1)
        live = length > 1e-9
        direction = np.zeros_like(delta)
        direction[live] = delta[live] / length[live, None]
        w0, w1 = inv_mass[pairs[:, 0]], inv_mass[pairs[:, 1]]
        total = w0 + w1
        error = np.where(total > 0, (length - rest) * stiffness / np.maximum(total, 1e-12), 0.0)
        np.add.at(out, pairs[:, 0], -(w0 * error)[:, None] * direction)
        np.add.at(out, pairs[:, 1], (w1 * error)[:, None] * direction)

    velocity = np.zeros_like(x)
    for _ in range(steps):
        previous = x
        velocity *= 1.0 - fabric.damping
        velocity[free] += GRAVITY * dt
        p = x + velocity * dt

        for _ in range(iterations):
            correction = np.zeros_like(p)
            project(p, edges, rest_edge, fabric.stretch, correction)
            project(p, bends, rest_bend, fabric.bend * 0.5, correction)
            p = p + correction / divisor
            p[~free] = x[~free]

        settled = collide(p, ease)
        push = settled - p
        depth = np.linalg.norm(push, axis=1)
        contact = depth > 1e-9
        surface = np.zeros_like(push)
        surface[contact] = push[contact] / depth[contact, None]

        travel = settled - anchor
        away = np.einsum("ij,ij->i", travel, outward)
        across = travel - away[:, None] * outward
        crept = np.linalg.norm(across, axis=1)
        clipped = (
            anchor
            + np.clip(away, -tether, tether)[:, None] * outward
            + across * np.minimum(1.0, slide / np.maximum(crept, 1e-9))[:, None]
        )
        held = (np.abs(away) > tether) | (crept > slide)
        if held.any():
            settled[held] = clipped[held]
            settled = collide(settled, ease)

        moved = settled - previous
        sliding = moved - np.einsum("ij,ij->i", moved, surface)[:, None] * surface
        moved[contact] -= fabric.friction * sliding[contact]

        velocity = moved / dt
        speed = np.linalg.norm(velocity, axis=1)
        fast = speed > MAX_SPEED
        velocity[fast] *= (MAX_SPEED / speed[fast])[:, None]
        x = settled[weld]
        velocity = velocity[weld]

    hem_weight = np.clip((hang - HEM_SMOOTH_FROM) / (1.0 - HEM_SMOOTH_FROM), 0.0, 1.0) * 0.5
    hem_weight[~free] = 0.0
    rim = _boundary_edges(tris, weld)
    on_rim = np.zeros(len(x), bool)
    on_rim[rim.ravel()] = True
    x = _smooth(x, rim, np.where(on_rim, hem_weight, 0.0), HEM_SMOOTH_PASSES)
    x = _smooth(x, edges, np.where(on_rim, 0.0, hem_weight), HEM_SMOOTH_PASSES)
    x = collide(x, ease)[weld]

    final = np.linalg.norm(x[edges[:, 0]] - x[edges[:, 1]], axis=1)
    strain = np.abs(final - rest_edge) / np.maximum(rest_edge, 1e-9)
    return x, ease, float(np.median(strain)), float(np.percentile(strain, 99))
