import argparse

import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

import garment_details
from bake_texture import LIBRARY_GARMENT_MESH, fill_uncovered, rasterize_atlas


def remap(texture: np.ndarray, old_uv: np.ndarray, new_uv: np.ndarray, faces: np.ndarray) -> np.ndarray:
    h, w = texture.shape[:2]
    size = max(h, w)
    old3 = np.column_stack([old_uv, np.zeros(len(old_uv))])
    lookup, _, filled = rasterize_atlas(new_uv, faces, old3, old3, size)

    x = lookup[:, :, 0] * (w - 1)
    y = (1.0 - lookup[:, :, 1]) * (h - 1)
    out = np.zeros((size, size, 3), np.float32)
    for c in range(3):
        out[:, :, c] = ndimage.map_coordinates(
            texture[:, :, c].astype(np.float32), [y, x], order=1, mode="nearest"
        )
    return fill_uncovered(out * filled[:, :, None], filled)

SURFACE_CANDIDATES = 8
SURFACE_CHUNK = 100_000


def remap_by_surface(
    texture: np.ndarray, old: tuple, new: tuple, size: int | None = None
) -> np.ndarray:
    old_uv, old_faces, old_verts = old
    new_uv, new_faces, new_verts = new
    h, w = texture.shape[:2]
    size = size or max(h, w)
    surface, _, filled = rasterize_atlas(new_uv, new_faces, new_verts, new_verts, size)
    wanted = surface[filled]

    area = np.linalg.norm(np.cross(*np.diff(old_verts[old_faces], axis=1).transpose(1, 0, 2)), axis=1)
    old_faces = old_faces[area > 1e-12]
    triangles = old_verts[old_faces]
    candidates = cKDTree(triangles.mean(axis=1)).query(wanted, k=SURFACE_CANDIDATES)[1]
    uv = np.empty((len(wanted), 2))
    for start in range(0, len(wanted), SURFACE_CHUNK):
        points = wanted[start : start + SURFACE_CHUNK]
        tri = candidates[start : start + SURFACE_CHUNK]
        flat = trimesh.triangles.closest_point(
            triangles[tri.ravel()], np.repeat(points, SURFACE_CANDIDATES, axis=0)
        ).reshape(len(points), SURFACE_CANDIDATES, 3)
        best = np.argmin(np.linalg.norm(flat - points[:, None], axis=2), axis=1)
        rows = np.arange(len(points))
        chosen = tri[rows, best]
        bary = trimesh.triangles.points_to_barycentric(triangles[chosen], flat[rows, best])
        uv[start : start + SURFACE_CHUNK] = np.einsum("ij,ijk->ik", bary, old_uv[old_faces[chosen]])

    out = np.zeros((size, size, 3), np.float32)
    x = uv[:, 0] * (w - 1)
    y = (1.0 - uv[:, 1]) * (h - 1)
    for c in range(3):
        out[filled, c] = ndimage.map_coordinates(
            texture[:, :, c].astype(np.float32), [y, x], order=1, mode="nearest"
        )
    return fill_uncovered(out, filled)


def _uv(glb: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mesh = trimesh.load(glb, process=False).geometry[LIBRARY_GARMENT_MESH]
    faces = garment_details.outside_faces(np.asarray(mesh.faces), garment_details.read_attributes(glb, LIBRARY_GARMENT_MESH))
    return np.asarray(mesh.visual.uv, np.float64), faces, np.asarray(mesh.vertices)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("texture")
    ap.add_argument("out")
    ap.add_argument("--old-glb", required=True, help="the garment the texture was baked against")
    ap.add_argument("--new-glb", required=True, help="the same garment with its new UV layout")
    ap.add_argument(
        "--by-surface",
        action="store_true",
        help="the triangles differ too (a refit dropped or cut some): match by closest point "
        "on the garment's surface instead of triangle for triangle",
    )
    args = ap.parse_args()

    old = _uv(args.old_glb)
    new = _uv(args.new_glb)
    texture = np.asarray(Image.open(args.texture).convert("RGB"))
    if args.by_surface:
        out = remap_by_surface(texture, old, new)
    else:
        if not np.array_equal(old[1], new[1]):
            raise SystemExit("the two GLBs have different triangles; pass --by-surface")
        out = remap(texture, old[0], new[0], new[1])
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(args.out)
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
