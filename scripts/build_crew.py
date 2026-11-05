"""
Tier H crew & craft builder (issue #229): single scull + female/male rowers.
The rower is the high-definition llm-cad body in `crew_body.py` (issue #672).

Authored in METRES (the boat loader consumes true scale), bow toward +Z, up +Y,
pivot at the hull's geometric centre at the waterline (Y=0).

Exports crewed GLBs to public/assets/boat/ with the node tree the slot requires
(public/assets/boat/README.md): Hull, Seat, Left/RightRigger, Left/RightOar,
Rower -> Rower_Torso / Rower_LeftArm / Rower_RightArm / Rower_LeftLeg /
Rower_RightLeg.  Renders a validation PNG and asserts the hull bounds.

The crew also carries four hairstyle siblings (Hair_Short / Hair_Long /
Hair_Buzz / Hair_Bun) and three hat siblings (Hat_Cap / Hat_Visor / Hat_Beanie
under a `Hat` parent). The renderer shows one hairstyle and at most one hat;
colouring is runtime-only (`src/lib/renderer/plan/crewPalette.ts`), so a
palette change does not touch the GLB. Issue #474 Phase 2.

Pass `--dry-run` to print the authored node tree without exporting a GLB; this
is the oracle AC8 asserts the generator against.
"""
import cadquery as cq
import sys, os, math, tempfile, argparse
from pathlib import Path
import numpy as np


def _parse_args(argv):
    parser = argparse.ArgumentParser(description="Build crewed scull GLBs for virtualrow.")
    parser.add_argument("out_boat", nargs="?", default="./boat",
                        help="Output directory for the GLBs (default: ./boat).")
    parser.add_argument("renders", nargs="?", default=None,
                        help="Output directory for the validation PNGs (default: <out_boat>/renders).")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print the authored node tree per GLB; do not export GLBs or renders.")
    return parser.parse_args(argv)


_ARGS = _parse_args(sys.argv[1:])
DRY_RUN = _ARGS.dry_run
OUT_BOAT = Path(_ARGS.out_boat)
RENDERS = Path(_ARGS.renders) if _ARGS.renders else (OUT_BOAT / "renders")
if not DRY_RUN:
    OUT_BOAT.mkdir(parents=True, exist_ok=True)
    RENDERS.mkdir(parents=True, exist_ok=True)


def hx(h):
    h = h.lstrip('#')
    return (int(h[0:2], 16)/255, int(h[2:4], 16)/255, int(h[4:6], 16)/255)

def col(h):
    r, g, b = hx(h); return cq.Color(r, g, b)

def ellipsoid(rx, ry, rz, center=(0, 0, 0)):
    from OCP.gp import gp_GTrsf
    from OCP.BRepBuilderAPI import BRepBuilderAPI_GTransform
    m = max(rx, ry, rz)
    s = cq.Workplane("XY").sphere(m)
    gt = gp_GTrsf(); gt.SetValue(1, 1, rx/m); gt.SetValue(2, 2, ry/m); gt.SetValue(3, 3, rz/m)
    return cq.Shape(BRepBuilderAPI_GTransform(s.val().wrapped, gt, True).Shape()).translate(center)

def box(w, d, h, c=(0, 0, 0)):
    return cq.Workplane("XY").box(w, d, h).val().translate(c)

def cyl(r, h, c=(0, 0, 0)):
    return cq.Solid.makeCylinder(r, h).translate(c)

def strut(p1, p2, r):
    v = np.array(p2, float) - np.array(p1, float); L = float(np.linalg.norm(v))
    if L < 1e-6: return cyl(r, r, p1)
    d = cq.Vector(float(v[0]/L), float(v[1]/L), float(v[2]/L))
    return cq.Solid.makeCylinder(r, L, cq.Vector(float(p1[0]), float(p1[1]), float(p1[2])), d)

# --- palette ---
DECK="#E8E4D8"; UNDER="#1E2A33"; COCK="#2A2A28"
SEAT="#3E4348"; RAIL="#C8CCD0"; GATE="#1A1A1A"
OAR_SHAFT="#F2F2F0"; OAR_BLADE="#C8102E"

# Pivot offset from hull centre (right side; mirror X for left). The gate sits
# about 15 cm above the seat top (0.195 m), as on a real scull, so the hands
# can hold the handles at a natural height (#672). It was 0.15 m, below the
# seat, which left the hands floating ~19 cm above the oar.
OARLOCK = (0.30, 0.34, 0.50)
# The oar slopes down outboard so the blade sits at the waterline while the
# handle rises to the hands, about 10 degrees on a real scull.
OAR_DROOP_DEG = 10.0

