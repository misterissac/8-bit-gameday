"""
generate_body_parts.py
----------------------
Blender Python script to procedurally model and export all solomon-gumball
baseball player body parts according to body_part_modeling_guide.md.

Updates:
- Limbs (upper_arm, forearm, thigh, shin) are pill-shaped (capsules with hemispherical ends)
- Uses user's custom head combined with custom eyes and helmet as the default head
- Exports separate helmet.glb and head_bare.glb for cap/helmet swapping flexibility
"""

import bpy
import bmesh
import math
import mathutils
import os
import shutil

# Paths
WORKSPACE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BLEND_OUTPUT_PATH = os.path.join(WORKSPACE_ROOT, "models", "baseball_bodyparts.blend")
EXPORT_DIR = os.path.join(WORKSPACE_ROOT, "frontend", "public", "models", "parts")
EXISTING_BLEND_PATH = os.path.join(WORKSPACE_ROOT, "models", "baseball_bodyparts.blend")
BACKUP_TMP_PATH = os.path.join(WORKSPACE_ROOT, "models", "baseball_bodyparts.blend.tmp")

os.makedirs(EXPORT_DIR, exist_ok=True)

# -----------------------------------------------------------------------------
# -----------------------------------------------------------------------------
# Color Palette Definition (solomon-gumball aesthetic)
# -----------------------------------------------------------------------------
PALETTE = {
    "skin":         {"color": (0.880, 0.539, 0.205, 1.0), "roughness": 0.8}, # matches user custom skin.001
    "team_primary": {"color": (0.010, 0.037, 0.109, 1.0), "roughness": 0.70}, # matches user custom helmet_shell
    "helmet":       {"color": (0.010, 0.037, 0.109, 1.0), "roughness": 0.70}, # matches user custom helmet_shell
    "cap":          {"color": (0.010, 0.037, 0.109, 1.0), "roughness": 0.92, "specular": 0.05}, # soft matte cap fabric, less reflective
    "eye_dark":     {"color": (0.012, 0.010, 0.009, 1.0), "roughness": 1.0, "specular": 0.0}, # completely non-reflective matte
    "jersey":       {"color": (0.169, 0.424, 0.690, 1.0), "roughness": 0.8}, # #2b6cb0
    "pants":        {"color": (0.886, 0.910, 0.941, 1.0), "roughness": 0.8}, # #e2e8f0
    "shoe_upper":   {"color": (0.961, 0.961, 0.961, 1.0), "roughness": 0.7}, # #f5f5f5
    "shoe_sole":    {"color": (0.122, 0.161, 0.216, 1.0), "roughness": 0.9}, # #1f2937
    "shoe_accent":  {"color": (1.000, 0.824, 0.247, 1.0), "roughness": 0.8}, # #ffd23f (signature yellow)
    "glove_leather":{"color": (0.498, 0.114, 0.114, 1.0), "roughness": 0.9}, # #7f1d1d
    "bat_wood":     {"color": (0.769, 0.541, 0.361, 1.0), "roughness": 0.6}, # #c48a5c
    "bat_knob":     {"color": (0.545, 0.353, 0.169, 1.0), "roughness": 0.7}, # #8b5a2b
}

def get_or_create_material(name, props):
    if name in bpy.data.materials:
        mat = bpy.data.materials[name]
    else:
        mat = bpy.data.materials.new(name=name)
        mat.use_nodes = True
    
    if mat.node_tree:
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            if "Base Color" in bsdf.inputs:
                bsdf.inputs["Base Color"].default_value = props["color"]
            if "Roughness" in bsdf.inputs:
                bsdf.inputs["Roughness"].default_value = props["roughness"]
            if "specular" in props:
                for spec_name in ["Specular IOR Level", "Specular"]:
                    if spec_name in bsdf.inputs:
                        bsdf.inputs[spec_name].default_value = props["specular"]
            if "Metallic" in bsdf.inputs:
                bsdf.inputs["Metallic"].default_value = 0.0
    return mat

def setup_materials():
    materials = {}
    for name, props in PALETTE.items():
        materials[name] = get_or_create_material(name, props)
    return materials

# -----------------------------------------------------------------------------
# Scene & Collection Setup
# -----------------------------------------------------------------------------
def setup_scene():
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1.0

    collections = ["Head_Parts", "Torso", "Arms", "Legs", "Accessories"]
    col_map = {}
    for col_name in collections:
        if col_name in bpy.data.collections:
            col_map[col_name] = bpy.data.collections[col_name]
        else:
            col = bpy.data.collections.new(col_name)
            bpy.context.scene.collection.children.link(col)
            col_map[col_name] = col
    return col_map

def assign_to_collection(obj, target_collection):
    for col in list(obj.users_collection):
        col.unlink(obj)
    target_collection.objects.link(obj)

# -----------------------------------------------------------------------------
# BMesh Mesh Joining Helper
# -----------------------------------------------------------------------------
def combine_meshes(target_name, source_objs, col):
    """
    Combines geometry from source_objs into a new mesh object, preserving
    all material slots and polygon material index assignments.
    """
    bm = bmesh.new()
    mesh = bpy.data.meshes.new(f"{target_name}_mesh")
    combined_obj = bpy.data.objects.new(target_name, mesh)
    
    mat_map = {}
    for src in source_objs:
        if not src or not src.data:
            continue
        src_bm = bmesh.new()
        src_bm.from_mesh(src.data)
        
        src_mat_remap = {}
        for src_i, src_m in enumerate(src.data.materials):
            if not src_m:
                continue
            if src_m.name not in mat_map:
                combined_obj.data.materials.append(src_m)
                mat_map[src_m.name] = len(combined_obj.data.materials) - 1
            src_mat_remap[src_i] = mat_map[src_m.name]
            
        for f in src_bm.faces:
            f.material_index = src_mat_remap.get(f.material_index, 0)
            
        temp_mesh = bpy.data.meshes.new("_temp_mesh")
        src_bm.to_mesh(temp_mesh)
        src_bm.free()
        bm.from_mesh(temp_mesh)
        bpy.data.meshes.remove(temp_mesh)
        
    bm.to_mesh(mesh)
    bm.free()
    
    for p in mesh.polygons:
        p.use_smooth = True
        
    assign_to_collection(combined_obj, col)
    return combined_obj

def apply_auto_smooth(obj, angle_degrees=35.0):
    """
    Applies Shade Auto Smooth to an object using Blender's Smooth by Angle modifier.
    A threshold of 35.0° keeps all dome spherical facets (max angle 31.5°) 100% shade smooth,
    while cleanly splitting the sharp creases of the ear flap, jaw guard, and visor brim (> 45°).
    """
    if not obj or not obj.data:
        return
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.shade_auto_smooth()
    mod = obj.modifiers.get("Smooth by Angle")
    if mod and hasattr(mod, "properties") and hasattr(mod.properties, "inputs"):
        if hasattr(mod.properties.inputs, "Input_1"):
            mod.properties.inputs.Input_1.value = math.radians(angle_degrees)


