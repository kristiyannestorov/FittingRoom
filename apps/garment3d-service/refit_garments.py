import argparse
import json
import os
import struct

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

import drape as cloth
import garment_construction as build
import garment_pockets
import layout
from pack_uv import best_layout, repack

AVATAR_PATH = os.path.join(os.path.dirname(__file__), "avatar-default.glb")

FEMALE_AVATAR_PATH = os.path.join(os.path.dirname(__file__), "avatar-female.glb")

SIZING_CONTRACT = ("..", "..", "packages", "contracts", "src", "sizing.ts")

GARMENT_MESH = "Garment"

SOURCE_BONE_PREFIX = "mixamorig:"

BODY_PROXY = ["Wolf3D_Body", "Wolf3D_Head", "Wolf3D_Outfit_Top", "Wolf3D_Outfit_Bottom"]
COLLIDERS = {
    "TOP": [["Wolf3D_Body", "Wolf3D_Head", "Wolf3D_Hair", "Wolf3D_Outfit_Top"], ["Wolf3D_Outfit_Bottom"]],
    "BOTTOM": [["Wolf3D_Body", "Wolf3D_Outfit_Bottom"], ["Wolf3D_Outfit_Footwear"]],
    "FULL_BODY": [
        ["Wolf3D_Body", "Wolf3D_Head", "Wolf3D_Hair", "Wolf3D_Outfit_Top"],
        ["Wolf3D_Outfit_Bottom", "Wolf3D_Outfit_Footwear"],
    ],
}
KEEP_INSIDE = {
    "BOTTOM": ["Wolf3D_Outfit_Top"],
}
SLOT_FOR_TYPE = {
    "T_SHIRT": "TOP",
    "LONG_SLEEVE": "TOP",
    "HOODIE": "TOP",
    "SHORTS": "BOTTOM",
    "PANTS": "BOTTOM",
    "DRESS": "FULL_BODY",
}

SOURCE_FOR_CUT = {
    "SHORTS": "PANTS",
    "SHORTS/DENIM": "PANTS/DENIM",
    "T_SHIRT/V_NECK": "T_SHIRT",
    "T_SHIRT/POLO": "T_SHIRT",
}
TRIM_TO_HEM = {"SHORTS": 0.88}

CATEGORY_CUTS = (
    "T_SHIRT/V_NECK",
    "T_SHIRT/POLO",
    "LONG_SLEEVE/BUTTON_UP",
    "PANTS/DENIM",
    "PANTS/ATHLETIC",
    "SHORTS/DENIM",
    "SHORTS/ATHLETIC",
    "DRESS/BODYCON",
    "DRESS/A_LINE",
    "DRESS/MAXI",
    "DRESS/BALL_GOWN",
)

CLEARANCE_M = 0.006

NECKLINE = {"T_SHIRT": 0.004, "LONG_SLEEVE": 0.005}
NECKLINE_FALLOFF_M = 0.05
NECKLINE_LIFT_M = 0.006
NECKLINE_SPREAD = np.radians(20)
NECKLINE_SMOOTH_PASSES = 10

CLOSE_FRONT = {"HOODIE": 0.012}
CLOSE_FRONT_OVERLAP_M = 0.012
CLOSE_FRONT_REACH_M = 0.11
CLOSE_FRONT_STRINGS_M = 0.016
CLOSE_FRONT_LAYER_M = 0.004
IRON_FOLDS = {"HOODIE": 0.1, "PANTS/ATHLETIC": 0.0, "SHORTS/ATHLETIC": 0.0, "PANTS/DENIM": 0.0}
IRON_FOLD_DEG = 150.0
IRON_BELOW_NECK_M = 0.08
IRON_ROUNDS = 4
IRON_PASSES = 6
IRON_GROW = 2
IRON_SOURCE_PLEATS = {"HOODIE": ((((-0.17, -0.085), (0.925, 1.065)), ((0.085, 0.17), (0.925, 1.065))), 0.10)}

PLACKET = {"T_SHIRT/V_NECK": (0.085, 0.055)}

COLLAR = {"T_SHIRT/POLO": (0.028, 0.024, 0.008, 0.014)}
COLLAR_POINT_SPAN = np.radians(30)
COLLAR_CLEARANCE_M = 0.003

LOOSE_TRIM_SHARE = 0.02

HEM_LEVEL = {"T_SHIRT": 0.004, "LONG_SLEEVE": -0.005}
HEM_STRETCH_FROM = "Spine1"

FLAT_CUFFS = {"T_SHIRT"}
CUFF_BAND_END_ROW = 5
CUFF_BAND_REACH_M = 0.02
CUFF_PLAIN_REACH_M = 0.05
PUSH_ROUNDS = 4

RIB_BANDS = {"HOODIE": (0.065, 0.065)}
HANG_FROM_CHEST = {"HOODIE": 0.1}
SETTLE_FRONT_M = {"HOODIE": 0.028}
SETTLE_KEEP = 0.25
HANG_CHEST_BAND_M = (0.06, 0.1)
HANG_HALF_WIDTH_M = 0.11
BAND_BLOUSE_M = 0.03
BAND_BLOUSE_GAIN = 0.1
CUFF_EASE_M = 0.004
CUFF_GIRTH_BINS = (12, 24)
HEM_BAND_EASE_M = 0.02
HEM_TAPER_M = 0.07
CUFF_SHORT_OF_WRIST_M = 0.012
CUFF_STACK_M = 0.14
RIB_PITCH_M = 0.005
NO_BAND = 9.0

SOURCE_STRINGS = {"HOODIE": ((0.019, 0.05), (1.2, 1.35), 0.1)}
STRING_ISLAND_MAX_TRIS = 120
STRING_MAX_WIDTH_M = 0.012
CLOSURE_REBUILD_M = 0.05
CLOSURE_ANCHOR_M = 0.1
CLOSURE_LAYERS_M = 0.003
CLOSURE_EDGE_MARGIN_M = 0.004
CLOSURE_ROLL_M = 0.03
CLOSURE_ROLLED_FACING = 0.6
CLOSURE_THROAT_M = 0.02
CORD_SPACING_M = 0.019
CORD_LENGTH_M = 0.2
CORD_HALF_WIDTH_M = 0.0045
CORD_HALF_THICKNESS_M = 0.0012
CORD_STANDOFF_M = 0.004
CORD_SPLAY_M = 0.006

CONSTRUCTION = {"HOODIE"}
FABRIC_ROUGHNESS = 0.85

TAIL_PREFERENCE = ("Spine", "Neck", "Head", "HandMiddle1")

_COMPONENTS = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class Glb:
    def __init__(self, path: str):
        with open(path, "rb") as f:
            data = f.read()
        json_len = struct.unpack_from("<I", data, 12)[0]
        self.gltf = json.loads(data[20 : 20 + json_len])
        bin_start = 20 + json_len
        bin_len = struct.unpack_from("<I", data, bin_start)[0]
        self.bin = data[bin_start + 8 : bin_start + 8 + bin_len]

    def accessor(self, index: int) -> np.ndarray:
        acc = self.gltf["accessors"][index]
        view = self.gltf["bufferViews"][acc["bufferView"]]
        dtype = np.dtype(_COMPONENTS[acc["componentType"]])
        width = _WIDTH[acc["type"]]
        stride = view.get("byteStride") or dtype.itemsize * width
        start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        count = acc["count"]
        raw = np.frombuffer(self.bin, dtype=np.uint8, count=stride * (count - 1) + dtype.itemsize * width, offset=start)
        out = np.lib.stride_tricks.as_strided(
            raw, shape=(count, dtype.itemsize * width), strides=(stride, 1)
        ).copy()
        values = out.view(dtype).reshape(count, width)
        if acc.get("normalized"):
            values = values.astype(np.float32) / np.iinfo(dtype).max
        return values

    def world_matrices(self) -> list[np.ndarray]:
        nodes = self.gltf["nodes"]
        parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
        cache: dict[int, np.ndarray] = {}

        def local(n: dict) -> np.ndarray:
            if "matrix" in n:
                return np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
            x, y, z, w = n.get("rotation", [0, 0, 0, 1])
            r = np.array([
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
            ])
            m = np.eye(4)
            m[:3, :3] = r * np.array(n.get("scale", [1, 1, 1]))
            m[:3, 3] = n.get("translation", [0, 0, 0])
            return m

        def world(i: int) -> np.ndarray:
            if i not in cache:
                m = local(nodes[i])
                cache[i] = world(parent[i]) @ m if i in parent else m
            return cache[i]

        return [world(i) for i in range(len(nodes))]


def _bind_heads(glb: Glb, skin: dict, joints: list[int]) -> np.ndarray:
    if "inverseBindMatrices" in skin:
        ibm = glb.accessor(skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1)
        return np.array([np.linalg.inv(m)[:3, 3] for m in ibm])
    worlds = glb.world_matrices()
    return np.array([worlds[j][:3, 3] for j in joints])


class Rig:
    def __init__(self, glb: Glb, prefix: str = ""):
        nodes = glb.gltf["nodes"]
        skin = glb.gltf["skins"][0]
        joints = skin["joints"]
        self.names = [nodes[j]["name"].removeprefix(prefix) for j in joints]
        self.head = dict(zip(self.names, _bind_heads(glb, skin, joints)))
        self.children = {
            name: [nodes[c]["name"].removeprefix(prefix) for c in nodes[j].get("children", [])]
            for name, j in zip(self.names, joints)
        }
        self.parent = {c: p for p, cs in self.children.items() for c in cs}


def _tail_child(bone: str, source: Rig, target: Rig) -> str | None:
    common = [c for c in source.children.get(bone, []) if c in target.head]
    for preferred in TAIL_PREFERENCE:
        for child in common:
            if child.endswith(preferred) or child == preferred:
                return child
    return common[0] if common else None


def _frame(head: np.ndarray, direction: np.ndarray) -> np.ndarray:
    y = direction / np.linalg.norm(direction)
    reference = np.array([0.0, 0.0, 1.0])
    if abs(y @ reference) > 0.85:
        reference = np.array([0.0, 1.0, 0.0])
    x = np.cross(y, reference)
    x /= np.linalg.norm(x)
    z = np.cross(x, y)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, y, z, head
    return m


def _bone_transforms(source: Rig, target: Rig, across_scale: float) -> dict[str, np.ndarray]:
    transforms = {}
    for bone in source.names:
        if bone not in target.head:
            raise ValueError(f"avatar has no bone {bone!r}")
        walk, child = bone, _tail_child(bone, source, target)
        while child is None and walk in source.parent:
            walk = source.parent[walk]
            child = _tail_child(walk, source, target)
        if child is None:
            transforms[bone] = np.eye(4)
            continue
        src_dir = source.head[child] - source.head[walk]
        dst_dir = target.head[child] - target.head[walk]
        along = np.linalg.norm(dst_dir) / np.linalg.norm(src_dir) if walk == bone else 1.0
        along = float(np.clip(along, 0.75, 1.4))
        scale = np.diag([across_scale, along, across_scale, 1.0])
        src = _frame(source.head[bone], src_dir)
        dst = _frame(target.head[bone], dst_dir)
        transforms[bone] = dst @ scale @ np.linalg.inv(src)
    return transforms


def _avatar_triangles(avatar: Glb, mesh_names: list[str]) -> list[tuple[np.ndarray, np.ndarray]]:
    parts = []
    for mesh in avatar.gltf["meshes"]:
        if mesh["name"] not in mesh_names:
            continue
        for prim in mesh["primitives"]:
            parts.append((
                avatar.accessor(prim["attributes"]["POSITION"]).astype(np.float64),
                avatar.accessor(prim["indices"]).reshape(-1, 3).astype(np.int64),
            ))
    return parts


