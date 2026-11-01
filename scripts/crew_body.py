"""
High-definition rower body for the crewed scull GLBs (issue #672).

Authored with the llm-cad design loop (execute CadQuery -> render -> critique
-> measure, https://github.com/MaximumTrainer/llm-cad): every body segment is
a smooth loft through anatomical elliptical cross-sections rather than a
primitive, so the torso tapers from lats to waist, the upper arm carries a
biceps belly, the calf bulges behind the shin and the hands wrap the handle
with jointed fingers. Male and female share one skeleton solver and differ by
the proportion tables at the bottom of the file.

Frame and pose match the scaffold the engine already consumes (see
`build_crew.py`): metres, up +Y, beam +X, the rower's feet and reach toward
+Z, seated on the slide at the catch. Node names are the slot contract the
renderer and the appearance tint read (`crewPalette.ts CREW_SLOT_PATTERNS`):

    Rower
      Rower_Torso   Torso_Spine (suit), Torso_Shoulders (suit), Torso_Stripe,
                    Neck, Head, Head_Eyes, Hairstyles/Hair_*, Hat/Hat_*
      Rower_LeftArm / Rower_RightArm    <Side>Arm_Upper, <Side>Arm_Fore, <Side>Hand
      Rower_LeftLeg / Rower_RightLeg    <Side>Thigh (suit), <Side>Knee,
                                        <Side>Shin, <Side>Foot (shoe), <Side>Foot_Sole

Body solids are pre-tessellated at `BODY_TOLERANCE`; the GLB export keeps an
existing finer triangulation (`cq.Shape.mesh` only meshes when none
satisfies the requested tolerance), so the rower is meshed finely while the
8 m hull stays at the coarse export tolerance and the GLB fits its cap.
"""
import math

import cadquery as cq
import numpy as np

# Linear / angular deflection for the body. Finer than the hull's export
# tolerance on purpose (see module docstring).
BODY_TOLERANCE = 0.0025
BODY_ANGULAR_TOLERANCE = 0.40

HAIRSTYLES = ("Short", "Long", "Buzz", "Bun")
HATS = ("Cap", "Visor", "Beanie")


def hx(h):
    h = h.lstrip('#')
    return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255)


def col(h):
    r, g, b = hx(h)
    return cq.Color(r, g, b)


SUIT = "#1E3A5F"
STRIPE = "#F2F2F0"
SKIN = "#C9A184"
HAIR = "#2A2320"
EYES = "#1B1512"
SHOE = "#2A2A28"
SOLE = "#D8D8D4"
HAT_DEFAULT = "#1A1A1A"


# --------------------------------------------------------------------------
# geometry primitives
# --------------------------------------------------------------------------

def _v(p):
    return cq.Vector(float(p[0]), float(p[1]), float(p[2]))


def _unit(v):
    v = np.asarray(v, float)
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-9 else v


def frame(a, b, side_ref):
    """Orthonormal frame for a segment a->b: z along the segment, x as close to
    `side_ref` as the segment allows, y = z x x (the segment's 'front')."""
    z = _unit(np.asarray(b, float) - np.asarray(a, float))
    ref = np.asarray(side_ref, float)
    x = ref - np.dot(ref, z) * z
    if np.linalg.norm(x) < 1e-6:
        x = np.cross(z, [0.0, 1.0, 0.0])
    x = _unit(x)
    y = np.cross(z, x)
    return x, y, z


def ellipse_wire(center, rx, ry, x, z):
    """Closed ellipse in the plane normal to `z`, `rx` measured along `x`."""
    rx = max(rx, 1e-4)
    ry = max(ry, 1e-4)
    if rx >= ry:
        return cq.Wire.makeEllipse(rx, ry, _v(center), _v(z), _v(x))
    # OCCT wants major >= minor: swap and turn the major axis onto y.
    y = np.cross(z, x)
    return cq.Wire.makeEllipse(ry, rx, _v(center), _v(z), _v(y))


def section_loft(a, b, sections, side_ref=(1.0, 0.0, 0.0)):
    """Smooth loft from `a` to `b` through elliptical sections.

    `sections` is a list of ``(t, rx, ry[, dx, dy])``: `t` in [0, 1] along the
    segment, radii across (`rx` toward `side_ref`, `ry` toward the segment's
    front) and an optional centre offset in that same frame. This is how the
    muscle bellies are drawn: a wider section part-way along the segment.
    """
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    x, y, z = frame(a, b, side_ref)
    wires = []
    for s in sections:
        t, rx, ry = s[0], s[1], s[2]
        dx = s[3] if len(s) > 3 else 0.0
        dy = s[4] if len(s) > 4 else 0.0
        c = a + (b - a) * t + x * dx + y * dy
        wires.append(ellipse_wire(c, rx, ry, x, z))
    return cq.Solid.makeLoft(wires, False)