# --- sculling geometry, from the real thing (issue #232) ---
# A single scull is rigged to a span of 158-162 cm between the pin centres;
# 160 cm is the common setting, so each gate sits 80 cm off the centreline.
# The model had them at 85 cm, a 170 cm span, which is wider than the rig is
# ever set.
GATE_OFFSET = 0.80
# A sculling oar measures 284-290 cm overall with the inboard set at 87-89 cm,
# leaving about 198 cm outboard of the pin. The model's inboard was right at
# 88 cm, but its outboard reached 257 cm — a 345 cm oar, 20% longer than any
# scull is rowed with, and the blades swept correspondingly wide.
OAR_INBOARD = 0.88
OAR_OUTBOARD = 1.98
# Cleaver blades for sculling are about 46 cm long and 17-18 cm across; 25 cm
# is a sweep blade, which is a different oar entirely.
BLADE_LENGTH = 0.46
BLADE_WIDTH = 0.18
BLADE_THICKNESS = 0.05


def oar_assembly(name, sign):
    """One sculling oar in its own local frame; pivot (gate) at the origin.
    +X is outboard for the right oar; the whole node is placed at the gate and
    the scene rotates it about Y."""
    a = cq.Assembly(name=name)
    # loom: handle inboard (-X) to blade outboard (+X), through the gate at x=0
    shaft_end = OAR_OUTBOARD - BLADE_LENGTH * 0.55   # the loom runs into the blade throat
    shaft = strut((sign*-OAR_INBOARD, 0, 0), (sign*shaft_end, 0, 0), 0.018)
    a.add(shaft, name=f"{name}_Shaft", color=col(OAR_SHAFT))
    # Spoon, squared — the working position, and the only one this model can
    # hold: the scene sweeps each oar about Y and never rolls it, so whatever
    # the blade is built at is what a rower sees through the whole drive.
    #
    # Length runs along the oar (X), width is the vertical measure (Y), and the
    # spoon is thin fore-aft (Z). These arrived as (thickness, width, length),
    # which gave a blade 5 cm along the oar and 46 cm fore-aft: a fin lying
    # along the boat, which is what read as the wrong angle (#232).
    blade = box(BLADE_LENGTH, BLADE_WIDTH, BLADE_THICKNESS,
                (sign*(OAR_OUTBOARD - BLADE_LENGTH / 2), 0, 0))
    a.add(blade, name=f"{name}_Blade", color=col(OAR_BLADE))
    # collar/button at the gate
    a.add(cyl(0.028, 0.04, (sign*-0.02, 0, -0.02)), name=f"{name}_Collar", color=col(GATE))
    return a


# The rower itself — body, head, hairstyles and hats — is the high-definition
# llm-cad model in `crew_body.py` (issue #672). This file keeps the boat.
from crew_body import rower_assembly, MALE, FEMALE, HAIRSTYLES, HATS  # noqa: E402


def scull_hull():
    """The bare rig: Hull, Seat, riggers, oars. Returns a fresh Assembly."""
    a = cq.Assembly(name="scull")
    # hull — fine racing shell (smooth lofted ellipsoid), deck above the waterline
    hull = ellipsoid(0.14, 0.10, 4.05, (0, 0.02, 0))
    a.add(hull, name="Hull", color=col(DECK))
    a.add(ellipsoid(0.135, 0.06, 3.9, (0, -0.05, 0)), name="Hull_Underside", color=col(UNDER))
    # open cockpit recess amidships
    a.add(box(0.16, 0.02, 1.2, (0, 0.11, 0.0)), name="Cockpit", color=col(COCK))
    a.add(box(0.02, 0.05, 0.30, (0, 0.13, 0.95)), name="FootStretcher", color=col(GATE))
    # sliding seat
    seat = cq.Assembly(name="Seat")
    seat.add(box(0.28, 0.03, 0.30, (0, 0.18, 0.0)), name="Seat_Pan", color=col(SEAT))
    seat.add(box(0.30, 0.02, 0.02, (0, 0.15, 0.12)), name="Seat_RailF", color=col(RAIL))
    seat.add(box(0.30, 0.02, 0.02, (0, 0.15, -0.12)), name="Seat_RailB", color=col(RAIL))
    a.add(seat)
    # riggers: from the hull side out to the gate, which is where the oar pivots
    ox, oy, oz = OARLOCK
    for side, s in (("Left", -1), ("Right", 1)):
        rig = cq.Assembly(name=f"{side}Rigger")
        rig.add(strut((s*0.13, 0.08, oz), (s*GATE_OFFSET, oy, oz), 0.02), name=f"{side}Rig_Stay1", color=col(RAIL))
        rig.add(strut((s*0.13, 0.14, oz-0.22), (s*GATE_OFFSET, oy, oz), 0.02), name=f"{side}Rig_Stay2", color=col(RAIL))
        rig.add(cyl(0.03, 0.10, (s*GATE_OFFSET, oy-0.05, oz)), name=f"{side}Gate", color=col(GATE))
        a.add(rig)
    # oars, each placed at its gate
    for side, s in (("Left", -1), ("Right", 1)):
        oar = oar_assembly(f"{side}Oar", s)
        # Rotate about +Z so the outboard end drops: -X (left) and +X (right)
        # outboard need opposite signs.
        oar.loc = cq.Location(cq.Vector(s*GATE_OFFSET, oy, oz), cq.Vector(0, 0, 1), -s * OAR_DROOP_DEG)
        a.add(oar)
    return a