def _surface_samples(parts: list[tuple[np.ndarray, np.ndarray]], count: int = 400_000):
    tri_a, tri_b, tri_c, tri_n, tri_area = [], [], [], [], []
    for pos, tris in parts:
        a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
        cross = np.cross(b - a, c - a)
        area = np.linalg.norm(cross, axis=1)
        keep = area > 1e-12
        tri_a.append(a[keep]); tri_b.append(b[keep]); tri_c.append(c[keep])
        tri_n.append(cross[keep] / area[keep, None]); tri_area.append(area[keep])
    tri_a, tri_b, tri_c = np.concatenate(tri_a), np.concatenate(tri_b), np.concatenate(tri_c)
    tri_n, tri_area = np.concatenate(tri_n), np.concatenate(tri_area)

    rng = np.random.default_rng(0)
    pick = rng.choice(len(tri_area), size=count, p=tri_area / tri_area.sum())
    u, v = rng.random(count), rng.random(count)
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    samples = tri_a[pick] + u[:, None] * (tri_b[pick] - tri_a[pick]) + v[:, None] * (tri_c[pick] - tri_a[pick])
    return np.concatenate([samples, tri_a]), np.concatenate([tri_n[pick], tri_n])


def _welded(positions: np.ndarray) -> np.ndarray:
    keys = np.round(positions / 1e-5).astype(np.int64)
    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    return first[inverse.ravel()]


def _clearance(positions: np.ndarray, tris: np.ndarray, weld: np.ndarray) -> np.ndarray:
    edges, degree = _adjacency(tris, weld, len(positions))
    lengths = np.linalg.norm(positions[edges[:, 0]] - positions[edges[:, 1]], axis=1)
    mean = np.bincount(edges[:, 0], weights=lengths, minlength=len(positions)) / np.maximum(degree, 1)
    return np.maximum(CLEARANCE_M, 0.3 * mean[weld])

COLLIDER_REACH_M = 0.10


class _Collider:
    def __init__(self, parts: list[tuple[np.ndarray, np.ndarray]]):
        self.points, self.normals = _surface_samples(parts, count=150_000)
        self.tree = cKDTree(self.points)
        self.hem = float(self.points[:, 1].min())

    def _offsets(self, positions: np.ndarray):
        distance, nearest = self.tree.query(positions, workers=-1)
        normals = self.normals[nearest]
        offset = np.einsum("ij,ij->i", positions - self.points[nearest], normals)
        return offset, normals, distance < COLLIDER_REACH_M

    def push_out(self, positions: np.ndarray, clearance: np.ndarray) -> np.ndarray:
        offset, normals, near = self._offsets(positions)
        depth = clearance - offset
        inside = (depth > 0) & (offset > -0.08) & near
        out = positions.copy()
        out[inside] += normals[inside] * depth[inside, None]
        return out

    def pull_in(self, positions: np.ndarray, clearance: np.ndarray) -> np.ndarray:
        offset, normals, near = self._offsets(positions)
        excess = offset + clearance
        outside = (excess > 0) & (offset < 0.08) & (positions[:, 1] > self.hem) & near
        out = positions.copy()
        out[outside] -= normals[outside] * excess[outside, None]
        return out


def _relax(positions: np.ndarray, tris: np.ndarray, weld: np.ndarray, moved: np.ndarray) -> np.ndarray:
    n = len(positions)
    w = weld[tris]
    edges = np.concatenate([w[:, [0, 1]], w[:, [1, 2]], w[:, [2, 0]]])
    edges = np.concatenate([edges, edges[:, ::-1]])
    total = np.zeros((n, 3))
    np.add.at(total, edges[:, 0], positions[edges[:, 1]])
    degree = np.bincount(edges[:, 0], minlength=n)[:, None]
    has = degree[:, 0] > 0
    average = positions.copy()
    average[has] = total[has] / degree[has]
    out = positions.copy()
    region = moved & has
    out[region] = positions[region] * 0.5 + average[region] * 0.5
    return out[weld]


def _vertex_normals(positions: np.ndarray, tris: np.ndarray, weld: np.ndarray, reference: np.ndarray) -> np.ndarray:
    face = np.cross(positions[tris[:, 1]] - positions[tris[:, 0]], positions[tris[:, 2]] - positions[tris[:, 0]])
    acc = np.zeros_like(positions)
    for k in range(3):
        np.add.at(acc, weld[tris[:, k]], face)
    acc = acc[weld]
    acc /= np.maximum(np.linalg.norm(acc, axis=1, keepdims=True), 1e-12)
    if np.einsum("ij,ij->i", acc, reference).mean() < 0:
        acc = -acc
    return acc.astype(np.float32)


def _retarget(positions, joints, weights, source: Rig, target: Rig):
    across = float(target.head["Neck"][1] / source.head["Neck"][1])
    transforms = _bone_transforms(source, target, across)
    stack = np.stack([transforms[name] for name in source.names])
    weights = weights / np.maximum(weights.sum(axis=1, keepdims=True), 1e-12)
    blended = np.einsum("vk,vkij->vij", weights, stack[joints])
    moved = np.einsum("vij,vj->vi", blended, np.c_[positions, np.ones(len(positions))])[:, :3]
    return moved, blended


def _adjacency(tris: np.ndarray, weld: np.ndarray, n: int):
    w = weld[tris]
    edges = np.concatenate([w[:, [0, 1]], w[:, [1, 2]], w[:, [2, 0]]])
    edges = np.concatenate([edges, edges[:, ::-1]])
    degree = np.bincount(edges[:, 0], minlength=n).astype(np.float64)
    return edges, degree


def _diffuse(field: np.ndarray, edges: np.ndarray, degree: np.ndarray, weld: np.ndarray, iterations: int) -> np.ndarray:
    field = field[weld]
    has = degree > 0
    for _ in range(iterations):
        total = np.zeros_like(field)
        np.add.at(total, edges[:, 0], field[edges[:, 1]])
        average = field.copy()
        average[has] = total[has] / degree[has, None]
        field = (0.5 * field + 0.5 * average)[weld]
    return field


def _conform(fitted, source_body, avatar_body, tris, weld) -> np.ndarray:
    src_points, src_normals = source_body
    dst_points, dst_normals = avatar_body
    _, near_src = cKDTree(src_points).query(fitted, workers=-1)
    p_s = src_points[near_src]
    gap = np.einsum("ij,ij->i", fitted - p_s, src_normals[near_src])

    n_s = src_normals[near_src]
    dst_tree = cKDTree(dst_points)
    shift = np.zeros_like(fitted)
    agree = np.zeros(len(fitted))
    distances, near_dst = dst_tree.query(p_s, k=16, workers=-1)
    facing = np.einsum("vkj,vj->vk", dst_normals[near_dst], n_s) > 0.6
    first = np.argmax(facing, axis=1)
    rows = np.arange(len(fitted))
    chosen = near_dst[rows, first]
    agree = facing[rows, first] & (distances[rows, first] < 0.06)
    n_t = dst_normals[chosen]
    along = np.einsum("ij,ij->i", dst_points[chosen] - p_s, n_t)
    shift = n_t * np.clip(along, -0.04, 0.04)[:, None]

    trust = np.clip((0.12 - np.abs(gap)) / 0.08, 0.0, 1.0) * agree
    edges, degree = _adjacency(tris, weld, len(fitted))
    field = _diffuse(shift * trust[:, None], edges, degree, weld, 25)
    total = _diffuse(trust[:, None], edges, degree, weld, 25)
    return fitted + field / np.maximum(total, 1e-4)


def _fit_neckline(fitted, tris, weld, avatar: "Glb", rig: "Rig", standoff: float) -> np.ndarray:
    loops = cloth._rim_loops(tris, weld)
    if not loops:
        return fitted
    collar = max(loops, key=lambda loop: fitted[loop, 1].max())
    (head_v, head_t), = _avatar_triangles(avatar, ["Wolf3D_Head"])
    neck = _Collider([(head_v, head_t)])

    axis = rig.head["Neck"]
    edges = np.sort(np.concatenate([head_t[:, [0, 1]], head_t[:, [1, 2]], head_t[:, [2, 0]]]), axis=1)
    edge_key, edge_count = np.unique(edges, axis=0, return_counts=True)
    head_rim = np.unique(edge_key[edge_count == 1])
    head_rim = head_rim[head_v[head_rim, 1] < axis[1] + 0.06]
    rim_angle = np.arctan2(head_v[head_rim, 0] - axis[0], head_v[head_rim, 2] - axis[2])
    order = np.argsort(rim_angle)
    angle = np.arctan2(fitted[collar, 0] - axis[0], fitted[collar, 2] - axis[2])
    rim_y = np.array([
        head_v[head_rim, 1][np.abs(np.angle(np.exp(1j * (rim_angle - a)))) < NECKLINE_SPREAD].max(initial=-np.inf)
        for a in angle
    ])
    fallback = np.interp(angle, rim_angle[order], head_v[head_rim, 1][order], period=2 * np.pi)
    rim_y = np.where(np.isfinite(rim_y), rim_y, fallback)
    lift = np.maximum(rim_y + NECKLINE_LIFT_M - fitted[collar, 1], 0.0)
    lifted = fitted[collar] + np.column_stack([np.zeros_like(lift), lift, np.zeros_like(lift)])

    offset, normals, _ = neck._offsets(lifted)
    normals = normals * np.array([1.0, 0.0, 1.0])
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-9)
    excess = np.where(offset < 0.08, np.maximum(offset - standoff, 0.0), 0.0)
    shift = lifted - fitted[collar] - normals * excess[:, None]

    distance, nearest = cKDTree(fitted[collar]).query(fitted, workers=-1)
    t = np.clip(1.0 - distance / NECKLINE_FALLOFF_M, 0.0, 1.0)
    weight = t * t * (3 - 2 * t)
    pulled = fitted + shift[nearest] * weight[:, None]
    edge_pairs = cloth._boundary_edges(tris, weld)
    in_collar = np.zeros(len(fitted), bool)
    in_collar[collar] = True
    edge_pairs = edge_pairs[in_collar[edge_pairs].all(axis=1)]
    pulled = cloth._smooth(pulled, edge_pairs, np.where(in_collar, 0.5, 0.0), NECKLINE_SMOOTH_PASSES)
    band = np.where(in_collar, 0.0, 0.5 * weight)
    pulled = cloth._smooth(pulled, cloth._unique_edges(tris, weld), band, NECKLINE_SMOOTH_PASSES)[weld]
    near = weight > 0
    pulled[near] = neck.push_out(pulled[near], np.full(int(near.sum()), standoff))
    return pulled[weld]