def path_loft(points, radii, side_ref=(1.0, 0.0, 0.0), closed=False):
    """Smooth loft through circular-ish sections placed along a polyline,
    each normal to the local tangent: one surface for a curled finger or a
    hat band instead of a chain of capsules. `radii` is one ``(rx, ry)`` per
    point; `closed` joins the last section back to the first."""
    pts = [np.asarray(p, float) for p in points]
    n = len(pts)
    wires = []
    for i, p in enumerate(pts):
        if closed:
            tan = pts[(i + 1) % n] - pts[(i - 1) % n]
        else:
            tan = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
        z = _unit(tan)
        ref = np.asarray(side_ref, float)
        x = ref - np.dot(ref, z) * z
        if np.linalg.norm(x) < 1e-6:
            x = np.cross(z, [0.0, 1.0, 0.0])
        wires.append(ellipse_wire(p, radii[i][0], radii[i][1], _unit(x), z))
    if closed:
        wires.append(wires[0])
    return cq.Solid.makeLoft(wires, False)


def ellipsoid(rx, ry, rz, center=(0, 0, 0)):
    from OCP.gp import gp_GTrsf
    from OCP.BRepBuilderAPI import BRepBuilderAPI_GTransform
    m = max(rx, ry, rz)
    s = cq.Solid.makeSphere(m, angleDegrees1=-90, angleDegrees2=90, angleDegrees3=360)
    gt = gp_GTrsf()
    gt.SetValue(1, 1, rx / m)
    gt.SetValue(2, 2, ry / m)
    gt.SetValue(3, 3, rz / m)
    sh = cq.Shape.cast(BRepBuilderAPI_GTransform(s.wrapped, gt, True).Shape())
    return sh.translate(_v(center))


def oriented_ellipsoid(center, radii, x, y, z):
    """Ellipsoid with semi-axes `radii` along the given orthonormal axes."""
    e = ellipsoid(*radii)
    return _place(e, center, x, y, z)


def _place(shape, center, x, y, z):
    """Map local X/Y/Z onto the world axes `x`/`y`/`z`, origin onto `center`."""
    from OCP.gp import gp_Trsf
    x, y, z = (np.asarray(v, float) for v in (x, y, z))
    t = gp_Trsf()
    t.SetValues(x[0], y[0], z[0], float(center[0]),
                x[1], y[1], z[1], float(center[1]),
                x[2], y[2], z[2], float(center[2]))
    return shape.transformShape(cq.Matrix(t))


def sphere(r, center):
    return cq.Solid.makeSphere(r, angleDegrees1=-90, angleDegrees2=90).translate(_v(center))


def _meshed(shape):
    from OCP.BRepTools import BRepTools
    return BRepTools.Triangulation_s(shape.wrapped, 1.0)


def compound(shapes):
    return cq.Compound.makeCompound(list(shapes))


def premesh(shape, coarse=False):
    """Triangulate now; the GLB export reuses it (module docstring).

    Absolute deflection on purpose: `cq.Shape.mesh` meshes *relative* to edge
    size, which gives a 7 mm eye the triangle count of a forearm."""
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    # `coarse` is for trim that reads as a line at the chase camera (stripes,
    # bands, soles): the angular limit, not the linear one, drives those.
    ang = BODY_ANGULAR_TOLERANCE * (2.0 if coarse else 1.0)
    BRepMesh_IncrementalMesh(shape.wrapped, BODY_TOLERANCE, False, ang, True)
    return shape


def two_bone(root, end, l1, l2, pole):
    """Planar two-bone IK: the joint between `root` and `end` for segment
    lengths `l1`, `l2`, bent toward `pole`. Clamps an over-reach straight."""
    root = np.asarray(root, float)
    end = np.asarray(end, float)
    d = end - root
    L = float(np.linalg.norm(d))
    L = min(L, l1 + l2 - 1e-4)
    u = _unit(d)
    a = (l1 * l1 - l2 * l2 + L * L) / (2 * L)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    p = np.asarray(pole, float)
    perp = p - np.dot(p, u) * u
    perp = _unit(perp)
    return root + u * a + perp * h


# --------------------------------------------------------------------------
# skeleton
# --------------------------------------------------------------------------