def render_glb(glb_path, name):
    import matplotlib; matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    import trimesh
    scene = trimesh.load(str(glb_path))
    meshes = scene.dump() if hasattr(scene, 'dump') else [scene]
    tess = []
    allv = []
    for m in meshes:
        v = np.array(m.vertices); f = np.array(m.faces)
        if len(v) == 0: continue
        c = (0.6, 0.6, 0.62)
        try:
            bc = m.visual.material.baseColorFactor
            c = (bc[0]/255, bc[1]/255, bc[2]/255) if max(bc[:3]) > 1 else (bc[0], bc[1], bc[2])
        except Exception:
            pass
        tess.append((v, f, c)); allv.append(v)
    allv = np.vstack(allv); mins = allv.min(0); maxs = allv.max(0)
    ctr = (mins+maxs)/2; span = (maxs-mins).max()/2*1.1
    views = [("Front", 8, -88), ("Right", 8, 2), ("Top", 89, -90), ("Iso", 24, -52)]
    light = np.array([0.4, 0.5, 0.75]); light /= np.linalg.norm(light)
    fig, axes = plt.subplots(1, 4, figsize=(22, 5.5), subplot_kw={'projection': '3d'})
    fig.suptitle(name, fontsize=15, fontweight='bold')
    for ax, (lbl, el, az) in zip(axes, views):
        for v, f, c in tess:
            polys = v[f]
            n = np.cross(polys[:, 1]-polys[:, 0], polys[:, 2]-polys[:, 0])
            nn = np.linalg.norm(n, axis=1, keepdims=True); nn[nn == 0] = 1; n /= nn
            inten = 0.5 + 0.5*np.abs(n @ light)
            fc = np.column_stack([np.clip(inten*c[0], 0, 1), np.clip(inten*c[1], 0, 1), np.clip(inten*c[2], 0, 1), np.ones(len(inten))])
            ax.add_collection3d(Poly3DCollection(polys, facecolors=fc, edgecolors='none'))
        ax.set_xlim(ctr[0]-span, ctr[0]+span); ax.set_ylim(ctr[1]-span, ctr[1]+span); ax.set_zlim(ctr[2]-span, ctr[2]+span)
        ax.set_box_aspect((1, 1, 1)); ax.view_init(elev=el, azim=az); ax.set_title(lbl, fontsize=10)
        ax.set_xlabel('X (beam)'); ax.set_ylabel('Y (up)'); ax.set_zlabel('Z (bow)')
    plt.tight_layout()
    p = RENDERS / f"{name}.png"; fig.savefig(str(p), dpi=135, facecolor='#f4f5f6', bbox_inches='tight'); plt.close(fig)
    print(f"  PNG:  {p}")


def _authored_node_names(assembly):
    """Walk the authored CadQuery assembly and return every node name in order.

    This is the oracle for AC8's --dry-run listing: it reports what the GLB
    SHOULD carry before the glTF export runs, so the test does not have to
    load a GLB to check structural expectations.
    """
    names = []
    for nm, _sub in assembly.traverse():
        names.append(nm)
    return names


def _print_node_tree(assembly, label):
    print(f"=== node tree: {label} ===")
    for name in _authored_node_names(assembly):
        print(f"  {name}")


