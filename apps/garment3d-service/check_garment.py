import argparse
import os
import sys

import trimesh

from bake_texture import AVATAR_PATH, GARMENT_LIBRARY_DIR, mesh_for_product_type


def bone_names(path: str) -> set[str]:
    scene = trimesh.load(path, process=False)
    return set(scene.graph.nodes)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("glb", help="a Ready Player Me avatar export wearing the garment")
    ap.add_argument(
        "--product-type",
        required=True,
        help="decides which mesh in the GLB is the garment (a top's or a bottom's)",
    )
    ap.add_argument(
        "--category",
        help="install under this category instead of the product type, so it applies to "
        "just this cut (e.g. ZIP_UP) rather than every product of the type",
    )
    ap.add_argument(
        "--install",
        action="store_true",
        help="on success, copy into garments/ under the product type's name",
    )
    args = ap.parse_args()

    product_type = args.product_type.upper()
    try:
        mesh_name = mesh_for_product_type(product_type)
    except ValueError as error:
        print(f"FAIL: {error}")
        return 1

    scene = trimesh.load(args.glb, process=False)
    problems: list[str] = []

    if mesh_name not in scene.geometry:
        found = ", ".join(sorted(scene.geometry))
        problems.append(
            f"no {mesh_name!r} mesh (found: {found}).\n"
            "      If you see a single 'Wolf3D_Avatar' mesh, the export merged the outfit\n"
            "      into the body and can't be used. Re-export without mesh optimisation."
        )
    else:
        mesh = scene.geometry[mesh_name]
        if getattr(mesh.visual, "uv", None) is None:
            problems.append(f"{mesh_name} has no UVs, so there is nowhere to bake into")
        else:
            lo, hi = mesh.bounds
            print(f"  {mesh_name}: {len(mesh.vertices)} verts, {len(mesh.faces)} faces")
            print(f"    height y=[{lo[1]:.2f}, {hi[1]:.2f}]  width x=[{lo[0]:.2f}, {hi[0]:.2f}]")

            reference = trimesh.load(AVATAR_PATH, process=False)
            if mesh_name in reference.geometry:
                rlo, rhi = reference.geometry[mesh_name].bounds
                print(f"    default avatar's {mesh_name}: y=[{rlo[1]:.2f}, {rhi[1]:.2f}]")
                print("    (a hoodie should hang lower than the tee; shorts stop above the ankle)")

    theirs, ours = bone_names(args.glb), bone_names(AVATAR_PATH)
    missing = {b for b in ours if b.startswith(("Hips", "Spine", "LeftArm", "RightArm"))} - theirs
    if missing:
        problems.append(
            f"skeleton differs from the default avatar, missing {sorted(missing)[:5]}.\n"
            "      The garment can't be re-bound to the avatar's skeleton, so it won't move."
        )

    if problems:
        print(f"\nFAIL ({len(problems)} problem(s)):")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    print(f"\nOK: usable as the {product_type} garment.")
    if args.category:
        dest = os.path.join(GARMENT_LIBRARY_DIR, product_type, f"{args.category.upper()}.glb")
    else:
        dest = os.path.join(GARMENT_LIBRARY_DIR, f"{product_type}.glb")
    if args.install:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(args.glb, "rb") as src, open(dest, "wb") as out:
            out.write(src.read())
        print(f"Installed -> {dest}")
    else:
        print(f"Re-run with --install to copy it into {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