def skeleton(d):
    """Joint positions for the catch pose from a proportion table `d`."""
    lean = math.radians(d["lean_deg"])
    up = np.array([0.0, math.cos(lean), math.sin(lean)])
    pelvis = np.array([0.0, d["hip_y"], 0.0])
    neck_base = pelvis + up * d["spine"]
    j = {"pelvis": pelvis, "neck_base": neck_base, "up": up}
    # Head held more upright than the trunk, eyes on the stern.
    head_up = _unit(np.array([0.0, 1.0, 0.15]))
    j["head_up"] = head_up
    j["head"] = neck_base + head_up * d["neck"] + np.array([0.0, 0.0, 0.015])
    for side, s in (("Left", -1.0), ("Right", 1.0)):
        sh = neck_base + np.array([s * d["shoulder_half"], -0.035, -0.012])
        hand = np.array([s * d["hand_x"], d["hand_y"], d["hand_z"]])
        # Arms near-straight at the catch: a slight outward elbow bend.
        elbow = two_bone(sh, hand, d["uarm"], d["larm"], (s * 1.0, -0.2, 0.0))
        hip = pelvis + np.array([s * d["hip_half"], 0.0, 0.0])
        ankle = np.array([s * d["ankle_x"], d["ankle_y"], d["ankle_z"]])
        knee = two_bone(hip, ankle, d["thigh"], d["shin"], (s * 0.35, 1.0, 0.0))
        j[side] = {"shoulder": sh, "elbow": elbow, "hand": hand,
                   "hip": hip, "knee": knee, "ankle": ankle, "s": s}
    return j


# --------------------------------------------------------------------------
# body parts
# --------------------------------------------------------------------------

def torso_sections(d):
    """Pelvis -> waist -> ribs -> chest -> shoulder line, (t, rx, ry, dx, dy)."""
    k = d["torso_k"]
    return [
        (0.00, 0.150 * k["hip"], 0.105, 0.0, -0.010),
        (0.12, 0.158 * k["hip"], 0.112, 0.0, -0.004),
        (0.30, 0.138 * k["waist"], 0.100, 0.0, 0.004),
        (0.50, 0.146 * k["ribs"], 0.110, 0.0, 0.010),
        (0.70, 0.168 * k["chest"], 0.118, 0.0, 0.014),
        (0.86, 0.176 * k["chest"], 0.108, 0.0, 0.006),
        (0.97, 0.130 * k["shoulder"], 0.080, 0.0, -0.006),
        (1.00, 0.070, 0.055, 0.0, -0.004),
    ]


def build_torso(d, j):
    pelvis, neck = j["pelvis"], j["neck_base"]
    secs = torso_sections(d)
    trunk = section_loft(pelvis, neck, secs)
    x, y, z = frame(pelvis, neck, (1, 0, 0))
    parts = [trunk]
    # Glutes on the seat, behind and below the pelvis section.
    for s in (-1.0, 1.0):
        parts.append(oriented_ellipsoid(
            pelvis + x * (s * 0.068) - y * 0.045 - z * 0.010,
            (0.075 * d["torso_k"]["hip"], 0.070, 0.085), x, y, z))
    # Chest: pectorals (male) or bust (female), inside the suit.
    for s in (-1.0, 1.0):
        c = pelvis + (neck - pelvis) * 0.74 + x * (s * 0.070) + y * 0.090
        if d["sex"] == "female":
            parts.append(oriented_ellipsoid(c - z * 0.035 + y * 0.004, (0.058, 0.050, 0.052), x, y, z))
        else:
            parts.append(oriented_ellipsoid(c, (0.072, 0.040, 0.058), x, y, z))
    # Lats flare from the armpit down the back (the rower's V).
    for s in (-1.0, 1.0):
        a = pelvis + (neck - pelvis) * 0.40 + x * (s * 0.10) - y * 0.035
        b = pelvis + (neck - pelvis) * 0.82 + x * (s * 0.15 * d["torso_k"]["chest"]) - y * 0.035
        parts.append(section_loft(a, b, [
            (0.0, 0.020, 0.040), (0.5, 0.050 * d["lat_k"], 0.070), (1.0, 0.040, 0.060)], (s, 0, 0)))
    spine = premesh(compound(parts))

    # Shoulder girdle: trapezius slope from neck to each shoulder.
    trap = []
    for side in ("Left", "Right"):
        sh = j[side]["shoulder"]
        # A flat sloping sheet, thin vertically and deep front-to-back, that
        # sinks into the deltoid rather than ending as a tube.
        trap.append(section_loft(neck - y * 0.022 - z * 0.030, sh - z * 0.012 + np.array([0, 0.004, 0]),
                                 [(0.0, 0.040, 0.058), (0.50, 0.030, 0.056),
                                  (0.85, 0.026, 0.050), (1.0, 0.018, 0.036)],
                                 tuple(z)))
    shoulders = premesh(compound(trap))

    # Side stripes: thin raised panels following the flank of the trunk.
    stripes = []
    for s in (-1.0, 1.0):
        wires = []
        for t, rx, ry, dx, dy in secs[:-2:2] + [secs[-3]]:
            c = pelvis + (neck - pelvis) * t + x * (s * (rx - 0.004)) + y * dy
            wires.append(ellipse_wire(c, 0.007, 0.022, x, z))
        stripes.append(cq.Solid.makeLoft(wires, False))
    stripe = premesh(compound(stripes), coarse=True)
    return spine, shoulders, stripe