def _add_collar(attributes: dict, tris: np.ndarray, stand: float, reach: float, drop: float, point: float):
    fitted, source = attributes["POSITION"], attributes["SOURCE"]
    weld = _welded(fitted)
    rim = np.asarray(max(cloth._rim_loops(tris, weld), key=lambda loop: fitted[loop, 1].max()))
    centre = source[rim].mean(axis=0)
    around = np.arctan2(source[rim, 0] - centre[0], centre[2] - source[rim, 2])
    order = np.argsort(around)
    rim, around = rim[order], around[order]

    base = fitted[rim]
    out = (base - base.mean(axis=0)) * np.array([1.0, 0.0, 1.0])
    out /= np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-9)
    up = np.array([0.0, 1.0, 0.0])
    tip = np.clip((np.abs(around) - (np.pi - COLLAR_POINT_SPAN)) / COLLAR_POINT_SPAN, 0.0, 1.0)[:, None]
    fold = base + up * (stand + 0.004) + out * 0.004
    edge = base + out * (reach + 0.6 * point * tip) - up * (drop + point * tip)

    shirt_normals = _vertex_normals(fitted, tris, weld, attributes["NORMAL"])
    _, nearest = cKDTree(fitted).query(edge, workers=-1)
    below = np.einsum("ij,ij->i", edge - fitted[nearest], shirt_normals[nearest])
    edge += shirt_normals[nearest] * np.maximum(COLLAR_CLEARANCE_M - below, 0.0)[:, None]

    rows = [base, base + up * stand - out * 0.002, fold, edge]
    facing = [out, up + out, up + out]
    count, first = len(rim), len(fitted)

    def at(row: int, i: np.ndarray) -> np.ndarray:
        return first + row * count + i

    i = np.arange(count - 1)
    new_tris, wanted = [], []
    for row in range(3):
        a, b, c, d = at(row, i), at(row, i + 1), at(row + 1, i + 1), at(row + 1, i)
        new_tris += [np.column_stack([a, b, c]), np.column_stack([a, c, d])]
        wanted += [facing[row][:-1], facing[row][:-1]]
    new_tris, wanted = np.concatenate(new_tris), np.concatenate(wanted)

    positions = np.concatenate([fitted, *rows])
    shirt_face = np.cross(fitted[tris[:, 1]] - fitted[tris[:, 0]], fitted[tris[:, 2]] - fitted[tris[:, 0]])
    winding = np.sign(np.einsum("ij,ij->i", shirt_face, attributes["NORMAL"][tris[:, 0]]).mean())
    face = np.cross(positions[new_tris[:, 1]] - positions[new_tris[:, 0]], positions[new_tris[:, 2]] - positions[new_tris[:, 0]])
    flip = np.einsum("ij,ij->i", face, wanted) * winding < 0
    new_tris[flip] = new_tris[flip][:, [0, 2, 1]]

    edges = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]]])
    density = np.median(
        np.linalg.norm(attributes["TEXCOORD_0"][edges[:, 0]] - attributes["TEXCOORD_0"][edges[:, 1]], axis=1)
        / np.maximum(np.linalg.norm(fitted[edges[:, 0]] - fitted[edges[:, 1]], axis=1), 1e-9)
    )
    u = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(base, axis=0), axis=1))])
    v = np.concatenate([[0.0], np.cumsum([np.linalg.norm(rows[r + 1] - rows[r], axis=1).mean() for r in range(3)])])
    island = np.stack(np.meshgrid(u, v), axis=-1).reshape(-1, 2) * density + np.array([2.0, 0.0])

    normal_rows = [out, out, (up + out) / np.sqrt(2), (up + out) / np.sqrt(2)]
    extended = {
        "POSITION": positions,
        "NORMAL": np.concatenate([attributes["NORMAL"], *normal_rows]),
        "TEXCOORD_0": np.concatenate([attributes["TEXCOORD_0"], island.astype(attributes["TEXCOORD_0"].dtype)]),
        "JOINTS_0": np.concatenate([attributes["JOINTS_0"], np.tile(attributes["JOINTS_0"][rim], (4, 1))]),
        "WEIGHTS_0": np.concatenate([attributes["WEIGHTS_0"], np.tile(attributes["WEIGHTS_0"][rim], (4, 1))]),
        "SOURCE": np.concatenate([source, np.tile(source[rim], (4, 1))]),
    }
    print(f"  grew a collar: {count} columns, {1000 * stand:.0f} mm stand, {len(new_tris)} triangles")
    return extended, np.concatenate([tris, new_tris])


def _split_along(side_of, attributes: dict, tris: np.ndarray, key: str = "POSITION") -> tuple[dict, np.ndarray]:
    positions = attributes[key]
    value = side_of(positions)
    positive = value >= 0
    added = {key: [] for key in attributes}
    cache: dict[tuple[int, int], int] = {}
    count = len(positions)

    def cut(i: int, j: int) -> int:
        key = (i, j) if i < j else (j, i)
        if key not in cache:
            a, b = key
            t = value[a] / (value[a] - value[b])
            for name, values in attributes.items():
                if name in ("JOINTS_0", "WEIGHTS_0"):
                    added[name].append(values[a if t < 0.5 else b])
                else:
                    added[name].append(values[a] + t * (values[b] - values[a]))
            cache[key] = count + len(added["POSITION"]) - 1
        return cache[key]

    out = []
    for tri in tris:
        mask = positive[tri]
        if mask.all() or not mask.any():
            out.append(list(tri))
            continue
        k = int(np.flatnonzero(mask != (mask.sum() == 2))[0])
        lone, a, b = tri[k], tri[(k + 1) % 3], tri[(k + 2) % 3]
        pa, pb = cut(lone, a), cut(lone, b)
        out += [[lone, pa, pb], [pa, a, b], [pa, b, pb]]
    grown = {
        name: np.concatenate([values, np.array(added[name], dtype=values.dtype).reshape(-1, values.shape[1])])
        for name, values in attributes.items()
    }
    return grown, np.array(out, dtype=np.int64)