# -----------------------------------------------------------------------------
# Geometry Creation
# -----------------------------------------------------------------------------

def create_cap(materials, col, user_helmet=None):
    """
    Cap (cap.glb):
    - Derived from the user's custom helmet (identical dome + brim).
    - Thinner profile (scaled snugger to the head: ~0.975x).
    - Ear flap and jaw guard completely removed.
    - Soft matte fabric material (roughness 0.92, specular 0.05).
    """
    bm = bmesh.new()
    if user_helmet and user_helmet.data:
        bm.from_mesh(user_helmet.data)
        bm.faces.ensure_lookup_table()
        
        # Remove ear flap and jaw guard faces
        flap_faces = [
            f for f in bm.faces
            if f.calc_center_median().x < -0.05 and f.calc_center_median().z < 0.25 and not (f.calc_center_median().y > 0.24 and f.calc_center_median().z > 0.22)
        ]
        bmesh.ops.delete(bm, geom=flap_faces, context='FACES_ONLY')
        orphan_verts = [v for v in bm.verts if len(v.link_faces) == 0]
        bmesh.ops.delete(bm, geom=orphan_verts, context='VERTS')
        
        # Scale slightly thinner/snugger to head
        thin_mat = mathutils.Matrix.Diagonal((0.975, 0.975, 0.975, 1.0))
        bmesh.ops.transform(bm, matrix=thin_mat, verts=bm.verts)
    else:
        # Procedural fallback if custom helmet not loaded
        bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=12, radius=0.235)
        verts_to_delete = [v for v in bm.verts if v.co.z < -0.005]
        bmesh.ops.delete(bm, geom=verts_to_delete, context='VERTS')

        brim = bmesh.ops.create_cube(bm, size=1.0)
        scale_mat = mathutils.Matrix.Diagonal((0.34, 0.21, 0.04, 1.0))
        bmesh.ops.transform(bm, matrix=scale_mat, verts=brim['verts'])
        rot_mat = mathutils.Matrix.Rotation(math.radians(-10.0), 4, 'X')
        bmesh.ops.transform(bm, matrix=rot_mat, verts=brim['verts'])
        trans_mat = mathutils.Matrix.Translation((0.0, 0.21, 0.02))
        bmesh.ops.transform(bm, matrix=trans_mat, verts=brim['verts'])

    mesh = bpy.data.meshes.new("cap_mesh")
    bm.to_mesh(mesh)
    bm.free()

    for p in mesh.polygons:
        p.use_smooth = True

    obj = bpy.data.objects.new("cap", mesh)
    obj.data.materials.append(materials["cap"])
    assign_to_collection(obj, col)
    return obj

def create_torso(materials, col):
    """
    Torso (torso.glb):
    - Athletic jersey build (wider across X, thicker in Y front-to-back).
    - Tucks into baseball pants waist at Z = 0 (Three.js Y = 1.14).
    - Shoulder deck at Z = 0.72m (Three.js Y = 1.86m), neck rises to Z = 0.90m (Three.js Y = 2.04m, penetrating into head).
    - Front jersey patch on the chest.
    - Origin at bottom-center of jersey waist (Z = 0).
    """
    bm = bmesh.new()
    height_body = 0.72
    height_neck = 0.90
    neck_radius = 0.085
    num_z_rings = 16
    num_radial = 16

    rings = []
    for i in range(num_z_rings):
        t = i / (num_z_rings - 1)
        z = t * height_body
        curve = math.sin(t * math.pi)
        
        shoulder_tuck = 1.0
        if t > 0.85:
            st = (t - 0.85) / 0.15
            shoulder_tuck = 1.0 - 0.25 * (st ** 2)
        
        bot_tuck = 1.0
        if t < 0.15:
            bt = (0.15 - t) / 0.15
            bot_tuck = 1.0 - 0.12 * (bt ** 2)
            
        wx = (0.245 + 0.040 * curve) * shoulder_tuck * bot_tuck
        wy = (0.215 + 0.035 * curve) * shoulder_tuck * bot_tuck
        
        ring_verts = []
        for j in range(num_radial):
            angle = j * 2 * math.pi / num_radial
            c = math.cos(angle)
            s = math.sin(angle)
            p = 0.75
            x = wx * math.copysign(abs(c) ** p, c)
            y = wy * math.copysign(abs(s) ** p, s)
            if abs(c) > 0.4:
                x *= (1.0 + 0.04 * math.sin(abs(c) * math.pi))
            v = bm.verts.new((x, y, z))
            ring_verts.append(v)
        rings.append(ring_verts)

    for i in range(num_z_rings - 1):
        r1 = rings[i]
        r2 = rings[i + 1]
        for j in range(num_radial):
            j_next = (j + 1) % num_radial
            f = bm.faces.new([r1[j], r1[j_next], r2[j_next], r2[j]])
            f.material_index = 0

    bot_center = bm.verts.new((0.0, 0.0, 0.005))
    for j in range(num_radial):
        j_next = (j + 1) % num_radial
        f = bm.faces.new([bot_center, rings[0][j_next], rings[0][j]])
        f.material_index = 0

    # Sturdy neck connecting to head
    num_neck_rings = 6
    neck_rings = []
    for i in range(num_neck_rings):
        t = i / (num_neck_rings - 1)
        z = height_body + t * (height_neck - height_body)
        r = neck_radius * (1.0 + 0.04 * (1.0 - t))
        n_verts = []
        for j in range(num_radial):
            angle = j * 2 * math.pi / num_radial
            x = r * math.cos(angle)
            y = r * math.sin(angle)
            v = bm.verts.new((x, y, z))
            n_verts.append(v)
        neck_rings.append(n_verts)

    # Collar deck (connect body to neck)
    top_body_ring = rings[-1]
    neck_base_ring = neck_rings[0]
    for j in range(num_radial):
        j_next = (j + 1) % num_radial
        f = bm.faces.new([top_body_ring[j], top_body_ring[j_next], neck_base_ring[j_next], neck_base_ring[j]])
        f.material_index = 0

    # Neck cylinder faces (skin material)
    for i in range(num_neck_rings - 1):
        r1 = neck_rings[i]
        r2 = neck_rings[i + 1]
        for j in range(num_radial):
            j_next = (j + 1) % num_radial
            f = bm.faces.new([r1[j], r1[j_next], r2[j_next], r2[j]])
            f.material_index = 1

    top_neck_center = bm.verts.new((0.0, 0.0, height_neck))
    for j in range(num_radial):
        j_next = (j + 1) % num_radial
        f = bm.faces.new([top_neck_center, neck_rings[-1][j], neck_rings[-1][j_next]])
        f.material_index = 1

    # Front jersey patch (on front chest, y > 0)
    t_mid = 0.40 / height_body
    curve_mid = math.sin(t_mid * math.pi)
    wy_chest = (0.215 + 0.035 * curve_mid)
    patch_y = wy_chest + 0.004

    faces_before = set(bm.faces)
    patch = bmesh.ops.create_cube(bm, size=1.0)
    scale_mat = mathutils.Matrix.Diagonal((0.19, 0.015, 0.15, 1.0))
    bmesh.ops.transform(bm, matrix=scale_mat, verts=patch["verts"])
    trans_mat = mathutils.Matrix.Translation((0.0, patch_y, 0.40))
    bmesh.ops.transform(bm, matrix=trans_mat, verts=patch["verts"])
    for f in bm.faces:
        if f not in faces_before:
            f.material_index = 2

    mesh = bpy.data.meshes.new("torso_mesh")
    bm.to_mesh(mesh)
    bm.free()

    for p in mesh.polygons:
        p.use_smooth = True

    obj = bpy.data.objects.new("torso", mesh)
    obj.data.materials.append(materials["jersey"])
    obj.data.materials.append(materials["skin"])
    obj.data.materials.append(materials["team_primary"])
    assign_to_collection(obj, col)
    return obj