def build_neck(d, j):
    nb = j["neck_base"]
    top = j["head"] - j["head_up"] * 0.055 - np.array([0, 0, 0.012])
    return premesh(section_loft(nb - j["up"] * 0.03, top, [
        (0.0, 0.060 * d["neck_k"], 0.058),
        (0.45, 0.050 * d["neck_k"], 0.050, 0.0, 0.004),
        (1.0, 0.046 * d["neck_k"], 0.050, 0.0, 0.006)], (1, 0, 0)))


def head_frame(j):
    zf = _unit(np.array([0.0, -0.04, 1.0]))  # face direction: toward the stern, eyes level
    yu = j["head_up"]
    yu = _unit(yu - np.dot(yu, zf) * zf)
    xs = np.cross(yu, zf)
    return xs, yu, zf


def build_head(d, j):
    c = j["head"]
    xs, yu, zf = head_frame(j)
    hk = d["head_k"]
    parts = []
    # Cranium.
    parts.append(oriented_ellipsoid(c, (0.076 * hk, 0.100 * hk, 0.094 * hk), xs, zf, yu))
    # Face mass: cheekbones -> jaw -> chin, lofted downward and forward.
    jaw_top = c + zf * 0.030 - yu * 0.010
    chin = c + zf * 0.062 * hk - yu * 0.108 * hk
    parts.append(section_loft(jaw_top, chin, [
        (0.0, 0.070 * hk, 0.060 * hk),
        (0.45, 0.064 * hk * d["jaw_k"], 0.050 * hk),
        (0.80, 0.044 * hk * d["jaw_k"], 0.036 * hk),
        (1.0, 0.020 * hk, 0.018 * hk)], tuple(xs)))
    # Brow ridge.
    parts.append(oriented_ellipsoid(c + zf * 0.078 * hk + yu * 0.018 * hk,
                                    (0.058 * hk, 0.016 * hk, 0.018 * hk), xs, zf, yu))
    # Nose: bridge to tip.
    nb = c + zf * 0.086 * hk + yu * 0.004
    nt = c + zf * 0.106 * hk - yu * 0.034 * hk
    parts.append(section_loft(nb, nt, [
        (0.0, 0.008, 0.008), (0.7, 0.012 * d["nose_k"], 0.012), (1.0, 0.009, 0.006)], tuple(xs)))
    parts.append(oriented_ellipsoid(nt - zf * 0.004 - yu * 0.004,
                                    (0.017 * d["nose_k"], 0.010, 0.010), xs, zf, yu))
    # Lips.
    lip = c + zf * 0.086 * hk - yu * 0.066 * hk
    parts.append(oriented_ellipsoid(lip, (0.022, 0.008, 0.009), xs, zf, yu))
    # Ears.
    for s in (-1.0, 1.0):
        parts.append(oriented_ellipsoid(c + xs * (s * 0.076 * hk) - yu * 0.012 + zf * 0.002,
                                        (0.010, 0.020, 0.032), xs, zf, yu))
    head = premesh(compound(parts))
    eyes = []
    for s in (-1.0, 1.0):
        eyes.append(oriented_ellipsoid(c + zf * 0.081 * hk + xs * (s * 0.030 * hk) - yu * 0.004,
                                       (0.011, 0.007, 0.006), xs, zf, yu))
    return head, premesh(compound(eyes), coarse=True)