def _cut_placket(attributes: dict, tris: np.ndarray, rig: "Rig", target_neck: np.ndarray, depth: float, half: float):
    positions = attributes["SOURCE"]
    axis = rig.head["Neck"]
    weld = _welded(positions)
    collar = max(cloth._rim_loops(tris, weld), key=lambda loop: positions[loop, 1].max())
    front = collar[(positions[collar, 2] > axis[2]) & (np.abs(positions[collar, 0] - axis[0]) < half)]
    if len(front) == 0:
        return attributes, tris
    top = positions[front, 1].min()
    tip = top - depth
    slope = half / depth

    def left(p):
        return (p[:, 0] - axis[0]) + slope * (p[:, 1] - tip)

    def right(p):
        return slope * (p[:, 1] - tip) - (p[:, 0] - axis[0])

    for side_of in (left, right, lambda p: p[:, 1] - tip):
        attributes, tris = _split_along(side_of, attributes, tris, key="SOURCE")
    centre = attributes["SOURCE"][tris].mean(axis=1)
    inside = (left(centre) > 0) & (right(centre) > 0) & (centre[:, 1] > tip) & (centre[:, 2] > axis[2])
    print(f"  opened a {1000 * depth:.0f} mm placket V ({int(inside.sum())} triangles)")
    opening = _fitted_opening(attributes["POSITION"][tris[inside]].reshape(-1, 3), target_neck)
    tris = tris[~inside]
    used = np.unique(tris)
    remap = np.full(len(attributes["POSITION"]), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return {name: values[used] for name, values in attributes.items()}, remap[tris], opening


def _fitted_opening(corners: np.ndarray, axis: np.ndarray):
    tip, top = corners[:, 1].min(), corners[:, 1].max()
    rise = corners[:, 1] - tip
    above = rise > 1e-3
    slope = float(np.max(np.abs(corners[above, 0] - axis[0]) / rise[above])) if above.any() else 0.3
    return (axis, tip, top, slope)

UNDERLAY_MESH = "Underlay"
UNDERLAY_MARGIN_M = 0.015


def _underlay(avatar: "Glb", opening) -> dict | None:
    axis, tip, top, slope = opening
    node = next(n for n in avatar.gltf["nodes"] if n.get("name") == "Wolf3D_Outfit_Top")
    prim = avatar.gltf["meshes"][node["mesh"]]["primitives"][0]
    attributes = {
        name: avatar.accessor(prim["attributes"][name]).astype(np.float64 if name != "JOINTS_0" else np.int64)
        for name in ("POSITION", "NORMAL", "JOINTS_0", "WEIGHTS_0")
    }
    tris = avatar.accessor(prim["indices"]).reshape(-1, 3).astype(np.int64)
    m = UNDERLAY_MARGIN_M
    sides = (
        lambda p: (p[:, 0] - axis[0]) + slope * (p[:, 1] - tip) + m,
        lambda p: slope * (p[:, 1] - tip) - (p[:, 0] - axis[0]) + m,
        lambda p: p[:, 1] - (tip - m),
        lambda p: (top + m) - p[:, 1],
    )
    for side_of in sides:
        attributes, tris = _split_along(side_of, attributes, tris)
    centre = attributes["POSITION"][tris].mean(axis=1)
    keep = np.all([side_of(centre) > 0 for side_of in sides], axis=0) & (centre[:, 2] > axis[2])
    tris = tris[keep]
    if len(tris) == 0:
        return None
    used = np.unique(tris)
    remap = np.full(len(attributes["POSITION"]), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    out = {name: values[used] for name, values in attributes.items()}
    out["NORMAL"] /= np.maximum(np.linalg.norm(out["NORMAL"], axis=1, keepdims=True), 1e-12)
    out["tris"] = remap[tris]
    print(f"  underlay: {len(out['tris'])} triangles of the avatar's tee behind the opening")
    return out


def _drop_loose_trim(tris: np.ndarray, weld: np.ndarray) -> np.ndarray:
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    w = weld[tris]
    edges = np.concatenate([w[:, [0, 1]], w[:, [1, 2]]])
    n = int(weld.max()) + 1
    graph = coo_matrix((np.ones(len(edges)), (edges[:, 0], edges[:, 1])), shape=(n, n))
    _, label = connected_components(graph, directed=False)
    piece = label[w[:, 0]]
    share = np.bincount(piece) / len(tris)
    keep = share[piece] >= LOOSE_TRIM_SHARE
    if not keep.all():
        print(f"  dropped {int((~keep).sum())} triangles of loose trim")
    return tris[keep]


def _sharp_fold_vertices(fitted, tris, weld) -> np.ndarray:
    w = weld[tris]
    n = np.cross(fitted[tris[:, 1]] - fitted[tris[:, 0]], fitted[tris[:, 2]] - fitted[tris[:, 0]])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    rows = [np.column_stack([np.sort(w[:, [a, b]], axis=1), np.arange(len(tris))]) for a, b in ((0, 1), (1, 2), (2, 0))]
    r = np.concatenate(rows)
    r = r[np.lexsort((r[:, 1], r[:, 0]))]
    same = (r[1:, 0] == r[:-1, 0]) & (r[1:, 1] == r[:-1, 1])
    f1, f2 = r[:-1][same, 2], r[1:][same, 2]
    cos = (n[f1] * n[f2]).sum(axis=1)
    sharp = cos < np.cos(np.radians(IRON_FOLD_DEG))
    return np.unique(w[np.concatenate([f1[sharp], f2[sharp]])])


def _iron_source_pleats(positions: np.ndarray, tris: np.ndarray, boxes, z_min: float) -> np.ndarray:
    from scipy import sparse
    from scipy.sparse.linalg import spsolve

    weld = _welded(positions)
    p = positions[weld]
    zone = np.zeros(len(p), bool)
    for (xa, xb), (ya, yb) in boxes:
        zone |= (p[:, 0] >= xa) & (p[:, 0] <= xb) & (p[:, 1] >= ya) & (p[:, 1] <= yb) & (p[:, 2] > z_min)
    zone &= weld == np.arange(len(p))
    edges = np.unique(_adjacency(tris, weld, len(p))[0], axis=0)
    degree = np.bincount(edges[:, 0], minlength=len(p)).astype(np.float64)
    idx = np.flatnonzero(zone)
    column = np.full(len(p), -1)
    column[idx] = np.arange(len(idx))
    e = edges[zone[edges[:, 0]]]
    inner = zone[e[:, 1]]
    system = sparse.coo_matrix(
        (-np.ones(inner.sum()), (column[e[inner, 0]], column[e[inner, 1]])), shape=(len(idx), len(idx))
    ).tocsr() + sparse.diags(degree[idx])
    held = np.zeros((len(idx), 3))
    np.add.at(held, column[e[~inner, 0]], p[e[~inner, 1]])
    out = p.copy()
    out[idx] = np.column_stack([spsolve(system.tocsc(), held[:, k]) for k in range(3)])
    moved = np.linalg.norm(out[idx] - p[idx], axis=1).max()
    print(f"  ironed the source's pocket pleats: {len(idx)} vertices, moved {1000 * moved:.0f} mm at most")
    return out[weld]


def _iron_folds(fitted, tris, weld, rig: "Rig", collide, floor, centre: float) -> np.ndarray:
    axis = rig.head["Neck"]
    edges = cloth._unique_edges(tris, weld)
    both = np.concatenate([edges, edges[:, ::-1]])
    before = len(_sharp_fold_vertices(fitted, tris, weld))
    for _ in range(IRON_ROUNDS):
        sharp = _sharp_fold_vertices(fitted, tris, weld)
        sharp = sharp[
            (fitted[sharp, 1] < axis[1] - IRON_BELOW_NECK_M) & (np.abs(fitted[sharp, 0] - axis[0]) > centre)
        ]
        if len(sharp) == 0:
            break
        mask = np.zeros(len(fitted), bool)
        mask[sharp] = True
        for _ in range(IRON_GROW):
            grown = mask.copy()
            grown[both[mask[both[:, 0]], 1]] = True
            mask = grown
        fitted = cloth._smooth(fitted, edges, mask * 0.5, IRON_PASSES)[weld]
        fitted = collide(fitted, floor)
    after = len(_sharp_fold_vertices(fitted, tris, weld))
    print(f"  ironed folded-back flaps: {before} -> {after} vertices on a fold over {IRON_FOLD_DEG:.0f} deg")
    return fitted


def _close_front(
    fitted, tris, weld, avatar: "Glb", rig: "Rig", below_neck: float, only_top: float | None = None
) -> np.ndarray:
    loops = cloth._rim_loops(tris, weld)
    if not loops:
        return fitted
    axis = rig.head["Neck"]
    collar = np.asarray(max(loops, key=lambda loop: fitted[loop, 1].max()))
    front = collar[fitted[collar, 2] > axis[2]]
    if len(front) < 8:
        return fitted

    (head_v, head_t), = _avatar_triangles(avatar, ["Wolf3D_Head"])
    edges = np.sort(np.concatenate([head_t[:, [0, 1]], head_t[:, [1, 2]], head_t[:, [2, 0]]]), axis=1)
    edge_key, edge_count = np.unique(edges, axis=0, return_counts=True)
    rim = head_v[np.unique(edge_key[edge_count == 1])]
    throat = rim[(np.abs(rim[:, 0] - axis[0]) < 0.03) & (rim[:, 2] > axis[2])]
    top = (throat[:, 1].min() if len(throat) else axis[1]) - below_neck

    x0 = axis[0]
    tip = fitted[front, 1].min()
    heights = np.arange(tip, top + 0.005, 0.005)
    edge = np.full((len(heights), 2), np.nan)
    for i, h in enumerate(heights):
        row = fitted[front[np.abs(fitted[front, 1] - h) < 0.006], 0] - x0
        if (row < 0).any() and (row >= 0).any():
            edge[i] = -row.min(), row.max()
    known = ~np.isnan(edge[:, 0])
    if known.sum() < 2:
        return fitted
    edge = np.column_stack([np.interp(heights, heights[known], edge[known, k]) for k in (0, 1)])
    edge = ndimage.uniform_filter1d(edge, 5, axis=0, mode="nearest")

    y = fitted[:, 1]
    offset = fitted[:, 0] - x0
    side = (offset >= 0).astype(int)
    to_edge = np.column_stack([np.interp(np.minimum(y, top), heights, edge[:, k]) for k in (0, 1)])
    to_edge = to_edge[np.arange(len(y)), side]
    fade = np.clip((y - (tip - 0.02)) / 0.02, 0.0, 1.0)
    above = np.clip((y - top) / 0.03, 0.0, 1.0)
    fade *= 1.0 - above * above * (3 - 2 * above)
    fade *= fitted[:, 2] > axis[2] - 0.02
    if only_top is not None:
        fade *= np.clip((y - (top - only_top)) / 0.01, 0.0, 1.0)
    reach = (to_edge + CLOSE_FRONT_OVERLAP_M / 2) * fade

    distance = np.abs(offset)
    inside = distance < to_edge
    t = np.clip(1.0 - (distance - to_edge) / CLOSE_FRONT_REACH_M, 0.0, 1.0)
    u = np.clip((distance - CLOSE_FRONT_STRINGS_M) / np.maximum(to_edge - CLOSE_FRONT_STRINGS_M, 1e-6), 0.0, 1.0)
    falloff = np.where(inside, u * u * (3 - 2 * u), t * t * (3 - 2 * t))
    strings = inside & (distance < CLOSE_FRONT_STRINGS_M + 0.01)

    closed = fitted.copy()
    sign = np.where(side == 1, 1.0, -1.0)
    closed[:, 0] -= sign * reach * falloff
    closed[:, 2] += (side == 1) * CLOSE_FRONT_LAYER_M * falloff**2 * (fade > 0)
    ramp = np.clip((CLOSE_FRONT_STRINGS_M + 0.01 - distance) / 0.01, 0.0, 1.0)
    closed[:, 2] += strings * 2 * CLOSE_FRONT_LAYER_M * ramp * fade
    print(
        f"  closed the front from {1000 * (axis[1] - tip):.0f} to {1000 * (axis[1] - top):.0f} mm"
        f" below the neck joint ({1000 * edge.sum(axis=1).max():.0f} mm at its widest)"
    )
    return closed[weld]


def _lengthen(fitted, weld, rig: "Rig", hem_level: float) -> np.ndarray:
    hips = rig.head["Hips"]
    start = rig.head[HEM_STRETCH_FROM][1]
    target = hips[1] + hem_level
    below = fitted[:, 1] < start
    angle = np.arctan2(fitted[:, 0] - hips[0], fitted[:, 2] - hips[2])
    bins = np.linspace(-np.pi, np.pi, 37)
    which = np.clip(np.digitize(angle, bins) - 1, 0, 35)
    hem = np.full(36, np.nan)
    torso = below & (np.abs(fitted[:, 0] - hips[0]) < 0.2)
    for k in range(36):
        here = torso & (which == k)
        if here.any():
            hem[k] = fitted[here, 1].min()
    known = ~np.isnan(hem)
    centres = (bins[:-1] + bins[1:]) / 2
    hem_y = np.interp(angle, centres[known], hem[known], period=2 * np.pi)
    t = np.clip((start - fitted[:, 1]) / np.maximum(start - hem_y, 1e-3), 0.0, 1.0)
    drop = np.maximum(hem_y - target, 0.0) * t
    out = fitted.copy()
    out[:, 1] -= drop * below
    return out[weld]


def _flatten_cuffs(fitted, tris, weld, rig: "Rig") -> np.ndarray:
    edges = cloth._unique_edges(tris, weld)
    loops = [loop for loop in cloth._rim_loops(tris, weld) if cloth._on_arm(fitted[loop], rig, "TOP").mean() > 0.5]
    if not loops:
        return fitted
    cuffs = np.concatenate(loops)

    neighbours = [[] for _ in range(len(fitted))]
    for a, b in edges:
        neighbours[a].append(b)
        neighbours[b].append(a)
    row = {int(v): 0 for v in cuffs}
    front = list(row)
    for depth in range(1, CUFF_BAND_END_ROW + 1):
        reached = []
        for v in front:
            for u in neighbours[v]:
                if u not in row:
                    row[u] = depth
                    reached.append(u)
        front = reached
    vertices = np.array(list(row))
    rows = np.array([row[v] for v in vertices])

    out = fitted.copy()
    hips_x = rig.head["Hips"][0]
    for side in ("Left", "Right"):
        head, tail = rig.head.get(f"{side}Arm"), rig.head.get(f"{side}ForeArm")
        if head is None or tail is None:
            continue
        axis = (tail - head) / np.linalg.norm(tail - head)
        mine = np.sign(fitted[vertices, 0] - hips_x) == np.sign(head[0] - hips_x)
        v, r_ = vertices[mine], rows[mine]
        from_edge, _ = cKDTree(fitted[v[r_ == 0]]).query(fitted[v], workers=-1) if (r_ == 0).any() else (np.full(len(v), np.inf), None)
        edge = r_ == 0
        plain = (r_ == CUFF_BAND_END_ROW) & (from_edge < CUFF_PLAIN_REACH_M)
        if edge.sum() < 3 or plain.sum() < 3:
            continue
        radial = (fitted[v] - head) - ((fitted[v] - head) @ axis)[:, None] * axis
        up = np.cross(axis, [0.0, 0.0, 1.0])
        up /= np.linalg.norm(up)
        angle = np.arctan2(radial @ np.cross(axis, up), radial @ up)

        def at(which: np.ndarray, query: np.ndarray) -> np.ndarray:
            order = np.argsort(angle[which])
            a, pts = angle[which][order], fitted[v[which]][order]
            return np.column_stack([np.interp(query, a, pts[:, k], period=2 * np.pi) for k in range(3)])

        band = (r_ > 0) & (r_ < CUFF_BAND_END_ROW) & (from_edge < CUFF_BAND_REACH_M)
        f = (r_[band] / CUFF_BAND_END_ROW)[:, None]
        out[v[band]] = at(edge, angle[band]) * (1 - f) + at(plain, angle[band]) * f
    return out[weld]


def _distance_up(fitted, tris, weld, loop: np.ndarray, limit: float) -> np.ndarray:
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import dijkstra

    edges = cloth._unique_edges(tris, weld)
    length = np.linalg.norm(fitted[edges[:, 0]] - fitted[edges[:, 1]], axis=1)
    n = len(fitted)
    graph = coo_matrix(
        (np.r_[length, length], (np.r_[edges[:, 0], edges[:, 1]], np.r_[edges[:, 1], edges[:, 0]])), shape=(n, n)
    ).tocsr()
    return dijkstra(graph, indices=np.unique(weld[loop]), min_only=True, limit=limit)[weld]


def _smoothstep(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def _gather_bands(fitted, tris, weld, rig: "Rig", avatar: "Glb", cuff: float, hem: float):
    rib = np.zeros((len(fitted), 4), np.float32)
    rib[:, 0], rib[:, 1] = NO_BAND, 1.0
    loops = cloth._rim_loops(tris, weld)
    on_arm = [cloth._on_arm(fitted[loop], rig, "TOP").mean() > 0.5 for loop in loops]
    cuffs = [loop for loop, arm in zip(loops, on_arm) if arm]
    rest = [loop for loop, arm in zip(loops, on_arm) if not arm]
    skin = _surface_samples(_avatar_triangles(avatar, ["Wolf3D_Body"]), count=200_000)[0]
    hips_below = np.concatenate([p for p, _ in _avatar_triangles(avatar, ["Wolf3D_Body", "Wolf3D_Outfit_Bottom"])])
    out = fitted.copy()
    hips_x = rig.head["Hips"][0]

    for loop in cuffs:
        side = "Left" if np.sign(fitted[loop, 0].mean() - hips_x) == np.sign(rig.head["LeftHand"][0] - hips_x) else "Right"
        wrist, elbow = rig.head[f"{side}Hand"], rig.head[f"{side}ForeArm"]
        axis = (wrist - elbow) / np.linalg.norm(wrist - elbow)
        d = _distance_up(fitted, tris, weld, loop, cuff + CUFF_STACK_M + 0.05)
        near = np.isfinite(d)
        rel = fitted[near] - wrist
        t = rel @ axis
        radial = rel - t[:, None] * axis
        r = np.linalg.norm(radial, axis=1)
        unit = radial / np.maximum(r, 1e-9)[:, None]

        up = np.cross(axis, [0.0, 0.0, 1.0])
        up /= np.linalg.norm(up)
        side_axis = np.cross(axis, up)
        angle = np.arctan2(unit @ side_axis, unit @ up)

        body = skin - wrist
        bt = body @ axis
        radial_b = body - bt[:, None] * axis
        br = np.linalg.norm(radial_b, axis=1)
        keep = (br < 0.07) & (bt > -cuff - CUFF_STACK_M - 0.02) & (bt < 0.0)
        bt, br = bt[keep], br[keep]
        ba = np.arctan2(radial_b[keep] @ side_axis, radial_b[keep] @ up)
        rows, cols = CUFF_GIRTH_BINS
        grid = np.linspace(-cuff - CUFF_STACK_M - 0.02, 0.0, rows + 1)
        row_of = np.clip(np.searchsorted(grid, bt) - 1, 0, rows - 1)
        col_of = ((ba + np.pi) / (2 * np.pi) * cols).astype(int) % cols
        girth = np.full((rows, cols), np.nan)
        np.fmax.at(girth, (row_of, col_of), br)
        middle = (np.arange(cols) + 0.5) / cols * 2 * np.pi - np.pi
        for row in range(rows):
            known = ~np.isnan(girth[row])
            girth[row] = np.interp(middle, middle[known], girth[row, known], period=2 * np.pi) if known.any() else np.nan
        known = ~np.isnan(girth[:, 0])
        if known.sum() < 2:
            continue
        centres = (grid[1:] + grid[:-1]) / 2
        girth = np.column_stack([np.interp(centres, centres[known], girth[known, c]) for c in range(cols)])
        girth = ndimage.uniform_filter1d(girth, 3, axis=1, mode="wrap")

        du = d[near]
        stack = max(float(t[np.isin(np.flatnonzero(near), loop)].mean()) + CUFF_SHORT_OF_WRIST_M, 0.0)
        shift = stack * np.where(du <= cuff, 1.0, 1.0 - _smoothstep((du - cuff) / CUFF_STACK_M))
        t_new = t - shift
        row = np.clip(np.searchsorted(grid, t_new) - 1, 0, rows - 1)
        snug = np.array([np.interp(a, middle, girth[k], period=2 * np.pi) for a, k in zip(angle, row)]) + CUFF_EASE_M
        pull = 1.0 - _smoothstep((du - cuff) / BAND_BLOUSE_M)
        blouse = np.exp(-(((du - cuff - BAND_BLOUSE_M * 0.6) / (BAND_BLOUSE_M * 0.5)) ** 2))
        r_new = (r * (1 - pull) + snug * pull) * (1 + BAND_BLOUSE_GAIN * blouse)
        out[near] = wrist + t_new[:, None] * axis + unit * r_new[:, None]

        wales = round(float(snug[du < cuff].mean()) * 2 * np.pi / RIB_PITCH_M)
        mine = np.flatnonzero(near)[du < 2 * cuff]
        rib[mine] = np.column_stack([
            du[du < 2 * cuff] / cuff, np.cos(angle[du < 2 * cuff]), np.sin(angle[du < 2 * cuff]),
            np.full((du < 2 * cuff).sum(), wales),
        ])
        print(f"  gathered the {side.lower()} cuff: drawn back {1000 * stack:.0f} mm, {wales} wales")

    if rest:
        loop = min(rest, key=lambda l: fitted[l, 1].mean())
        d = _distance_up(fitted, tris, weld, loop, hem + HEM_TAPER_M + 0.08)
        edge_angle = np.arctan2(fitted[loop, 2] - np.median(fitted[loop, 2]), fitted[loop, 0] - hips_x)
        edge_bins = 36
        edge_which = ((edge_angle + np.pi) / (2 * np.pi) * edge_bins).astype(int) % edge_bins
        edge_y = np.full(edge_bins, np.nan)
        for b in range(edge_bins):
            if (edge_which == b).any():
                edge_y[b] = fitted[loop][edge_which == b, 1].min()
        edge_mid = (np.arange(edge_bins) + 0.5) / edge_bins * 2 * np.pi - np.pi
        known_edge = ~np.isnan(edge_y)
        edge_y = ndimage.uniform_filter1d(
            np.interp(edge_mid, edge_mid[known_edge], edge_y[known_edge], period=2 * np.pi), 3, mode="wrap"
        )
        vertex_angle = np.arctan2(fitted[:, 2] - np.median(fitted[loop, 2]), fitted[:, 0] - hips_x)
        edge_at = np.interp(vertex_angle, edge_mid, edge_y, period=2 * np.pi)
        rise = fitted[:, 1] - edge_at
        d = np.where(np.isfinite(d), np.clip(np.minimum(rise, d), 0.0, None), np.inf)
        d[(d > hem + HEM_TAPER_M + 0.03)] = np.inf
        near = np.isfinite(d)
        on_edge = np.zeros(len(fitted), bool)
        on_edge[loop] = True
        on_edge = np.bincount(weld, weights=on_edge, minlength=len(fitted))[weld] > 0
        pinned = on_edge | ~near | (rise >= 1.2 * hem)
        value = np.where(on_edge, 0.0, np.where(near, np.minimum(np.maximum(rise, 0.0), d), 0.0))
        edges_b, degree_b = _adjacency(tris, weld, len(fitted))
        has_b = degree_b > 0
        for _ in range(300):
            total = np.zeros(len(fitted))
            np.add.at(total, edges_b[:, 0], value[edges_b[:, 1]])
            average = np.where(has_b, total / np.maximum(degree_b, 1), value)
            value = np.where(pinned, value, average)[weld]
        d = np.where(near, value, np.inf)
        du = d[near]
        out[near, 1] = edge_at[near] + du
        low, high = fitted[loop, 1].min() - 0.02, fitted[near][du < hem, 1].max() + 0.02
        slab = hips_below[(hips_below[:, 1] > low) & (hips_below[:, 1] < high) & (np.abs(hips_below[:, 0] - hips_x) < 0.22)]
        centre = np.array([hips_x, 0.0, np.median(slab[:, 2])])
        bins = 72
        slab_angle = np.arctan2(slab[:, 2] - centre[2], slab[:, 0] - centre[0])
        slab_r = np.hypot(slab[:, 0] - centre[0], slab[:, 2] - centre[2])
        which = ((slab_angle + np.pi) / (2 * np.pi) * bins).astype(int) % bins
        girth = np.full(bins, np.nan)
        for b in range(bins):
            if (which == b).any():
                girth[b] = slab_r[which == b].max()
        known = ~np.isnan(girth)
        middle = (np.arange(bins) + 0.5) / bins * 2 * np.pi - np.pi
        girth = np.interp(middle, middle[known], girth[known], period=2 * np.pi)
        girth = ndimage.uniform_filter1d(girth, 5, mode="wrap") + HEM_BAND_EASE_M

        p = fitted[near]
        angle = np.arctan2(p[:, 2] - centre[2], p[:, 0] - centre[0])
        r = np.hypot(p[:, 0] - centre[0], p[:, 2] - centre[2])
        snug = np.interp(angle, middle, girth, period=2 * np.pi)
        pull = 1.0 - _smoothstep((du - hem) / HEM_TAPER_M)
        r_new = r * (1 - pull) + snug * pull
        out[near, 0] = centre[0] + np.cos(angle) * r_new
        out[near, 2] = centre[2] + np.sin(angle) * r_new

        wales = round(float(girth.mean()) * 2 * np.pi / RIB_PITCH_M)
        band = du < 2 * hem
        rib[np.flatnonzero(near)[band]] = np.column_stack([
            du[band] / hem, np.cos(angle[band]), np.sin(angle[band]), np.full(band.sum(), wales),
        ])
        print(f"  gathered the hem band: {1000 * float(np.median(r - snug + HEM_BAND_EASE_M)):.0f} mm "
              f"off the hip before, {1000 * HEM_BAND_EASE_M:.0f} after, {wales} wales")
    return out[weld], rib


def _settle_front(fitted, tris, weld, rig: "Rig", body: "_Collider", standoff: float) -> np.ndarray:
    neck, chest, hips = rig.head["Neck"], rig.head["Spine2"], rig.head["Hips"]
    offset, normals, near = body._offsets(fitted)
    arm = cloth._on_arm(fitted, rig, "TOP")
    weight = (
        (near & ~arm)
        * _smoothstep((fitted[:, 2] - chest[2] - 0.02) / 0.04)
        * (1.0 - _smoothstep((fitted[:, 1] - (neck[1] - 0.1)) / 0.04))
        * (fitted[:, 1] > hips[1] - 0.15)
    )
    excess = np.maximum(offset - standoff, 0.0)
    moved = fitted - normals * (excess * (1.0 - SETTLE_KEEP) * weight)[:, None]
    edges = cloth._unique_edges(tris, weld)
    moved = cloth._smooth(moved, edges, 0.5 * np.minimum(weight * 4, 1.0) * (excess > 0), 4)[weld]
    shift = np.linalg.norm(moved - fitted, axis=1)
    print(f"  settled the front: {int((shift > 0.005).sum())} vertices in, {1000 * shift.max():.0f} mm at most")
    return moved


def _hang_front(fitted, weld, rig: "Rig", slope: float) -> np.ndarray:
    hips = rig.head["Hips"]
    chest = rig.head["Spine2"]
    x = fitted[:, 0] - hips[0]
    front = ~cloth._on_arm(fitted, rig, "TOP") & (fitted[:, 2] > chest[2]) & (np.abs(x) < HANG_HALF_WIDTH_M + 0.04)
    bins = np.arange(-HANG_HALF_WIDTH_M - 0.04, HANG_HALF_WIDTH_M + 0.04 + 1e-9, 0.01)
    column = np.clip(np.digitize(x, bins) - 1, 0, len(bins) - 2)
    peak_y = np.full(len(bins) - 1, np.nan)
    peak_z = np.full(len(bins) - 1, np.nan)
    band = front & (fitted[:, 1] > chest[1] - HANG_CHEST_BAND_M[0]) & (fitted[:, 1] < chest[1] + HANG_CHEST_BAND_M[1])
    for c in range(len(bins) - 1):
        mine = np.flatnonzero(band & (column == c))
        if len(mine):
            top = mine[np.argmax(fitted[mine, 2])]
            peak_y[c], peak_z[c] = fitted[top, 1], fitted[top, 2]
    known = ~np.isnan(peak_z)
    if known.sum() < 3:
        return fitted
    middle = (bins[1:] + bins[:-1]) / 2
    peak_y = ndimage.uniform_filter1d(np.interp(middle, middle[known], peak_y[known]), 3, mode="nearest")
    peak_z = ndimage.uniform_filter1d(np.interp(middle, middle[known], peak_z[known]), 3, mode="nearest")

    py, pz = np.interp(x, middle, peak_y), np.interp(x, middle, peak_z)
    drop = py - fitted[:, 1]
    hang = pz - slope * drop
    weight = (
        front
        * _smoothstep(drop / 0.03)
        * (1.0 - _smoothstep((np.abs(x) - HANG_HALF_WIDTH_M) / 0.04))
        * (fitted[:, 1] > hips[1] - 0.15)
    )
    out = fitted.copy()
    out[:, 2] = np.maximum(fitted[:, 2], fitted[:, 2] + (hang - fitted[:, 2]) * weight)
    moved = out[:, 2] - fitted[:, 2]
    print(f"  hung the front from the chest: {int((moved > 0.003).sum())} vertices out, {1000 * moved.max():.0f} mm at most")
    return out[weld]


def _source_strings(tris: np.ndarray, source: np.ndarray, box) -> list[np.ndarray]:
    from pack_uv import uv_islands

    (x_lo, x_hi), (y_lo, y_hi), z_min = box
    _, label = uv_islands(tris, len(source))
    face_label = label[tris[:, 0]]
    sides: dict[int, list[np.ndarray]] = {-1: [], 1: []}
    for island in np.unique(face_label):
        faces = face_label == island
        if faces.sum() > STRING_ISLAND_MAX_TRIS:
            continue
        verts = np.unique(tris[faces])
        p = source[verts]
        c = p.mean(axis=0)
        if np.ptp(p[:, 0]) < STRING_MAX_WIDTH_M and x_lo < abs(c[0]) < x_hi and y_lo < c[1] < y_hi and c[2] > z_min:
            sides[int(np.sign(c[0]))].append(verts)
    return [np.unique(np.concatenate(sides[s])) for s in (-1, 1) if sides[s]]


def _source_opening(tris: np.ndarray, source: np.ndarray):
    loops = cloth._rim_loops(tris, _welded(source))
    if not loops:
        return None
    slot = np.asarray(max(loops, key=lambda loop: source[loop, 1].max()))
    rim = source[slot]
    rim = rim[rim[:, 2] > np.median(source[:, 2])]
    heights = np.arange(rim[:, 1].min(), rim[:, 1].max() + 1e-9, 0.004)
    edges = np.full((len(heights), 2), np.nan)
    for i, h in enumerate(heights):
        row = rim[np.abs(rim[:, 1] - h) < 0.006, 0]
        if (row < 0).any() and (row > 0).any():
            edges[i] = -row.min(), row.max()
    known = ~np.isnan(edges[:, 0])
    if known.sum() < 2:
        return None
    edges = np.column_stack([np.interp(heights, heights[known], edges[known, k]) for k in (0, 1)])
    return float(rim[:, 1].min()), float(rim[:, 1].max()), heights, ndimage.uniform_filter1d(edges, 3, axis=0)


def _rebuild_closure(fitted, tris, source, source_normals, skip: np.ndarray) -> np.ndarray:
    from scipy.interpolate import RBFInterpolator

    opening = _source_opening(tris, source)
    if opening is None:
        return fitted
    tip, top, heights, edges = opening
    used = np.zeros(len(fitted), bool)
    used[np.unique(tris)] = True
    xs, ys = source[:, 0], source[:, 1]
    side = np.where(xs > 0, 1, 0)
    edge = np.column_stack([np.interp(ys, heights, edges[:, k]) for k in (0, 1)])[np.arange(len(xs)), side]
    edge = np.where(ys < tip, 0.0, edge)
    outside = np.abs(xs) - edge
    front = used & ~skip & (source[:, 2] > np.median(source[:, 2])) & (ys > tip - 0.06) & (ys < top)
    facing = front & (ys >= tip) & (
        (outside < -CLOSURE_EDGE_MARGIN_M)
        | ((source_normals[:, 2] < CLOSURE_ROLLED_FACING) & (outside < CLOSURE_ROLL_M))
    )

    fade = _smoothstep((ys - (tip - 0.012)) / 0.012)
    reach = (edge + CLOSE_FRONT_OVERLAP_M) * fade
    shift = reach * (1.0 - _smoothstep(np.maximum(outside, 0.0) / CLOSE_FRONT_REACH_M))
    u = xs - np.sign(xs) * shift

    anchor = front & ~facing & (outside > CLOSURE_REBUILD_M) & (outside < CLOSURE_ANCHOR_M)
    anchor |= used & ~skip & (source[:, 2] > np.median(source[:, 2])) & (ys < tip - 0.03) & (ys > tip - 0.07) & (np.abs(xs) < CLOSURE_ANCHOR_M)
    rebuild = front & (outside < CLOSURE_REBUILD_M)
    if anchor.sum() < 20 or not rebuild.any():
        return fitted
    surface = RBFInterpolator(
        np.column_stack([u[anchor], ys[anchor]]), fitted[anchor], kernel="thin_plate_spline", smoothing=1e-4
    )
    laid = surface(np.column_stack([u[rebuild], ys[rebuild]]))
    proud = CLOSURE_LAYERS_M * (0.3 + 0.7 * _smoothstep(outside[rebuild] / 0.015))
    layer = np.where(facing[rebuild], -CLOSURE_LAYERS_M, np.where(xs[rebuild] > 0, proud, 0.0))
    laid[:, 2] += layer
    weight = (1.0 - _smoothstep((outside[rebuild] - (CLOSURE_REBUILD_M - 0.015)) / 0.015)) * (
        1.0 - _smoothstep((ys[rebuild] - (top - CLOSURE_THROAT_M)) / CLOSURE_THROAT_M)
    )
    out = fitted.copy()
    out[rebuild] = fitted[rebuild] * (1 - weight[:, None]) + laid * weight[:, None]
    moved = np.linalg.norm(out - fitted, axis=1)
    print(f"  rebuilt the front closure: {int(rebuild.sum())} vertices, {int(facing.sum())} of them facing, "
          f"{1000 * moved.max():.0f} mm at most")
    return out


def _hang_strings(fitted, tris, weld, source: np.ndarray, strings: list[np.ndarray], rig: "Rig"):
    part = np.zeros((len(fitted), 4), np.float32)
    cords = np.zeros(len(fitted), bool)
    for verts in strings:
        cords[verts] = True
    cloth_verts = ~cords
    cloth_verts[np.setdiff1d(np.arange(len(fitted)), np.unique(tris))] = False
    front = cloth_verts & (fitted[:, 2] > rig.head["Spine2"][2])
    out = fitted.copy()

    for verts in strings:
        p = source[verts]
        c = p.mean(axis=0)
        _, _, vt = np.linalg.svd(p - c)
        down = vt[0] if vt[0][1] < 0 else -vt[0]
        s = (p - c) @ down
        s -= s.min()
        length = s.max()
        edges = np.linspace(0, length, 17)
        middle = (edges[1:] + edges[:-1]) / 2
        centre = np.array([
            p[(s >= a) & (s <= b)].mean(axis=0) if ((s >= a) & (s <= b)).any() else np.full(3, np.nan)
            for a, b in zip(edges[:-1], edges[1:])
        ])
        known = ~np.isnan(centre[:, 0])
        centre_at = np.column_stack([np.interp(s, middle[known], centre[known, k]) for k in range(3)])
        across = np.array([1.0, 0.0, 0.0]) - down * down[0]
        across /= np.linalg.norm(across)
        normal = np.cross(down, across)
        if normal[2] < 0:
            normal = -normal
        off = p - centre_at
        ox, on = off @ across, off @ normal
        body = (s > 0.2 * length) & (s < 0.8 * length)
        sx = CORD_HALF_WIDTH_M / max(np.percentile(np.abs(ox[body]), 90), 1e-4)
        sn = CORD_HALF_THICKNESS_M / max(np.percentile(np.abs(on[body]), 90), 1e-4)

        side = np.sign(c[0])
        top = fitted[verts][s < 0.01]
        eyelet_y = float(top[:, 1].mean()) if len(top) else float(fitted[verts, 1].max())
        ys = eyelet_y - np.arange(0.0, CORD_LENGTH_M * 1.6, 0.003)
        xs = side * (CORD_SPACING_M + CORD_SPLAY_M * np.clip((eyelet_y - ys) / CORD_LENGTH_M, 0, 1))
        zs = np.full(len(ys), np.nan)
        for i, (x, y) in enumerate(zip(xs, ys)):
            near = front & (np.abs(fitted[:, 0] - x) < 0.012) & (np.abs(fitted[:, 1] - y) < 0.008)
            if near.any():
                zs[i] = np.percentile(fitted[near, 2], 80)
        known = ~np.isnan(zs)
        if known.sum() < 2:
            continue
        zs = ndimage.uniform_filter1d(np.interp(-ys, -ys[known], zs[known]), 7, mode="nearest")
        path = np.column_stack([xs, ys, zs])
        arc = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))])
        along = s * CORD_LENGTH_M / length
        at = np.column_stack([np.interp(along, arc, path[:, k]) for k in range(3)])
        tangent = np.column_stack([np.interp(along, arc, np.gradient(path[:, k], arc)) for k in range(3)])
        tangent /= np.linalg.norm(tangent, axis=1, keepdims=True)
        side_axis = np.array([1.0, 0.0, 0.0])
        out_axis = np.cross(side_axis, tangent)
        out_axis *= np.sign(out_axis[:, 2:3] + 1e-9)
        standoff = CORD_STANDOFF_M * _smoothstep(along / 0.012) - 0.002 * (1 - _smoothstep(along / 0.012))
        wide = np.clip(ox * sx, -1.2 * CORD_HALF_WIDTH_M, 1.2 * CORD_HALF_WIDTH_M)
        thick = np.clip(on * sn, -1.5 * CORD_HALF_THICKNESS_M, 1.5 * CORD_HALF_THICKNESS_M)
        out[verts] = at + side_axis * wide[:, None] + out_axis * (thick + standoff)[:, None]
        part[verts, 0], part[verts, 1] = 1.0, along
        print(f"  hung a drawstring {1000 * CORD_LENGTH_M:.0f} mm from {1000 * side * CORD_SPACING_M:+.0f} mm off centre")
    return out, part