def create_pelvis(materials, col):
    """
    Pelvis (pelvis.glb):
    - Baseball pants pelvis / hips with cute, rounded double-lobed behind (glutes).
    - Origin at (0, 0, 0) centered at the hip line (Z = 0).
    - Fits between torso (waist at Z = +0.15m) and thighs (leg sockets at Z = -0.15m).
    - In Blender:
      +Y is front (crotch/fly)
      -Y is rear (glutes/behind)
      +Z is waistline
      -Z is leg openings (sockets at X = +/- 0.165m)
    - Materials:
      Slot 0: pants (baseball white)
      Slot 1: team_primary (belt band at waist)
    """
    bm = bmesh.new()
    num_z_rings = 13
    num_radial = 24
    height_pelvis = 0.30  # -0.15 to +0.15

    rings = []
    for i in range(num_z_rings):
        t = i / (num_z_rings - 1)  # 0 at bottom, 1 at waist
        z = -0.15 + t * height_pelvis

        waist_tuck = 1.0
        if t > 0.75:
            wt = (t - 0.75) / 0.25
            waist_tuck = 1.0 - 0.08 * (wt ** 2)

        bot_tuck = 1.0
        if t < 0.25:
            bt = (0.25 - t) / 0.25
            bot_tuck = 1.0 - 0.18 * (bt ** 2)

        wx = (0.235 + 0.025 * math.sin(t * math.pi)) * waist_tuck * bot_tuck

        ring_verts = []
        for j in range(num_radial):
            angle = j * 2 * math.pi / num_radial
            c = math.cos(angle)  # X axis
            s = math.sin(angle)  # Y axis

            if s >= 0:
                # Front half: smooth athletic curvature
                wy_front = (0.165 + 0.02 * t) * waist_tuck * bot_tuck
                p = 0.82
                x = wx * math.copysign(abs(c) ** p, c)
                y = wy_front * math.copysign(abs(s) ** p, s)
            else:
                # Rear half: plump rounded baseball player behind / glutes
                glute_bulge = math.sin(t * math.pi) ** 1.3
                wy_rear = (0.160 + 0.095 * glute_bulge) * waist_tuck * bot_tuck

                # Double cheek profile with center cleft
                cheek_profile = 1.0 - 0.22 * math.exp(-((c / 0.35) ** 2))

                p = 0.88
                x = wx * math.copysign(abs(c) ** p, c)
                y = wy_rear * s * cheek_profile

            v = bm.verts.new((x, y, z))
            ring_verts.append(v)
        rings.append(ring_verts)

    # Connect rings and assign material indices
    for i in range(num_z_rings - 1):
        r1 = rings[i]
        r2 = rings[i + 1]
        # Top rings (t > 0.75) are the belt band
        is_belt = (i >= num_z_rings - 3)
        mat_idx = 1 if is_belt else 0
        for j in range(num_radial):
            j_next = (j + 1) % num_radial
            f = bm.faces.new([r1[j], r1[j_next], r2[j_next], r2[j]])
            f.material_index = mat_idx

    # Top cap (waist)
    top_center = bm.verts.new((0.0, 0.0, 0.15))
    for j in range(num_radial):
        j_next = (j + 1) % num_radial
        f = bm.faces.new([top_center, rings[-1][j], rings[-1][j_next]])
        f.material_index = 1  # belt

    # Bottom cap (leg openings / crotch)
    bmesh.ops.triangle_fill(
        bm,
        use_beauty=True,
        use_dissolve=False,
        edges=[e for e in bm.edges if e.verts[0] in rings[0] and e.verts[1] in rings[0]]
    )
    for f in bm.faces:
        if f.material_index not in (0, 1):
            f.material_index = 0

    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.002)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new("pelvis_mesh")
    bm.to_mesh(mesh)
    bm.free()

    for p in mesh.polygons:
        p.use_smooth = True

    obj = bpy.data.objects.new("pelvis", mesh)
    obj.data.materials.append(materials["pants"])
    obj.data.materials.append(materials["team_primary"])  # belt
    assign_to_collection(obj, col)
    return obj

def create_capsule_limb(name, r_top, r_bot, mat_name, materials, col):
    """
    Creates a pill-shaped / capsule limb of exact unit height 1.0 (Z: -0.5 to +0.5).
    Ends are hemispherical rounded domes for the chunky solomon-gumball pill aesthetic.
    Center origin at (0, 0, 0).
    """
    bm = bmesh.new()
    segments = 12
    ring_segments = 6

    cyl_top_z = 0.5 - r_top
    cyl_bot_z = -0.5 + r_bot
    cyl_height = cyl_top_z - cyl_bot_z

    cyl = bmesh.ops.create_cone(
        bm,
        cap_ends=False,
        segments=segments,
        radius1=r_bot,
        radius2=r_top,
        depth=cyl_height
    )
    trans_cyl = mathutils.Matrix.Translation((0.0, 0.0, (cyl_top_z + cyl_bot_z) / 2.0))
    bmesh.ops.transform(bm, matrix=trans_cyl, verts=cyl['verts'])

    # Top hemisphere cap (apex at +0.5)
    top_sphere = bmesh.ops.create_uvsphere(
        bm,
        u_segments=segments,
        v_segments=ring_segments * 2,
        radius=r_top
    )
    top_verts = [v for v in top_sphere['verts'] if v.co.z >= -0.0001]
    bmesh.ops.delete(bm, geom=[v for v in top_sphere['verts'] if v.co.z < -0.0001], context='VERTS')
    bmesh.ops.transform(bm, matrix=mathutils.Matrix.Translation((0.0, 0.0, cyl_top_z)), verts=top_verts)

    # Bottom hemisphere cap (apex at -0.5)
    bot_sphere = bmesh.ops.create_uvsphere(
        bm,
        u_segments=segments,
        v_segments=ring_segments * 2,
        radius=r_bot
    )
    bot_verts = [v for v in bot_sphere['verts'] if v.co.z <= 0.0001]
    bmesh.ops.delete(bm, geom=[v for v in bot_sphere['verts'] if v.co.z > 0.0001], context='VERTS')
    bmesh.ops.transform(bm, matrix=mathutils.Matrix.Translation((0.0, 0.0, cyl_bot_z)), verts=bot_verts)

    # Weld seams and recalculate normals
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.005)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    mesh = bpy.data.meshes.new(f"{name}_mesh")
    bm.to_mesh(mesh)
    bm.free()

    for p in mesh.polygons:
        p.use_smooth = True

    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(materials[mat_name])
    assign_to_collection(obj, col)
    return obj