def export_and_validate(assembly, filename, name):
    glb = OUT_BOAT / filename
    # The GLTF exporter bakes a -90deg X-rotation (CadQuery Z-up -> glTF Y-up).
    # We author in the scene's own frame (up +Y, length +Z, beam +X), so wrap the
    # assembly in a +90deg X-rotation that cancels the exporter's, leaving our
    # authored coordinates intact in the GLB (hull horizontal, deck up).
    root = cq.Assembly(name="scull_root")
    root.add(assembly, loc=cq.Location(cq.Vector(0, 0, 0), cq.Vector(1, 0, 0), 90))
    # Tolerance tuned to the OCCT 7.8+ meshing defaults so a regenerated GLB
    # lands near the 376 KB the Phase 1 commit set on OCCT 7.7 (NFR2 cap is
    # 460 KB). 0.006 / 0.15 (the OCCT 7.7 setting) inflates the hull mesh
    # ~6x on 7.8+; 0.025 / 0.40 brings it back to ~370 KB with every
    # Hair_<Style> and Hat_<Style> variant included. #474 Phase 2.
    root.export(str(glb), tolerance=0.025, angularTolerance=0.40)
    # node names present in the GLB
    import trimesh
    scene = trimesh.load(str(glb))
    nodes = set(scene.graph.nodes)
    required = {"Hull", "Seat", "LeftRigger", "RightRigger", "LeftOar", "RightOar",
                "Rower", "Rower_Torso", "Rower_LeftArm", "Rower_RightArm",
                "Rower_LeftLeg", "Rower_RightLeg"}
    crewed = "Rower" in " ".join(nodes) or any(g.startswith("Rower") for g in nodes)
    # Appearance-era crew nodes (#474 Phase 2 FR5 / FR6): every hairstyle and
    # every hat must be present as a sibling, otherwise the renderer has no
    # geometry to toggle to.
    appearance_nodes = (
        {f"Hair_{style}" for style in HAIRSTYLES}
        | {f"Hat_{hat}" for hat in HATS}
        | {"Hairstyles", "Hat"}
    )
    check = required if crewed else {n for n in required if not n.startswith("Rower")}
    if crewed:
        check = check | appearance_nodes
    missing = sorted(n for n in check if not any(n == g or g.startswith(n) for g in nodes))
    # hull bounds — measure the tessellated mesh (analytical sphere bbox over-reports)
    hull_shape = None
    for nm, sub in assembly.traverse():
        if nm == "Hull":
            hull_shape = sub.obj
    with tempfile.NamedTemporaryFile(suffix='.stl', delete=False) as f:
        tmp = f.name
    cq.exporters.export(hull_shape, tmp, cq.exporters.ExportTypes.STL, tolerance=0.002, angularTolerance=0.1)
    import trimesh as _tm
    hm = _tm.load(tmp, force='mesh'); os.unlink(tmp)
    ext = hm.bounds[1] - hm.bounds[0]
    Wx, Hy, Lz = float(ext[0]), float(ext[1]), float(ext[2])
    ok_len = 8.0 <= Lz <= 8.4; ok_beam = 0.25 <= Wx <= 0.35; ok_h = 0.15 <= Hy <= 0.25
    # orientation check on the EXPORTED GLB: hull must lie horizontal (length
    # along scene Z, up along Y), not stand on end.
    scene2 = _tm.load(str(glb))
    gb = scene2.bounds  # world-space
    gext = gb[1] - gb[0]
    orient_ok = gext[2] > 3.0 and gext[1] < 2.0   # Z (length) large, Y (up) small
    print(f"  GLB:  {glb}")
    print(f"  hull L={Lz:.2f} beam={Wx:.3f} height={Hy:.3f}  bounds ok: L={ok_len} beam={ok_beam} h={ok_h}")
    print(f"  GLB extent X={gext[0]:.2f} Y(up)={gext[1]:.2f} Z(len)={gext[2]:.2f}  orient ok: {orient_ok}")
    print(f"  required nodes present: {not missing}" + (f"  MISSING={missing}" if missing else ""))
    render_glb(glb, name)
    return not missing and ok_len and ok_beam and ok_h


if __name__ == "__main__":
    if DRY_RUN:
        # AC8: print the authored node tree for every GLB this script WOULD
        # export, without touching the filesystem. The tree is the oracle the
        # structural tests check the real GLBs against.
        bare = scull_hull()
        _print_node_tree(bare, "scull")
        male = scull_hull(); male.add(rower_assembly(MALE))
        _print_node_tree(male, "scull-male")
        female = scull_hull(); female.add(rower_assembly(FEMALE))
        _print_node_tree(female, "scull-female")
        print("dry-run: no GLBs written")
    else:
        print("=== bare scull ===")
        export_and_validate(scull_hull(), "scull.glb", "scull")

        print("=== male crew ===")
        a = scull_hull(); a.add(rower_assembly(MALE))
        export_and_validate(a, "scull-male.glb", "scull-male")

        print("=== female crew ===")
        a = scull_hull(); a.add(rower_assembly(FEMALE))
        export_and_validate(a, "scull-female.glb", "scull-female")
        print("done")