def build_arm(d, j, side):
    a = j[side]
    s = a["s"]
    sh, el, hd = a["shoulder"], a["elbow"], a["hand"]
    ak = d["arm_k"]
    # Wrist sits behind and above the handle the hand wraps.
    reach = _unit(hd - el)
    wrist = hd - reach * 0.060 + np.array([0.0, 0.026, 0.0])
    side_ref = (s * 1.0, 0.0, 0.0)
    upper = [
        # Deltoid cap, then the arm tapers through the biceps/triceps belly.
        oriented_ellipsoid(sh, (0.062 * ak, 0.058 * ak, 0.070 * ak), *frame(sh, el, side_ref)),
        section_loft(sh, el, [
            (0.00, 0.052 * ak, 0.054 * ak),
            (0.22, 0.050 * ak, 0.052 * ak, 0.0, 0.002),
            (0.48, 0.043 * ak, 0.050 * ak, 0.0, 0.006),
            (0.80, 0.038 * ak, 0.040 * ak),
            (1.00, 0.036 * ak, 0.036 * ak)], side_ref),
        sphere(0.036 * ak, el),
    ]
    fore = [
        section_loft(el, wrist, [
            (0.00, 0.038 * ak, 0.036 * ak),
            (0.22, 0.044 * ak, 0.038 * ak, s * 0.002, 0.0),
            (0.60, 0.034 * ak, 0.028 * ak),
            (1.00, 0.030 * ak, 0.020 * ak)], (1.0, 0.0, 0.0)),
    ]
    hand = build_hand(d, wrist, hd, s)
    return premesh(compound(upper)), premesh(compound(fore)), hand


def build_hand(d, wrist, grip, s):
    """Overhand grip around a handle running along X through `grip`."""
    hk = d["hand_k"]
    R = 0.017 + 0.009 * hk     # handle radius + finger radius
    fr = 0.0088 * hk
    ex = np.array([1.0, 0.0, 0.0])

    def around(theta_deg, x_off, r=R):
        t = math.radians(theta_deg)
        # theta 0 -> toward the rower (-Z), 90 -> over the top (+Y), 180 -> front (+Z)
        return grip + ex * x_off + np.array([0.0, math.sin(t), -math.cos(t)]) * r

    parts = []
    # Palm: from the wrist over the back of the handle to the knuckle line.
    knuckle = around(78, 0.0, R + 0.004)
    back = _unit(wrist - knuckle)
    parts.append(section_loft(wrist + back * 0.018, knuckle, [
        (0.0, 0.029 * hk, 0.020 * hk),
        (0.25, 0.034 * hk, 0.021 * hk),
        (0.65, 0.043 * hk, 0.020 * hk),
        (1.0, 0.044 * hk, 0.016 * hk)], (1.0, 0.0, 0.0)))
    # Four fingers: index nearest the gate (outboard), pinky toward the handle
    # end. Each is one loft curling over the top of the handle and under it,
    # with a knuckle bump and a rounded tip.
    offsets = [s * 0.030, s * 0.010, -s * 0.010, -s * 0.029]
    lengths = [1.0, 1.06, 1.0, 0.82]
    for off, ln in zip(offsets, lengths):
        r = fr * (0.92 if ln < 0.9 else 1.0)
        thetas = [72, 84, 80 + 60 * ln, 80 + 120 * ln, 80 + 175 * ln, 80 + 196 * ln, 80 + 204 * ln]
        prof = [1.05, 1.15, 1.0, 0.95, 0.88, 0.70, 0.25]
        pts = [around(t, off) for t in thetas]
        parts.append(path_loft(pts, [(r * k, r * k * 0.9) for k in prof], (1.0, 0.0, 0.0)))
    # Thumb: from the base of the palm, under the handle toward the fingertips.
    tb = wrist + (knuckle - wrist) * 0.35 + ex * (-s * 0.030) - np.array([0, 0.008, 0])
    pts = [tb, around(-5, -s * 0.040, R + 0.004), around(-38, -s * 0.042, R),
           around(-62, -s * 0.040, R), around(-70, -s * 0.039, R)]
    prof = [1.5, 1.25, 1.05, 0.85, 0.30]
    parts.append(path_loft(pts, [(fr * k, fr * k * 0.9) for k in prof], (1.0, 0.0, 0.0)))
    return premesh(compound(parts))


