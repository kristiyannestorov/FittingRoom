import argparse
import io
import json
import os
import struct

import numpy as np
import trimesh
from PIL import Image

COMPONENT_TYPES = {
    5120: (1, np.int8),
    5121: (1, np.uint8),
    5122: (2, np.int16),
    5123: (2, np.uint16),
    5125: (4, np.uint32),
    5126: (4, np.float32),
}
COMPONENT_COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

QUADRANTS = {
    "SKIN": (0.0, 0.0),
    "BOTTOM": (0.5, 0.0),
    "TOP": (0.0, 0.5),
    "DETAIL": (0.5, 0.5),
}

PART_MATERIALS = {
    "Wolf3D_Outfit_Top": ("TOP", "Wolf3D_Outfit_Top"),
    "Wolf3D_Outfit_Bottom": ("BOTTOM", "Wolf3D_Outfit_Bottom"),
    "Wolf3D_Outfit_Footwear": ("DETAIL", "Wolf3D_Outfit_Footwear"),
    "Wolf3D_Head": ("SKIN", "Wolf3D_Skin_Head"),
    "Wolf3D_Body": ("DETAIL", "Wolf3D_Body_Skin"),
    "Wolf3D_Hair": ("DETAIL", "Wolf3D_Hair"),
    "Wolf3D_Teeth": ("DETAIL", "Wolf3D_Teeth"),
    "Wolf3D_Eyes": ("DETAIL", "Wolf3D_Eye"),
}


def read_glb(path: str) -> tuple[dict, bytes]:
    blob = open(path, "rb").read()
    magic, _version, _length = struct.unpack("<III", blob[:12])
    if magic != 0x46546C67:
        raise ValueError(f"{path} is not a GLB")
    json_len, json_tag = struct.unpack("<II", blob[12:20])
    if json_tag != 0x4E4F534A:
        raise ValueError("first chunk is not JSON")
    doc = json.loads(blob[20 : 20 + json_len])
    bin_start = 20 + json_len
    bin_len, bin_tag = struct.unpack("<II", blob[bin_start : bin_start + 8])
    if bin_tag != 0x004E4942:
        raise ValueError("second chunk is not BIN")
    return doc, blob[bin_start + 8 : bin_start + 8 + bin_len]