def _hem_height(rig: Rig, fraction: float) -> float:
    hip, knee = rig.head["LeftUpLeg"][1], rig.head["LeftLeg"][1]
    return hip - fraction * (hip - knee)


def _trim_below(y_cut: float, attributes: dict, tris: np.ndarray) -> tuple[dict, np.ndarray]:
    positions = attributes["POSITION"]
    above = positions[:, 1] >= y_cut
    added = {key: [] for key in attributes}
    cut_cache: dict[tuple[int, int], int] = {}
    original_count = len(positions)

    def cut_vertex(i: int, j: int) -> int:
        key = (i, j) if i < j else (j, i)
        if key in cut_cache:
            return cut_cache[key]
        a, b = key
        t = (y_cut - positions[a, 1]) / (positions[b, 1] - positions[a, 1])
        for name, values in attributes.items():
            if name in ("JOINTS_0", "WEIGHTS_0"):
                added[name].append(values[a if t < 0.5 else b])
            else:
                added[name].append(values[a] + t * (values[b] - values[a]))
        cut_cache[key] = original_count + len(added["POSITION"]) - 1
        return cut_cache[key]

    kept = []
    for tri in tris:
        mask = [bool(above[v]) for v in tri]
        if all(mask):
            kept.append([tri[0], tri[1], tri[2]])
        elif sum(mask) == 2:
            k = mask.index(False)
            a, b, c = tri[(k + 1) % 3], tri[(k + 2) % 3], tri[k]
            ac, bc = cut_vertex(a, c), cut_vertex(b, c)
            kept.append([a, b, bc])
            kept.append([a, bc, ac])
        elif sum(mask) == 1:
            k = mask.index(True)
            a, b, c = tri[k], tri[(k + 1) % 3], tri[(k + 2) % 3]
            kept.append([a, cut_vertex(a, b), cut_vertex(a, c)])

    if not kept:
        raise ValueError(f"trim at y={y_cut:.3f} removed the whole garment")

    kept = np.array(kept, dtype=np.int64)
    grown = {
        name: np.concatenate([values, np.array(added[name], dtype=values.dtype).reshape(-1, values.shape[1])])
        for name, values in attributes.items()
    }
    used = np.unique(kept)
    remap = np.full(len(grown["POSITION"]), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return {name: values[used] for name, values in grown.items()}, remap[kept]


def refit(
    src_path: str,
    out_path: str,
    product_type: str,
    avatar: Glb,
    target: Rig,
    source_body,
    avatar_body,
    fit: str = "REGULAR",
    steps: int = 260,
    category: str | None = None,
    source_cut: str | None = None,
    uv_template: str | None = None,
    pockets: tuple | None = None,
) -> None:
    source_cut = source_cut or product_type
    library_cut = f"{product_type}/{category}" if category else product_type
    garment = Glb(src_path)
    source = Rig(garment, SOURCE_BONE_PREFIX)
    prim = next(m for m in garment.gltf["meshes"] if m["name"] == GARMENT_MESH)["primitives"][0]
    attrs = prim["attributes"]
    positions = garment.accessor(attrs["POSITION"]).astype(np.float64)
    src_normals = garment.accessor(attrs["NORMAL"]).astype(np.float64)
    uvs = garment.accessor(attrs["TEXCOORD_0"]).astype(np.float32)
    joints = garment.accessor(attrs["JOINTS_0"]).astype(np.int64)
    weights = garment.accessor(attrs["WEIGHTS_0"]).astype(np.float64)
    tris = garment.accessor(prim["indices"]).reshape(-1, 3).astype(np.int64)
    weights /= np.maximum(weights.sum(axis=1, keepdims=True), 1e-12)
    if source_cut in IRON_SOURCE_PLEATS:
        positions = _iron_source_pleats(positions, tris, *IRON_SOURCE_PLEATS[source_cut])

    if product_type in TRIM_TO_HEM:
        attributes, tris = _trim_below(
            _hem_height(source, TRIM_TO_HEM[product_type]),
            {
                "POSITION": positions,
                "NORMAL": src_normals,
                "TEXCOORD_0": uvs,
                "JOINTS_0": joints,
                "WEIGHTS_0": weights,
            },
            tris,
        )
        positions, src_normals = attributes["POSITION"], attributes["NORMAL"]
        uvs, joints, weights = attributes["TEXCOORD_0"], attributes["JOINTS_0"], attributes["WEIGHTS_0"]

    source_positions = positions
    fitted, blended = _retarget(positions, joints, weights, source, target)
    normals_ref = np.einsum("vij,vj->vi", blended[:, :3, :3], src_normals)
    weld = _welded(fitted)
    fitted = _conform(fitted, source_body, avatar_body, tris, weld)

    colliders = [_Collider(_avatar_triangles(avatar, group)) for group in COLLIDERS[SLOT_FOR_TYPE[product_type]]]
    keep_inside = [
        _Collider(_avatar_triangles(avatar, [name]))
        for name in KEEP_INSIDE.get(SLOT_FOR_TYPE[product_type], [])
    ]
    if product_type in HEM_LEVEL:
        fitted = _lengthen(fitted, weld, target, HEM_LEVEL[product_type])
    if source_cut in CLOSE_FRONT:
        tris = _drop_loose_trim(tris, _welded(source_positions))
        fitted = _close_front(fitted, tris, weld, avatar, target, CLOSE_FRONT[source_cut])
    floor = _clearance(fitted, tris, weld)

    def collide(positions: np.ndarray, clearance: np.ndarray) -> np.ndarray:
        clearance = np.maximum(clearance, floor)
        for collider in colliders:
            positions = collider.push_out(positions, clearance)
        for collider in keep_inside:
            positions = collider.pull_in(positions, clearance)
        return positions

    for _ in range(PUSH_ROUNDS):
        pushed = collide(fitted, floor)
        moved = np.linalg.norm(pushed - fitted, axis=1) > 1e-6
        moved = np.bincount(weld, weights=moved, minlength=len(fitted))[weld] > 0
        fitted = _relax(pushed, tris, weld, moved)
    fitted = collide(fitted, floor)

    undraped = fitted.copy()
    fabric = cloth.FABRIC.get(product_type)
    if fabric is not None and steps > 0:
        cut = category or cloth.DEFAULT_CATEGORY[product_type]
        outward = _vertex_normals(fitted, tris, weld, normals_ref).astype(np.float64)
        fitted, ease, strain, worst_strain = cloth.drape(
            fitted, tris, weld, outward, target, SLOT_FOR_TYPE[product_type], fabric, cut,
            avatar_body, collide, fit=cloth.FIT[fit], steps=steps,
        )
        gap = np.maximum(ease, floor)
        print(
            f"  draped {cut} in a {fit.lower()} fit:"
            f" {1000 * gap.mean():.0f} mm mean gap, {1000 * gap.max():.0f} mm at its widest,"
            f" seams within {100 * strain:.0f}% ({100 * worst_strain:.0f}% at worst)"
        )

    if source_cut in CLOSE_FRONT and fabric is not None and steps > 0:
        closed = _close_front(fitted, tris, weld, avatar, target, CLOSE_FRONT[source_cut], only_top=0.03)
        fitted = collide(closed, floor)
    if source_cut in IRON_FOLDS:
        fitted = _iron_folds(fitted, tris, weld, target, collide, floor, IRON_FOLDS[source_cut])
    if source_cut in FLAT_CUFFS:
        fitted = _flatten_cuffs(fitted, tris, weld, target)
    built = source_cut in CONSTRUCTION
    if built:
        construction = np.zeros((len(fitted), build.C_COUNT))
        construction[:, build.C_POS] = build.reference_positions(undraped, tris, weld)
        construction[:, build.C_HOOD] = build.hood_weight(undraped, tris, weld, target, colliders[0])
        fitted = collide(build.smooth_hood(fitted, undraped, tris, weld, construction[:, build.C_HOOD]), floor)
        fitted = collide(build.smooth_crumples(fitted, undraped, tris, weld, build.closure_zone(undraped, target)), floor)
        fitted = build.smooth_armpits(fitted, tris, weld, target, colliders[0], collide, floor)
    extra = {}
    if source_cut in SETTLE_FRONT_M:
        fitted = collide(_settle_front(fitted, tris, weld, target, colliders[0], SETTLE_FRONT_M[source_cut]), floor)
    if source_cut in HANG_FROM_CHEST:
        fitted = _hang_front(fitted, weld, target, HANG_FROM_CHEST[source_cut])
    if source_cut in RIB_BANDS:
        fitted, extra["_RIB"] = _gather_bands(fitted, tris, weld, target, avatar, *RIB_BANDS[source_cut])
        fitted = collide(fitted, floor)
    if source_cut in SOURCE_STRINGS:
        strings = _source_strings(tris, source_positions, SOURCE_STRINGS[source_cut])
        skip = np.zeros(len(fitted), bool)
        for verts in strings:
            skip[verts] = True
        fitted = _rebuild_closure(fitted, tris, source_positions, src_normals, skip)
        fitted, extra["_PART"] = _hang_strings(fitted, tris, weld, source_positions, strings, target)
    if built:
        fitted, tris, normals_ref, uvs, joints, weights, source_positions, extra, construction, carried, details = _construct(
            fitted, tris, weld, normals_ref, uvs, joints, weights, source_positions, extra, construction,
            source, target, colliders, collide, floor,
            garment_pockets.pockets_for(library_cut) if pockets is None else pockets,
        )
        weld = _welded(fitted)
    if product_type in NECKLINE:
        fitted = _fit_neckline(fitted, tris, weld, avatar, target, NECKLINE[product_type])
    if library_cut in COLLAR:
        attributes, tris = _add_collar(
            {
                "POSITION": fitted, "NORMAL": normals_ref, "TEXCOORD_0": uvs, "JOINTS_0": joints,
                "WEIGHTS_0": weights, "SOURCE": source_positions,
            },
            tris, *COLLAR[library_cut],
        )
        fitted, normals_ref, uvs = attributes["POSITION"], attributes["NORMAL"], attributes["TEXCOORD_0"]
        joints, weights, source_positions = attributes["JOINTS_0"], attributes["WEIGHTS_0"], attributes["SOURCE"]
        weld = _welded(fitted)
        uvs = repack(uvs.astype(np.float64), tris)[0].astype(np.float32)
    underlay = None
    if library_cut in PLACKET:
        attributes, tris, opening = _cut_placket(
            {
                "POSITION": fitted, "NORMAL": normals_ref, "TEXCOORD_0": uvs, "JOINTS_0": joints,
                "WEIGHTS_0": weights, "SOURCE": source_positions,
            },
            tris, source, target.head["Neck"], *PLACKET[library_cut],
        )
        fitted, normals_ref, uvs = attributes["POSITION"], attributes["NORMAL"], attributes["TEXCOORD_0"]
        joints, weights = attributes["JOINTS_0"], attributes["WEIGHTS_0"]
        weld = _welded(fitted)
        underlay = _underlay(avatar, opening)

    normals = _vertex_normals(fitted, tris, weld, normals_ref)

    target_index = {name: i for i, name in enumerate(target.names)}
    remap = np.array([target_index[name] for name in source.names])
    new_joints = np.where(weights > 0, remap[joints], 0).astype(np.uint8)

    if uv_template is not None:
        uvs = _template_uvs(uv_template, tris)[: len(fitted)]
        print(f"  UV layout: {os.path.basename(uv_template)}'s, so one texture fits both")
    else:
        layout, note = best_layout(uvs.astype(np.float64), tris, fitted.astype(np.float64))
        print(f"  UV layout: {note}")
        uvs = layout.astype(np.float32)

    material = garment.gltf["materials"][prim["material"]] if "material" in prim else {"name": GARMENT_MESH}
    material = {**material, "pbrMetallicRoughness": {
        **material.get("pbrMetallicRoughness", {}), "metallicFactor": 0.0, "roughnessFactor": FABRIC_ROUGHNESS,
    }}
    colours = normal_image = None
    if built:
        fitted, normals, uvs, tris, new_joints, weights, extra, colours, normal_image = _thicken(
            fitted, normals, uvs, tris, new_joints, weights, extra, construction, carried, details, avatar, target, colliders,
        )
    _write(
        out_path, avatar, fitted.astype(np.float32), normals, uvs, new_joints,
        weights.astype(np.float32), tris.astype(np.uint32), material, underlay, extra, colours, normal_image,
    )


def _construct(
    fitted, tris, weld, normals_ref, uvs, joints, weights, source_positions, extra, construction,
    source: Rig, target: Rig, colliders, collide, floor, pockets,
):
    rib = extra.get("_RIB")
    if rib is None:
        rib = np.tile(np.array([NO_BAND, 1.0, 0.0, 0.0], np.float32), (len(fitted), 1))
    part = extra.get("_PART", np.zeros((len(fitted), 4), np.float32))
    edge = build.hood_edge_distance(fitted, tris, weld, construction[:, build.C_POS], target)
    construction[:, build.C_HOOD_EDGE] = np.where(np.isfinite(edge), edge, 9.0)

    keep = np.maximum(build.closure_zone(construction[:, build.C_POS], target), part[:, 0] > 0.5)
    fitted = collide(build.smooth_open_edges(fitted, tris, weld, keep), floor)
    fitted = collide(build.shape_sleeves(fitted, tris, weld, target, colliders[0], rib), floor)
    fold = build.FoldField(target, construction[:, build.C_POS], rib)
    normals = _vertex_normals(fitted, tris, weld, normals_ref).astype(np.float64)
    calm = (1.0 - build.closure_zone(construction[:, build.C_POS], target)) * (part[:, 0] < 0.5)
    fitted, carried = build.add_folds(fitted, tris, weld, normals, fold(construction[:, build.C_POS]) * calm)
    fitted = collide(fitted, floor)

    lows = layout.armhole_lows(fitted, tris, joints, weights, source.names)
    armhole = max(lows.values()) if len(lows) == 2 else None
    panels = build.add_pockets(fitted, tris, rib, part, target, pockets, armhole)
    edges = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]]])
    density = np.median(
        np.linalg.norm(uvs[edges[:, 0]] - uvs[edges[:, 1]], axis=1)
        / np.maximum(np.linalg.norm(fitted[edges[:, 0]] - fitted[edges[:, 1]], axis=1), 1e-9)
    )
    no_band = np.array([NO_BAND, 1.0, 0.0, 0.0], np.float32)
    parts = {
        "positions": [fitted], "tris": [tris], "normals": [normals_ref], "uvs": [uvs], "joints": [joints],
        "weights": [weights], "source": [source_positions], "construction": [construction],
        "carried": [carried], "rib": [rib], "part": [part],
    }
    first = len(fitted)
    for i, panel in enumerate(panels):
        n = len(panel.positions)
        panel_c = construction[panel.nearest].copy()
        panel_c[:, build.C_POCKET] = i + 1
        panel_c[:, [build.C_POCKET_U, build.C_POCKET_V]] = panel.chart
        panel_part = np.zeros((n, 4), np.float32)
        panel_part[:, build.POCKET_COLUMN] = 1.0
        parts["positions"].append(panel.positions)
        parts["tris"].append(panel.tris + first)
        parts["normals"].append(panel.normals)
        parts["uvs"].append((panel.chart * density + np.array([3.0 + i, 0.0])).astype(uvs.dtype))
        parts["joints"].append(joints[panel.nearest])
        parts["weights"].append(weights[panel.nearest])
        parts["source"].append(source_positions[panel.nearest])
        parts["construction"].append(panel_c)
        parts["carried"].append(np.zeros(n))
        parts["rib"].append(np.tile(no_band, (n, 1)))
        parts["part"].append(panel_part)
        first += n
    joined = {k: np.concatenate(v) for k, v in parts.items()}
    extra = {"_RIB": joined["rib"], "_PART": joined["part"]}
    return (
        joined["positions"], joined["tris"], joined["normals"], joined["uvs"], joined["joints"], joined["weights"],
        joined["source"], extra, joined["construction"], joined["carried"], (fold, panels),
    )