def build_leg(d, j, side):
    a = j[side]
    s = a["s"]
    hip, knee, ankle = a["hip"], a["knee"], a["ankle"]
    lk = d["leg_k"]
    side_ref = (s * 1.0, 0.0, 0.0)
    # Thigh in the suit: quads belly toward the front, hamstrings behind.
    cut = 0.70
    suit = section_loft(hip, hip + (knee - hip) * cut, [
        (0.00, 0.088 * lk, 0.090 * lk, 0.0, -0.004),
        (0.25, 0.086 * lk, 0.092 * lk, 0.0, 0.006),
        (0.60, 0.074 * lk, 0.078 * lk, 0.0, 0.006),
        (1.00, 0.065 * lk, 0.066 * lk, 0.0, 0.004)], side_ref)
    hem = hip + (knee - hip) * (cut - 0.02)
    lower_thigh = section_loft(hem, knee, [
        (0.00, 0.062 * lk, 0.062 * lk, 0.0, 0.004),
        (0.60, 0.054 * lk, 0.056 * lk, 0.0, 0.004),
        (1.00, 0.050 * lk, 0.050 * lk)], side_ref)
    xk, yk, zk = frame(hip, knee, side_ref)
    kneecap = oriented_ellipsoid(knee + yk * 0.026, (0.034, 0.024, 0.036), xk, yk, zk)
    knee_joint = sphere(0.050 * lk, knee)
    # Shin: calf bulges behind, tibia ridge in front, tapers to the ankle.
    shin = section_loft(knee, ankle, [
        (0.00, 0.050 * lk, 0.050 * lk),
        (0.25, 0.052 * lk, 0.058 * lk, 0.0, -0.010),
        (0.45, 0.048 * lk, 0.052 * lk, 0.0, -0.008),
        (0.80, 0.032 * lk, 0.032 * lk),
        (1.00, 0.028 * lk, 0.030 * lk)], side_ref)
    shoe, sole = build_shoe(d, ankle, s)
    return (premesh(suit), premesh(compound([lower_thigh, kneecap, knee_joint])),
            premesh(shin), shoe, sole)


def build_shoe(d, ankle, s):
    """Rowing shoe on the angled foot plate: toes up toward the stern."""
    fk = d["foot_k"]
    heel = ankle + np.array([0.0, -0.055, -0.040])
    toe = heel + _unit(np.array([0.0, 0.42, 1.0])) * 0.270 * fk
    side_ref = (s * 1.0, 0.0, 0.0)
    upper = section_loft(heel, toe, [
        (0.00, 0.032 * fk, 0.040, 0.0, 0.010),
        (0.18, 0.040 * fk, 0.050, 0.0, 0.016),
        (0.55, 0.046 * fk, 0.036, 0.0, 0.006),
        (0.85, 0.042 * fk, 0.026, 0.0, 0.000),
        (1.00, 0.026 * fk, 0.016, 0.0, -0.004)], side_ref)
    collar = section_loft(ankle - np.array([0, 0.028, 0.006]), ankle + np.array([0, 0.040, 0.010]), [
        (0.0, 0.040 * fk, 0.044), (1.0, 0.034 * fk, 0.036)], side_ref)
    x, y, z = frame(heel, toe, side_ref)
    strap = section_loft(heel + z * 0.090 * fk - y * 0.002, heel + z * 0.130 * fk - y * 0.002, [
        (0.0, 0.050 * fk, 0.056), (1.0, 0.049 * fk, 0.050)], side_ref)
    sole = section_loft(heel - y * 0.030 - z * 0.012, toe - y * 0.018 + z * 0.004, [
        (0.0, 0.034 * fk, 0.010), (0.5, 0.048 * fk, 0.010), (1.0, 0.030 * fk, 0.008)], side_ref)
    return premesh(compound([upper, collar, strap])), premesh(sole, coarse=True)


# --------------------------------------------------------------------------
# hair and hats, in the head's frame
# --------------------------------------------------------------------------

def _cap(c, radii, below_deg, tilt_deg, xs, yu, zf):
    """Spherical-zone shell scaled to an ellipsoid: everything above
    `below_deg` latitude, tilted back by `tilt_deg` so the hairline sits high
    at the forehead and low at the nape."""
    from OCP.gp import gp_GTrsf
    from OCP.BRepBuilderAPI import BRepBuilderAPI_GTransform
    m = max(radii)
    zone = cq.Solid.makeSphere(m, angleDegrees1=below_deg, angleDegrees2=90, angleDegrees3=360)
    gt = gp_GTrsf()
    gt.SetValue(1, 1, radii[0] / m)
    gt.SetValue(2, 2, radii[1] / m)
    gt.SetValue(3, 3, radii[2] / m)
    sh = cq.Shape.cast(BRepBuilderAPI_GTransform(zone.wrapped, gt, True).Shape())
    sh = sh.rotate(cq.Vector(0, 0, 0), cq.Vector(1, 0, 0), tilt_deg)
    # local: X side, Y face (zone pole on +Z = up) -> place with z=up, x=side.
    return _place(sh, c, xs, zf, yu)


