import os

import bpy

SIZE = 1024
OUT_DIR = os.path.join(os.path.dirname(__file__), "out")


def build_material() -> bpy.types.Material:
    mat = bpy.data.materials.new(name="CottonFabric")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = (0.75, 0.75, 0.75, 1.0)

    texcoord = nodes.new("ShaderNodeTexCoord")

    warp = nodes.new("ShaderNodeTexWave")
    warp.wave_type = "BANDS"
    warp.bands_direction = "X"
    warp.inputs["Scale"].default_value = 40.0
    warp.inputs["Distortion"].default_value = 0.3
    warp.inputs["Detail"].default_value = 1.0
    links.new(texcoord.outputs["UV"], warp.inputs["Vector"])

    weft = nodes.new("ShaderNodeTexWave")
    weft.wave_type = "BANDS"
    weft.bands_direction = "Y"
    weft.inputs["Scale"].default_value = 40.0
    weft.inputs["Distortion"].default_value = 0.3
    weft.inputs["Detail"].default_value = 1.0
    links.new(texcoord.outputs["UV"], weft.inputs["Vector"])

    interlace = nodes.new("ShaderNodeMath")
    interlace.operation = "MAXIMUM"
    links.new(warp.outputs["Color"], interlace.inputs[0])
    links.new(weft.outputs["Color"], interlace.inputs[1])

    fuzz = nodes.new("ShaderNodeTexNoise")
    fuzz.inputs["Scale"].default_value = 120.0
    fuzz.inputs["Detail"].default_value = 2.0
    fuzz.inputs["Roughness"].default_value = 0.6
    links.new(texcoord.outputs["UV"], fuzz.inputs["Vector"])

    fuzz_weighted = nodes.new("ShaderNodeMath")
    fuzz_weighted.operation = "MULTIPLY"
    fuzz_weighted.inputs[1].default_value = 0.08
    links.new(fuzz.outputs["Fac"], fuzz_weighted.inputs[0])

    height = nodes.new("ShaderNodeMath")
    height.operation = "ADD"
    links.new(interlace.outputs["Value"], height.inputs[0])
    links.new(fuzz_weighted.outputs["Value"], height.inputs[1])

    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.25
    links.new(height.outputs["Value"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

    roughness_range = nodes.new("ShaderNodeMapRange")
    roughness_range.inputs["From Min"].default_value = 0.0
    roughness_range.inputs["From Max"].default_value = 1.0
    roughness_range.inputs["To Min"].default_value = 0.45
    roughness_range.inputs["To Max"].default_value = 0.75
    links.new(height.outputs["Value"], roughness_range.inputs["Value"])
    links.new(roughness_range.outputs["Result"], bsdf.inputs["Roughness"])

    return mat


def bake(obj: bpy.types.Object, mat: bpy.types.Material, bake_type: str, filename: str) -> str:
    nodes = mat.node_tree.nodes
    img = bpy.data.images.new(filename, width=SIZE, height=SIZE, float_buffer=False)
    img.colorspace_settings.name = "Non-Color"

    img_node = nodes.new("ShaderNodeTexImage")
    img_node.image = img
    for n in nodes:
        n.select = False
    img_node.select = True
    nodes.active = img_node

    bpy.context.scene.cycles.bake_type = bake_type
    if bake_type == "NORMAL":
        bpy.context.scene.render.bake.normal_space = "TANGENT"
    bpy.ops.object.bake(type=bake_type)

    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"{filename}.png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    nodes.remove(img_node)
    print(f"Wrote {path}")
    return path


def main() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"

    bpy.ops.mesh.primitive_plane_add(size=2)
    obj = bpy.context.active_object
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name="UVMap")

    mat = build_material()
    obj.data.materials.append(mat)

    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    bake(obj, mat, "NORMAL", "cotton-normal")
    bake(obj, mat, "ROUGHNESS", "cotton-roughness")
    print("DONE")


if __name__ == "__main__":
    main()