def create_hand(materials, col):
    """
    Hand (hand.glb): Smooth pill/capsule hand with hemispherical caps and angled pill thumb.
    Origin at center (0, 0, 0).
    """
    bm = bmesh.new()

    num_z = 10
    num_rad = 14
    height = 0.085
    h_half = height / 2.0
    cyl_h = 0.038
    cap_h = (height - cyl_h) / 2.0

    rings = []
    for i in range(num_z):
        v_norm = i / (num_z - 1)
        z = -h_half + v_norm * height
        if z > cyl_h / 2.0:
            rel = (z - cyl_h / 2.0) / cap_h
            scale = math.sqrt(max(0.01, 1.0 - rel**2))
        elif z < -cyl_h / 2.0:
            rel = (-cyl_h / 2.0 - z) / cap_h
            scale = math.sqrt(max(0.01, 1.0 - rel**2))
        else:
            scale = 1.0
        
        rx = 0.038 * (0.2 + 0.8 * scale)
        ry = 0.026 * (0.2 + 0.8 * scale)
        ring = [bm.verts.new((rx * math.cos(j * 2 * math.pi / num_rad), ry * math.sin(j * 2 * math.pi / num_rad), z)) for j in range(num_rad)]
        rings.append(ring)

    for i in range(num_z - 1):
        r1, r2 = rings[i], rings[i+1]
        for j in range(num_rad):
            jn = (j + 1) % num_rad
            bm.faces.new([r1[j], r1[jn], r2[jn], r2[j]])

    top_c = bm.verts.new((0, 0, h_half))
    bot_c = bm.verts.new((0, 0, -h_half))
    for j in range(num_rad):
        jn = (j + 1) % num_rad
        bm.faces.new([top_c, rings[-1][jn], rings[-1][j]])
        bm.faces.new([bot_c, rings[0][j], rings[0][jn]])

    # Angled capsule thumb
    thumb_len = 0.042
    thumb_r = 0.015
    t_cyl_h = 0.020
    t_cap_h = (thumb_len - t_cyl_h) / 2.0
    t_verts = []
    t_rings = []
    for i in range(7):
        v_norm = i / 6.0
        tz = -thumb_len / 2.0 + v_norm * thumb_len
        if tz > t_cyl_h / 2.0:
            rel = (tz - t_cyl_h / 2.0) / t_cap_h
            scale = math.sqrt(max(0.01, 1.0 - rel**2))
        elif tz < -t_cyl_h / 2.0:
            rel = (-t_cyl_h / 2.0 - tz) / t_cap_h
            scale = math.sqrt(max(0.01, 1.0 - rel**2))
        else:
            scale = 1.0
        tr = thumb_r * (0.2 + 0.8 * scale)
        ring = [bm.verts.new((tr * math.cos(j * 2 * math.pi / 10), tr * math.sin(j * 2 * math.pi / 10), tz)) for j in range(10)]
        t_rings.append(ring)
        t_verts.extend(ring)

    for i in range(6):
        r1, r2 = t_rings[i], t_rings[i+1]
        for j in range(10):
            jn = (j + 1) % 10
            bm.faces.new([r1[j], r1[jn], r2[jn], r2[j]])

    t_top = bm.verts.new((0, 0, thumb_len / 2.0))
    t_bot = bm.verts.new((0, 0, -thumb_len / 2.0))
    t_verts.extend([t_top, t_bot])
    for j in range(10):
        jn = (j + 1) % 10
        bm.faces.new([t_top, t_rings[-1][jn], t_rings[-1][j]])
        bm.faces.new([t_bot, t_rings[0][j], t_rings[0][jn]])

    rot = mathutils.Euler((math.radians(-10), math.radians(40), math.radians(15))).to_matrix().to_4x4()
    trans = mathutils.Matrix.Translation((0.036, 0.008, -0.010))
    bmesh.ops.transform(bm, matrix=trans @ rot, verts=t_verts)

    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.002)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))

    mesh = bpy.data.meshes.new("hand_mesh")
    bm.to_mesh(mesh)
    bm.free()

    for p in mesh.polygons:
        p.use_smooth = True

    obj = bpy.data.objects.new("hand", mesh)
    obj.data.materials.append(materials["skin"])
    assign_to_collection(obj, col)
    return obj