def build_hairstyle(name, d, j):
    c = j["head"]
    xs, yu, zf = head_frame(j)
    hk = d["head_k"]
    base = (0.083 * hk, 0.108 * hk, 0.103 * hk)   # side, face, up: clears the cranium
    parts = []
    if name == "Short":
        parts.append(("Cap", _cap(c, base, -16, 40, xs, yu, zf)))
        # Swept fringe and crown volume.
        parts.append(("Fringe", oriented_ellipsoid(c + yu * 0.074 * hk + zf * 0.040 * hk,
                                        (0.060 * hk, 0.036 * hk, 0.030 * hk), xs, zf, yu)))
    elif name == "Long":
        parts.append(("Cap", _cap(c, tuple(r * 1.03 for r in base), -22, 30, xs, yu, zf)))
        top = c - zf * 0.092 * hk + yu * 0.010
        tail = top - yu * 0.190 - zf * 0.020
        parts.append(("Tail", section_loft(top, tail, [
            (0.0, 0.030, 0.028), (0.25, 0.036, 0.030), (0.75, 0.026, 0.020), (1.0, 0.008, 0.008)],
            tuple(xs))))
        parts.append(("Tie", oriented_ellipsoid(top, (0.022, 0.016, 0.016), xs, zf, yu)))
    elif name == "Buzz":
        parts.append(("Cap", _cap(c, tuple(r * 0.985 for r in base), -8, 26, xs, yu, zf)))
    elif name == "Bun":
        parts.append(("Cap", _cap(c, base, -16, 30, xs, yu, zf)))
        bun = c - zf * 0.080 * hk + yu * 0.070 * hk
        parts.append(("Bun", oriented_ellipsoid(bun, (0.040, 0.034, 0.036), xs, zf, yu)))
    else:
        raise ValueError(f"unknown hairstyle: {name!r}")
    return [(nm, premesh(p)) for nm, p in parts]