def read_accessor(doc: dict, buf: bytes, index: int) -> np.ndarray:
    acc = doc["accessors"][index]
    size, dtype = COMPONENT_TYPES[acc["componentType"]]
    ncomp = COMPONENT_COUNTS[acc["type"]]
    count = acc["count"]
    view = doc["bufferViews"][acc["bufferView"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = view.get("byteStride")

    if stride and stride != size * ncomp:
        rows = [
            np.frombuffer(buf, dtype=dtype, count=ncomp, offset=start + i * stride)
            for i in range(count)
        ]
        data = np.stack(rows)
    else:
        data = np.frombuffer(buf, dtype=dtype, count=count * ncomp, offset=start)
        data = data.reshape(count, ncomp)

    return data[:, 0] if ncomp == 1 else data


def read_base_color(doc: dict, buf: bytes, material: int) -> Image.Image:
    texture = doc["materials"][material]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    view = doc["bufferViews"][doc["images"][doc["textures"][texture]["source"]]["bufferView"]]
    start = view.get("byteOffset", 0)
    return Image.open(io.BytesIO(buf[start : start + view["byteLength"]])).convert("RGBA")


def classify(components, verts, uv, faces) -> dict[str, list[np.ndarray]]:
    parts: dict[str, list[np.ndarray]] = {name: [] for name in PART_MATERIALS}

    for comp in components:
        vi = np.unique(faces[comp])
        v, u = verts[vi], uv[vi]
        uc, vc = u[:, 0].mean(), u[:, 1].mean()
        y_min, y_max = v[:, 1].min(), v[:, 1].max()

        if uc < 0.5 and vc >= 0.5:
            part = "Wolf3D_Outfit_Top"
        elif uc >= 0.5 and vc < 0.5:
            part = "Wolf3D_Outfit_Bottom"
        elif uc < 0.5 and vc < 0.5:
            part = "Wolf3D_Head"
        elif y_max < 0.30:
            part = "Wolf3D_Outfit_Footwear"
        elif 0.55 <= uc <= 0.75 and 0.50 <= vc <= 0.75:
            part = "Wolf3D_Eyes"
        elif y_min > 1.58:
            part = "Wolf3D_Hair"
        elif y_min > 1.50:
            part = "Wolf3D_Teeth"
        else:
            part = "Wolf3D_Body"

        parts[part].append(comp)

    return {name: comps for name, comps in parts.items() if comps}


def crop_quadrant(image: Image.Image, quadrant: str) -> bytes:
    u0, v0 = QUADRANTS[quadrant]
    w, h = image.size
    box = (int(u0 * w), int(v0 * h), int((u0 + 0.5) * w), int((v0 + 0.5) * h))
    out = io.BytesIO()
    image.crop(box).save(out, format="PNG")
    return out.getvalue()


def split(src: str, out: str) -> None:
    doc, buf = read_glb(src)

    meshes = doc["meshes"]
    if len(meshes) != 1 or len(meshes[0]["primitives"]) != 1:
        raise SystemExit(
            f"expected one mesh with one primitive, found "
            f"{len(meshes)} mesh(es). Is {os.path.basename(src)} already split?"
        )
    prim = meshes[0]["primitives"][0]
    attrs = prim["attributes"]

    verts = read_accessor(doc, buf, attrs["POSITION"]).astype(np.float32)
    normals = read_accessor(doc, buf, attrs["NORMAL"]).astype(np.float32)
    uv = read_accessor(doc, buf, attrs["TEXCOORD_0"]).astype(np.float32)
    joints = read_accessor(doc, buf, attrs["JOINTS_0"])
    weights = read_accessor(doc, buf, attrs["WEIGHTS_0"]).astype(np.float32)
    faces = read_accessor(doc, buf, prim["indices"]).astype(np.uint32).reshape(-1, 3)

    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
    components = trimesh.graph.connected_components(
        mesh.face_adjacency, nodes=np.arange(len(faces))
    )
    parts = classify(components, verts, uv, faces)

    source_image = read_base_color(doc, buf, prim["material"])

    blobs: list[bytes] = []
    views: list[dict] = []
    accessors: list[dict] = []

    def add_view(data: bytes, target: int | None = None) -> int:
        pad = (-len(data)) % 4
        blobs.append(data + b"\x00" * pad)
        offset = sum(len(b) for b in blobs[:-1])
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        views.append(view)
        return len(views) - 1

    def add_accessor(array: np.ndarray, kind: str, target: int, minmax=False) -> int:
        ctype = {
            np.dtype(np.float32): 5126,
            np.dtype(np.uint32): 5125,
            np.dtype(np.uint16): 5123,
            np.dtype(np.uint8): 5121,
        }[array.dtype]
        acc = {
            "bufferView": add_view(array.tobytes(), target),
            "componentType": ctype,
            "count": len(array),
            "type": kind,
        }
        if minmax:
            acc["min"] = array.min(axis=0).tolist()
            acc["max"] = array.max(axis=0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    quadrants_used = sorted({PART_MATERIALS[p][0] for p in parts})
    images, textures = [], []
    texture_for_quadrant = {}
    for quadrant in quadrants_used:
        view = add_view(crop_quadrant(source_image, quadrant))
        images.append({"name": f"{quadrant}.png", "mimeType": "image/png", "bufferView": view})
        textures.append({"sampler": 0, "source": len(images) - 1})
        texture_for_quadrant[quadrant] = len(textures) - 1

    materials, material_for_part = [], {}
    for part in parts:
        quadrant, material_name = PART_MATERIALS[part]
        materials.append(
            {
                "name": material_name,
                "alphaMode": "OPAQUE",
                "doubleSided": False,
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": texture_for_quadrant[quadrant], "texCoord": 0},
                    "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.85,
                },
            }
        )
        material_for_part[part] = len(materials) - 1

    new_meshes, new_nodes = [], []
    for part, comps in parts.items():
        part_faces = faces[np.concatenate(comps)]
        used = np.unique(part_faces)
        remap = np.full(len(verts), -1, np.int64)
        remap[used] = np.arange(len(used))

        quadrant = PART_MATERIALS[part][0]
        u0, v0 = QUADRANTS[quadrant]
        part_uv = (uv[used] - np.array([u0, v0], np.float32)) * 2.0

        new_meshes.append(
            {
                "name": part,
                "primitives": [
                    {
                        "attributes": {
                            "POSITION": add_accessor(verts[used], "VEC3", 34962, minmax=True),
                            "NORMAL": add_accessor(normals[used], "VEC3", 34962),
                            "TEXCOORD_0": add_accessor(part_uv.astype(np.float32), "VEC2", 34962),
                            "JOINTS_0": add_accessor(joints[used], "VEC4", 34962),
                            "WEIGHTS_0": add_accessor(weights[used], "VEC4", 34962),
                        },
                        "indices": add_accessor(
                            remap[part_faces].reshape(-1).astype(np.uint32), "SCALAR", 34963
                        ),
                        "material": material_for_part[part],
                        "mode": 4,
                    }
                ],
            }
        )
        new_nodes.append({"name": part, "mesh": len(new_meshes) - 1, "skin": 0})
        print(f"  {part:<24} {len(part_faces):>6} faces  {len(used):>6} verts  [{quadrant}]")

    nodes = [dict(node) for node in doc["nodes"]]
    mesh_node = next(i for i, n in enumerate(nodes) if "mesh" in n)
    parent = next(i for i, n in enumerate(nodes) if mesh_node in n.get("children", []))
    nodes[parent] = dict(nodes[parent])
    nodes[parent]["children"] = [c for c in nodes[parent]["children"] if c != mesh_node]
    nodes[mesh_node] = {"name": nodes[mesh_node].get("name", "Wolf3D_Avatar") + "_Split"}

    first_new = len(nodes)
    nodes.extend(new_nodes)
    nodes[parent]["children"].extend(range(first_new, len(nodes)))

    skin = dict(doc["skins"][0])
    skin["inverseBindMatrices"] = add_accessor(
        read_accessor(doc, buf, skin["inverseBindMatrices"]).astype(np.float32), "MAT4", 34962
    )

    out_doc = {
        "asset": {"version": "2.0", "generator": "split_merged_avatar.py"},
        "scene": doc.get("scene", 0),
        "scenes": doc["scenes"],
        "nodes": nodes,
        "meshes": new_meshes,
        "skins": [skin],
        "materials": materials,
        "textures": textures,
        "images": images,
        "samplers": doc.get("samplers", [{}]),
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": sum(len(b) for b in blobs)}],
    }

    bin_chunk = b"".join(blobs)
    json_chunk = json.dumps(out_doc, separators=(",", ":")).encode("utf-8")
    json_chunk += b" " * ((-len(json_chunk)) % 4)
    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    with open(out, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(json_chunk), 0x4E4F534A))
        fh.write(json_chunk)
        fh.write(struct.pack("<II", len(bin_chunk), 0x004E4942))
        fh.write(bin_chunk)
    print(f"Wrote {out} ({total / 1024:.0f} KB, {len(parts)} meshes)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", help="a merged RPM avatar GLB (one Wolf3D_Avatar mesh)")
    ap.add_argument("--out", required=True, help="where to write the split avatar")
    args = ap.parse_args()
    split(args.source, args.out)


if __name__ == "__main__":
    main()
