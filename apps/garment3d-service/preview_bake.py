import argparse
import os

import numpy as np
import trimesh
from PIL import Image

from bake_texture import LIBRARY_GARMENT_MESH, _mesh_names, garment_source, mesh_for_product_type

AVATAR_PATH = os.path.join(os.path.dirname(__file__), "avatar-default.glb")
GARMENT_MESH = "Wolf3D_Outfit_Top"

VIEW_AXES = {
    "front": (0, 2, 1.0),
    "back": (0, 2, -1.0),
    "right": (2, 0, 1.0),
    "left": (2, 0, -1.0),
}


def render(
    texture_path: str | None,
    out_path: str,
    views: list[str],
    size: int = 512,
    avatar_path: str = AVATAR_PATH,
    mesh_name: str = GARMENT_MESH,
) -> None:
    scene = trimesh.load(avatar_path, process=False)
    mesh = scene.geometry[mesh_name]

    if texture_path:
        tex = np.asarray(Image.open(texture_path).convert("RGB"))
    else:
        tex = np.asarray(mesh.visual.material.baseColorTexture.convert("RGB"))
    th, tw = tex.shape[:2]

    verts = np.asarray(mesh.vertices)
    faces = np.asarray(mesh.faces)
    uv = np.asarray(mesh.visual.uv)

    lo, hi = verts.min(0), verts.max(0)
    span = (hi - lo).max()

    panels = []
    for view in views:
        h_axis, d_axis, d_sign = VIEW_AXES[view]
        img = np.full((size, size, 3), 245, np.uint8)
        zbuf = np.full((size, size), -np.inf)

        sx = (verts[:, h_axis] - (lo[h_axis] + hi[h_axis]) / 2) / span
        if view in ("back", "left"):
            sx = -sx
        sy = (verts[:, 1] - (lo[1] + hi[1]) / 2) / span
        px = (sx * 0.9 + 0.5) * (size - 1)
        py = (0.5 - sy * 0.9) * (size - 1)
        depth = verts[:, d_axis] * d_sign

        for a, b, c in faces:
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
            inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            if not inside.any():
                continue

            ys, xs = gy[inside], gx[inside]
            bw = np.stack([w0[inside], w1[inside], w2[inside]], axis=1)
            z = bw @ depth[[a, b, c]]
            nearer = z > zbuf[ys, xs]
            if not nearer.any():
                continue

            ys, xs, bw, z = ys[nearer], xs[nearer], bw[nearer], z[nearer]
            fuv = bw @ uv[[a, b, c]]
            tx = np.clip((fuv[:, 0] * (tw - 1)).astype(int), 0, tw - 1)
            ty = np.clip(((1 - fuv[:, 1]) * (th - 1)).astype(int), 0, th - 1)
            img[ys, xs] = tex[ty, tx]
            zbuf[ys, xs] = z

        panels.append(img)

    Image.fromarray(np.concatenate(panels, axis=1)).save(out_path)
    print(f"Wrote {out_path} ({', '.join(views)})")


def render_dressed(
    texture_path: str,
    out_path: str,
    views: list[str],
    size: int = 512,
    avatar_path: str = AVATAR_PATH,
    baked_mesh: str = GARMENT_MESH,
) -> None:
    scene = trimesh.load(avatar_path, process=False)
    baked = np.asarray(Image.open(texture_path).convert("RGB"))

    panels = []
    for view in views:
        h_axis, d_axis, d_sign = VIEW_AXES[view]
        img = np.full((size, size, 3), 245, np.uint8)
        zbuf = np.full((size, size), -np.inf)

        everything = np.vstack([np.asarray(g.vertices) for g in scene.geometry.values()])
        lo, hi = everything.min(0), everything.max(0)
        span = (hi - lo).max()

        for name, mesh in scene.geometry.items():
            tex = baked if name == baked_mesh else _stock_texture(mesh)
            if tex is None:
                continue
            _raster(mesh, tex, img, zbuf, view, lo, hi, span, size)

        panels.append(img)

    Image.fromarray(np.concatenate(panels, axis=1)).save(out_path)
    print(f"Wrote {out_path} - full avatar, {baked_mesh} retextured ({', '.join(views)})")


def _stock_texture(mesh) -> np.ndarray | None:
    image = getattr(getattr(mesh.visual, "material", None), "baseColorTexture", None)
    return np.asarray(image.convert("RGB")) if image is not None else None


def _raster(mesh, tex, img, zbuf, view, lo, hi, span, size) -> None:
    h_axis, d_axis, d_sign = VIEW_AXES[view]
    verts = np.asarray(mesh.vertices)
    uv = np.asarray(mesh.visual.uv)
    th, tw = tex.shape[:2]

    sx = (verts[:, h_axis] - (lo[h_axis] + hi[h_axis]) / 2) / span
    if view in ("back", "left"):
        sx = -sx
    sy = (verts[:, 1] - (lo[1] + hi[1]) / 2) / span
    px = (sx * 0.9 + 0.5) * (size - 1)
    py = (0.5 - sy * 0.9) * (size - 1)
    depth = verts[:, d_axis] * d_sign

    for a, b, c in np.asarray(mesh.faces):
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
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        ys, xs = gy[inside], gx[inside]
        bw = np.stack([w0[inside], w1[inside], w2[inside]], axis=1)
        z = bw @ depth[[a, b, c]]
        nearer = z > zbuf[ys, xs]
        if not nearer.any():
            continue
        ys, xs, bw, z = ys[nearer], xs[nearer], bw[nearer], z[nearer]
        fuv = bw @ uv[[a, b, c]]
        tx = np.clip((fuv[:, 0] * (tw - 1)).astype(int), 0, tw - 1)
        ty = np.clip(((1 - fuv[:, 1]) * (th - 1)).astype(int), 0, th - 1)
        img[ys, xs] = tex[ty, tx]
        zbuf[ys, xs] = z


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("texture", nargs="?", help="omit to render the avatar's stock texture")
    ap.add_argument(
        "--avatar",
        help="defaults to whichever GLB the bake would have painted for this product type",
    )
    ap.add_argument("--product-type", default="T_SHIRT", help="which avatar mesh to render")
    ap.add_argument("--out", default="bake-preview.png")
    ap.add_argument("--views", default="front,back,left")
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument(
        "--dressed",
        action="store_true",
        help="render the whole avatar, not just the garment mesh",
    )
    args = ap.parse_args()

    if args.avatar:
        source_path = args.avatar
        if LIBRARY_GARMENT_MESH in _mesh_names(source_path):
            mesh_name = LIBRARY_GARMENT_MESH
        else:
            mesh_name = mesh_for_product_type(args.product_type)
    else:
        source_path, mesh_name = garment_source(args.product_type)

    renderer = render_dressed if args.dressed else render
    renderer(
        args.texture,
        args.out,
        args.views.split(","),
        args.size,
        source_path,
        mesh_name,
    )


if __name__ == "__main__":
    main()
