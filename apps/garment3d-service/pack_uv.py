import argparse
import json
import os
import struct

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

GUTTER = 0.008

MIN_GAIN = 1.05


def uv_islands(faces: np.ndarray, vertex_count: int) -> tuple[int, np.ndarray]:
    edges = np.vstack([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    graph = coo_matrix(
        (np.ones(len(edges)), (edges[:, 0], edges[:, 1])), shape=(vertex_count, vertex_count)
    )
    return connected_components(graph, directed=False)


def shelf_pack(sizes: np.ndarray, gutter: float = GUTTER) -> np.ndarray | None:
    out = np.zeros_like(sizes)
    x = y = shelf_height = 0.0
    for i in np.argsort(-sizes[:, 1]):
        w, h = sizes[i]
        if x + w + gutter > 1.0:
            y += shelf_height + gutter
            x = shelf_height = 0.0
        if y + h + gutter > 1.0:
            return None
        out[i] = (x + gutter / 2, y + gutter / 2)
        x += w + gutter
        shelf_height = max(shelf_height, h)
    return out


def repack(uv: np.ndarray, faces: np.ndarray, gutter: float = GUTTER) -> tuple[np.ndarray, float]:
    count, label = uv_islands(faces, len(uv))
    corners = np.array(
        [[uv[label == i].min(axis=0), uv[label == i].max(axis=0)] for i in range(count)]
    )
    origin, size = corners[:, 0], corners[:, 1] - corners[:, 0]

    lo, hi, best = 0.5, 8.0, None
    for _ in range(40):
        scale = (lo + hi) / 2
        placed = shelf_pack(size * scale, gutter)
        if placed is None:
            hi = scale
        else:
            lo, best = scale, (scale, placed)
    if best is None:
        return uv, 0.0

    scale, placed = best
    packed = uv.copy()
    for i in range(count):
        island = label == i
        packed[island] = (uv[island] - origin[i]) * scale + placed[i]
    return packed, scale


def texel_density(uv: np.ndarray, faces: np.ndarray, verts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    e1, e2 = verts[faces[:, 1]] - verts[faces[:, 0]], verts[faces[:, 2]] - verts[faces[:, 0]]
    area3 = np.linalg.norm(np.cross(e1, e2), axis=1) / 2
    t = uv[faces]
    area2 = np.abs(
        (t[:, 1, 0] - t[:, 0, 0]) * (t[:, 2, 1] - t[:, 0, 1])
        - (t[:, 2, 0] - t[:, 0, 0]) * (t[:, 1, 1] - t[:, 0, 1])
    ) / 2
    return np.sqrt(area2 / np.maximum(area3, 1e-14)), area3


def density_percentile(uv: np.ndarray, faces: np.ndarray, verts: np.ndarray, q: float) -> float:
    density, area = texel_density(uv, faces, verts)
    order = np.argsort(density)
    cumulative = np.cumsum(area[order]) / max(area.sum(), 1e-14)
    return float(density[order][min(np.searchsorted(cumulative, q / 100.0), len(order) - 1)])


def _flatten_triangles(faces: np.ndarray, verts: np.ndarray) -> np.ndarray:
    p0, p1, p2 = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    ex = p1 - p0
    lx = np.linalg.norm(ex, axis=1)
    ex = ex / np.maximum(lx, 1e-12)[:, None]
    normal = np.cross(p1 - p0, p2 - p0)
    ey = np.cross(normal / np.maximum(np.linalg.norm(normal, axis=1), 1e-14)[:, None], ex)
    zero = np.zeros(len(faces))
    return np.stack(
        [
            np.stack([zero, zero], 1),
            np.stack([lx, zero], 1),
            np.stack([np.einsum("ij,ij->i", p2 - p0, ex), np.einsum("ij,ij->i", p2 - p0, ey)], 1),
        ],
        axis=1,
    )


ARAP_ITERATIONS = 40


def _arap(faces: np.ndarray, verts: np.ndarray, start: np.ndarray) -> np.ndarray:
    from scipy.sparse import csc_matrix
    from scipy.sparse.linalg import splu

    n = len(verts)
    local = _flatten_triangles(faces, verts)
    if _signed_areas(start, faces).sum() < 0:
        local = local * np.array([1.0, -1.0])

    edges = [(1, 2, 0), (2, 0, 1), (0, 1, 2)]
    weights = []
    for i, j, k in edges:
        a, b = local[:, i] - local[:, k], local[:, j] - local[:, k]
        cross = np.abs(a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0])
        cot = np.einsum("ij,ij->i", a, b) / np.maximum(cross, 1e-14)
        weights.append(np.clip(0.5 * cot, 1e-3, 1e3))

    rows, cols, vals = [], [], []
    for (i, j, _), w in zip(edges, weights):
        vi, vj = faces[:, i], faces[:, j]
        rows += [vi, vj, vi, vj]
        cols += [vi, vj, vj, vi]
        vals += [w, w, -w, -w]
    L = csc_matrix(
        (np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n)
    ).tolil()
    L[0, :] = 0
    L[0, 0] = 1
    solve = splu(L.tocsc())

    uv = start.copy()
    for _ in range(ARAP_ITERATIONS):
        cov = np.zeros((len(faces), 2, 2))
        for (i, j, _), w in zip(edges, weights):
            du = uv[faces[:, i]] - uv[faces[:, j]]
            dx = local[:, i] - local[:, j]
            cov += w[:, None, None] * np.einsum("ti,tj->tij", du, dx)
        U, _, Vt = np.linalg.svd(cov)
        det = np.linalg.det(U @ Vt)
        U[:, :, 1] *= det[:, None]
        R = U @ Vt

        rhs = np.zeros((n, 2))
        for (i, j, _), w in zip(edges, weights):
            e = w[:, None] * np.einsum("tij,tj->ti", R, local[:, i] - local[:, j])
            np.add.at(rhs, faces[:, i], e)
            np.add.at(rhs, faces[:, j], -e)
        rhs[0] = uv[0]
        uv = np.stack([solve.solve(rhs[:, 0]), solve.solve(rhs[:, 1])], axis=1)
    return uv


def _tightest_rotation(coords: np.ndarray, steps: int = 90) -> np.ndarray:
    centred = coords - coords.mean(axis=0)
    best, best_area = centred, np.inf
    for angle in np.linspace(0.0, np.pi / 2, steps, endpoint=False):
        c, s = np.cos(angle), np.sin(angle)
        turned = centred @ np.array([[c, s], [-s, c]])
        area = np.prod(turned.max(axis=0) - turned.min(axis=0))
        if area < best_area:
            best, best_area = turned, area
    extent = best.max(axis=0) - best.min(axis=0)
    if extent[0] > extent[1]:
        best = best @ np.array([[0.0, 1.0], [-1.0, 0.0]])
    return best


def _signed_areas(coords: np.ndarray, faces: np.ndarray) -> np.ndarray:
    t = coords[faces]
    return (t[:, 1, 0] - t[:, 0, 0]) * (t[:, 2, 1] - t[:, 0, 1]) - (
        t[:, 2, 0] - t[:, 0, 0]
    ) * (t[:, 1, 1] - t[:, 0, 1])


def reunwrap(uv: np.ndarray, faces: np.ndarray, verts: np.ndarray, gutter: float = GUTTER) -> np.ndarray:
    count, label = uv_islands(faces, len(uv))
    face_island = label[faces[:, 0]]
    out = uv.copy()
    for i in range(count):
        members = np.flatnonzero(label == i)
        island_faces = faces[face_island == i]
        if len(island_faces) == 0:
            continue
        index = np.full(len(uv), -1)
        index[members] = np.arange(len(members))
        local_faces = index[island_faces]
        pts = verts[members]

        density, area = texel_density(uv[members], local_faces, pts)
        uv_area = (density**2 * area).sum()
        if uv_area <= 1e-14:
            continue
        start = uv[members] * np.sqrt(area.sum() / uv_area)

        flat = _arap(local_faces, pts, start)
        source_sign = np.sign(_signed_areas(start, local_faces).sum())
        folded = (np.sign(_signed_areas(flat, local_faces)) != source_sign).mean()
        out[members] = start if folded > FOLDED_FRACTION_MAX else flat

    squared = out.copy()
    for i in range(count):
        members = label == i
        squared[members] = _tightest_rotation(out[members])

    best, best_density = None, 0.0
    for candidate in (out, squared):
        boxes = sum(
            np.prod(candidate[label == i].max(axis=0) - candidate[label == i].min(axis=0))
            for i in range(count)
        )
        norm = np.sqrt(max(boxes, 1e-14))
        packed, scale = repack(candidate / norm, faces, gutter)
        if scale > 0.0 and scale / norm > best_density:
            best, best_density = packed, scale / norm
    if best is None:
        raise ValueError("re-unwrapped islands did not pack into the atlas")
    return best


FOLDED_FRACTION_MAX = 0.015


REUNWRAP_MIN_SCORE = 1.05
REUNWRAP_MIN_MEDIAN = 0.85


def best_layout(
    uv: np.ndarray, faces: np.ndarray, verts: np.ndarray
) -> tuple[np.ndarray, str]:
    candidates = []
    packed, gain = repack(uv, faces)
    if gain >= MIN_GAIN:
        candidates.append((packed, f"repacked, x{gain:.2f} linear resolution"))
    base_uv, base_note = candidates[0] if candidates else (uv, "left as authored")

    try:
        relaxed = reunwrap(uv, faces, verts)
    except ValueError:
        return base_uv, base_note
    p5 = density_percentile(relaxed, faces, verts, 5) / max(
        density_percentile(base_uv, faces, verts, 5), 1e-12
    )
    p50 = density_percentile(relaxed, faces, verts, 50) / max(
        density_percentile(base_uv, faces, verts, 50), 1e-12
    )
    if np.sqrt(p5 * p50) >= REUNWRAP_MIN_SCORE and p50 >= REUNWRAP_MIN_MEDIAN:
        return relaxed, f"re-unwrapped: starved fabric x{p5:.2f}, typical fabric x{p50:.2f}"
    return base_uv, f"{base_note} (re-unwrap would give x{p5:.2f} / x{p50:.2f}; not worth it)"


def _uv_accessor(gltf: dict, mesh_name: str | None) -> tuple[dict, dict, dict]:
    meshes = gltf["meshes"]
    if mesh_name is not None:
        meshes = [m for m in meshes if m.get("name") == mesh_name]
        if not meshes:
            raise ValueError(f"no mesh named {mesh_name!r}")
    primitives = [p for m in meshes for p in m["primitives"]]
    if len(primitives) != 1:
        raise ValueError(f"expected one primitive to repack, found {len(primitives)}")
    attributes = primitives[0]["attributes"]
    return (
        gltf["accessors"][attributes["TEXCOORD_0"]],
        gltf["accessors"][primitives[0]["indices"]],
        gltf["accessors"][attributes["POSITION"]],
    )


def repack_glb(path: str, out_path: str | None = None, mesh_name: str | None = None) -> bool:
    with open(path, "rb") as handle:
        data = bytearray(handle.read())
    json_length = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20 : 20 + json_length])
    bin_start = 20 + json_length + 8

    uv_acc, index_acc, position_acc = _uv_accessor(gltf, mesh_name)
    if uv_acc["componentType"] != 5126 or uv_acc["type"] != "VEC2":
        raise ValueError("TEXCOORD_0 is not float32 VEC2; rewriting it in place isn't safe")

    def read(acc, dtype, width):
        view = gltf["bufferViews"][acc["bufferView"]]
        if view.get("byteStride") not in (None, np.dtype(dtype).itemsize * width):
            raise ValueError("interleaved accessor; rewriting it in place isn't safe")
        start = bin_start + view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        count = acc["count"] * width
        return start, np.frombuffer(bytes(data[start : start + count * np.dtype(dtype).itemsize]), dtype=dtype).reshape(-1, width)

    uv_start, uv = read(uv_acc, np.float32, 2)
    _, indices = read(index_acc, np.uint32 if index_acc["componentType"] == 5125 else np.uint16, 1)
    faces = indices.reshape(-1, 3).astype(np.int64)
    _, positions = read(position_acc, np.float32, 3)

    layout, note = best_layout(uv.astype(np.float64), faces, positions.astype(np.float64))
    print(f"{os.path.basename(path)}: {note}")
    if np.array_equal(layout.astype(np.float32), uv):
        return False

    blob = np.ascontiguousarray(layout, dtype=np.float32).tobytes()
    data[uv_start : uv_start + len(blob)] = blob
    with open(out_path or path, "wb") as handle:
        handle.write(bytes(data))
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("glb", nargs="+", help="garment GLBs to repack in place")
    ap.add_argument("--out", help="write here instead of in place (single input only)")
    ap.add_argument("--mesh", help="mesh to repack, when the GLB holds more than one")
    args = ap.parse_args()
    if args.out and len(args.glb) > 1:
        ap.error("--out takes a single input")
    for path in args.glb:
        repack_glb(path, args.out, args.mesh)


if __name__ == "__main__":
    main()