def _thicken(fitted, normals, uvs, tris, joints, weights, extra, construction, carried, details, avatar: Glb, target: Rig, colliders):
    weld = _welded(fitted)
    fold, panels = details
    rib, part = extra["_RIB"], extra["_PART"]
    t = build.thickness(
        len(fitted), rib, construction[:, build.C_HOOD_EDGE], construction[:, build.C_POCKET],
        construction[:, [build.C_POCKET_U, build.C_POCKET_V]], panels,
        build.closure_zone(construction[:, build.C_POS], target),
    )
    positions, all_normals, all_uvs, all_tris, copy_of, layer = build.solidify(
        fitted.astype(np.float64), normals.astype(np.float64), uvs, tris, weld, t, colliders[0], part[:, 0] > 0.5,
    )
    part = part[copy_of].copy()
    part[:, build.LAYER_COLUMN] = layer
    extra = {"_RIB": rib[copy_of], "_PART": part}
    occluders = _avatar_triangles(avatar, ["Wolf3D_Body", "Wolf3D_Head", "Wolf3D_Outfit_Bottom"])
    ao = build.occlusion(positions, all_normals, all_tris, occluders)
    colours = build.occlusion_colours(ao, all_tris, _welded(positions))
    print(f"  occlusion: median {np.median(colours[:, 0]):.2f}, p05 {np.percentile(colours[:, 0], 5):.2f}")
    image = build.normal_map(
        positions, all_normals, all_uvs, all_tris, layer, construction[copy_of], extra["_RIB"], part, target, fold,
        carried[copy_of], panels,
    )
    return positions, all_normals, all_uvs, all_tris, joints[copy_of], weights[copy_of], extra, colours, image


