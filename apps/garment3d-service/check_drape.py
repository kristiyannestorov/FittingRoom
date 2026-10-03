import argparse
import os

import numpy as np
from scipy.spatial import cKDTree

from refit_garments import (
    AVATAR_PATH,
    BODY_PROXY,
    KEEP_INSIDE,
    SLOT_FOR_TYPE,
    Glb,
    Rig,
    _avatar_triangles,
    _surface_samples,
)

SLICES = {"chest": 0.62, "waist": 0.22, "hip": 0.02, "thigh": -0.30}


def _garment(path: str):
    glb = Glb(path)
    prim = glb.gltf["meshes"][0]["primitives"][0]
    positions = glb.accessor(prim["attributes"]["POSITION"]).astype(np.float64)
    tris = glb.accessor(prim["indices"]).reshape(-1, 3).astype(np.int64)
    if "_PART" in prim["attributes"]:
        part = glb.accessor(prim["attributes"]["_PART"]).reshape(len(positions), -1)
        if part.shape[1] > 2:
            tris = tris[part[tris, 2].max(axis=1) < 0.5]
            used = np.unique(tris)
            remap = np.full(len(positions), -1, np.int64)
            remap[used] = np.arange(len(used))
            positions, tris = positions[used], remap[tris]
    return positions, tris


def _slice(positions: np.ndarray, tris: np.ndarray, y: float) -> np.ndarray:
    out = []
    for a, b in ((0, 1), (1, 2), (2, 0)):
        p, q = positions[tris[:, a]], positions[tris[:, b]]
        crossing = ((p[:, 1] - y) * (q[:, 1] - y)) < 0
        if not crossing.any():
            continue
        p, q = p[crossing], q[crossing]
        t = (y - p[:, 1]) / (q[:, 1] - p[:, 1])
        out.append((p + t[:, None] * (q - p))[:, [0, 2]])
    return np.concatenate(out) if out else np.empty((0, 2))


def gaps(positions: np.ndarray, body_points: np.ndarray, body_normals: np.ndarray) -> np.ndarray:
    _, nearest = cKDTree(body_points).query(positions, workers=-1)
    return np.einsum("ij,ij->i", positions - body_points[nearest], body_normals[nearest])


def _tucked(positions: np.ndarray, avatar: Glb, path: str) -> np.ndarray:
    product_type = os.path.splitext(os.path.basename(path))[0]
    slot = SLOT_FOR_TYPE.get(product_type)
    hems = [
        min(vertices[:, 1].min() for vertices, _ in _avatar_triangles(avatar, [name]))
        for name in KEEP_INSIDE.get(slot, [])
    ]
    return positions[:, 1] >= min(hems) if hems else np.zeros(len(positions), bool)


def report(path: str, avatar: Glb, body_points: np.ndarray, body_normals: np.ndarray) -> None:
    positions, _ = _garment(path)
    gap = 1000 * gaps(positions, body_points, body_normals)
    exposed = ~_tucked(positions, avatar, path)
    print(f"{os.path.basename(path)}")
    print(
        f"  gap mm   median {np.median(gap[exposed]):5.1f}   p05 {np.percentile(gap[exposed], 5):5.1f}"
        f"   p95 {np.percentile(gap[exposed], 95):5.1f}"
    )
    print(f"  apparently inside the body: {100 * (gap[exposed] < 0).mean():.1f}% of the exposed vertices")
    print(f"  hem at y={positions[:, 1].min():.3f}   top at y={positions[:, 1].max():.3f}")


def plot(paths: list[str], body: tuple[np.ndarray, np.ndarray], rig: Rig, out: str) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    body_positions, body_tris = body
    hips, neck, knee = rig.head["Hips"][1], rig.head["Neck"][1], rig.head["LeftLeg"][1]
    levels = {
        name: hips + f * ((neck - hips) if f >= 0 else (hips - knee))
        for name, f in SLICES.items()
    }

    hems = [_garment(p)[0][:, 1].min() for p in paths]
    levels["hem"] = max(hems) + 0.015

    fig, axes = plt.subplots(1, len(levels), figsize=(4 * len(levels), 4.2))
    for ax, (name, y) in zip(np.atleast_1d(axes), levels.items()):
        skin = _slice(body_positions, body_tris, y)
        ax.scatter(skin[:, 0], skin[:, 1], s=1.5, c="#c9a227", label="body")
        for path, colour in zip(paths, ("#d1495b", "#2a9d8f", "#4361ee")):
            positions, tris = _garment(path)
            cloth = _slice(positions, tris, y)
            if len(cloth):
                ax.scatter(cloth[:, 0], cloth[:, 1], s=1.5, c=colour, label=os.path.basename(path))
        ax.set_title(f"{name}  (y={y:.2f} m)")
        ax.set_aspect("equal")
        ax.set_xlabel("x (m)")
        ax.set_ylabel("z (m)")
        ax.grid(alpha=0.25)
    np.atleast_1d(axes)[0].legend(loc="upper left", fontsize=7)
    fig.tight_layout()
    fig.savefig(out, dpi=130)
    print(f"wrote {out}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("garment", nargs="+", help="refitted garment GLBs, e.g. garments/T_SHIRT.glb")
    ap.add_argument("--plot", help="write cross-sections through the body and the garments here")
    args = ap.parse_args()

    avatar = Glb(AVATAR_PATH)
    parts = _avatar_triangles(avatar, BODY_PROXY)
    points, normals = _surface_samples(parts)
    for path in args.garment:
        report(path, avatar, points, normals)
    if args.plot:
        merged_positions, merged_tris, offset = [], [], 0
        for positions, tris in parts:
            merged_positions.append(positions)
            merged_tris.append(tris + offset)
            offset += len(positions)
        plot(
            args.garment,
            (np.concatenate(merged_positions), np.concatenate(merged_tris)),
            Rig(avatar),
            args.plot,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