def create_glove(materials, col):
    """
    Glove (glove.glb): Chunky rounded baseball mitt with deep pocket scoop, rounded thumb pod, and webbing.
    Origin at center (0, 0, 0).
    """
    bm = bmesh.new()

    num_z = 12
    num_rad = 16
    height = 0.17
    h_half = height / 2.0
    cyl_h = 0.08
    cap_h = (height - cyl_h) / 2.0

    rings = []
    for i in range(num_z):
        v_norm = i / (num_z - 1)
        z = -h_half + v_norm * height
        if z > cyl_h / 2.0:
            rel = (z - cyl_h / 2.0) / cap_h
            scale = math.sqrt(max(0.01, 1.0 - rel**2))
        elif z < -cyl_h / 2.0:
            rel = (-cyl_h / 2.0 - z) / cap_h
            scale = math.sqrt(max(0.01, 1.0 - rel**2))
        else:
            scale = 1.0
        
        rx = 0.068 * (0.25 + 0.75 * scale)
        ry = 0.042 * (0.25 + 0.75 * scale)
        
        ring = []
        for j in range(num_rad):
            ang = j * 2.0 * math.pi / num_rad
            x = rx * math.cos(ang)
            y = ry * math.sin(ang)
            if y > 0:
                dist = math.sqrt((x / rx)**2 + ((z + 0.01) / 0.065)**2)
                if dist < 1.0:
                    y -= 0.024 * (1.0 - dist)
            v = bm.verts.new((x, y, z))
            ring.append(v)
        rings.append(ring)

    for i in range(num_z - 1):
        r1, r2 = rings[i], rings[i+1]
        for j in range(num_rad):
            jn = (j + 1) % num_rad
            bm.faces.new([r1[j], r1[jn], r2[jn], r2[j]])

    top_c = bm.verts.new((0, 0, h_half))
    bot_c = bm.verts.new((0, 0, -h_half))
    for j in range(num_rad):
        jn = (j + 1) % num_rad
        bm.faces.new([top_c, rings[-1][jn], rings[-1][j]])
        bm.faces.new([bot_c, rings[0][j], rings[0][jn]])

    # Pill thumb wing on +X securely rooted into palm body at base
    p_base = mathutils.Vector((0.045, 0.006, -0.042))
    p_tip = mathutils.Vector((0.078, 0.018, 0.040))
    v_thumb = p_tip - p_base
    thumb_len = v_thumb.length
    dir_thumb = v_thumb.normalized()
    p_center = (p_base + p_tip) / 2.0
    thumb_r = 0.026

    t_cyl_h = thumb_len * 0.45
    t_cap_h = (thumb_len - t_cyl_h) / 2.0
    t_verts = []
    t_rings = []
    for i in range(8):
        v_norm = i / 7.0
        tz = -thumb_len / 2.0 + v_norm * thumb_len
        if tz > t_cyl_h / 2.0:
            rel = (tz - t_cyl_h / 2.0) / t_cap_h
            scale = math.sqrt(max(0.01, 1.0 - rel**2))
        elif tz < -t_cyl_h / 2.0:
            rel = (-t_cyl_h / 2.0 - tz) / t_cap_h
            scale = math.sqrt(max(0.01, 1.0 - rel**2))
        else:
            scale = 1.0
        tr = thumb_r * (0.25 + 0.75 * scale)
        ring = [bm.verts.new((tr * math.cos(j * 2 * math.pi / 12), tr * math.sin(j * 2 * math.pi / 12), tz)) for j in range(12)]
        t_rings.append(ring)
        t_verts.extend(ring)

    for i in range(7):
        r1, r2 = t_rings[i], t_rings[i+1]
        for j in range(12):
            jn = (j + 1) % 12
            bm.faces.new([r1[j], r1[jn], r2[jn], r2[j]])

    t_top = bm.verts.new((0, 0, thumb_len / 2.0))
    t_bot = bm.verts.new((0, 0, -thumb_len / 2.0))
    t_verts.extend([t_top, t_bot])
    for j in range(12):
        jn = (j + 1) % 12
        bm.faces.new([t_top, t_rings[-1][jn], t_rings[-1][j]])
        bm.faces.new([t_bot, t_rings[0][j], t_rings[0][jn]])

    quat_thumb = mathutils.Vector((0, 0, 1)).rotation_difference(dir_thumb)
    mat_thumb = mathutils.Matrix.Translation(p_center) @ quat_thumb.to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=mat_thumb, verts=t_verts)

    # Webbing bridge between palm finger side and thumb shaft
    p_w1 = mathutils.Vector((0.036, 0.016, 0.045))
    p_w2 = mathutils.Vector((0.064, 0.017, 0.028))
    v_web = p_w2 - p_w1
    web_len = v_web.length
    dir_web = v_web.normalized()
    p_web_center = (p_w1 + p_w2) / 2.0
    web_r = 0.015

    web = bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=web_r, radius2=web_r, depth=web_len)
    quat_web = mathutils.Vector((0, 0, 1)).rotation_difference(dir_web)
    mat_web = mathutils.Matrix.Translation(p_web_center) @ quat_web.to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=mat_web, verts=web["verts"])

    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.003)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))

    mesh = bpy.data.meshes.new("glove_mesh")
    bm.to_mesh(mesh)
    bm.free()

    for p in mesh.polygons:
        p.use_smooth = True

    obj = bpy.data.objects.new("glove", mesh)
    obj.data.materials.append(materials["glove_leather"])
    assign_to_collection(obj, col)
    return obj

def create_shoe(materials, col):
    """
    Shoe (shoe.glb): Chunky rounded sneaker cleat with stadium-pill outsole, rounded dome upper,
    crisp toe bumper, and yellow ankle sock collar centered at (0, 0).
    Origin at bottom-center of ground contact (Z=0).
    """
    bm = bmesh.new()

    # Ankle is centered at (X=0, Y=0) to align with leg/shin connection.
    # Heel extends backwards along -Y; toe extends forwards along +Y.
    y_heel = -0.050
    y_toe = 0.095
    r_heel = 0.070
    r_toe = 0.082
    n_pts_half = 12

    sole_contour = []
    for i in range(n_pts_half):
        alpha = i * math.pi / n_pts_half
        sole_contour.append((r_toe * math.cos(alpha), y_toe + r_toe * math.sin(alpha)))
    for i in range(n_pts_half):
        alpha = math.pi + i * math.pi / n_pts_half
        sole_contour.append((r_heel * math.cos(alpha), y_heel + r_heel * math.sin(alpha)))
    
    num_pts = len(sole_contour)

    # 1. Outsole (Black)
    sole_z = [0.000, 0.006, 0.020, 0.026]
    sole_s = [0.93, 1.00, 1.00, 0.95]
    sole_rings = []
    for zi, z in enumerate(sole_z):
        s = sole_s[zi]
        ring = [bm.verts.new((px * s, py * s, z)) for px, py in sole_contour]
        sole_rings.append(ring)

    for i in range(len(sole_z) - 1):
        r1, r2 = sole_rings[i], sole_rings[i+1]
        for j in range(num_pts):
            jn = (j + 1) % num_pts
            f = bm.faces.new([r1[j], r1[jn], r2[jn], r2[j]])
            f.material_index = 1 # Black sole

    bot_c = bm.verts.new((0, (y_heel + y_toe) / 2.0, 0))
    for j in range(num_pts):
        jn = (j + 1) % num_pts
        f = bm.faces.new([bot_c, sole_rings[0][jn], sole_rings[0][j]])
        f.material_index = 1

    # 2. Upper body
    num_u = 10
    upper_rings = []
    for i in range(num_u):
        t = i / (num_u - 1)
        z = 0.026 + t * 0.058
        
        toe_recede = (1.0 - math.cos(t * math.pi * 0.5)) * (r_toe * 1.08)
        heel_inset = t * 0.008
        w_scale = math.sqrt(max(0.04, 1.0 - 0.50 * (t ** 1.8)))
        
        ring = []
        for j, (px, py) in enumerate(sole_contour):
            if py >= 0:
                y_norm = py / (y_toe + r_toe)
                cur_y = py - toe_recede * (y_norm ** 0.9)
                cur_x = px * (0.95 * w_scale)
                cur_z = z - 0.020 * (y_norm ** 1.8) * math.sin(t * math.pi * 0.5)
            else:
                cur_y = py + heel_inset
                cur_x = px * (0.95 - 0.04 * t)
                cur_z = z - 0.005 * (t ** 2.0)
            ring.append(bm.verts.new((cur_x, cur_y, cur_z)))
        upper_rings.append(ring)

    for j in range(num_pts):
        jn = (j + 1) % num_pts
        f = bm.faces.new([sole_rings[-1][j], sole_rings[-1][jn], upper_rings[0][jn], upper_rings[0][j]])
        f.material_index = 1

    for i in range(num_u - 1):
        r1, r2 = upper_rings[i], upper_rings[i+1]
        for j in range(num_pts):
            jn = (j + 1) % num_pts
            f = bm.faces.new([r1[j], r1[jn], r2[jn], r2[j]])
            if (2 <= j <= 9) and i < 3:
                f.material_index = 1 # Black bumper
            else:
                f.material_index = 0 # White upper

    top_c = bm.verts.new((0, (y_heel + y_toe * 0.3) / 2.0, 0.082))
    for j in range(num_pts):
        jn = (j + 1) % num_pts
        f = bm.faces.new([top_c, upper_rings[-1][j], upper_rings[-1][jn]])
        f.material_index = 0

    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.002)

    # 3. Yellow sock collar at ankle opening (centered at X=0, Y=0)
    sock = bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=24,
        radius1=0.082,
        radius2=0.080,
        depth=0.038
    )
    bmesh.ops.transform(bm, matrix=mathutils.Matrix.Translation((0.0, 0.0, 0.100)), verts=sock["verts"])
    for v in sock["verts"]:
        for f in v.link_faces:
            f.material_index = 2

    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))

    mesh = bpy.data.meshes.new("shoe_mesh")
    bm.to_mesh(mesh)
    bm.free()

    for p in mesh.polygons:
        p.use_smooth = True

    obj = bpy.data.objects.new("shoe", mesh)
    obj.data.materials.append(materials["shoe_upper"])
    obj.data.materials.append(materials["shoe_sole"])
    obj.data.materials.append(materials["shoe_accent"])
    assign_to_collection(obj, col)
    return obj