def _template_uvs(path: str, tris: np.ndarray) -> np.ndarray:
    template = Glb(path)
    prim = next(m for m in template.gltf["meshes"] if m["name"] == GARMENT_MESH)["primitives"][0]
    theirs = template.accessor(prim["indices"]).reshape(-1, 3).astype(np.int64)
    theirs = theirs[: len(tris)]
    if not np.array_equal(theirs, tris):
        raise ValueError(
            f"{path} has different triangles ({len(theirs)} vs {len(tris)}): something decided "
            "the topology from the fitted body instead of the source"
        )
    return template.accessor(prim["attributes"]["TEXCOORD_0"]).astype(np.float32)


def _source_body(path: str, target: Rig):
    glb = Glb(path)
    rig = Rig(glb, SOURCE_BONE_PREFIX)
    body_material = next(i for i, m in enumerate(glb.gltf["materials"]) if m["name"].endswith(".body"))
    parts = []
    for mesh in glb.gltf["meshes"]:
        for prim in mesh["primitives"]:
            if prim.get("material") != body_material:
                continue
            a = prim["attributes"]
            moved, _ = _retarget(
                glb.accessor(a["POSITION"]).astype(np.float64),
                glb.accessor(a["JOINTS_0"]).astype(np.int64),
                glb.accessor(a["WEIGHTS_0"]).astype(np.float64),
                rig,
                target,
            )
            parts.append((moved, glb.accessor(prim["indices"]).reshape(-1, 3).astype(np.int64)))
    return _surface_samples(parts)