def build_hat(name, d, j):
    c = j["head"]
    xs, yu, zf = head_frame(j)
    hk = d["head_k"]
    base = (0.088 * hk, 0.112 * hk, 0.108 * hk)
    parts = []

    def brim(y_off, depth):
        a = c + yu * y_off + zf * 0.070 * hk
        b = a + zf * depth - yu * 0.022
        return section_loft(a, b, [(0.0, 0.074 * hk, 0.008), (0.6, 0.070 * hk, 0.007),
                                   (1.0, 0.044 * hk, 0.005)], tuple(xs))

    if name == "Cap":
        parts.append(_cap(c, base, 6, 20, xs, yu, zf))
        parts.append(brim(0.032 * hk, 0.075))
        parts.append(sphere(0.008, c + yu * 0.112 * hk))
    elif name == "Visor":
        band = []
        for t in range(0, 360, 360 // 24):
            r = math.radians(t)
            band.append(c + yu * 0.030 * hk + xs * math.sin(r) * 0.085 * hk + zf * math.cos(r) * 0.100 * hk)
        parts.append(premesh(path_loft(band, [(0.011, 0.016)] * len(band), tuple(yu), closed=True), coarse=True))
        parts.append(brim(0.028 * hk, 0.080))
    elif name == "Beanie":
        parts.append(_cap(c, (base[0] * 1.02, base[1] * 1.02, base[2] * 1.18), 2, 16, xs, yu, zf))
        # Folded cuff.
        ring = []
        for t in range(0, 360, 360 // 24):
            r = math.radians(t)
            ring.append(c + yu * (0.018 * hk + 0.024 * math.cos(r)) + xs * math.sin(r) * 0.088 * hk
                        + zf * math.cos(r) * 0.104 * hk)
        parts.append(premesh(path_loft(ring, [(0.016, 0.022)] * len(ring), tuple(yu), closed=True), coarse=True))
    else:
        raise ValueError(f"unknown hat: {name!r}")
    return [p if _meshed(p) else premesh(p) for p in parts]


# --------------------------------------------------------------------------
# assembly
# --------------------------------------------------------------------------

def rower_assembly(d):
    """The seated rower at the catch, segmented into the five rig chains."""
    j = skeleton(d)
    rower = cq.Assembly(name="Rower")

    torso = cq.Assembly(name="Rower_Torso")
    spine, shoulders, stripe = build_torso(d, j)
    torso.add(spine, name="Torso_Spine", color=col(SUIT))
    torso.add(shoulders, name="Torso_Shoulders", color=col(SUIT))
    torso.add(stripe, name="Torso_Stripe", color=col(STRIPE))
    torso.add(build_neck(d, j), name="Neck", color=col(SKIN))
    head, eyes = build_head(d, j)
    torso.add(head, name="Head", color=col(SKIN))
    torso.add(eyes, name="Head_Eyes", color=col(EYES))

    # One hairstyle and at most one hat are shown at a time; colouring is
    # runtime-only (rowerAppearance.ts / crewPalette.ts).
    hairstyles = cq.Assembly(name="Hairstyles")
    for style in HAIRSTYLES:
        sub = cq.Assembly(name=f"Hair_{style}")
        for suffix, p in build_hairstyle(style, d, j):
            sub.add(p, name=f"Hair_{style}_{suffix}", color=col(HAIR))
        hairstyles.add(sub)
    torso.add(hairstyles)

    hat_parent = cq.Assembly(name="Hat")
    for hat in HATS:
        sub = cq.Assembly(name=f"Hat_{hat}")
        pieces = build_hat(hat, d, j)
        if hat == "Cap":
            for p, nm in zip(pieces, ("Crown", "Brim", "Button")):
                sub.add(p, name=f"Hat_{hat}_{nm}", color=col(HAT_DEFAULT))
        elif hat == "Visor":
            sub.add(pieces[0], name=f"Hat_{hat}_Band", color=col(HAT_DEFAULT))
            sub.add(pieces[1], name=f"Hat_{hat}_Brim", color=col(HAT_DEFAULT))
        else:
            sub.add(pieces[0], name=f"Hat_{hat}_Dome", color=col(HAT_DEFAULT))
            sub.add(pieces[1], name=f"Hat_{hat}_Cuff", color=col(HAT_DEFAULT))
        hat_parent.add(sub)
    torso.add(hat_parent)
    rower.add(torso)

    for side in ("Left", "Right"):
        arm = cq.Assembly(name=f"Rower_{side}Arm")
        upper, fore, hand = build_arm(d, j, side)
        arm.add(upper, name=f"{side}Arm_Upper", color=col(SKIN))
        arm.add(fore, name=f"{side}Arm_Fore", color=col(SKIN))
        arm.add(hand, name=f"{side}Hand", color=col(SKIN))
        rower.add(arm)

    for side in ("Left", "Right"):
        leg = cq.Assembly(name=f"Rower_{side}Leg")
        suit, knee, shin, shoe, sole = build_leg(d, j, side)
        leg.add(suit, name=f"{side}Thigh", color=col(SUIT))
        leg.add(knee, name=f"{side}Knee", color=col(SKIN))
        leg.add(shin, name=f"{side}Shin", color=col(SKIN))
        leg.add(shoe, name=f"{side}Foot", color=col(SHOE))
        leg.add(sole, name=f"{side}Foot_Sole", color=col(SOLE))
        rower.add(leg)

    return rower


# --------------------------------------------------------------------------
# proportions
# --------------------------------------------------------------------------

_COMMON = dict(
    lean_deg=28.0, hip_y=0.275,
    hand_y=0.34, hand_z=0.80, ankle_y=0.165, ankle_z=0.78, ankle_x=0.105,
)

MALE = dict(
    _COMMON, sex="male",
    spine=0.560, neck=0.135, shoulder_half=0.205, hip_half=0.092, hand_x=0.125,
    uarm=0.335, larm=0.300, thigh=0.475, shin=0.450,
    torso_k=dict(hip=1.00, waist=1.00, ribs=1.05, chest=1.10, shoulder=1.12),
    lat_k=1.15, neck_k=1.10, head_k=1.00, jaw_k=1.06, nose_k=1.05,
    arm_k=1.08, hand_k=1.04, leg_k=1.05, foot_k=1.04,
)

FEMALE = dict(
    _COMMON, sex="female",
    spine=0.525, neck=0.130, shoulder_half=0.188, hip_half=0.094, hand_x=0.120,
    uarm=0.310, larm=0.272, thigh=0.445, shin=0.420,
    torso_k=dict(hip=1.06, waist=0.86, ribs=0.92, chest=0.94, shoulder=0.95),
    lat_k=0.90, neck_k=0.90, head_k=0.95, jaw_k=0.90, nose_k=0.88,
    arm_k=0.90, hand_k=0.92, leg_k=0.98, foot_k=0.94,
)