def create_bat(materials, col):
    """
    Bat (bat.glb): Authentic baseball bat profile with flared knob, slender handle,
    gradual taper, and cylindrical barrel with domed cap.
    Origin at handle grip (0, 0, 0).
    Oriented along local +Y (maps to glTF -Z barrel direction).
    """
    bm = bmesh.new()
    num_radial = 16
    profile = [
        (-0.024, 0.000, True),
        (-0.022, 0.024, True),
        (-0.012, 0.028, True),
        (-0.004, 0.024, True),
        (0.000,  0.016, False),
        (0.120,  0.016, False),
        (0.250,  0.016, False),
        (0.330,  0.024, False),
        (0.410,  0.035, False),
        (0.480,  0.046, False),
        (0.700,  0.046, False),
        (0.900,  0.046, False),
        (0.930,  0.034, False),
        (0.940,  0.000, False),
    ]
    rings = []
    for y, r, is_knob in profile:
        if r == 0.0:
            v = bm.verts.new((0.0, y, 0.0))
            rings.append([v])
        else:
            ring = []
            for j in range(num_radial):
                angle = j * 2 * math.pi / num_radial
                x = r * math.cos(angle)
                z = r * math.sin(angle)
                ring.append(bm.verts.new((x, y, z)))
            rings.append(ring)
    for i in range(len(profile) - 1):
        r1, r2 = rings[i], rings[i + 1]
        is_knob_face = profile[i][2] and profile[i + 1][2]
        mat_idx = 1 if is_knob_face else 0
        if len(r1) == 1:
            center = r1[0]
            for j in range(num_radial):
                jn = (j + 1) % num_radial
                f = bm.faces.new([center, r2[jn], r2[j]])
                f.material_index = mat_idx
        elif len(r2) == 1:
            center = r2[0]
            for j in range(num_radial):
                jn = (j + 1) % num_radial
                f = bm.faces.new([center, r1[j], r1[jn]])
                f.material_index = mat_idx
        else:
            for j in range(num_radial):
                jn = (j + 1) % num_radial
                f = bm.faces.new([r1[j], r1[jn], r2[jn], r2[j]])
                f.material_index = mat_idx

    mesh = bpy.data.meshes.new("bat_mesh")
    bm.to_mesh(mesh)
    bm.free()

    for p in mesh.polygons:
        p.use_smooth = True

    obj = bpy.data.objects.new("bat", mesh)
    obj.data.materials.append(materials["bat_wood"])
    obj.data.materials.append(materials["bat_knob"])

    assign_to_collection(obj, col)
    return obj

# -----------------------------------------------------------------------------
# GLB Export
# -----------------------------------------------------------------------------
def export_part_glb(obj, filename):
    filepath = os.path.join(EXPORT_DIR, filename)

    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    original_loc = obj.location.copy()
    obj.location = (0.0, 0.0, 0.0)

    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials='EXPORT',
        export_animations=False,
        export_cameras=False,
        export_lights=False
    )

    obj.location = original_loc
    print(f"  ✓ Exported: {filename} ({os.path.getsize(filepath):,} bytes)")