def _write(
    path, avatar: Glb, positions, normals, uvs, joints, weights, tris, material, underlay=None, extra=None,
    colours=None, normal_image: bytes | None = None,
) -> None:
    src = avatar.gltf
    joint_nodes = src["skins"][0]["joints"]
    joint_children = {c for j in joint_nodes for c in src["nodes"][j].get("children", [])}
    root = next(j for j in joint_nodes if j not in joint_children)

    bone_set = set()
    stack = [root]
    while stack:
        i = stack.pop()
        bone_set.add(i)
        stack.extend(src["nodes"][i].get("children", []))
    old_to_new = {old: new for new, old in enumerate(sorted(bone_set))}
    nodes = []
    for old in sorted(bone_set):
        node = {k: v for k, v in src["nodes"][old].items() if k in ("name", "translation", "rotation", "scale", "matrix")}
        if src["nodes"][old].get("children"):
            node["children"] = [old_to_new[c] for c in src["nodes"][old]["children"]]
        nodes.append(node)
    garment_node = len(nodes)
    nodes.append({"name": GARMENT_MESH, "mesh": 0, "skin": 0})
    armature_children = [old_to_new[root], garment_node]
    if underlay is not None:
        armature_children.append(len(nodes))
        nodes.append({"name": UNDERLAY_MESH, "mesh": 1, "skin": 0})
    nodes.append({"name": "Armature", "children": armature_children})

    blob = bytearray()
    views, accessors = [], []

    def add(array: np.ndarray, kind: str, component: int, target: int | None = None, bounds: bool = False) -> int:
        while len(blob) % 4:
            blob.append(0)
        data = np.ascontiguousarray(array).tobytes()
        view = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)}
        if target:
            view["target"] = target
        views.append(view)
        blob.extend(data)
        acc = {"bufferView": len(views) - 1, "componentType": component, "count": len(array), "type": kind}
        if bounds:
            acc["min"] = array.min(axis=0).tolist()
            acc["max"] = array.max(axis=0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    ibm = avatar.accessor(src["skins"][0]["inverseBindMatrices"]).astype(np.float32)
    primitive = {
        "attributes": {
            "POSITION": add(positions, "VEC3", 5126, 34962, bounds=True),
            "NORMAL": add(normals, "VEC3", 5126, 34962),
            "TEXCOORD_0": add(uvs, "VEC2", 5126, 34962),
            "JOINTS_0": add(joints, "VEC4", 5121, 34962),
            "WEIGHTS_0": add(weights, "VEC4", 5126, 34962),
        },
        "indices": add(tris.reshape(-1), "SCALAR", 5125, 34963),
        "material": 0,
    }
    if colours is not None:
        primitive["attributes"]["COLOR_0"] = add(np.clip(colours * 255 + 0.5, 0, 255).astype(np.uint8), "VEC4", 5121, 34962)
        accessors[-1]["normalized"] = True
    for name, values in (extra or {}).items():
        if len(values) != len(positions):
            raise ValueError(f"{name} has {len(values)} values for {len(positions)} vertices")
        kind = {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4"}[values.shape[1] if values.ndim > 1 else 1]
        primitive["attributes"][name] = add(np.ascontiguousarray(values, np.float32), kind, 5126, 34962)
    meshes = [{"name": GARMENT_MESH, "primitives": [primitive]}]
    materials = [material]
    if underlay is not None:
        meshes.append({"name": UNDERLAY_MESH, "primitives": [{
            "attributes": {
                "POSITION": add(underlay["POSITION"].astype(np.float32), "VEC3", 5126, 34962, bounds=True),
                "NORMAL": add(underlay["NORMAL"].astype(np.float32), "VEC3", 5126, 34962),
                "JOINTS_0": add(underlay["JOINTS_0"].astype(np.uint8), "VEC4", 5121, 34962),
                "WEIGHTS_0": add(underlay["WEIGHTS_0"].astype(np.float32), "VEC4", 5126, 34962),
            },
            "indices": add(underlay["tris"].reshape(-1).astype(np.uint32), "SCALAR", 5125, 34963),
            "material": 1,
        }]})
        materials.append({
            "name": UNDERLAY_MESH,
            "pbrMetallicRoughness": {"baseColorFactor": [0.44, 0.12, 0.056, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.6},
        })
    ibm_accessor = add(ibm, "MAT4", 5126)
    images = []
    if normal_image is not None:
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(normal_image)})
        blob.extend(normal_image)
        images.append({"bufferView": len(views) - 1, "mimeType": "image/jpeg"})
        materials[0] = {**materials[0], "normalTexture": {"index": 0, "scale": 1.0}}
    while len(blob) % 4:
        blob.append(0)

    gltf = {
        "asset": {"version": "2.0", "generator": "garment3d-service refit_garments.py"},
        "scene": 0,
        "scenes": [{"name": "Scene", "nodes": [len(nodes) - 1]}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "skins": [{"joints": [old_to_new[j] for j in joint_nodes], "inverseBindMatrices": ibm_accessor}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    if images:
        gltf["images"] = images
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
        gltf["textures"] = [{"source": 0, "sampler": 0}]
    encoded = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    total = 12 + 8 + len(encoded) + 8 + len(blob)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(encoded), 0x4E4F534A) + encoded)
        f.write(struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))


def main() -> int:
    ap = argparse.ArgumentParser(prog="refit_garments")
    ap.add_argument("--src", required=True, help="directory of MakeHuman garment GLBs (T_SHIRT.glb, ...)")
    ap.add_argument(
        "--source-body",
        required=True,
        help="the MakeHuman avatar GLB the source garments were fitted over (avatar-makehuman.glb)",
    )
    ap.add_argument("--out", required=True, help="directory to write the refitted GLBs into")
    ap.add_argument("--only", action="append", choices=sorted(SLOT_FOR_TYPE))
    ap.add_argument(
        "--fit",
        default="REGULAR",
        choices=sorted(cloth.FIT),
        help="how loosely the garment is cut; scales both the gap to the body and the spare fabric",
    )
    ap.add_argument(
        "--drape-steps",
        type=int,
        default=260,
        help="cloth simulation steps (0 skips the drape and leaves the garment lying on the body)",
    )
    ap.add_argument(
        "--category",
        choices=sorted(cloth.CATEGORY_EASE_CM),
        help="build <TYPE>/<CATEGORY>.glb only, from its own source or SOURCE_FOR_CUT's",
    )
    ap.add_argument(
        "--avatar",
        default=AVATAR_PATH,
        help="body to fit against; pass avatar-female.glb to build the women's library",
    )
    ap.add_argument(
        "--uvs-from",
        help="library directory whose cuts lend their UV layout, so one baked texture fits "
        "this body's garment and theirs; defaults to garments/ for any avatar but the "
        "default one, whose own layout everything else follows",
    )
    ap.add_argument(
        "--types-only",
        action="store_true",
        help="build just the plain product types, not their category cuts (CATEGORY_CUTS)",
    )
    ap.add_argument(
        "--pattern",
        action="append",
        choices=sorted(garment_pockets.PATTERNS),
        help="build products/<PATTERN>.glb: its cut again, with one product's own pockets "
        "(garment_pockets.PATTERNS); repeatable",
    )
    ap.add_argument(
        "--patterns",
        action="store_true",
        help="build every pattern of the types being built, as well as the cuts",
    )
    ap.add_argument("--patterns-only", action="store_true", help="build the patterns and no cuts")
    args = ap.parse_args()
    if args.category and len(args.only or []) != 1:
        ap.error("--category names one cut, so it needs exactly one --only to apply it to")
    if args.drape_steps:
        cloth._check_contract(os.path.join(os.path.dirname(__file__), *SIZING_CONTRACT))

    uvs_from = args.uvs_from
    if uvs_from is None and os.path.abspath(args.avatar) != os.path.abspath(AVATAR_PATH):
        uvs_from = os.path.join(os.path.dirname(__file__), "garments")

    avatar = Glb(args.avatar)
    target = Rig(avatar)
    source_body = _source_body(args.source_body, target)
    avatar_body = _surface_samples(_avatar_triangles(avatar, BODY_PROXY))
    types = args.only or sorted(SLOT_FOR_TYPE)
    if args.category:
        cuts = [f"{types[0]}/{args.category}"]
    else:
        cuts = list(types)
        if not args.types_only:
            cuts += [cut for cut in CATEGORY_CUTS if cut.split("/")[0] in types]
    patterns = list(args.pattern or [])
    if args.patterns or args.patterns_only:
        patterns += [name for name, p in garment_pockets.PATTERNS.items() if p.cut.split("/")[0] in types]
    if args.patterns_only:
        cuts = []
    for name in dict.fromkeys(patterns):
        cuts.append(f"products/{name}")
    for cut in cuts:
        pockets = None
        if cut.startswith("products/"):
            pattern = garment_pockets.PATTERNS[cut.split("/", 1)[1]]
            pockets = pattern.pockets
            library_cut = pattern.cut
        else:
            library_cut = cut
        product_type, _, category = library_cut.partition("/")
        source_cut = SOURCE_FOR_CUT.get(library_cut, library_cut)
        src = os.path.join(args.src, *f"{source_cut}.glb".split("/"))
        if not os.path.exists(src) and category and library_cut not in SOURCE_FOR_CUT:
            source_cut = SOURCE_FOR_CUT.get(product_type, product_type)
            src = os.path.join(args.src, f"{source_cut}.glb")
        if not os.path.exists(src):
            print(f"skip  {cut:22s} (no {src})")
            continue
        out = os.path.join(args.out, *f"{cut}.glb".split("/"))
        uv_template = None
        if uvs_from:
            uv_template = os.path.join(uvs_from, *f"{cut}.glb".split("/"))
            if not os.path.exists(uv_template):
                print(f"skip  {cut:22s} (no {uv_template} to share a UV layout with; build it first)")
                continue
        print(f"{cut} from {source_cut}")
        refit(
            src, out, product_type, avatar, target, source_body, avatar_body,
            args.fit, args.drape_steps, category or None, source_cut, uv_template, pockets,
        )
        print(f"WROTE {cut:22s} {os.path.getsize(out):>9,} bytes  {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