def refine_helmet_ear_guard(user_helmet):
    """
    Refines the helmet ear flap / ear guard geometry:
    - Removes the unnatural jut-out extending rearward behind the ear to Y = -0.122
    - Completes the helmet dome quad [v52, v51, v57, v_rim_rear] so the dome and rim
      curve smoothly and continuously around the back of the head
    - Positions the rear edge of the ear guard cleanly hugging the ear (Y ≈ -0.048 to -0.042)
    """
    if not user_helmet or not user_helmet.data:
        return
    
    bm = bmesh.new()
    bm.from_mesh(user_helmet.data)
    bm.faces.ensure_lookup_table()
    bm.verts.ensure_lookup_table()

    def find_vert(bm, target, tol=0.015):
        for v in bm.verts:
            if (v.co - mathutils.Vector(target)).length < tol:
                return v
        return None

    v83 = find_vert(bm, (-0.2049, -0.1183, 0.1661))
    v84 = find_vert(bm, (-0.2122, -0.0966, 0.1027))

    if not v83 or not v84:
        # Already refined or different base geometry
        bm.free()
        return

    v58 = find_vert(bm, (-0.2472, 0.0000, 0.2535))
    v57 = find_vert(bm, (-0.2419, 0.0000, 0.3170))
    v51 = find_vert(bm, (-0.2049, -0.1183, 0.3170))
    v52 = find_vert(bm, (-0.2122, -0.1225, 0.2535))
    v85 = find_vert(bm, (-0.2419, 0.0000, 0.1661))
    v86 = find_vert(bm, (-0.2472, 0.0000, 0.1027))

    if not all([v58, v57, v51, v52, v85, v86]):
        bm.free()
        return

    faces_to_remove = list(set(v83.link_faces) | set(v84.link_faces))
    bmesh.ops.delete(bm, geom=faces_to_remove, context='FACES_ONLY')

    bm.faces.ensure_lookup_table()
    bm.verts.ensure_lookup_table()

    # Reposition v83 (mid rear) cleanly right behind the ear
    v83.co = mathutils.Vector((-0.2420, -0.0480, 0.1661))

    # Replace sharp bottom-rear corner v84 with smooth filleted corner arc
    bmesh.ops.delete(bm, geom=[v84], context='VERTS')
    bm.verts.ensure_lookup_table()

    v84_up = bm.verts.new((-0.2440, -0.0460, 0.1250))
    v84_mid = bm.verts.new((-0.2460, -0.0350, 0.1080))
    v84_fwd = bm.verts.new((-0.2470, -0.0150, 0.1027))

    # Create new dome rim vertex right behind ear at Y = -0.048
    v_rim_rear = bm.verts.new((-0.2431, -0.0480, 0.2535))

    # 1. Clean dome quad completing the rear dome rim smoothly
    f_dome = bm.faces.new([v52, v51, v57, v_rim_rear])
    f_dome.material_index = 0

    # 2. Ear flap outer faces with rounded bottom-rear corner
    f_outer_up = bm.faces.new([v57, v_rim_rear, v83, v85])
    f_outer_up.material_index = 0

    f_out1 = bm.faces.new([v85, v83, v84_up, v84_mid])
    f_out1.material_index = 0

    f_out2 = bm.faces.new([v85, v84_mid, v84_fwd, v86])
    f_out2.material_index = 0

    # 3. Ear flap inner face with rounded corner
    f_inner = bm.faces.new([v_rim_rear, v84_mid, v86, v58])
    f_inner.material_index = 0

    # 4. Rear end-cap with rounded corner
    f_cap1 = bm.faces.new([v_rim_rear, v84_up, v83])
    f_cap1.material_index = 0
    f_cap2 = bm.faces.new([v_rim_rear, v84_mid, v84_up])
    f_cap2.material_index = 0

    # 5. Round the front corners of the jaw guard (top-front and bottom-front)
    v93 = find_vert(bm, (-0.0560, 0.2860, 0.1859))
    v92 = find_vert(bm, (-0.0599, 0.2966, 0.0710))
    v91 = find_vert(bm, (-0.1546, 0.2370, 0.1991))
    v90 = find_vert(bm, (-0.1584, 0.2477, 0.0842))

    if v93 and v92 and v91 and v90:
        face_89 = None
        for f in bm.faces:
            if set(f.verts) == {v91, v93, v92, v90}:
                face_89 = f
                break
        if face_89:
            bmesh.ops.delete(bm, geom=[face_89], context="FACES_ONLY")
            bmesh.ops.delete(bm, geom=[v93, v92], context="VERTS")
            bm.verts.ensure_lookup_table()

            v_top_mid = bm.verts.new((-0.0950, 0.2660, 0.1930))
            v_nose_top = bm.verts.new((-0.0650, 0.2900, 0.1650))
            v_nose_mid = bm.verts.new((-0.0560, 0.3000, 0.1280))
            v_nose_bot = bm.verts.new((-0.0650, 0.2980, 0.0920))
            v_bot_mid = bm.verts.new((-0.0990, 0.2770, 0.0760))
            v_center = bm.verts.new((-0.1050, 0.2700, 0.1350))

            f_jg1 = bm.faces.new([v91, v_top_mid, v_center, v90])
            f_jg1.material_index = 0

            f_jg2 = bm.faces.new([v_top_mid, v_nose_top, v_nose_mid, v_center])
            f_jg2.material_index = 0

            f_jg3 = bm.faces.new([v_center, v_nose_mid, v_nose_bot, v_bot_mid])
            f_jg3.material_index = 0

            f_jg4 = bm.faces.new([v90, v_center, v_bot_mid])
            f_jg4.material_index = 0

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    bm.to_mesh(user_helmet.data)
    bm.free()

    for p in user_helmet.data.polygons:
        p.use_smooth = True
    print("  ✓ Helmet ear guard & jaw guard refined: rounded corners and smooth dome rim")

# -----------------------------------------------------------------------------
# Main Execution
# -----------------------------------------------------------------------------
def main():
    print("==========================================================")
    print("  Upgraded Solomon-Gumball Body Parts Generator")
    print("==========================================================")

    # 1. First, retrieve user's custom head, eyes, and helmet from backup tmp file
    custom_objs = {}
    source_blend = BACKUP_TMP_PATH if os.path.exists(BACKUP_TMP_PATH) else BLEND_OUTPUT_PATH
    
    print(f"Loading custom models from {os.path.basename(source_blend)}...")
    with bpy.data.libraries.load(source_blend) as (data_from, data_to):
        for ob_name in data_from.objects:
            if ob_name in ["head", "eye", "helmet", "head.001_custom", "eye_custom", "helmet.001_custom"]:
                data_to.objects.append(ob_name)

    # Link temporarily to scene to access data
    loaded_map = {}
    for ob in data_to.objects:
        if ob is not None:
            bpy.context.scene.collection.objects.link(ob)
            loaded_map[ob.name] = ob

    # Identify user custom pieces
    user_head = loaded_map.get("head") or loaded_map.get("head.001_custom") or loaded_map.get("head.001")
    user_eyes = loaded_map.get("eye") or loaded_map.get("eye_custom") or loaded_map.get("eye.001")
    user_helmet = loaded_map.get("helmet") or loaded_map.get("helmet.001_custom") or loaded_map.get("helmet.001")

    print(f"  Found custom parts -> Head: {user_head.name if user_head else None}, Eyes: {user_eyes.name if user_eyes else None}, Helmet: {user_helmet.name if user_helmet else None}")

    # Set up collections and materials
    materials = setup_materials()
    col_map = setup_scene()

    # Clean other startup objects
    for obj in list(bpy.context.scene.objects):
        if obj not in [user_head, user_eyes, user_helmet]:
            bpy.data.objects.remove(obj, do_unlink=True)

    # 1a. Make the eyes non-reflective (roughness = 1.0, specular = 0.0)
    for mat_name in ["eye_dark.001", "eye_dark"]:
        if mat_name in bpy.data.materials:
            mat = bpy.data.materials[mat_name]
            if mat.node_tree:
                bsdf = mat.node_tree.nodes.get("Principled BSDF")
                if bsdf:
                    if "Roughness" in bsdf.inputs:
                        bsdf.inputs["Roughness"].default_value = 1.0
                    for spec_name in ["Specular IOR Level", "Specular"]:
                        if spec_name in bsdf.inputs:
                            bsdf.inputs[spec_name].default_value = 0.0
                    if "Metallic" in bsdf.inputs:
                        bsdf.inputs["Metallic"].default_value = 0.0
    print("  ✓ Eyes updated: non-reflective (roughness = 1.0, specular = 0.0)")

    # 1b. Ensure helmet is one unified piece with matching finish across dome, flap & guard
    if user_helmet and user_helmet.data:
        refine_helmet_ear_guard(user_helmet)
        for p in user_helmet.data.polygons:
            p.material_index = 0
            p.use_smooth = True
        while len(user_helmet.data.materials) > 1:
            user_helmet.data.materials.pop(index=len(user_helmet.data.materials) - 1)
        if "helmet_shell" in bpy.data.materials:
            hs = bpy.data.materials["helmet_shell"]
            if hs.node_tree:
                bsdf = hs.node_tree.nodes.get("Principled BSDF")
                if bsdf:
                    bsdf.inputs["Base Color"].default_value = (0.010, 0.037, 0.109, 1.0)
                    bsdf.inputs["Roughness"].default_value = 0.70
                    if "Specular IOR Level" in bsdf.inputs:
                        bsdf.inputs["Specular IOR Level"].default_value = 0.5
                    if "Metallic" in bsdf.inputs:
                        bsdf.inputs["Metallic"].default_value = 0.0
        print("  ✓ Helmet unified: single cohesive piece and single uniform material (helmet_shell, roughness = 0.70)")

    parts = {}

    print("\n[1/3] Building Custom Combined Head and Pill Limbs...")

    # Combine custom head + custom eyes + custom helmet into the default 'head'
    if user_head and user_eyes and user_helmet:
        parts["head"] = combine_meshes("head", [user_head, user_eyes, user_helmet], col_map["Head_Parts"])
        # Also create a bare head version (head + eyes only) for cap compatibility
        parts["head_bare"] = combine_meshes("head_bare", [user_head, user_eyes], col_map["Head_Parts"])
        # And separate helmet
        parts["helmet"] = combine_meshes("helmet", [user_helmet], col_map["Head_Parts"])
        # Create cap derived directly from custom helmet (thinner, no flap/guard, matte fabric)
        parts["cap"] = create_cap(materials, col_map["Head_Parts"], user_helmet=user_helmet)
        print("  ✓ Created default combined head (Head + Eyes + Helmet)")
        print("  ✓ Created separate helmet, cap, and head_bare meshes")
    else:
        parts["cap"] = create_cap(materials, col_map["Head_Parts"])
        print("  Warning: Custom head pieces not found, using fallback.")

    # Remove temporary raw user objects now that they are combined
    for raw_ob in [user_head, user_eyes, user_helmet]:
        if raw_ob:
            bpy.data.objects.remove(raw_ob, do_unlink=True)

    # Ensure clean object naming now that raw objects are freed
    if "head" in parts:
        parts["head"].name = "head"
        if parts["head"].data:
            parts["head"].data.name = "head_mesh"
    if "helmet" in parts:
        parts["helmet"].name = "helmet"
        if parts["helmet"].data:
            parts["helmet"].data.name = "helmet_mesh"

    # Remove library data blocks so we can save to BLEND_OUTPUT_PATH without conflict
    for lib in list(bpy.data.libraries):
        bpy.data.libraries.remove(lib)

    # Torso (athletic rectangular build with curved sides and cylindrical neck)
    parts["torso"] = create_torso(materials, col_map["Torso"])

    # Limbs with pill-shaped hemispherical ends (capsules)
    print("  ✓ Generating pill-shaped limbs (upper_arm, forearm, thigh, shin)...")
    parts["upper_arm"] = create_capsule_limb("upper_arm", 0.065, 0.065, "skin", materials, col_map["Arms"])
    parts["forearm"] = create_capsule_limb("forearm", 0.055, 0.055, "skin", materials, col_map["Arms"])
    parts["thigh"] = create_capsule_limb("thigh", 0.108, 0.094, "pants", materials, col_map["Legs"])
    parts["shin"] = create_capsule_limb("shin", 0.088, 0.078, "pants", materials, col_map["Legs"])

    # Pelvis / hips / behind
    parts["pelvis"] = create_pelvis(materials, col_map["Legs"])

    # Hands, accessories, shoes
    parts["hand"] = create_hand(materials, col_map["Arms"])
    parts["glove"] = create_glove(materials, col_map["Accessories"])
    parts["shoe"] = create_shoe(materials, col_map["Legs"])
    parts["bat"] = create_bat(materials, col_map["Accessories"])

    # Apply Shade Auto Smooth (35°) to helmet, head, cap, and head_bare to keep dome 100% smooth while keeping flap/guard crisp
    for p_name in ["helmet", "head", "cap", "head_bare"]:
        if p_name in parts:
            apply_auto_smooth(parts[p_name], angle_degrees=35.0)
    print("  ✓ Applied Shade Auto Smooth (35°) to helmet, head, cap, and head_bare")

    print(f"  ✓ All {len(parts)} meshes ready in scene.")

    # 2. Export GLBs
    print("\n[2/3] Exporting GLB Files to frontend/public/models/parts/...")
    export_map = {
        "head": "head.glb",
        "head_bare": "head_bare.glb",
        "helmet": "helmet.glb",
        "cap": "cap.glb",
        "torso": "torso.glb",
        "pelvis": "pelvis.glb",
        "upper_arm": "upper_arm.glb",
        "forearm": "forearm.glb",
        "thigh": "thigh.glb",
        "shin": "shin.glb",
        "hand": "hand.glb",
        "glove": "glove.glb",
        "shoe": "shoe.glb",
        "bat": "bat.glb",
    }
    for part_name, filename in export_map.items():
        if part_name in parts:
            export_part_glb(parts[part_name], filename)

    # 3. Viewport Layout & Save
    print(f"\n[3/3] Arranging Viewport & Saving {BLEND_OUTPUT_PATH}...")
    layout_offsets = {
        "head": (0.0, 0.0, 1.2),
        "head_bare": (2.0, 0.0, 1.2),
        "cap": (0.8, 0.0, 1.2),
        "helmet": (-0.8, 0.0, 1.2),
        "torso": (0.0, 0.0, 0.5),
        "pelvis": (0.0, 0.0, 0.0),
        "upper_arm": (-0.6, 0.0, 0.5),
        "forearm": (-1.0, 0.0, 0.5),
        "hand": (-1.4, 0.0, 0.5),
        "thigh": (0.6, 0.0, 0.5),
        "shin": (1.0, 0.0, 0.5),
        "shoe": (1.4, 0.0, 0.0),
        "glove": (-1.4, 0.0, 0.0),
        "bat": (0.0, 1.0, 0.0),
    }
    for name, offset in layout_offsets.items():
        if name in parts:
            parts[name].location = offset

    # Ensure all objects are deselected
    bpy.ops.object.select_all(action='DESELECT')
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUTPUT_PATH)
    print("  ✓ Saved baseball_bodyparts.blend")

    print("\n==========================================================")
    print("  Done! Updated pill-shaped limbs and custom head exported.")
    print("==========================================================")

if __name__ == "__main__":
    main()
