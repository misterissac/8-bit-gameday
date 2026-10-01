# React + Vite

## Batter body

The batter's body is the skinned player model (`public/models/player.glb`, from
the solomon-gumball reference). It is posed every frame by `src/util/playerRig.js`
from the same joint targets the animation tuning in `Batter.jsx` always computed —
the front-leg step, the back-leg drive, the hip thrust, the torso turn and the
follow-through — so the data-driven contact geometry (attack angle, swing path
tilt, sweet spot) is unchanged; what changed is only how the pose is realised
(bones and 2-bone IK instead of rigidly placed part meshes). Only the bat remains
a part mesh, placed by that geometry.

## Batter visual-regression suite

`npm test` runs the unit tests (node:test). `npm run test:visual` runs the
Playwright visual-regression suite for the batter: it renders the real `<Batter>`
component on a harness stage (`e2e/harness/batter.html`) at five moments of the
swing cycle — set stance, mid-swing, contact, follow-through and part way through
the recovery — and compares each render against the committed baselines in
`e2e/__screenshots__/`.

Alongside the pixels, the contact phase is checked against the live scene graph:
the bat's barrel axis must pass through the pitch's plate crossing with the sweet
spot (78% down the barrel) on the ball. The pitch fixture and phase timings live
in `e2e/harness/fixture.js`, shared by the spec and the harness so they cannot
drift apart.

The suite also checks the posed skeleton against the joints the animation computed
— both read back in the batter's own frame — because the bat is placed
analytically from the pitch data while the body is posed by a bone driver: each
hand has to end up on the grip it was given, the arms must stay within reach, and
the feet must stay on the ground.

### The body is rigid parts joined by narrow bands

The torso is held to the same kind of check, and it is where the model's own
skinning had to be replaced. A skinned mesh only deforms where two bones' regions
blend: inside one region the surface moves rigidly with its bone. player.glb's
weights are soft — they spend a third of the *pelvis* on the thigh bones and a
fifth of the torso's on the pelvis — so the hips bend across a band nearly half a
torso tall, and when the batter bends over the plate the belt shears into the
stomach while the pelvis itself stays put with the legs. `shapeRigidParts` in
`src/util/playerRig.js` instead cuts the weights into the parts the animation
really models — each leg, the pelvis (the trunks, from the hip crease up to the
waistband) and the torso (the waist, the ribcage and everything above it) —
keeping each part's own internal detail and re-cutting only the *boundaries*
between parts, by height. So the body behaves like an artist's adjustable doll:
whole parts move, and the joints are absorbed by the narrow bands of skin between
them.

The bands are the places a batter's body really hinges. The hip crease is placed
on the hip joints themselves (the thigh bones rest at rig 1.158), which is where a
doll's legs hinge — the legs give there, as blended skin. The neck is placed the
same way, on the neck joint (the neck bone rests at rig 1.885), so the batter's
look turns the *head* as a block instead of wringing the neck: see "the head turns
as a block" below. The belt is not a band at all: it is *cut open* (see below),
because the belt is where two pieces of clothing meet. Where that is, on any given
player, is **read off the model**: the uniform's own trouser band in the model's
base-color texture (rig 1.258-1.293 on this one) is what the swing's
hip-to-shoulder turn reads against.

### The twist's height is read off the model, not hard-coded

The belt sits where the uniform's trousers meet its jersey, and that is a
property of the *model*, not of the animation. So `measureWaistband` in
`src/util/playerRig.js` reads it at load time, before anything is cut:

- **The window** is the model's own skeleton — the hip socket (`thighL`'s rest
  height, rig 1.158) up to half way to the neck (rig 1.522). A waistband is
  between the hips and the ribs, and stating the window as a share of the model's
  own hip-to-neck span keeps it right for a rig of any proportions.
- **The samples** are the *trunk's* vertices only — the ones the model's own
  skinning weights to a spine or pelvis bone — so a sleeve or a shoe drawn in the
  same trim colour is not mistaken for the waist. Each one's UV is looked up in
  the model's base-color map (the texel its UV falls in, not a filtered blend, so
  a vertex on a boundary is not half one colour and half another).
- **The rule** is the lowest run of heights where most of the ring (≥ 50% of the
  samples) is drawn in the uniform's trim colour, at least 0.02 and no more than
  0.12 rig units tall. Half the ring is what separates a waistband from a
  *stripe*: the trouser stripe is trim-coloured at every height but covers a
  sliver of the ring, and taking the *lowest* run keeps a chest trim from moving
  the twist up. The rule is the exported `waistbandFromShares`, and it is tested
  on synthetic profiles in `test/waistband.test.js` — a belt under a stripe, a
  gap between two bands, a panel too tall to be a belt.
- **What it finds on this model**: 314 trunk samples, and the band 1.258-1.293
  rig units — 50% of the ring in rgb 0.75, 0.33, 0.18, the uniform's belt red.
  The recorded 1.26-1.30 was measured by eye when the cut was built; the read
  agrees with it to 0.007, and it is the read the driver uses.

If the texture cannot be read — a model with no base-color image, or a canvas a
browser will not hand back pixels for — the band falls back to the recorded one
*restated in the model's own proportions* (14% and 20% of the hip-to-neck span,
which is 1.26-1.30 on the model those numbers were measured on). The driver
reports which it used, so the suite can require the read rather than the fallback
(`the twist reads at the waistband, on a band the width of a joint`: it pins the
band's window to the model's own metrics, the trim colour it found, that the band
still sits on the belt the recorded numbers described, and that the twist reads at
the band's own top edge).

### The head turns as a block, hinged at the neck

The batter's look is the largest *relative* rotation in the animation: the set
stance closes the chest to the plate while the head watches the pitcher, and
the driver writes that look on the neck bone (rig 1.885). Where it is absorbed is
what the neck looks like. Left to the model's own weights it was absorbed
badly, in two ways at once:

- **There was no rigid head.** The model's own skin only reaches the head's bone
  (`spine006`) by 1.94, and blends the ribcage into it from 1.87 — so the top of
the head was still turning a fraction of the way behind the look.
- **The trapezius turned with it.** The model spends 20-70% of the trapezius —
  skin at the *shoulder joints'* own radius (0.28 rig) — on the head's bones, so
  the look dragged the top of the chest round with the neck. That is the neck
twisting like a towel.

So the head is a part of the body like the pelvis and the torso (`HEAD_BONES`, on
the neck and head bones, which the driver turns together), and it is cut in the
same way — with two model-derived answers rather than a radius someone picked:

- **Where the joint is**: the neck band is the neck joint's own neighbourhood,
  1.845-1.925 — the neck bone's rest height ±0.04, the same 0.08 the hip crease
  is given.
- **Which skin turns with it**: a vertex keeps the head's motion only where the
  model carried it on the *body* rather than on the arms (its arm bones, the
  clavicles included, under half of it). That is the line the model itself draws:
  the neck's own skin is weighted to the spine and the head, and the trapezius to
  the clavicles.

Measured on the cut (`the head turns as a block, hinged at the neck, without
wringing the chest`, and the bands test's `head/torso` row): the skin that blends
the head and the torso runs **rig 1.873-1.897** — inside the band, and only there,
so nothing else in the body is still partly the head; the head's own skin carries
no other part's bones and no other part carries the head's (leaks 0.0000 in all
four parts). What the band takes, per phase, is the look on the neck's thin skin:

| phase | head/torso band | its own skin |
| --- | --- | --- |
| stance | 0.293 rig (366%) | 0.262 rig (327%) |
| mid-swing | 0.093 rig (116%) | 0.081 rig (101%) |
| contact | 0.029 rig (36%) | 0.025 rig (31%) |
| follow-through | 0.029 rig (36%) | 0.025 rig (31%) |
| recovery | 0.129 rig (162%) | 0.113 rig (142%) |

The stance is the worst phase and that is the *pose's* number, not the cut's: it
is the one the animation asks for the biggest look in, and a wider band would only
lower the fraction by spreading it into the chest — the towel again. The suite's
bound for it is 4.2 (418%), against the hip crease's 2.6.

### How much the band stretches, measured

Rigid parts joined by a thin strip of skin mean *all* of a joint's motion is
absorbed by that strip, and a strip can only stretch. So the suite measures it
(`probeStrain` in the harness, read by `the bands report how far the parts pull
the skin between them`): for every vertex whose weights straddle two parts, where
the vertex would be if it followed each part alone, and the distance between those
two answers — the gap the band's skin has to span, in rig units and as a fraction
of the band's own width. Only the hip crease is left to report; on the tuned
animation:

| phase | hip crease | of its 0.08 band |
| --- | --- | --- |
| stance | 0.022 rig | 28% |
| mid-swing | 0.164 rig | 205% |
| contact | 0.165 rig | 206% |
| follow-through | 0.120 rig | 150% |
| recovery | 0.138 rig | 173% |

The hip crease's number is the hip joint's own rotation spread over the strip:
that relative motion is exactly a rotation about the hip socket (46° at mid-swing
on the drive leg), so its gap is 2 sin(23°) times a vertex's distance from the
socket — up to 0.2 rig units out at the buttock and the crotch, where the body is
widest. It is therefore the *pose's* number and does not move with the drive.

### The belt is cut open, with a sleeve hidden under it

The belt used to be a band of skin like the hip crease, and it was the worst thing
in the model: 174% of its own height at mid-swing, and 582% before the drive was
given to the pelvis. Neither number was a rotation — the hip crease's is, which is
why it is the one that stays — so `cutBeltAndSleeve` in `src/util/playerRig.js`
stops pretending the belt is skin. The surface is cut open along the belt's own
top edge (rig 1.293 on this model, where the uniform draws the jersey's hem):
every triangle the
cut plane crosses is split along it, each side of the cut gets its own vertices,
and the weight rule becomes a hard split there — the trousers and the belt with the
pelvis, the jersey with the torso. Nothing spans the cut, so nothing there can
stretch, and the hem slides over the belt the way clothing does.

Under the opening sits a sleeve: a duplicate of the body's own surface either side
of the cut, inset toward the body's axis and weighted rigidly to the pelvis, so
there is no hole to see the body's inside through. Two of its three numbers are
measured in every phase (`probeSleeve` in the harness, and the ring the driver
keeps from the cut):

- **How far past the cut it runs** (0.09 rig units) has to exceed how far the two
  sides of the cut drift apart *vertically* — at most 0.026 rig at mid-swing. The
  cut's own edges barely separate, and not because the parts agree: a spin about the
  body's up axis carries a ring perpendicular to it onto itself, so the turn moves
  each point of the edge *along* the edge (0.077 rig of drift at mid-swing, all of
  it tangential) and what opens the seam is the swing's lean, not its turn.
- **How much smaller than the body it is** (25% of its radius) has to exceed how
  far the swing carries the jersey's surface *inward* past the belt — 18.1% at
  mid-swing. This is the number worth recording, because 8% looks like "slightly
  smaller" and is not enough: the waist's section is half again as wide as it is
  deep, so turning it by the swing's 29° sweeps its widest angles inward, and a
  sleeve that is only 8% smaller is poked through by the hem it is hiding under.
  (`the belt is cut open, with a sleeve hidden under it` computes both numbers from
  the ring and the phase's own separation, so the inset cannot be shrunk back.)

What the sleeve does *not* change is the picture: the seam's own edges coincide as
curves, so the visible difference at the belt is the belt holding still while the
hem turns over it — under the suite's 0.2% pixel tolerance for a whole pose, which
is why the belt also has two cropped baselines of its own (`the belt, close up`,
compared at 0.1% of a 240×130 crop) and why the numbers above are the real pin.

### The drive moves the pelvis, not the torso over it

The belt's number was 582% before this and it was a translation: the component
authors the upper body coming forward over the hips (its own forward drive, ~0.33
rig units at mid-swing, on top of the hips' ~0.45), and written on the torso that
is a slide *between* two rigid blocks — a band of skin can only answer a
translation by stretching, and the belt band is 0.08 rig units tall. Given to the
pelvis instead, the whole lower body travels forward *with* the torso: the two
blocks keep their distance, and the chest lands in exactly the same place either
way — the share is turned by the pelvis's own accumulated rotation, the same turn
the chain would have given the torso's offset — so the swing's geometry, the arm
solves and the bat's contact are untouched (the arm stretch reads the same to
three decimals).

The drive's footing is a place on the *dirt*, not a place in the batter's turning
frame. The rear shoe is the plant the swing turns on, so its footprint — the ball
of the shoe, where the stance plants it — is authored once in the ground's own
frame, and the ankle is authored about it: the shoe pivots on its ball as the hips
open, so the ball stays on the dirt and the ankle swings round it rather than the
other way about. Authored in the batter's frame instead, the drive carried it:
measured, the rear shoe slid **0.26 rig** across the dirt through the swing, and
the shoe sat 0.034 rig *in* the dirt besides (it was never quite standing on it).
Planted, it moves only by the tuning's own push forward along the line it stands
on (`legBackPushForward` 0.05 rig) plus the shoe's own levelling roll (0.018
measured), and the toe stands at **0.021 rig in every phase** — the set stance's
own height — while the rear ankle holds **0.106-0.113** instead of riding up.

What keeps the batter from walking off that footprint is the bound in `Batter.jsx`
(`rearPlanted`), and it is the leg's own geometry: the pelvis's ride forward and
its turn are read *together* against the socket's own place over the footprint,
because the rear leg has one span to cover both with. The tuning asks the drive to
carry the body **0.762 rig** by contact; the planted rear leg spans **0.365** of
it, and what it cannot span it does not take. Neither does it take a turn it
cannot hold: the legs are posed again on the turn that survives, and the extra
rotation is simply not taken by the pelvis — the chest's own opening moves no
socket and is untouched, so the belt takes the difference. The ride that survives
is handed to the contact geometry, which re-fits the bat to it (0.74 m of bat, the
sweet spot 0.789 of the way up it, on the ball to 3 mm).

The shoe's own give is in that bound too, and only as far as the leather can tip.
A shoe that tips onto its ball swings its toe box down through the dirt —
measured, 0.2 rad of tip leaves it 0.02 rig under and 0.65 rad leaves it 0.135
under — and the driver's ground rule answers anything under the surface by lifting
the whole foot, which takes the toe 0.126 rig up off the footprint it was planted
on and stands the rear ankle 0.21 rig above its own stance. So the bound reads the
tip no further than `REAR_BALL_TIP` (0.2 rad), past which the *pelvis* gives
instead, and the rear shoe holds its sole level on the dirt besides (the driver's
`leg.flat`): a sole left to bank with the leg's own turn stands on a corner
(0.03 rig of it) and the ground rule lifts the foot to stand it on the surface. `rollFootOnToe` in the driver still turns the ankle about the
shoe's own toe — the point the tuning plants the ball of the foot on, hinged on
the axis a foot actually flexes about — and its own rules are unchanged: it stops
with the ankle over the toe, it is skipped for a foot the roll pulls *away* from
the hips (the front foot, which the tuning lifts on purpose), and an ankle the
hips have outrun further still lifts the rest of the way, so the leg cannot
stretch. What the rework changed is that the bound above never asks it for more
than the shoe can tip without leaving the dirt, so the roll is the emergency it
reads as here rather than the drive's everyday answer: measured across all six
phases, the rear shoe is planted (`lifted` 0.001 rig) and never rolled at all. `the feet stay on the ground through the drive`
bounds the feet from above as well as below and requires the lowest toe to stay
down, so the pivot cannot quietly become a levitation again.

### The lead foot stays flat, opens with the hips, and lifts its toes at the finish

The lead foot is the swing's anchor, so it may not give the way the pivot foot
does: its **heel stays on the dirt all swing long**, it **turns with the hips**,
and only at the finish does the **toe** end come up. Three tuning values say so —
`legFrontUnplantLift` **0.03** (was 0.08: the foot no longer floats as the drive
fires, and the little that is left is the leg's own elbow room rather than a
levitation — the ground rule lands the shoe on the dirt either way), `frontFootPivot`
**1** (was 0.2: the shoe takes the whole of the body's turn instead of refusing
four fifths of it), and `legFrontToeLift` **0.18 rad** (new: the toes tip up over
the ankle at the swing's arrival) — and one rule in the driver, `leg.heelDown`,
which the pose asks for on the lead foot alone.

`heelDown` does two things. It **skips `rollFootOnToe`**, so a leg the drive has
outrun cannot take its shortfall out of the shoe by pivoting it onto its toe -
which is what used to happen, and what read as a batter stepping out of his own
swing. And it keeps the **skid** as the fallback it now is: the ankle target slides
back along the ground until the leg spans it, at the height the pose asked for, for
any frame the pose's own sink below has not already answered. Two things about that
skid had to be measured rather than assumed. It runs **along the line the shoe
stands on** and not along the line to the socket: a shoe's edge bites sideways, and
the socket-line version dragged the lead ankle **0.12 rig across the box** by
contact, which is the batter's foot walking in toward the plate (`the front foot
steps straight at the front line` caught it; sliding along the length reads 0.000).
And it is **eased in**, because the shortfall arrives through a square root: a hard
handover made the lead knee swing **22° and back inside 5 ms** (0.285 s) and the hip
17° and back inside 50 ms (0.39-0.44 s), which `no joint turns back on itself`
refused. It is blended over `SLIDE_EASE` **0.04 rig**, which leaves at most half of
that on the table for the leg's own miss to take.

### The pelvis sinks onto the lead leg, instead of the shoe giving the drive its ride

That skid was the *solver* answering a pose, not the pose answering itself, and
what it was answering was the drive: the pelvis rides forward over a foot that is
planted, and at the contact the socket used to sit **further from its own footprint
than the leg is long** — 0.33 rig of over-reach on the build this replaced, all of
it coming out of the shoe. `poseLegs` now holds the pelvis inside the lead leg's own
span instead. For every leg the swing is *standing* on, the rule takes the socket's
horizontal offset from the footprint (the pose's own geometry, at the pelvis's own
yaw), asks how high the pelvis may be for that leg to reach it with `REACH_SLACK`
**0.04** of its 1.0576 rig still in hand, and sinks the pelvis by the deepest
answer — the legs share one pelvis, and the leg with the most to reach is the one
the crouch has to satisfy. It eases over `REACH_EASE` **0.04**, so the frame the
pelvis starts giving is not a corner in the body's height (see `idleCrouch` for the
same reason on the idle's flex).

Two details are load-bearing. It is a **geometry and not a number**: it holds on
every frame of the drive, at any drive distance, on either foot, because it is read
from the sockets and the targets that frame was just built from. And a planted foot
is measured from **the dirt** and not from its own target: read off the target's own
lift, the recovery's step-lift let the pelvis back up and the ankle came out 0.035
rig below what the leg could reach.

Measured over the whole swing, the lead leg is left **0.046 rig of its own span over
at the finish and 0.019 at its tightest** (contact, 0.38 s), and the driver's own
skid reads **0.000 at every frame of it** — the pose reaches on its own, which is
the whole point of the change. The hip and the knee each turn once in the swing
cycle (their budgets are 1) with no flicks. `the feet stay on the ground through the
drive` reads the lead foot **0.095-0.115 rig above its own heel** against the set
stance's 0.105, its toe **0.039 rig over that heel at the follow-through** where it
stands 0.020 at the set, and the shoe's own angle against the pelvis's line within
**6.3°** of its set-stance value across all six phases — the shoe turns with the
hips rather than holding its own line while the ankle carries the turn.
`the front foot steps straight at the front line` reads the front ankle **0.000 rig
across the box and 1.049 rig forward**, with the pelvis at world z 0.294 m, so the
step itself is untouched by any of it.

The sink is the **pelvis's**, and the whole body rides it down. The hips drop onto
the lead leg and the chest, the shoulders, the head and the frame the bat hangs in
all come with them: the joint between the two blocks the belt sits between turns and
does not slide (`PELVIS_DRIVE_SHARE` is all of the drive, and the waist is given no
translation at all), so `the body is rigid parts joined by narrow bands` reads the
pelvis-to-torso distance **0.281 rig in every one of the six phases** — where the
rise this replaced parted the two edges by the sink, 0.081 at the contact and 0.131
by the follow-through, and only the sleeve's own **0.14** of headroom covered it.
The rig's chest therefore sits `legs.reachDrop` **lower** than the tuning authored
it, and every consumer is handed the frame the body really has: the bat hangs in the
sunk frame and is raised inside it by the same sink, so the bat itself is exactly
where the contact geometry put it — `contact puts the sweet spot on the ball` still
reads **0.0151 m** off the ball's centre, where the bat left in the sunk frame reads
0.0377 m, the ball's own radius; the arm solve's own frame offset carries the same
drop, so the shoulder its elbow hints are read from is the live one; and the legs
are solved onto the same sunk hips, which is the sink they asked for in the first
place. The hip's forward ride is untouched, the lead foot never skids (the driver's
own skid still reads **0.000** at every frame of it) and no shoe rolls onto its toe.

What the drop *is*, then, is a lower body — which is worth saying, because it is
what the pose is for. The hips go down onto a front foot the batter has already
planted, as a hitter's do, and the swing's reach into the bottom of the zone comes
with it: the shoulder is `legs.reachDrop` nearer a low pitch than it was, and a
two-bone arm is exactly what runs out of reach first down there.

The two other answers are worth recording, because both were measured. Leaving the
bat in the sunk frame carries it down with the body and misses the pitch by the
whole sink (**0.047 m** at the contact). Lifting it out of a sunk frame whose chest
has *not* sunk with it is the same distance the other way round — the grip comes
`reachDrop` nearer the shoulder than the pose has it — and the trailing arm, whose
chord grazes its span through the follow-through, answers by folding **27° inside 50
ms** where the pose asks it straight: `no joint turns back on itself` read that as a
flick at 0.405 s and 0.460 s. Handing the frame its own drop is the third answer and
the one the pose takes: the arms are solved from the shoulder the body really has to
the handle the bat really has, the elbows' hints are read from that same live
socket, and the whole swing cycle turns **0 flicks** on every joint of it.

The fold is the two-bone solve's own **square root**: a two-bone chain's elbow angle
is the angle of a triangle whose legs are the bones and whose base is the chord, so
near full extension the bow grows as the root of how far the target sits inside the
span — an arm a centimetre inside it is *already* visibly bent. The pose has one
place where it comes inside: through the follow-through's pinch, at 0.46 s, the
trail arm's chord reads **0.9979 of the span** — two millimetres, where the pose's
own chord (with the shoulder at rest) is 1.12 — and the elbow paid for it in a 2.4°
turn over 15 ms that the pose never asked for. The solve now takes that whisker out
of the **chord** rather than out of the elbow: for the first `ELBOW_FOLD_SLACK`
(**0.006**) of the shortfall the chord the bones are solved against — and aimed at —
is held out to the arm's own span, so the arm is straight across the pinch, and the
shortfall comes off in full beyond it (the curve is flat at both ends, so the
elbow's angle is a plain function of the chord on either side and neither side turns
over where they meet). The hand keeps the difference, and it is under **1.3 mm** at
its worst, on a fist closed on a handle.

The other half is the *clamp* every two-bone circle carries: the reach is clamped
just inside the two bone lengths so a target at the very end of the chain leaves a
circle to walk rather than a point, and at 0.999 that clamp was also a millimetre the
arm could not cover — everywhere the pose had the wrists stretched past the arm's
own length, which is the whole outward half of the swing. The hand landed that far
short of what it was aimed at, and near full extension the angle at the elbow turned
that fraction into **0.7° of drift** as the pose came back off its stretch: a turn
the joint never made. `MIDDLE_CLAMP` is **0.9999** (0.04° of drift) — as tight as a
walk on the circle can stand, and the elbow's real reserve is the shoulder's
(`ARM_SHOULDER_BEND` 0.97), not this.

Measured over the cycle, the trail elbow reads **4 turns of its 5** and the lead
**6 of 9**, with **no flicks anywhere** on any joint. The fists hold the handle, the
arms solve onto the bat in every phase, the hands stay clear of the torso and the
trail arm still comes round the chest rather than across it — the same tests that
would show an elbow a centimetre adrift. What the tighter clamp does move is where
the elbow *is* where the arm is stretched (it sits on its own line instead of on the
old clamp's bow), which the pose baselines pin.

What that costs is the **belt**, and the belt is cut for it. The surface is cut open
along the belt's own top edge with a band of the same surface hidden under it, so a
hem that stands with the chest while the hips drop does not tear anything — it
*slides up over the belt*, and what shows under it is more jersey. The seam's own
opening is the sink: **0.000 rig** at the set stance (no drive), 0.063 at mid-swing,
**0.081** at the contact and **0.131** at the follow-through, and the hidden sleeve
is cut to cover it (`SLEEVE_MARGIN` **0.14**, up from the 0.09 that covered only the
spin's own fraction of a face). Both of the belt's own tests read that seam in every
phase: `the belt is cut open, with a sleeve hidden under it` opens it against the
sleeve's coverage, and `the body is rigid parts joined by narrow bands` now holds the
two blocks' parting to the same number rather than to a flat 0.02 rig — the 0.465 rig
the drive once tore the belt open with is still refused, and the *shear* rule
(the pelvis and the chest differing by a spin and by nothing else) is unchanged and
still holds to **1°**.

What the drive decides is *which* skin absorbs it and in what shape: the weights
alone cannot tune it away, and the band's width and the drive are the other
levers.

The hip's relative motion being a rotation about the socket is also the reason a
horizontal band is the worst shape for it: the strip runs *across* the rotation's
axis, so the rotation shears it.

Reshaping the band does not get away from that, which is worth recording because
it looks like it should. A band on a sphere around the socket, weighted by the
angle around the hip's axis — a ball joint — was tried and measured: the weights
change, the numbers do not (224% before, 224% after, leaks still 0). The reason is
that a *continuous* surface has to carry the parts' motions across some surface
that separates them, and only a surface of revolution about the rotation's own
axis slides under that rotation without stretching; a sphere around the socket is
not one, and where it hands over to the height rules it has to agree with them
(the hip band's midpoint is the socket's height), so it ends up saying what the
height rules already said.

The way a real joint manages it is by *overlapping*: the ball sits inside the
socket and the two surfaces slide past each other, so neither has to stretch. On a
single closed surface that means adding the second layer — a sleeve under the
part above it — which is the puppet's answer rather than the skinning's.

The pelvis also has to *tilt with the torso* as the batter leans, which is what
makes it a part rather than a hinge for the legs: the legs give at the hip crease.
The component authors one lean for the whole upper body, so the pelvis, the waist
and the ribcage all carry it, and the pelvis is that block rolled back about its
own (leaning) up axis by the swing's separation — the joints then land where a
rigid torso hinged at the hip puts them. The upshot is the invariant the suite
pins: the pelvis and the chest may differ by a *spin* about the body's own up axis
and by nothing else — and, since the drive is carried by the pelvis, the *distance*
between the pelvis's joint and the torso's base has to stay the rigid offset it is
at the set stance (0.281 rig units, measured off the posed skeleton in every
phase). The drive written on the torso alone slides it 0.109 further out at
mid-swing and fails that check as well as the band's. A pelvis left upright while the torso bends over it is a
*shear*, which tips the body's up axis by the lean itself — that is the failure
that dragged the belt down the stomach, and reintroducing it fails the suite with
a 21° shear at mid-swing. The same test pins the residual cross-part weight inside
each part, the bands' heights and widths, and where the twist reads (the band's
50% contour, which has to stay on the waistband).

### The stance is squared, the stride is straight, and the batter stands deeper

The drive carries the whole one-piece body forward — hips, pelvis and torso
together, which is the previous section's result and not negotiable — so by
contact the batter has travelled **0.34 m** toward the pitcher (the pelvis' own
place on the dirt, taken off the posed skeleton from the set stance to the ball;
it was 0.198 m before the drive was re-authored — see *The drive's forward travel
is the rear stance's own pocket* below). Two things had to
follow from that.

**The stride.** The set stance is *squared*: both feet on the batter's own
centreline, one behind the other, so the line through them runs straight at the
front line of the box. The tuning's own footprint, turned by a stance that faces
the plate, staggers the feet *sideways* as well — each foot under its own hip
socket — and a step between two staggered footprints has to travel across the box
as it goes forward. That diagonal is what put the batter's foot beside the plate,
over the plate's own depth and out past the box's inner line. Squared, the front
foot's step reads **0.005 rig units across against 1.05 forward** (it was 0.095
across against 1.09), the two ankles start **0.000 rig apart across the box**, and
in every phase both ankles stand at |x| = 0.447 m, 8 cm clear of the box's inner
line, which the rulebook draws six inches from the side of the 17-inch plate
(0.368 m) — it was 0.407 m, 4 cm clear, before the setback below. The ankles are
what the test checks rather than the toes: the shoes point in at the
plate, as a batter's are, so a shoe *tip* crosses that line while the foot it
belongs to stands inside it.

**The depth.** `NOMINAL_STANCE_Z_M` went from 0.75 to 1.15 of the reference
sprite's own units, and then the whole stance was set back 0.10 m further along the
line from home plate's own centre out through the batter (see below): that is
another **0.092 m deeper** and 0.040 m further off the plate, on top of the
reference sprite's own 1.15. That is what the sweet spot asks for, now
that the bat hangs in the frame the whole body travels in. At the old depth the
ball came 0.10 m *inside* the bat's own reach at contact and met the barrel at 59%
of its length instead of the 78% sweet spot; deeper, the ball is the sweet spot's
own distance from the hands again and the contact frame reads **contact at 78.7% of
the barrel**, with the sweet spot 0.015 m from the ball — the 1.5 cm that is left
is the animation's own drive lean (`DRIVE_LEAN`), which the geometry does not carry
(see the note under that constant). The batter also drives *behind* the plate
rather than over it: at contact the pelvis is at world z **+0.340 m** (the plate
spans -0.432 to 0).

**The setback, and what pays for it.** The batter used to stand with its own
centreline on the box's inner line — as close to the zone as the rulebook allows,
0.039 m clear of it, which left the bat's path that close to the body too. The whole body is now set
back 0.10 m **along the line from home plate's own centre out through the batter**,
which is the line the stance's *facing* is measured along: stepping back down it
leaves the plate exactly where it was in the body's own frame, so every angle the
animation was tuned at — the facing, the swing's whole turn, the lean over the
plate, the drive's 0.31 m and its direction — is the pose it was. Measured, the
posed skeleton at the set stance reads digit-for-digit what it read at the old
position, the set turn is the same **-89.68°** (the hips' and the chest's), and the
contact frame still opens to 21.8° with the finish at -3.2°. One number covers the
box's two directions because on that line they are one: deeper in the box *is*
further off the plate.

The bat pays for it. The model reaches the ball *with the bat* — the hands are
placed a share of the way there and the bat covers the rest — so a stance further
back is a longer bat, which is the shape the request wanted anyway. The bat's own
length goes **0.967 -> 1.116 rig units**: rendered, **0.600 m -> 0.692 m** against
a 1.25 m-tall batter (a rig unit is 0.627 m on a 6'0" one), i.e. 48% of the body
to 55% (a real bat is 46%). The ball stands **1.956 -> 2.106 rig from the bat's own
handle** — the distance the longer bat is covering. That is also the limit on how
far back the batter can stand: `BAT_LENGTH_MAX` (1.18 rig) is where the growth
stops being the bat's and starts being a sweet spot that can no longer reach the
ball, and 0.10 m leaves the fixture pitch's own 1.116 a 5% margin (0.15 m needs
exactly 1.180, on the clamp, so the first pitch further away would come off the
sweet spot).

`the batter stands back off the zone, and the bat pays for it` measures the three
things that moved, each at the pose it shows in, and each against the numbers the
setback *removed* reads so that standing where the batter used to cannot satisfy
it: the ankles' clearance over the box's inner line **0.079 m** at the stance and
**0.076 / 0.056 m** at contact for the front and back ankle, against **0.039 /
0.036 / 0.016 m** without it (the back ankle is the tightest because the drive
rolls it up onto its toe, which carries it inboard); the rendered bat **0.692 m**
against **0.600 m**; and the ball **2.106 rig** from the bat's own handle against
**1.956**. The sweet spot still lands on the ball at the longer bat, which is the
test next door.

Two things the move broke, both fixed and measured. **The finish's hands rode the
pitch**: the follow-through's grip height was authored as an offset from the
contact grip's, and the contact grip's own height rides the ball's depth — 0.09 rig
of it put the trail forearm 5 mm inside the ribs at the follow-through, where it
had read 0 of 116 vertices. It is now pinned at the height that pose was tuned at
(`FINISH_HANDS_Y`). **And the contact grip carried the hands out after the ball**:
`handExtension` is a *share of the way* to the ball, so the same 0.35 sent the hands
out with it and stretched the trail arm to its own span at contact (its palm came
0.026 rig off the handle against a 0.01 bound). At **0.274** the hands sit the same
0.355 rig in front of the torso at contact as they always did, and the 0.13 rig of
extra distance goes to the bat instead — the palm reads 0.005 rig and the contact
pose is the arm pose it was.

**The facing.** Standing deeper exposed a latent bug in the set stance's turn.
The stance faced a *point* fixed in the world (a fraction of the way from home
plate to the catcher), which only works while the batter stands in front of it:
0.25 m deeper puts him level with it, and the direction to it swung the stance 34 degrees
round to face the pitcher. Since the swing's whole body turn is
measured from that yaw — the contact yaw is an absolute value (`bodyOpenMax`), not
a relative one — the swing's 90° of body turn silently became 56°, which is what
the recovery test caught. The stance now faces a *mix of directions* instead (to
the plate's centre and to the catcher, by `setFaceBias`), which carries with the
batter: the set turn reads -112.10° where it read -112.6°, at any depth in the
box, and the bias means what it always did (0 faces the plate's centre directly,
0.5 the plate→catcher midpoint).

### The hands come back around the body, not through it

The arms are solved onto a grip that rides the bat, so the path the hands take
between poses decides whether they are in front of the torso or inside it. On the
way *out* they always were (the swing's own control point bulges forward, and the
contact and mid-swing frames read the forearms 0.25-0.31 rig *clear* of the
trunk). On the way *back* they were not: the recovery ran them home on a straight
line from the finish pose to the load position, which is a line through the chest
— **91 of the arm's 116 skin vertices** inside the trunk at the midpoint of the
recovery window, worst **0.17 rig units (0.10 m) deep** — and both follow-through
elbow targets were tucked behind the torso's front surface.

Three changes, measured per phase by the harness's `probeTrunk` (which reads the
posed *skin*: for every vertex the forearm and hand bones carry, which side of the
nearest piece of trunk skin it is on, and how deep): the recovery bulges forward
like the swing does (91 → 4 vertices inside, 0.17 → 0.015 rig); the finish keeps
both elbows outside the trunk — the lead elbow alongside the ribs, the trail elbow
across the chest but in *front* of it (20 → 5 vertices, 0.030 rig); and the loaded
hands sit a little lower and further out at the back shoulder (0.36/1.90 → 0.44/
1.78, where 1.90 had the gloves up in the collar: 38 → 5 vertices, 0.187 → 0.031
rig). Every phase now reads a depth no worse than **-0.021 rig (1.3 cm)** — the
probe's own floor, i.e. skin contact and not intersection — with the swing frames
clear by a quarter of a rig unit and the *trail* arm reading **0 of 116 vertices
inside the trunk in every phase** (the lead arm rides against the chest through the
follow-through on purpose: it is the arm the swing brings across the body).
`the hands stay out of the torso, through the swing and all the way back` pins the
depth, how much of the arm may be on the wrong side at all, and that the trail arm
is never inside, phase by phase.

### The upper arm on the pitcher's side is in front of the torso too

That probe reads the forearm and the hand. The *upper* arm is the rest of it, and
it is the half of the arm a swing lays across the chest — the half a batter cannot
see, because the jersey's own shoulder cap covers it, so it can be sunk into the
ribs while the sleeve still looks attached. `probeTrunk` measures it in its own
pass (every vertex the upper arm's own bone carries, past a skirt at the shoulder)
and the pose is held to the same rule as the rest of the arm: in front of the
torso, or touching it.

It was not. A batter's elbows are flared out to the sides and down, which is how
they are authored — but the hints are written in the body's **own turned frame**,
and the set stance faces the *plate*, broadside to the pitcher, so "out to the
side" at the load is exactly where the torso is. With the clearance term authored
that way the arm on the pitcher's side sat **5 of its 34 skin vertices inside the
ribs at the loaded stance, worst 0.042 rig (2.5 cm) deep**, and the probe's own
trunk floor read -0.032 (an arm through the ribs is itself the deepest reading in
the frame). Riding the chest's own outward normal instead reads **0 vertices
inside, the nearest skin at the surface**. The finish gets the same treatment along
the pitch's own line: without it, **16 of the 34 vertices are inside at the
follow-through** (9 of them on the pitcher's side, worst 0.059 rig) and with both
elbows finishing *in front of* the chest **4 are, the worst 0.024 rig** — an arm
lying against the body. `the arm on the pitcher's side stays in front of the torso`
pins the depth against the probe's own floor in every phase, with a small
allowance for exactly that contact at the finish.

#### The skirt the measurement starts at is most of the story

Those 34 vertices were the last sixth of the upper arm. The pass skips everything
within a skirt of the shoulder joint — the deltoid's cap really is continuous with
the trapezius, so at the joint the arm's own skin *is* the trunk's surface — and
that skirt was set at **0.85 of the upper arm's length**, which measured only the
skin next to the elbow. The bicep could sit inside the ribs while the reading said
the arm was clear: at the loaded stance, with the skirt at 0.5, **15 of the lead
arm's 231 skin vertices are inside** (worst 0.043 rig) where 0.85 showed 0. The
depth it reported was real all along (the deepest vertex is always past 0.8 — a
chord from a shoulder to a grip crosses the chest most of the way along), but the
*share* was not, and the share is what tells you an arm is lit by its own sleeve
and sunk in the chest.

The skirt now sits at **0.5**: past where the deltoid's own cap ends, over the
bicep the eye reads as the arm. Against that measurement the load's own two levers
were retuned — `ELBOW_FRONT_LOAD` 0.24 → **0.5** and the lead arm's flare 0.3 →
**0.45** — and the loaded stance went from **15 of 231 vertices inside to 1**, the
recovery and the load end of the reset to 0-1, with the swing's own frames
unchanged at 29-37. Past those values the arm folds back onto the chest (5 at 0.6,
14 at a 0.6 flare), so they are measured values, not chosen ones. The follow-
through's trail arm is the one that stays buried (**25 of 229, worst 0.053 rig**):
that arm is a straight chord from its shoulder to a grip on the far side of the
chest, and **no elbow hint has authority over a straight arm** — it is open.

#### The test is the eye's test, not the surface's

An arm lying *along* the chest is outside the surface and still covered by it, and
that is the reading the eye makes. So the suite measures it directly:
`probeCover` projects the posed skin onto a view, and for every upper-arm vertex
asks whether some body vertex is nearer the camera and lands on top of it — a
z-buffer test against the body's own vertices, with the eight neighbouring cells
claimed too so a vertex cannot hide beside the one covering it. `the upper arms
are not hidden behind the torso` runs it from three views — the suite's own
three-quarter shot, the pitcher's side of the plate, and the game camera's view
from behind it — and holds the hidden share to 8%, 8% and 20%.

### The trunk starts the swing turned toward the arms

The arms are held toward the pitcher's line (that is where the bat has to come
through); the set stance faces the *plate*, which is broadside to the pitcher. The
angle between the two is the separation that has to go somewhere, and where it
goes is the upper arm: the further the trunk faces away from where the arms are, the
more of the arm has to lie across the chest, and the more of it the torso covers
from the pitcher's side.

The set stance is **112° off the pitcher's line** in the fixture's tuning. The new
`settings.stanceArmFacing` turns the trunk that share of the way from the
plate-facing yaw toward the pitcher's line — 20% of it, so the stance now sits at
**89.7°** — and the **pelvis turns with it by the same amount**, so none of it
lands in the waist as twist. It is the same yaw the whole swing is measured from,
so the body is already this far round before the stride and the reset unwinds back
to it (measured: **-89.7° at the set, -87.1° nine tenths of the way home**).
`the trunk starts the swing turned toward the arms, not away from them` holds that
band at both ends and holds the pelvis to the trunk within a degree.

The share is bounded at both ends, and it is the pose that puts the bounds there.
The pitcher's own view of the arms wants the trunk turned — with the grip in front
of the chest, the *trail* arm reads **91 of its 198 skin vertices hidden** at a
plate-facing stance, and **26-31** with the trunk turned a fifth of the way toward
him. The set wants the opposite: at 38% the trunk sits **69.5°** off his line and
the stance stops reading as a set. Measured, with this turn in place, of the 396
upper-arm vertices:

| view | loaded stance | mid-swing | contact | follow-through | hold |
| --- | --- | --- | --- | --- | --- |
| suite's three-quarter | **0** | 0 | 0 | 0 | 0 |
| pitcher's side | **31** (8%, at the bound) | 0 | 1 | 1 | 0 |
| behind the plate (the game camera) | **9** | 32 | 18 | 43 | 67 |

The loaded stance is the one the eye reads, and a fifth of the trunk turn is what
keeps it there while the grip sits in front of the chest: from the suite's own
shot the torso covers nothing of either arm at any phase, and from the pitcher it
covers 8% of the trail arm's own vertices at the set, the arm that holds the bat
in front of a chest that faces away from him. The turn is **not** a fix for an arm
*inside* the torso — the pose is authored in the body's own frame, so the trunk's
yaw cannot change the arm-vs-chest geometry, only where the arms can be seen from
— and the swing's own burial above is untouched by it.

### The set holds the bat in front of the torso

Where the grip *is* is what the lead arm's own reach has to span. The set used to
hold the handle out over the trail shoulder (0.36 off the midline, 1.90 up, 0.15
forward), which points the lead arm across the whole chest — the one direction it
has no room in — and the arm paid for it by going straight: **98% of its span, the
elbow locked out, the hand 0.68 rig across and 0.67 rig behind its own shoulder**.
It now sits at the *front* of the torso — **0.05 off the midline, 1.70 up, 0.50
rig forward** — and the same arm reads **78% of its span**, bent, its elbow 0.11 rig
in front of its shoulder, with the bat 0.32 rig further toward the pitcher than it
used to sit.

Height and depth are a trade, and this is the corner of it that holds every bound
at once, measured off the posed skin at the set:

| grip | lead upper arm inside | trail arm hidden from the pitcher |
| --- | --- | --- |
| 0.20 / 1.82 / −0.42 | **1** of 233 | 91 of 198 (23%) |
| 0.30 / 1.66 / −0.50 | **18** of 231 | 21 of 198 (5%) |
| **0.05 / 1.70 / −0.50** | **0** of 232 | 26 of 198 (7%) |

The lead bicep wants the hands **high** and the pitcher's view of the trail arm
wants them **low**; carrying them half a rig forward of the belly is the third term
that lets both hold, and the trunk's own turn is what turns with them. In front of
the chest, in front of the shoulder, and out toward the pitcher: the lead arm no
longer has to go through the torso to reach its own bat.

### The swing keeps opening after contact, until the chest faces the pitcher

Contact is not the end of the body's turn. A batter's chest carries on round
through the follow-through and finishes on the pitcher's line; the hold drifts a
little past it, the arms' own momentum still carrying the body. That continued
turn is also what makes room for the arms — a swing whose body stops turning at
contact folds them across a chest that has stopped moving.

The finish's turn used to be read as a magnitude, so it always subtracted the same
way as the contact turn and every value put it *short* of the contact turn: the
chest went **back** from 21° short of the pitcher at contact to **37° short** of
him at the finish — the swing visibly stalled and then closed up at the exact
moment a real one is still opening. The lower body came with it only to the 0.9
factor the hips lead the shoulders by *into* contact, which left the pelvis
**11.2° behind the chest** at the finish — a waist band with a turn to absorb.
Read along the pitcher's own line and taken past 0, the same read now gives **21.8°
short at contact → 27.0° past at the finish → 31.3° through the hold → 31.3° at the
peak** of the window, with the hips within **1.7° of the chest** from the finish on
(`settings.fullOpenYaw` −0.45). How far past him the finish goes is not the body's
to choose: the bat's own carry is written against the trailing arm's reach (see the
carry sections below), so it is the *shoulders* that bring the knob round to the
plane through the lead shoulder, and the turn above is the turn that buys. Carrying the pelvis further still
there — `followLowerOpenFactor` above 1, so the legs lead the chest past him — is
what the feet bound stops: at 1.15 the front leg is outrun by a pelvis its own
width further round and the lead shoe is left 0.274 rig off the ground at the
follow-through, against the 0.24 it is allowed. The whole lower body opening with
the chest (1.0) is as far as a planted lead foot goes.
`the swing keeps opening after contact, until the chest faces the pitcher` samples
four moments rather than one (the failure is a monotonicity, not a number), and
requires the hips to arrive with the chest in each of the three post-contact ones.

### The swing hands the bat to the follow-through on the move

The swing's own path is the stat-driven one — the bat's tilt and its attack angle
are read off the swing's plane and the ball's line — and it used to run up to a
handoff that let it *arrive and stop*: the ease that drives it reached the ball
with a slope of 0, so the bat met the pitch at **4.86 rig/s** and then had to be
collected by the follow-through, whose own curve leaves the contact pose from
rest. The bat's direction therefore turned in one frame — **82.1°** between the
samples either side of contact — and the two phases read as two movements.

Two changes, and they are separate: the swing's own ease now *arrives* on the ball
at its own largest slope (see `SWING_EASE` below), and the stat-driven curve now
ends on the ball — the frames between contact and
the follow-through are a cubic **Hermite bridge** (`SWING_HANDOFF`, 0.03 s) rather
than the follow-through's own ease. The bridge's two tangents are measured from
the two phase curves' own clocks (finite differences of `pathAt` a ten-thousandth
of a second either side), so it leaves the ball on the swing's own line at the
swing's own speed and reaches the follow-through's own pose at *its* speed, and
neither ease has to be re-derived inside the handoff. Blending the two *positions*
across a window — the obvious way to hide a seam — was tried first and is worse
than the seam: by the end of any useful window the two curves are a tenth of a rig
apart, so the blend drags the bat further in one frame than the swing ever moved
it.

Measured on the same tree with the bridge at 0.03 s and at 0 (**A/B**, 0.005 s
steps): the largest single-frame turn of the bat after contact is **82.1° →
62.9°**, and it is spread — 62.9° / 31.2° / 11.0° / ~6° across four frames — where
it used to be one 82.1° corner with the bat's own speed collapsing to 1.98 rig/s
on the far side of it (1.67 with the bridge: the follow-through's own curve still
eases out of the contact pose, and that is the bat's speed, not the handoff's
direction). The bridge is four frames long and the suite's recorded poses sit on its own
ends (contact) or outside it, so every baseline stands: `contact puts the sweet
spot on the ball`, `the barrel rides the swing plane into contact and follows
through`, `the swing keeps opening after contact` and the pose baselines all pass.

### The set stance's idle bounces off its knees

The batter waiting for a pitch used to bob his *hips*: a hip height that rose and
fell around the stance's own. Above the stance the rig's legs are at full stretch,
so the ankles rose with the hips and the shoes came off the ground — **3.9 cm of
it, heel first**, the rig rolling a foot onto its toe the moment a hip outran its
leg. The suite never caught it because the `stance`
phase renders with the idle held off; the defect only lived in the frames between
the shots.

Asked to reauthor it against the reference set (solomon-gumball's `BattingIdle`),
the bounce is now the **knees' own flex**, and the wave is *one-sided*: the crouch
is `(1 - cos) / 2`, which is 0 at the stance and 1 at the deepest point, so the
stance's own pose is the top of the wave and the body has nowhere to go but down.
`(1 - cos) / 2` rather than `|sin|` for the reason the old bob looked like a bob:
a rectified sine has a corner at the top, where this leaves and returns smoothly.

The hips' drop is not a second number to tune — it is what the flex *costs*. A leg
is two rigid links on a planted foot, so the hip sits at whatever distance the
knee's own angle puts it from the ankle (`idleCrouch`), and the driver takes the
smaller drop of the two legs. That is the whole reason a foot cannot leave the
ground: there is no hip height to disagree with the legs about. The flex itself is
**0.4 rad**, which costs 4.1 cm here — and it costs **24 degrees of knee** where
the reference's own 12 would move this batter 1.6 cm, because the rig's legs stand
within 5 mm of their own span at the set and the first degrees of flex are where
all the drop is. The rock, the lean and the bat's waggle ride the same clock: the
weight shift *is* the crouch (read off the reference, the pelvis reaches its
deepest *and* its most-lateral point on the same frame — there is no frame of that
clip where he is crouched and centred), the torso tips over the lead foot as the
knees give, and the bat turns in the hands at twice the tempo so it reads loose
rather than metronomic.

Measured on the harness across one period (0.01 s steps, one 1.23 s clock), against
the reference's own clip:

| | reference | ours |
| --- | --- | --- |
| bounce period | 1.23 s (two cycles in 2.46 s) | **1.23 s** |
| pelvis drops | 4.37 cm | **4.0 cm** |
| pelvis travels across | 3.05 cm | **3.0 cm** |
| torso tips | 1.8° | **1.75°** |
| bat turns in the hands | 8.2° | **7.7° yaw**, 3.6° pitch |
| the grip's own travel | — | **0.001 rig** |
| knee travel | — | **24.6° / 21.3°** |
| the hips' own bones | — | 4.9° / 1.1° (they ride the knees) |
| **feet** | planted | **0.0000 rig** on all four bones |

The lean is worth a note: `swayLeanAmount` is the tip at the *deepest* point, and
the wave only ever goes one way, so the constant is the reference's own range — it
was authored at 0.016 rad, which is half of the 1.8° the comment beside it quoted,
and read **0.90°** until it was doubled to 0.031.

`?idle=1` pins the idle's clock (the app drives it off real elapsed time, so no two
frames would otherwise agree) and `sweepIdle` walks it, which is what makes the
bounce measurable at all. The guard is `both feet stay planted through the whole
bounce`: a whole period at 0.01 s, where each of the four foot bones must sit
within 2 mm of its planted height and never above or below it, the hips may not
rise above the stance, and the travel that *is* there has to be the knees' (≥ 10°)
and the bat's (≥ 3°). It bites: authored the old way — hips rising — it reddens on
the first foot it reads.

### The batter is leaned in before the ball is released

The forward lean-in ramps across the pitcher's windup, and it used to *arrive* on
the release frame: the ramp hit full exactly on the wrap (`t = 0`, the frame the
ball leaves the hand), so there was no frame of a batter already leaning in and
waiting on the pitch — the lean was still on its way as the arm came through.

`leanLead` now comes off the **end** of that ramp, never off its start: the lean still
begins with the windup's first frame, which is the cue the batter is reading, and it
is complete well before the release and holds into it. Taking the lead off the end is
the same thing as speeding the whole lean up — `windupDur / (windupDur - leanLead)`,
half again as fast at the shipped 1.32 s windup and 0.45 s of lead — so "faster" and
"done early" are one change here, not two. The ramp is front-loaded on top of that
(`1 - (1 - u)²` across its own window): the batter takes the lean in the first part of
the windup and stands in it, instead of arriving at it as the arm comes through, and
it still arrives *by leaning* — the shape's own slope goes to nothing at its end.

Measured on the harness over the windup (2.68 s → 4.00 s at 0.01 s steps, reading
the chest's own up axis *along the lean's own direction* — taken from the release
pose, which is what keeps the idle's sideways wobble out of the number):

| | before | shipped |
| --- | --- | --- |
| the lean's own travel across the windup | 14.7° | 16.2° (−7.5° → 8.7°) |
| complete (within a quarter degree) at | **4.00 s** (the release frame) | **3.45 s** |
| held before the release | **0.00 s** | **0.55 s** |
| the fastest 10 ms step | 11.0°/s | **0.37°** (37°/s, against the 1.5° the guard allows) |

After it lands the trunk settles 3.3° back onto the back leg, which is the coil's own
beat and not the lean coming undone (see the next section), and stays there to the
release.

The lead it takes is now its own rather than the coil's own floor (see the next
section): the floor asks the lean to be in by `loadTime + loadLead` — 0.30 s — and the
authored 0.45 s is the tighter of the two, which is what moves the *coil* earlier
rather than the lean later. The two ramps read the same at the windup's start (both
−7.5°, the stance) and the same at the release (both 5.35°, the coil's own bottom),
and differ in between only by the lead's own share of the travel: the lead comes off
the end rather than the start for exactly that reason — the frame the ball leaves the
hand is untouched, so a change of pacing cannot move a pose the suite has a baseline
for.

The window is one nothing else here read: the shots are taken at 0.00-1.10 s of the
clock and every other sweep starts at the swing (`SWING_START_S`, 0.18 s) or in the
way home, all of which end at 1.37 s — so the lean-in could sit at "arrives on the
release frame, held for no time at all", which is what it did, with the suite green.
The guard is `the batter is fully leaned in before the ball is released`: it sweeps
the fixture's `WINDUP_WINDOW` (the cycle's last `ballReleaseTime`, 2.68 → 4.00 s) at
0.01 s and holds the lean to four things — the windup carries the whole lean
(≥ 10°), the lean is complete at least `max(leanLead, loadTime + loadLead)` (less two
steps of tolerance) before the release, it never falls a quarter degree off that
completion again before the ball goes, and it gets there by leaning: no 10 ms step may
move more than 1.5°, which is 125°/s against the shipped ramp's 12°/s. It bites: on the
old build it reddens with `it settles 0.02 s before the ball is thrown`.

### The batter coils from the leaned-in pose, and is coiled before the ball is released

The set is two beats, and the loading beat was on the wrong clock. The weight shift
ran off the *swing* — `loadStart = swingStart - loadTime` — and the swing fires 0.18 s
*after* the ball leaves the hand, so the whole crouch lived in the ball's flight.
Swept over the windup (2.68 → 4.00 s at 0.01 s, reading the pelvis's own height) the
old build does not move at all there: the hips hold 0.6822 rig from the windup's first
frame to the release, and the coil's 3.8 cm of drop happens after the ball has gone.
The batter was leaning and loading as the pitch came to him instead of being coiled and
waiting for it.

The coil's window is now read off the pitcher's release, like the lean's: it opens on
the frame the lean lands (`coilOpen = windupStart + leanRampDur`) and closes
`loadTime` later — `leanLead - loadTime`, i.e. 0.27 s at the shipped set — before the
ball is thrown (`coilEnd = coilOpen + loadTime`), which is never later than `loadLead`
(0.08 s) allows because the lean's own lead is floored there. That makes the lean's own lead a *floor* rather than a tuning of its own —
`leanLead = max(leanLead, loadTime + loadLead)` — because a coil that opened earlier
would be the batter loading before he had leaned in. The two beats can be timed apart,
but never overlapped: that is the structural half of "not leaning and loading on the
same frame". `loadLead` and `leanLead` both have a slider in the debug drawer
(`Coiled before release`, `Lean-in lead before release`).

| | before | after |
| --- | --- | --- |
| the coil's window | the swing's lead, 0.18 s *after* the release | the lean's landing → 0.27 s before the release |
| the hips over the windup | flat at 0.6822 rig, all 133 frames | flat to 3.56 s, then 3.78 cm of drop |
| the coil opens | — (never in the windup) | 3.56 s, the frame the lean lands |
| the coil's bottom | — | 3.73 s, **0.27 s before the release** |
| the coil's own length | — | 0.17 s of the authored 0.22 s |
| the coil's hold | — | drift 0.000 cm from its bottom to the release |
| the coil's own drop | — | 0.0600 rig (**3.78 cm**) |

The coil reads as 0.17 s of its 0.22 s because the ease leaves and arrives flat and
both readings are bracketed from *inside* — 0.2 mm of movement to call it open, the
same to call it at its bottom — which is why the suite allows a sixth either way.

The guard is `the batter coils from the leaned-in pose, and is coiled before the ball
is released`. It sweeps the same `WINDUP_WINDOW` at 0.01 s and reads the *pelvis*,
which the lean test above cannot see (the coil is exactly what settles the trunk that
test measures), against five things: the hips may not leave the height they hold while
the batter stands before the frame the lean lands; they must reach the bottom of the
coil `loadLead` (less two steps) before the release; they must hold there to the
release (drift under 0.4 mm); the coil must take its own `loadTime`; and it must be
worth reading as a weight shift at all (≥ 2.5 cm). It bites both ways — with the coil
back on the swing's clock it reddens on the first bound, `the hips should settle onto
the back leg somewhere in the windup`, and with the coil opened off the *windup's*
start instead of the lean's landing it reddens with `the weight shift should open from
the leaned-in pose, not before it (the hips start settling at 2.69s, the lean lands at
3.73s)`. The lean's own guard reads the same floor, so the two cannot disagree about
when the lean has to be in.

This is a clock, not a pose: the four swing baselines pass unchanged, and the bones at
mid-swing read **identical** to the pre-turn build (65 readings, no difference) — the
load is 1 on both clocks from the release to the hold.

### A taken pitch coils, and holds it while the ball comes

The coil above belongs to the *set*, not to the swing — but it used to be computed
only when the swing was called for. A take therefore got the lean-in and the stride
and nothing else: the batter leaned in, his weight settled, and then he stood there
with his hands up while the ball went by. Nothing about him read as *waiting* for it.

The window is now shared and only the way *out* of the hold differs. A swing unwinds
it over its own recovery (`coilHoldEnd = holdEnd`, `coilOutEnd = recoverEnd`); a take
holds it while the ball comes and eases back to the stance on the same window its
stride comes home on (`coilHoldEnd = takeSettleEnd`, `coilOutEnd = takeSettleEnd +
leanOutTime`). The lean, the coil's opening and its `loadTime` are the same set of
motions on the same pitcher's clock — which is the point: a batter taking a pitch
sets himself exactly as he does for a swing.

Measured at the frame the ball crosses the plate, against the height the take settles
back onto in the same page and at the same idle phase: the hips sit **6.00 rig-cm
(0.0376 rig) lower**, the same 3.76 cm the swing's coil reads, and the *whole body* is
behind it — the neck 6.17 cm, the lead shin 9.92 cm, the head and both hands 4–6 cm —
so it reads as a batter who loaded, not one who only sat down. Through the flight the
hips drift **0.00 cm**: the coil is held, and the frame the ball crosses is the pose
the pitch is taken in. The bat stays in the load with it, 0.147 rig off the stance's
own place where the same frame of the swing has it 1.668 away.

The phase is its own harness fixture (`phase=take`: the same pitch on the same
ball, `swing: false`, pinned at `CONTACT_TIME_S`) with its own baseline,
`batter-take.png`, so the pose is pinned rather than only measured.

The guard is `the batter coils on a taken pitch, and holds it while the ball comes`.
It sweeps the take's own clock at 0.01 s (the flight, then the windup the pitch was
taken from) and reads the *pelvis*, converted from the sweep's world metres into the
animation's own frame. Four things are held: the drop from the settled stance (≥ 2.5
rig-cm); the hold through the ball's crossing (drift under 0.4 mm); the crossing
frame itself inside that hold; and the coil's own clock in the windup — its
`loadTime`, finished before the release and holding through it, the same two bounds
the swing's coil is held to, because it is the same set. It also witnesses the swing *did not*
fire (0.147 rig against the swing's 1.668), because a take that turned out to be a
swing would satisfy every one of those bounds.

It bites on the ask: with the coil put back inside `if (swing)` — the pre-change
build — the assertion named for it reddens first, `a taken pitch has to shift the
batter's weight onto the back leg (the hips drop 0.00 cm)`, and the windup bound
follows, `the coil should take its own loadTime (it takes 0.00 s of 0.18)`.

### The swing's fastest frame is the ball, and the follow-through only slows

A bat's speed peaks at the ball. The swing's own clock did not: its progress used to
be a smoothstep that plateaued onto 0.4 of its peak slope by the tail, which
decelerates *into* contact, so measured off the suite's own sweep the tip's fastest
frame was **0.325 s at 38 rig/s** — a tenth of a second before the ball — and it had
fallen to **5.5** by the contact frame. The swing's own part of that is one exponent:
progress is now `x ** SWING_EASE` with `SWING_EASE = 2.4`, whose own slope is largest
at `x = 1`, i.e. on the ball, and the tip's peak moved to **0.405 s at 41.7 rig/s** —
the frame after contact, which is where a swing's speed is.

The other half is what happens to the *speed* after contact. Both phase curves are
driven by their own eases, and the follow-through's is shorter than the swing's, so
matching the two rates at the ball means the whole follow-through is covered in its
first third: the follow-through would be covered in its first third and the bat
would visibly slow just past the ball. On this pace it does not have to be: the
exponent raises the swing's own arrival rate, the follow-through's ease leaves the
ball on it (`followSlope`, one shared clock) and every frame after the ball is slower
than the ball's. Measured off the suite's own sweep, the tip reads **0.40 s 33 →
0.46 s 20 → 0.52 s 6 → 0.54 s 2 rig/s**, with one local re-acceleration left in it —
**27.8 rig/s at 0.435 s**, the bat's own carry being taken on over the back half of
the path, a third below the contact frame's 41.7.

Front-loading each quantity *individually* on top of that — a spread per quantity,
each leaving on its own rate at the ball — was built, measured and dropped, and those
numbers are why. It only buys a second, later hump: the tip throws again to **30.0
rig/s at 0.470 s** with the grip's own spread, where without it the only hump left is
the 27.8 at 0.435 s. And
front-loading the bat's *rotation* specifically is worse than useless: the trail hand
is on the handle, so the bat turning faster early swings its chord in toward the
shoulder faster, and the elbow folds and straightens **15 to 19 degrees inside 35 to
50 ms** at the ball — the flick class the joint test exists to catch (see below).

Two motions are *not* on either curve. The first is the bridge in the section above.
The second is momentum: past the path's own end the bat turns on the handle a little
further — `SWING_SWIVEL` (0.13 rad, 7.5°) over the hold's first `SWING_SWIVEL_TIME`
(0.10 s) — with the leading fist carried no further, because the grip is held where
the path put it. Its rate at 0.54 s is read off the follow-through's own curve one
ten-thousandth of a second before its end, so the swivel continues the motion the
bat already had instead of starting a rotation of its own, and the *sign* of that
rate decides which way it turns (turning it the other way is what pushed the trailing
arm's bicep back into the ribs: 0 of its 230 upper-arm vertices inside the trunk with
the sign kept, 11 at -0.004 with it flipped). It is nought at the finish frame itself,
settles well inside the hold, and is what the way home starts from — so both phases
still meet on one pose, and the finish's own baseline is untouched.

The bat's *total* turn was raised with it, and that is the same `HOLD_YAW` the finish
is posed on: **0.19 rad past the ball, against 0.12**. The extra 0.07 is not spread
evenly over the follow-through (`HOLD_YAW_LATE`, from `HOLD_YAW_LATE_FROM` 0.5 of it
onwards) because the bat's own turn is what the trailing arm's chord answers to while
both hands are on the handle. Taken evenly — one lerp to the wider finish — the
trailing elbow folds to **164.3°** at 0.46 s and straightens again, an 11° flick 60 ms
after the ball, which `a limb never flickers` reads; taken late but from the ball
itself it folds to **165.6°** and is read the same way. Started from the follow-
through's own half-way point the arm holds **174.1°**, against the 174.9 the narrower
finish held, and the test reads nought flicks: half-way along, the body's own turn has
already carried the grip, and the frames on the ball keep the rates they were measured
at. Read off the harness at 0.01 s steps, the barrel's own line now sweeps **321.5°**
from the load to the path's end (317.8° before) and **11.1°** more over the hold (8.1°
before), with the tip travelling **0.323 rig** past the path's end where it travelled
0.277 and the grip moving 0.140 over both, so the whole of the extra 0.046 is the bat's
own end coming round — the bat keeps swinging after the swing has stopped.

### The chain's leads arrive on the ball, and the legs leave the stance with them

Every motion after the legs is *drawn forward* by a lead — the hips by `hipsLead`, the
body's turn by `bodyTurnLead` — and each was written as a **gain**: `e * lead`, clamped
at 1. A gain has to be clamped (2.6 of the barrel's own progress is past 1 a third of
the way through the swing), and a clamp means the motion arrives *early and then
stops*: the body took its whole turn a tenth of a second before the ball and sat in it
while the bat was still gathering speed, and every one of those motions then had to be
*started again* on the far side of contact. Swept off the driver's own report at 0.02 s
steps, the old build read: the chest's own turn 682°/s at 0.38 s, **0°/s on the contact
frame**, 518°/s on the next — a stall and a restart in the two frames the ball is met
in — the pelvis **0°/s from 0.34 to 0.40 s** and then **1530°/s at 0.42 s**, the 55°
between the contact turn and the finish taken in four frames, and the legs' own first
frames at **25°/s and 106°/s** while the barrel was already at 400.

Two things are changed and neither touches a pose the suite has a baseline for.

**The lead is a shape rather than a gain** (`leadCurve`): a Hermite on the barrel's own
progress, nought at the set and one at the ball, leaving the set on `lead` of the
barrel's own slope (a phase lead *is* the kinetic chain) and arriving with an end slope
chosen as the speed its own follow-through picks it up at — the chord it keeps turning
onto after contact over the chord it turned through, times the follow-through's own
starting rate over the barrel's (`bodyTurnArrival`, `hipArrival`; both are computed from
the tuning, so a retuned finish re-times the contact frame with it). The pelvis' own
follow-through chord rides the chest's own `f` clock rather than a 2.6 gain of it, so
the 55° is carried over the whole follow-through instead of four frames of it.

**The legs ride their own clock** (`HIPS_EASE = 1.8`, against the barrel's 2.4): the
chain fires from the ground up, so the lower body is the one motion that is *not* on
the barrel's ease. It is 0 on the swing's first frame and 1 on the ball as before —
only the pace between them moves — and it stops short of the barrel's own exponent
deliberately: a leg drive that was a quarter of the way open on the frame the swing
fires is a twitch, not a drive.

Measured after, on the same sweep: the barrel's own turn peaks at **2437°/s on the
contact frame** (it was 2180 there and peaked a frame early), the chest's turn reads
**12 → 550 on the ball → 518, 482, 434, 373, 300, 214, 116, 48** — one hump, no stall,
and its fastest frame is the ball's — the pelvis reads **102, 267, 293, 355 … 589 at
0.42 s** and then decays the same way, and the legs' own first two frames are **102°/s
and 267°/s**. Every motion's fastest frame is the frame on the ball, and everything
after it is the body running down.

The pelvis' *forward* ride is on that clock too: it is the push envelope's own share of
the budget the planted rear leg leaves at the contact frame — the very number the
contact geometry draws the ball against (see the rear-foot block above) — so it leaves
the set with no speed, climbs without a backward frame, and turns over on the ball. It
is not bounded on the way in. The budget is read at the *contact's* own yaw, and the cap
falls as the pelvis turns (0.550 rig of it at 0.18 s, 0.418 at 0.36), so at every
earlier yaw the cap stands above the ask and the ride is exactly the ask: a bound, not a
shape. Swept at 0.005 s the ride reads 0.118 rig at 0.20 s climbing to **0.5984 on the
ball** — the budget the rear stance's own depth was re-authored to leave it, see the
next section — its fastest frame the ball's own at **3.91 rig/s** (0.62, 0.90, 1.27,
1.72, 2.17, 2.65, 3.08, 3.45, 3.74, 3.89, 3.91 as the last tenth of a second runs in),
and only past it does the footing take the ride back — **−1.05 rig/s on the first frame
after the ball**, then −1.04, −1.01, −0.99, −0.96 … — one decaying run with no
re-acceleration anywhere on the far side. The build this replaces had the ride peaking
**0.5013 rig a fifth of a second before the ball** and already reversing on the frame
the bat arrived on.

The ground pays no more for it either. The rear socket's worst reach over its own span
across the whole cycle is now **0.997, and on the contact frame** — 1.0547 rig against
the 1.0576 limb, the leg straight, which is the pose a drive arriving is — where the
build this replaces peaked at 1.0824 a frame *before* the ball, and the one before that
at 1.0885. Nothing is clamped on the way in, and the ride's own ceiling for the whole
swing is the frame the bat meets it.

Front-loading the *bat's* rotation this way was built, measured and dropped (see the
section above) — the trail hand is on the handle and a bat turning faster early folds
that elbow. Nothing here touches the bat's own path: the barrel's rotation is the same
curve it was, and what moved is the body the hands and the grip ride.

### The drive's forward travel is the rear stance's own pocket

How far the batter travels into the ball is not a distance any key sets. It is the
*budget the planted rear leg leaves the pelvis*: the socket rides forward and the swing
turns it, and both carry it away from a footprint that does not move, so what the leg
can still span over that footprint is the purse the pelvis spends (see `rearPlanted`,
and the rear-foot block in `poseLegs`). A bigger ride therefore needs the rear foot
standing further back, or a longer lead step to plant against — and both were bought:

| | before | after |
| --- | --- | --- |
| the rear stance's own depth (`legBackStance`, new) | 0 | **0.14** rig |
| the lead foot's stride (`legFrontStride`) | 0.24 | **0.38** rig |
| the plant's own place in the stride phase (`strideEdgeFrac`) | 0.30 | **0.20** |
| the ride on the ball | 0.3647 rig | **0.5984 rig** |
| the pelvis' own place on the dirt, set stance to contact | 0.198 m | **0.341 m** |
| the ride's own rate on the ball | 1.92 rig/s | **3.91 rig/s** |
| the rear leg's own reach on the ball | 1.002 of its span | 0.997 |
| the bat's rendered length on the ball | 1.190 m | 1.031 m |
| the sweet spot's miss on the ball | 0.015 m | 0.017-0.021 m |

**The stance's own depth is the new lever, and it is the cheap one.** It moves the rear
shoe's ball back along the ground the batter is already standing on — `legBackStance` in
`rearFootprint`, and the same number again in `poseLegs`'s stance so the shoe stands
where its footprint says it does — without moving the body's own upper geometry at all.
The pelvis then has that much more of its own footprint to ride over. It is also the
lever with a hard ceiling, because the rear ankle is what walks: standing on its own
footprint it comes to world x −0.446 at the contact with the depth at 0.14, −0.433 at
0.18 and **−0.354 at 0.22 — past the box's inner line at −0.368, i.e. −0.014 m of
clearance** where the shipped depth keeps **0.051 m** (0.079 m at the stance). 0.14 is
where the line still stands clear with the foot at its own footprint.

**The stride's own ceiling is the lead shoe.** The step is lengthened with the stance
so the lead leg has something to stand on where the ride now arrives, and the price is
how far the planted lead shoe is dragged round by the hips: read against the hips' own
line it drifts 9.7 degrees at 0.36, **10.35 at 0.38**, 11.1 at 0.40 and 12.31 at 0.44
— the suite's bound is 12, so 0.38 is the last step that clears it with the drift the
walk itself already reads (5.7 through the follow-through, −2.9 through the recovery).

**`strideEdgeFrac` is what makes the acceleration *visible*.** The ride's own envelope
turns over on the ball either way (that is the section above), but where the stride's
plant lands decides how much of the budget is spent before the swing even starts. At
0.30 the body has already 0.44 m/s on it at 0.20 s and arrives with **1.98 m/s** — the
speed curve flattens as it comes in (1.27, 1.48, 1.67, 1.82, 1.93, 1.98). At 0.20 the
plant lands a fifth of the way into the stride phase instead, so the body is further
back when the swing fires (z 0.7085 against 0.6683 at 0.20 s) and travels *further* in
the same time, gaining speed at every frame the whole way in — **0.31, 0.44, 0.64,
0.89, 1.18, 1.48, 1.76, 2.03, 2.24, 2.39, 2.45 m/s**, its fastest frame the ball's
own. The two read the same pose at contact (0.4142 m) and the same pose all the way
through the follow-through; only the pace on the way there moves.

The cost of all of it is paid by the carry, and it is a pose the suite reads. The
longer stride sinks the pelvis — **0.951 rig at 0.40 s against 1.011** (the spine
bone's own height) — and the ball's place in a frame that has ridden past it draws the
frame's own contact grip **0.08 rig higher** (the authored grip's own height there:
0.911 rig to 0.990), while the trail shoulder rides 0.05 lower with the sink. The carry's chord lost its vertical component to that (0.041 rig
at 0.44 s against 0.165) and the trail elbow folded to 148-156 degrees through 0.42-0.47 s
— so the carry's own control was re-authored with the drive, 0.12 rig further forward
(see the carry's section below).

Everything else the suite reads is unchanged or better. The feet stay on the ground at
every phase, the step lands straight at the front line (0.000 rig across the box, 0.998
forward) with the rear toe 0.021 across, and the rear ankle keeps its 0.051 m of
clearance to the inner line at the contact — the walk 0.22 pays for, above. The swing
plane's own poses read as they did, the bat comes *further* off the body over the carry
(the suite's own nearest-skin reading 0.351 rig at 0.44 s against its 0.25 bound, where
the section below records 0.266 for the pose before this drive), the palms stay closed on the handle
(0.0004-0.0024 rig off the axis, 0.999+ along it), and the flick guard reads better for
the straighter arm: the lead elbow's own turns through the swing drop from **10 of its 9
allowed to 4**. The one number that pays is the bat: the body arrives nearer the ball,
so the pose braces against **1.031 m of bat where it braced against 1.190** — still well
inside the suite's own floor on it, and the sweet spot still lands on the ball (0.017 to
0.021 m off it, against 0.015 before).

### A limb that cannot hold a direction fails the suite

Every test above reads a pose at a moment, or sweeps one quantity against a bound. A
limb that changes its mind *between* two poses leaves both poses exactly where they
were — which is how the trailing forearm used to turn over about its own elbow through
the follow-through, 136 to 151 degrees reversing every few frames, without anything
here noticing.

`a limb never flickers about its own joint` sweeps the whole cycle (the swing's start
through the end of the hold, 0.005 s steps) and reads each joint's own angle off the
posed skeleton: the elbow, both shoulders, the knees and hips, the spine and the neck.
A joint may turn — an elbow bends through the load and straightens through the swing —
and it may not turn *back on itself*: a reversal pair within `FLICK_WITHIN_S` (0.1 s)
whose smaller leg moved more than `FLICK_LEG_DEG` (8) is a flick, and every joint's
list has to be empty. The count of turns each joint is allowed is that build's own
reading plus one turn of headroom, per joint rather than one number nothing can reach,
so a change that adds a turn anywhere fails here too.

The wrists are deliberately not in the set: their angle read from bone positions rolls
with the fist's own reference, so it turns every time the rig rolls the hand on the
handle (measured, 10 and 11 turns at these steps). The wrist tests above cover what
the wrist's bend and twist may do instead.

The test earns its keep: written against the flicking build it fails with
`elbowR: 0.405s (19deg in 45ms)`, and the shipped build reads 0 flicks with the counts
the budgets are set from (elbowL 8, elbowR 4, shoulderL 5, shoulderR 1, knees 0/0,
hipL 0, hipR 5, spine 3, neck 0).

### The finish the swing settles into

A swing does not stop on its finish; it decelerates into it. Three motions meet at
the end of the follow-through, and they were read one at a time rather than as
one movement:

- the follow-through's own ease used to come to rest on the finish (both halves of
the swing were smoothsteps), so the bat decelerated to a standstill and the hold
had to pick it up again from nothing — measured, **0.98 rig/s at 0.55 s falling to
0.46 at 0.64**, the bat's slowest frames of the whole sequence;
- the hold's own *settle* then moved the hands 0.16 rig out, 0.05 up and 0.12 out in
front (the pose `peakHands`, see the hold's own grip above) as a straight
interpolation from the pose the path ended on;
- and the way home's own pull (0.74 rig across, `HELD_PULL`) is taken on over the
hold's last third, at **8.8 rig/s** — faster than any frame of the follow-through
itself, and after the moments the trail arm's bounds are read at.

The follow-through's own tail is now reshaped like the swing's own (the same
`hermite`; `FOLLOW_ARRIVAL` 0.18 of the clock's own slope per unit phase), so the bat
*arrives* on the finish moving — measured, **6 rig/s at 0.52 s and 2 at 0.54**, where
it used to come to a standstill — and the swivel (see the pace section above) is the
rate that arrival is chosen for: it carries the bat 7.5 degrees further over the
hold's first 0.10 s rather than starting a rotation of its own, so the hold continues
the motion the follow-through ended on instead of picking it up from nothing.

Making the *path* end on the hold's own pose — so that nothing has to move
sideways after it — was tried and measured, and the numbers say the two ends of the
sequence cannot share one pose. Re-aimed, the pose at the follow-through's own end
is the carried finish, and there the **lead palm leaves the handle** (0.0387 rig
off its axis against a 0.01 bound, and it slides 0.039 up it) and the retrace's
forearms come **inside the torso** (−0.052 against −0.05). Shrinking the hold's own
carry to 0.05 out / 0.08 front / 0.04 up so the lead hand can close on it passes
both of those — and flips `the trail arm comes round the chest` and `the hands
finish where the shoulders went`, because the carry is what shortens the trail
arm's own chord (0.784 of its span at the authored 0.44, and the trail arm's bound
is read at 0.76 s). The carry has to be **at least about 0.15** for the trail arm
and **at most about 0.08** for the lead palm at the finish: one pose cannot carry
both, and neither the path's aim nor the pull's direction changes that.

The across pose itself — the one the pull lands on — *was* outside the trail hand's
own grip: measured then, the trail arm read **1.052 of its span** (bound 0.9), a
**175-degree elbow** (a straight chord laid on the ribs) and a **49.3-degree bend
floor** against its 30-degree limit, and four pull directions (level, up 0.06, forward
0.12, and both together) all read 1.04 to 1.13, so it was the grip geometry and not
the direction. What fixes it is the *bat's* place rather than the hand's: carried round
the trailing shoulder and held inside that arm's own reach, the pose reads **0.933 of
its span with a 138-degree elbow**, with none of its 230 upper-arm vertices inside the
trunk (see the two carry sections at the end of this document).

### The trail hand's place on the handle, measured against the across pose

The across pose — the one the way home's own pull lands on, where the knob sits
0.031 rig from the plane through the lead shoulder — *was* where the trail arm's own
reach ran out, and the ask was to re-author that hand's place on the handle and its
roll reference until it fits. It was built, measured, and taken out again; the
numbers say the hand is not the lever, and the reason is the rig's own fists.

**The hand's place, when it could be moved, does exactly what the ask wanted.**
The two fists grip one rigger's two-handed grip apart — 0.253 rig, the model's own
`BatBottomHandIK` / `BatTopHandIK` targets, which is what the suite's "the fists
grip at the rig's own spacing" is measured against. Moving the trail target down
the handle toward the lead one (a share of the rigger's grip) is a real lever, and
at the across pose it reads:

| trail share | grip apart | trail span | trail elbow | trail bend floor |
| --- | --- | --- | --- | --- |
| 1.0 (the rig's own) | 0.253 | **1.052** | 175° | 49.3° |
| 0.55 | 0.139 | **0.965** | 149° | 33.9° |
| 0.40 | 0.101 | 0.965 | 149° | 30.0° |
| 0.25 | 0.063 | 0.964 | 149° | 30.0° |

So the two halves of the ask that are about the *joints* are met — the elbow comes
off 175 degrees (a straight chord across the chest) to 149, and the wrist's bend
floor comes off its 49.3-degree reading onto its 30-degree limit. **The span does
not**: it stops at 0.965, and the suite's own bound is 0.9.

**And the shares that buy that are not available.** The fists are bodies, not
points: at 0.152 rig apart the two of them overlap at the stance, and the suite
catches it (`the two fists should be stacked along the handle, not overlapped`, at a
share of 0.6). The spacing the fists leave room for is about **0.20 rig**, and
interpolating the table there puts the trail span back at **~1.0** — the whole
improvement is spent buying the fists their own room. The *roll* reference is not a
second lever at this pose either: the held-roll share was taken from 1 all the way
to 0 and the trail arm's span and elbow read identically (1.052, 175°) at every
value; only the fist's own orientation moves, and the arm's required reach at that
pose does not answer to it.

**The pose's own geometry was then measured across every lever it has**, at the
across pose (0.82 s), against the trail arm's 0.9 bound:

| lever | trail span | trail elbow | what it costs |
| --- | --- | --- | --- |
| authored (pull 0.74, level) | 1.052 | 175° | — (lead arm 0.892, knob 0.004 off the plane) |
| pull 0.60 | 0.963 | 149° | the knob finishes 0.141 rig short of the plane |
| pull 0.50 | 0.968 | 151° | 0.239 short |
| pull 0.42 | 0.940 | 140° | 0.321 short |
| the carry 0.06 up | 1.043 | 175° | the trail wrist's floor 49.3° → 52.1° |
| the carry 0.12 down | 1.079 | 175° | worse on both |
| the carry 0.12 further forward | 1.127 | 175° | worse on both |
| the carry 0.12 back | 1.029 | 175° | the trail wrist's floor 56.6° |
| the carry 0.24 back | 0.977 | 155° | the *lead* wrist's floor 46.6° (its limit is 30) |
| the body 0.18 further open | 1.059 | 175° | nothing bought (0.24 open: 1.063) |
| the trail grip at 0.55 of the rigger's grip | 0.965 | 149° | the fists overlap at the stance (the suite reads it at 0.6) |

The span falls with the *length* of the carry (1.052 → 0.940 as it goes 0.74 →
0.42), and never crosses 0.9: bringing it back toward the body — the one direction
that shortens the trail arm's chord — moves the grip out of the lead hand's own
bend (its floor past 30 degrees) before the trail arm is inside its bound. So the
across pose, at the plane, is about **0.06 to 0.15 of the trail arm's reach beyond
this rig's geometry**, and it is not a holdable two-handed pose for this body: the
re-authoring an animation can do is spent, and what is left is the model's own arms
(0.74 rig of reach from a shoulder 0.53 rig off the centreline) or giving up the
knob's crossing of the plane.

**So it is the bat's own place that moves, and what it moves against is the trailing
arm's reach.** A *release* — the trail hand coming off the handle and settling beside
and below its shoulder, with the lead hand carrying the bat alone — was tried first,
and it worked as a pose; what it could not do was stay one. Its own retarget is what
sweeps the arm round: the trailing arm's shoulder-to-hand line is carried through the
shoulder's narrow side and comes out the far side of it, a roll past a half turn,
which no shoulder makes. The reason a release was needed at all was that the
two-handed finish sat **1.05 of that arm's own span** from its shoulder (0.784 rig of
chord against a 0.743 rig arm) — a straight, stretched line the eye reads as an arm
come off its shoulder. What fixes that is the *bat's* place: carried round the
trailing shoulder and held inside that arm's reach, the same pose reads **0.933 of its
span with a 138-degree elbow** and none of its 230 upper-arm vertices inside the
trunk. So the hand never leaves the handle, there is no one-handed pose below the
path's own end, and the pose the suite reads the grip at is the pose the swing arrives
on (see the two carry sections at the end of this document — that is where the numbers
are).

What the release did buy is worth recording, because it is what the carry had to
replace: measured at the across pose, the released pose read 0.54 of that arm's span
with a 65-degree elbow, where the two-handed pose reads 0.933 and 138 — inside the
same 0.9-span and 90-degree bounds the suite holds the trail arm to, which is the
whole of why the release could go.

Measured at the across pose, the trade is between the two arms, and that is what
the pull buys and costs: the same 0.74 rig of carry takes the **lead** arm from
1.316 of its span (straight, its two bones 7% past their length) to **0.959** — a
real bend, which is why the pull exists — and takes the **trail** arm **inside its own
reach**, which is what the carry round and the reach bound do between them (the 1.052
in the frontier table above is the pose *before* them). The hand's place and its roll
sit inside that trade; what was left outside it was the pose's own geometry (where the
grip is carried, in height and depth, and how far the body has turned to meet it) or
the model's own fists.

The settle into the carried finish is, unlike the path's own aim, the swing's own
motion now: a cubic Hermite out of the follow-through's last frame, on that frame's
own arrival speed (the follow-through's ease arrives moving -- see FOLLOW_ARRIVAL),
into the carried pose at rest, over the first fifth of the hold (`HOLD_SETTLE_SHARE`,
about 0.06 s of the hold's own length). Measured on the bat's path, that is what
makes the end of the swing one movement instead of two: the bat leaves the
follow-through at **4.32 rig/s**, holds 4.40 and 4.34 through the next two frames
(turning 16 and 18 degrees a frame), then decelerates 2.39 -> 0.59 -> 0.42 as it
settles -- where before it stopped at 0.98 rig/s on the finish and was interpolated
sideways into the carried pose over the next 0.18 s.

The path's *endpoint* is the pose the suite reads the finish at: the `followThrough`
phase's default time **is** the path's end, and `the palms close on the handle`, `the
fingers fold round the handle` (both fists, in every sampled phase) and the
grip-spacing check all require *two* hands closed on the handle there. So there is no
second pose below it and no one-handed moment: the pose the sequence stops on and the
pose the suite reads are the same pose, which is what leaves the hold nothing to
translate and the way home nothing to settle before it starts. What is carried *onto*
that endpoint is the bat's own place (see the two carry sections at the end of this
document).

### The finish unwinds through the middle, not across the chest

Both hands ride *one* bat, so their two reaches trade off against each other, and
nothing about the trail arm can be fixed without moving where the grip finishes.
The trail hand — 0.253 rig up the handle from the lead one — is the hand a
follow-through sends across the body, and its arm's own *span* is what decides
whether it ends up lying along the chest or through it. The finish used to put the
grip **0.11 rig past the body's midline** and out at arm's length in front of the
chest, which left the trail hand 0.55 rig from its own shoulder: the arm read
**85% of its span at the finish, 98% mid-swing and 78% through the hold** — a
straight chord laid on the ribs, **10 of its 229 upper-arm skin vertices inside
the trunk** at the finish and **5** at the hold, worst **0.043 rig (2.7 cm)**. No
elbow hint can lift a straight arm: there is no bend left to steer, so this is the
grip's job and not the hint's.

The grip now finishes in front of the body's midline — the finish unwinds *through*
the middle of the body rather than reaching across it — and then **carries round
with the shoulders** as the body keeps opening. The same arm reads **69% of its
span at the finish and 59% through the hold, with 0 vertices inside the trunk** at
every moment sampled (0.54 s 10 → 0, 0.60 s 11 → 0, 0.68 s 5 → 0, 0.76 s 5 → 0).
Reverting the in-front term alone puts 13 / 9 / 11 back inside at a 94% span, so it
is the term that matters, not the shape of the arc.

The **carry** is what takes the arms out of each other. Both hands ride one bat, so
their lateral order is the *bat's* own: with the grip left on the centreline the two
hands finished **+0.08 rig apart the opposite way round from the shoulders**
(-0.35), and the two arms' own lines crossed in plan — the crossed-arms pose at the
end of a follow-through. Carried **0.44 rig the way the shoulders go** — read in the
batter's own frame, the grip finishes **0.47 rig out from the axis his pelvis stands
on**, out past his own trail shoulder rather than in front of the middle of his
chest, and the barrel goes round with it. The shoulder the carry goes toward is the
*trail* one, so it is the one lever that shortens that arm's chord while lengthening
the lead arm's: measured, the trail arm reads **0.784 at the finish and 0.765
through the hold** (0.871 / 0.815 at the 0.2 carry), against the 0.9 it is held to,
and the lead arm comes out long at **1.077 of its span** — which is what the way
home needs, since below 1.0 the pose its own pull is authored from is not the
straight one and the suite reads that frame in the same page (0.946 at the 0.2
carry). 0.44 is where those two readings cross the bounds they are held to with the
carry still taken *only* along the shoulders' own direction: the same pose with the
carry taken across the body instead puts the trail hand straight through the
chest. `the trail arm comes
round the chest, not across it, at the finish` holds the other half of it — the
trail arm's span stays under 90% and nothing of it is inside the trunk — and the
coverage probe reads 4% / 3% / 0% hidden at the hold from the three views.
`the hands finish where the shoulders went, not crossed over each other` pins the
pair: at the late follow-through and the hold the trail arm's own line has to stay
on the same side of the lead arm's as the trail shoulder is, which is a 1 cm
of-plan call at this pose (the two arms converge on the hands, so their lines only
just miss) and reads -0.002 — the other side — with the carry taken back out.
The carry alone does *not* hold it — at 0.44 the trail hand still read -0.020 at
the hold — because the two lines it compares are a *wrist* apart, and the wrists are
where the grip is plus the fist's own reach turned round it. It was closed once before by carrying the
hold's own grip *up and back toward the lead shoulder* — a 0.47-rig pull taken on the
held grip with 0.47 rig of depth given back out front — and that pair read **+0.000 at
the late follow-through and +0.005 at the hold**, i.e. this bound green by a
millimetre of plan. That pair is the same number as the lead arm's bend seen twice
(the pull shortens the lead arm's chord, which is what the way home wanted it for),
and it is spent: with the hold's grip re-authored to carry the bat *away* from him
(see `the hold's own grip, and the trail hand's wrist` below), this reads **-0.027 at
the late follow-through against the trail shoulder's own +0.106, and -0.065 through
the hold** — the far side of the line, which is what the bound exists to catch. So it
stands red on this pose, and the green it would take to fix it is exactly the rise
that broke the trail hand's grip.

The finish's **depth** (−0.46, where it was −0.40 and then −0.42) is what the
forearms read: each runs from an elbow beside the ribs up to the hands, so the chord
across the waist is theirs. At −0.40 they read 0.041 rig inside the trunk at the
finish and 0.040 through the hold; the pose is *out in front* of the belly now, and
what the suite reads is 0 of the arms' 116 skin vertices inside the trunk at every
one of the five pinned poses and 14 at the reset's own 0.96 s sample (`the hands
stay out of the torso`). It is not deeper still for the trail arm's sake — measured
on the carried grip, the trail arm's span climbs from 0.784 at −0.42 to 0.895 at
−0.60, against its 0.9 bound — and not deeper for the barrel's either: at −0.42 it
comes 0.341 rig from the trunk at the finish and at −0.46 it reads 0.394, which is
what sets the number.

The **bat's own clearance** is the other half of the same reading, and it is the
half a viewer sees: the swing's follow-through ends with the bat carried up across
the shoulder, and where the grip ends up decides whether it passes *over* him or
through him. Measured against the posed skin (`probeBatBody`, which runs the bat's
own axis against every vertex the arm holding the handle does not carry), the
barrel came **0.170 rig (0.10 m) from his skin at the late follow-through and 0.182
through the hold** before the carry, i.e. lying along his shoulder, against 0.409 at
the finish. With the finish carried 0.44 and deep at −0.46 and the hold's own grip
carried a further 0.16 rig round to his side (see below), the same window reads **0.480 at the
finish, 0.445 at its closest (0.66 s, the lead upper arm) and 0.445-0.480 across the
hold** — nothing in the follow-through or the hold comes nearer than 0.445 rig
(0.28 m), against 0.170 before either number moved. The grip's own place in the
batter's frame goes from **0.470 rig out at the finish to 0.585 through the hold**
(0.549 before the hold's own grip moved — see below), and the barrel's tip goes round
with it: **[−0.317, 0.893, −0.706] at the hold against [−0.352, 1.020, −0.667]**
before, i.e. 0.04 rig further out on the batter's own side, 0.04 further out in front
of him, and 0.13 rig lower because the *grip* rides lower — the bat's own elevation is
the same 0.56 of a rig unit off horizontal (34°, which is `FOLLOW_FLAT`'s purchase and
was already spent). Both arms' elbow angles at the hold read **176° and 106°**: the
trail arm keeps a real fold, where the lead arm is straight at the finish a third of a
second earlier.
`the bat is carried round and off the batter at the end of the follow-through` pins
both halves: the grip's own place in the batter's frame (0.470 rig out at the
finish, 0.585 through the hold, against a 0.4 bound at the finish and 0.22 across the
window) and the clearance (against 0.25).

Two directions are deliberately *not* taken, because each reads better at the
moment it is aimed at and costs more than it buys. Carrying the hold's grip up 0.12
and back 0.06 of the half-width takes the hold's forearms from 41 vertices inside
the trunk to 17, but straightens the lead arm on the way home (0 → 11 inside at the
recovery's midpoint). Lifting the way home 0.15, or bulging it 1.35× further out,
takes that lead arm back down to 4 — and carries it behind the body from the game
camera (back-view coverage 16% → 25%, against a 20% bound) and points the trail
elbow at the pitcher through the reset (0.019 against a 0.01 bound). Neither is the
direction that helps, though: the pull that gives the lead arm its bend back is
taken *along the shoulder's own direction* and on both the hold's grip and the
reset's path at once — see the next section. The hold's vertical offset, the arc's
control point and the swing's own path are still left as they were; the hold's
*depth* offset is not, and is the one the bat's clearance bought (0.2 rig further
out than the finish's own grip, against the 0.77 of the pull that is inward).

**What it cost, and what closed it.** With the grip finishing further out in front,
the *lead* arm straightened through the reset: at the recovery's own midpoint it
read **10 of its 231 upper-arm vertices inside the trunk, 0.033 rig (2 cm)** deep,
where the old grip read 0 — the one bound this change missed, since `the arm on the
pitcher's side stays in front of the torso` holds the set and the reset to four
vertices. It is the *set's* own grip that closes it: the hands moved from over the
trail shoulder to in front of the sternum (see above), which is 0.68 rig of reach
the lead arm no longer has to find across its own chest. Measured now, the lead arm
reads **0 of 232 vertices inside at the set and 0 of 231 through the reset**, worst
0.010 rig of clear air, with the coverage at the set 0% from the suite's own shot
and 8% from the pitcher's. The forearms' own worst depth at the finish clears the
belly by 0.05 rig, where the old grip read 0.041 rig inside.

`the trail arm comes round the chest, not across it, at the finish` pins it: at
four moments through the follow-through and the hold the trail arm's span stays
under 90% (the old grip reads 94% and is buried again), nothing of its upper arm is
inside the trunk, and none of it is sunk into the ribs.

### The hold's own grip, and the trail hand's wrist

The hold is not a second pose: it is the finish *carried on*, and each of its three
offsets from the finish is one thing the bat's own carry does — 0.16 rig further round
to the batter's own side, 0.12 further out in front of him, and 0.05 of a settle up
(`HOLD_OUT` / `HOLD_SETTLE` / `HOLD_DEPTH`). It used to be authored as a *pull*
instead: the grip carried 0.47 rig back along the lead shoulder's own direction, 0.17
of that upward, with 0.47 rig of depth given back out front. That rise is what bought
the lead arm its bend for the way home, and with the bat come round flat it is what
broke the trail hand's grip — the trail hand grips **0.253 rig up the handle**, so
every rig of height the grip gains is a rig its wrist rides further over its own
shoulder. Measured at the hold, the trail wrist sat **level with its own shoulder**
(−0.002 rig, against 0.14 rig *below* it now), the fist's own bend sat **exactly on its
floor of 30.0°** — no roll could bring it inside the limit, which is what "the roll
moves the elbow instead" reads as — and the elbow solved **0.58 of the upper arm's
length above its own shoulder**, the trailing upper arm pointing at the sky. Through
the follow-through the same reading climbs: +0.42 at the finish, +0.53 at 0.78 s, +0.58
at 0.82 s, then a 0.22-rig step in a single frame inside the hold and a 0.47-rig one
over the earlier window — the up-and-down flicker this pose reads as.

Carried the other way — away from him, level but for half a tenth of a rig of settle —
the trail arm's own chord is short enough to follow the bat round, and the fist closes
on the handle with the wrist straight:

| at the hold (0.82 s) | pulled up and back | carried away and level |
| --- | --- | --- |
| the trail elbow's own direction | **+0.58** above its own shoulder | **−0.13** below |
| the trail wrist's bend floor | **30.0°** (the limit) | **19.5°** |
| the trail arm's span / elbow angle | 0.705 / 90° | 0.799 / 106° |
| the fist's palm, back to the sky | 0.76 | 0.70 (bound 0.25) |
| the barrel's nearest skin | 0.463 rig | 0.456 rig |
| the grip's own place (bottom of the bat) | 0.549 rig out | **0.585** rig out |
| the *lead* arm's span at the hold | 1.179 | **1.313** |

The last row is what it costs, and it is the way home's own bound: the reset's first
frames *are* the hold's pose — or, since the pose the hold *ends* on is carried across
the body (see the next section), are that pose pulled; the reset reads 0.892 of that
arm's span where the hold's own pose gives it 1.313. The trail elbow, meanwhile, is
monotone the whole way
through the follow-through and the hold — **−0.01 to −0.13**, where it used to climb
+0.42 → +0.58 and then step down in one frame — and `the trail arm comes round the
chest, not across it, at the finish` holds it at **84% / 87% / 81% / 80%** of its span
at the four moments with **0 of its 246 upper-arm vertices inside the trunk**.

**The trailing elbow's plane rule is gone**, and this is the reading that says why it
had to be. It used to be held above the bat's plane for the whole of the swing and the
follow-through (the arm solve in `playerRig.js` now answers the plane for the *lead*
arm only), and with the bat come round flat, "over the plane" *is* above the hands: the
rule held that elbow up wherever the grip was, and the hint that asks for it down had
no say at all. With the bat carried away from him the elbow comes down on its own — and
`the elbows ride either side of the plane the bat swings in` still passes, because the
pose puts it over the plane rather than a rule.

### The bat is thrown across at the end of the follow-through

The pose the hold ends on is the one the way home is authored from, and it is also
where the bat finishes its throw. The carry that keeps the lead arm bent (see
`HELD_PULL`) is taken **laterally** — across the body, along the grip-to-lead-shoulder
line in plan — so it takes the whole bat with it, the bottom of the handle included,
and it is taken all the way: read in the batter's own frame against the plane through
the **lead shoulder that stands perpendicular to the front line of the box** (the plane
a viewer reads a follow-through's own carry against — the plane's own position is the
lead shoulder's, −0.143 rig off the pelvis's axis), the bat goes from lying across that
plane to lying *past* it, knob end and all:

| the bat, read off the posed bat and skeleton | 0.72 s (the hold's own pose) | 0.82 s (the pose the hold ends on) |
| --- | --- | --- |
| the knob, on the batter's side of the plane | +0.585 rig | **+0.004** |
| the barrel's tip | −0.317 rig | **−1.041** rig |
| the barrel's nearest skin of the body | 0.455 rig (upper arm) | **0.729** rig (head, 0.78 s) |
| the *lead* arm's span (the way home's first frame) | 1.316 | **0.892** |
| the *trail* arm's span / its elbow angle | 0.805 / 107° | **1.052 / 175°** |
| its wrist's bend floor / the palm's back to the sky | 16.2° / 0.68 | **49.3° / 0.56** |

The trail arm is the price, and it is that hand's own grip geometry rather than a
choice: it grips 0.253 rig up the handle and the bat lies 0.82 of its length across the
body, so it rides 0.208 rig *inboard* of the knob while its own shoulder stands 0.53 rig
out the other side of the pelvis. A knob on the plane therefore puts the trail hand
**0.76 rig** from its own shoulder, against the 0.74 the arm spans — the arm is
straight and the bones 5% past their own length, where the hold's own pose has it at
0.873 of its span with a 122° elbow. The suite's own trail-arm bound is read at the
four pinned moments (0.60, 0.68, 0.76 and the finish) and the pull is taken after all
four of them, which is why this is written down here as a cost rather than caught by
that test.

**What the throw does for the rear arm — the question it was asked — is measured, and
it is a real but partial answer.** Over the hold and the reset the trail elbow's own
direction sits **flatter and lower**: 0.11-0.13 rig up through 0.80-0.92 s, against
0.12-0.29 without the full carry (whose peak is the 0.29 at 0.91 s). The window it
spends above its own shoulder is the same length either way — 0.75-1.09 s — so
`the elbows keep their own directions` does not come back, but twelve of its samples
read 0.11-0.13 where they read 0.12-0.29. What the throw does *not* touch is the one
flick in that window: the trail elbow's own direction steps **0.77 rig between 1.09 s
and 1.10 s**, and it steps the same 0.77 with the carry at 0.30. It is the fist's own
*roll*, not the bat's path: with the held roll's shares set to zero that elbow holds
**−0.77** through the whole stretch and the 0.77 step is gone, but the wrists' bend
floors then read **86-98°** against their own 30, so the fists no longer close on the
handle at all. The flick is the held roll being handed back (see `PALM_HELD_BACK`),
and the throw neither causes nor cures it.

### Which moment the suite reads as the finish, and where the swing arrives

The bat's carry is **on the follow-through's own path** now, and that is what moved
the suite's own definitions. Written into the path (`followHandsAt`, taken on over
`FOLLOW_CARRY_FROM` = 0.55 of the follow-through), the carry is the swing's own
continuation rather than something that happens after the swing has stopped: the
pose the path *ends* on is the carried across pose, and the hold holds it — nothing
left to settle and nothing left to translate. Measured on the bat's own path, it is
the *throw* that spends the swing's speed: the follow-through arrives at **3.9 → 4.2
rig/s**, the carry whips to **14.7** at 0.50 s and **9.8** at 0.51, and the bat is
away by 0.53 (3.0 rig/s) and at rest through the hold (**0.33 / 0.26** rig/s, the
body's own turn). It used to come to rest at **0.98** rig/s on the finish and then be
slid 0.20 rig sideways into the hold's pose over the next 0.18 s — the stop and the
slide this replaces. (The bat's own roll turns over at 0.53-0.55 s as the held roll
is handed back — the pre-existing turnover the palm's own section records, and the
one turn in the window that is not the carry.)

Two things follow from it, and each one is a definition the suite had to be told:

- **The swing is two-handed the whole way.** Both fists stay on the handle from the
  set stance to the end of the hold — there is no release — and the trail hand grips
  `gripSplit` up it, which is what makes the trailing arm's own reach the bound on
  where the bat can be carried at all (see the two carry sections at the end of this
  document). `the palms close on the handle` and `the fingers fold round the handle`
  read both fists at every sampled phase (0.250 rig apart, 0.0001/0.0002 off the
  axis, against the rig's own 0.253).
- **The follow-through's own end is the pose the suite reads the finish at** —
  `followThrough`, where the path itself arrives and the hold then holds it. Everything
  about where the swing *arrives* — the bat's carry and clearance, the body's turn, and
  the arms' finish poses — is read there and through the hold.

The trail arm is the measurement the whole arrangement hangs on, so it is read on
both sides of the release (`the trail arm comes round the chest, not across it, at
the finish` now sweeps four moments rather than the old four pinned ones):

| the trail arm | span | elbow | its upper arm in the trunk |
| --- | --- | --- | --- |
| the carry (0.44 s) | 0.966 | 150° | **0 of its 230 vertices, on the surface (+0.000 rig)** |
| the last two-handed frame (0.48 s) | 0.941 | 140° | **0, +0.000** |
| the finish (0.54 s) | 0.928 | 136° | **0, +0.023** |
| the hold (0.68 s) | 0.933 | 138° | **0, +0.023** |

Without the carry round and the reach bound the arm *is* long — both hands are on one
bat and the bat is carried across the body, so the trail hand ends up at the end of its
reach by construction (1.00 of its span, a 175° elbow and 24 of its 230 skin vertices
0.048 rig into the ribs at 0.48 s, measured) — and that is the pose the release used to
answer. What answers it now is the bat's own place, and the table above is the reading
with both levers in: the arm is **inside its own reach and bent at every sampled
moment** (0.93-0.97 of its span, 136-150°), and the body's skin stays *clear* of it
rather than the arm resting on it (nought of its 230 upper-arm vertices inside the
trunk, +0.023 rig out from the finish on, held against the suite's −0.005 floor, which
is what stops the "resting on the chest" pose passing as a press). The grip the trail
palm keeps is read at the same moments: **0.0001/0.0002 rig off the handle's axis and
0.250 rig apart**, on the handle at every sampled phase, with the **lead** palm equally
closed on it.

The bat's own reading moved the same way. Against the plane through the lead shoulder
(perpendicular to the front line of the box), the knob stands **0.535 rig** on the
batter's own side at 0.44 s and **0.031** by the hold — arriving on the plane rather
than being translated into it — with the barrel end 0.89 rig *past* it: the whole bat
goes across, knob and all. With the bat out in clear air past the fists, the harness
reports **no body skin along the bat's own barrel half at any sample** (its nearest is
0.73 rig, the head), so that test also reads the nearest skin to the bat's line
anywhere (0.292 rig at its closest, 0.44 s, against the 0.25 bound) — a reading that
cannot come back vacuous, which the barrel-only one could.

**What this costs in the suite, measured rather than argued away.** The pose the hold
holds is the finish carried on with the bat out across the body, where it used to be
held up in front of the chest, so the tests that read the hold and the way home read a
different pose. What moved with this change, and had to be read again: `the lead arm
keeps a real bend on the way home` was authored against a folded finish (0.84 of the
arm's span) and the pull that bent it on the way back; the finish is the *long* one now
(0.955-0.959, the carry the lead elbow's own section is about), so the test reads the
way home's own motion instead of the seam — the arm is never past its own reach anywhere
in the reset, and it comes inside its bend bound (0.9) **0.11 s in** and holds it from
there — and the lead palm's back reads **−0.80** at 0.54 s, the first of the four
moments `the back of the palm stays up the whole way home` holds to 0.25. **Red and green, read off the two trees side by side.** The same seven tests were run
against the file this change was made on and against the change itself, and the result is
not a list of things it broke: `the hands stay out of the torso, through the swing and all
the way back` and `the hands finish where the shoulders went, not crossed over each
other` **fail before it and pass on it** (the deeper finish is what takes the arms clear
of the trunk), and nine of the others are unchanged — the five that read red, and four
that read green — so what is red in this tree is what was already red:

| test | on the tree before | on this one |
| --- | --- | --- |
| `the hands stay out of the torso` | red | **green** |
| `the hands finish where the shoulders went` | red | **green** |
| `the bat is carried round and off the batter` | green | green |
| `the back of the palm stays up the whole way home` | red (the lead palm's back **−0.80** at the across pose, against 0.25) | red, same |
| `the elbows keep their own directions` | red (the trail elbow 0.01-0.15 *up* over 0.91-0.96 s and 1.08-1.09 s) | red, same |
| `the trailing arm never changes places with the leading one` | red (0.26-0.31 s in the swing, and 1.09 s on the way home) | red, same |
| `the lead wrist keeps to the region between the bat plane and the ground` | red | red, same |
| `each wrist closes on the bat inside its own bend and twist` | red (its own 1.17-1.19 s readings) | red, same |

Nothing the change itself is asked for — the knob on the plane, the whole bat across,
the lead arm's own elbow at the finish, the trail arm inside its own reach with both
hands still on the bat, the fists' grip — reads red: `the bat is carried round and off
the batter`, `the trail arm comes round the chest`, `the lead arm keeps a real bend on
the way home`, `the palms close on the handle`, `the fingers fold round the handle`,
`the swing keeps opening after contact`, `the hands stay out of the torso`, `the hands
finish where the shoulders went` and every pose baseline pass (`batter-follow-through.png`
and `batter-recovery.png` re-generated — the two poses the finish's own grip and the carry
move).

The two things that answer the pair this section describes are both in the component
rather than in the bounds, and both are in it now: the **held roll's reference** for a bat
carried flat across the body (the lead palm's own flip is that reference at that bat
angle, not the wrist's reach — see the back-of-the-palm section) and the **bat's own
place**, carried round the trailing shoulder and held inside that arm's reach, so that
the pose the reach is read at is one the trail arm can hold with both hands on the
handle. The section at the end of this document — *the knob is taken away from him at the
finish, with both hands on the handle* — carries both, with their measurements.

### The lead arm keeps a bend on the way home

The bounds above are about the *trail* arm, and about the two pinned poses. What
the lead arm did between them was not bounded by anything, and it was running to
the end of its reach: with the hands left where the follow-through put them, that
arm's shoulder-hand chord reads **0.97 to 1.07 of its own span from the hold to
0.95 s** — the clavicle's reach spends its whole 20° budget and the two bones are
stretched past their own length to cover the rest, a straight, over-extended arm
for the third of a second the hands take to come back. It is the *one* thing in the way home that reads as the
body being dragged rather than moving, and no other lever reaches it. Holding the
body open later into the reset (`settings.torsoRecoverLag` 0.25-0.75) leaves the
chord at 1.066 through the crux. The elbows' own carries run along their chords, so
neither can shorten one.

The pull has to be **along the direction the lead shoulder lies in from the held
grip**, and it is taken on two poses: the *hold's* own, so that the frame the reset
starts from is already bent, and the retrace's, along the whole of the way home
(`RESET_PULL`, **0.38** of that direction, faded out as the load comes back). The
hold's share is the one the boundary needs, and it is why there is no boundary: the
reset's first frame *is* the hold's last pose by construction (see `HELD_PULL`), so
the two phases meet on one pose handed from one to the other rather than on two
poses that have to agree. Measured in the reset's own sweep, the lead arm reads
**0.892 of its span at 0.82 s** (a 156° elbow) falling to **0.521 at 0.96 s**,
against the **1.316** the hold's own pose gives it before the pull — where the
hand's own reach takes the clavicle's whole 20° budget and stretches the two bones
7% past their own length to cover the rest.

The direction is **lateral**, across the body, and that is not a free choice: of the
three parts of the shoulder-to-grip chord, the vertical one is the trail hand's cost
(its grip rides 0.253 rig up the handle, so the higher the hands are carried the
further that wrist comes over its own shoulder) and the backward one is the bat's
clearance of the belly, while the lateral part buys the chord and *nothing else*.
What it does in exchange is carry the whole bat with it — knob end included — which
is the throw a follow-through ends on, and it is taken all the way: see the section
below for what it buys the rear arm and what it costs it.

`the lead arm keeps a real bend on the way home` pins it, in three parts now that the
pose the way home starts from is the *long* one the finish's own carry leaves (see the
section at the end of this document): swept at 0.01 s over the reset, no sample **past
the arm's own reach** (1.0 — the pose that reads as a straight arm laid on the ribs);
the arm **inside 0.9 of its span within 0.15 s of the hold's end and from there to the
end of the way home** (measured 0.11 s in — 0.892 at 0.93 s — then 0.576 by 1.00 s); and
the column required to *vary*, with the pose the path is authored from read on the same
page and required to be *over* the bound the pull bends it to (0.969 at the seam). A
frozen column is what the harness hands back when a probe aliases its own report across
a sweep — see `copyPlain`.

**What it costs is six bounds, and they are written where they are held rather than
argued away.** The bend brings the arms against the trunk, because the grip comes
back toward a shoulder that is inside the body's own mass: at 0.96 s, **22 of the
arms' 116 skin vertices read inside**, all of them the lead arm's, worst **0.053 rig**
against the trunk's own 0.016 noise floor (it is 31 and 0.058 with the hold's own
un-pulled grip — the throw below takes a third of it back) — `the hands stay out of
the torso` had held the whole arm's share to 15% and the trail arm to *0*, and now
takes 25% and 8 at the reset while keeping both bounds exact at all five pinned
poses. The trail arm's clearance of the ribs at the two samples the grip reaches
used to move with it and now reads **0 of its 246 vertices at the late
follow-through and 0 of 230 at the hold, worst 0.000**: `the trail arm comes round
the chest` raises its bound to 12 there and the pose leaves it as slack, with the mid
follow-through and the finish still reading 0 of 229 and 0 of 237. Both of that
test's *span* bounds still hold, unweakened.

The two elbow bounds are the sharper price, and getting them back cost the pose
itself. **The trail elbow rides *up* through the reset** — the way-home bow's own
vertical part lifted the hands 0.139 rig, and the trail hand grips 0.2 rig up the
handle, so its wrist rode over its own shoulder and took the elbow with it: +0.13
rig above horizontal between 0.91 s and 1.10 s, where the pose it replaced held it
at or below 0 at every sample. Held **flat** (see `LEAD_SHOULDER_FROM_PATH`) that
lift is gone, and the elbow comes down on its own — but only once `DRIVE_LEAN`
pitches the trunk further forward over the arms, which is what lowers the trail
shoulder's own wrist: measured, the elbow's direction through the reset reads
**−0.02 of the upper arm's length below horizontal at its highest** (1.06 s), or
−0.09 and below either side of it. The bound is back where it belongs — `the
elbows keep their own directions` holds the trail elbow **down for the whole cycle**
(`DOWN_MAX` 0 as it was before the bend, not the 0.14 it had been raised to), and
the same rule holds the *lead* elbow down too (`LEAD_DOWN_MAX` −0.1: it reads −0.23
at its highest, 0.73 s). With no drive lean at all the trail elbow rides **+0.02
*above* horizontal for seventeen samples** (0.92-1.07 s) and the same test fails
there; leaned *back* it is up for most of the way home and peaks +0.16 at 0.93 s.
What the pitch costs is the arms' clearance, monotonically: the chains' closest
approach reads 0.103 rig with no drive lean, 0.077 at 0.10 and **0.051 at 0.20**,
against a floor of 0.05 — and at zero the *order* breaks too (the trail forearm dips
0.004 below the lead's at 1.12 s). 0.10 is where the elbow comes down and the
ordering still holds; twice it trades one bound for the other.

**The lead elbow folds in with the hands**: its own carry used to hold it 0.2 rig
out beside the shoulder for the whole reset, and a folded arm's elbow sits beside
the ribcage instead — 0.12-0.19 through the hold and the reset's start and down to
−0.34 at 1.22 s, so that floor moves to −0.25 and now guards only the elbow folding
*past* the ribs. The ordering carry's “not thrown at the pitcher” bound moves
0.2 → 0.25 for the same reason (0.220 at 0.90 s against 0.170 before), and the
`recovery` baseline is regenerated: the reset is a different pose. Nothing else
moved — the swing's own frames, the contact geometry, the belt, the palm rule and
the ordering test's own crux bound (0.077 rig at 0.52 s against a 0.05 floor, with
the forearms' order held at +0.016 or above for all 68 of the samples they are
within 0.3 rig of each other) all hold.

### The back of the palm stays up all the way home

The fist's *roll* is the one axis of a grip that nothing else pins down. The palm
has to sit on the handle and the fingers have to close around it — both are
solved — but which way round the knuckles end up was whatever the arm's own reach
direction happened to give, because that is the reference the fist's frame was
built from (see `fistRotation`). Through the swing that is exactly right: a wrist
rolls with the swing it is driving. For a pose *held* up in front of the chest it
is not, and the reach direction there runs from a shoulder behind the body out to a
grip in front of it — through the follow-through and the way home it swings the
palm the whole way over. Measured off the posed skeleton, the **lead** hand's back
faced **0.69 and 0.54 *down*** at the end of the follow-through and through the
hold, ran 0.25 → **-0.50** over 0.05 s at 0.87-0.92 s, and the trail hand's ran to
**-0.50** at 1.22-1.37 s.

The reference is now blended, per arm and per phase, toward the axis that leaves
the back of the palm facing the sky — perpendicular to the barrel and to the
vertical. Two details it has to get right are read off the model rather than
assumed: which of the *hand's* axes is the back of the palm (the `palm_handle`
marker sits on the palm's side of the hand, so its own offset says which), and the
fact that the mirror-image right hand's basis comes out the other way round.

**A held roll's share is not scaled by the barrel's tilt.** The axis the reference
is built on is the world up crossed with the barrel, so it is ill-defined at
vertical and perfectly well defined thirty degrees off it — and a share *scaled* by
that tilt is not a held roll at all. At the 0.5 the barrel stands at through the
crux, the 0.6 this used to ask for came out as 0.3, and a blend that takes under
half of a reference passes *through* the reference's own opposite and comes out the
far side: that is the -0.50 above, measured. The share is therefore gated by the
tilt (0 below 0.1, all of it above 0.3) and the two figures below are what the pose
takes, while the swing's own roll keeps the tilt-scaled blend it was tuned with.

**The two hands do not take the same share, and the reason is measured.** The
front (lead) hand's held share is **0.5** and the back (trail) hand's is **0.65**.
Taking 0.55 and 0.6 on the front hand leaves the *back* forearm inside the trunk
at 0.96 s — 6 and 2 of its 116 skin vertices, against a bound of none — where at
0.5 it reads 0 (sweeping the back hand's own share from 0.5 to 0.65 changes that
reading by nothing at all: it is the front hand's roll, whose arm drags the chest
far enough round, that closes the back forearm's path along the ribs). The back
hand needs the larger share for the opposite reason: its own reach direction turns
through the reference's opposite halfway round the reset, and a share under half
passes through it instead of holding — at 0.5 the back elbow's direction stepped
**0.49 rig in one frame** there and the back palm came within 0.11 of edge-on; at
0.65 they read 0.19 and 0.15.

**Opening the body more does not buy the roll any authority** — measured, because
it is the obvious place to look for it. The wrist that puts the palm on the handle
swings *around* the bat's own axis with it (0.13 rig of arc), so the more roll is
taken the further the arm has to reach; that reach is what the bounds above are
about, so every opening lever was tried against it with the shares at 0.6: the
chest carried past the pitcher (`fullOpenYaw` -0.14: the back forearm at 0.96 s
reads 6 inside, unchanged), the trunk turned further toward the arms at the set
(`stanceArmFacing` 0.25: 6), the hands' way-home path bulged 0.42 instead of 0.30
(6), and both together and further (`fullOpenYaw` -0.35 with `followLowerOpenFactor`
1.15: 7). What the opening does buy is the *lead* arm's own clearance at the
reset's midpoint (5 of its 229 upper-arm vertices inside the trunk at 0.6, against
a bound of 4, falling to 4 with the chest at -0.14) — a real effect, but not the
one the roll needs, and it is not worth the set's own reading to take.

How far through the animation the roll actually holds is worth being exact about,
because its own reference fades out as the bat comes back upright: a bat standing on
end has no such direction at all. Sampled every 0.01 s across the whole way home
(84 samples, 157 of them with the barrel more than 0.5 off vertical), the back of
the palm, per hand:

| | finish | late follow-through | hold | reset midpoint | worst in the window |
| --- | --- | --- | --- | --- | --- |
| lead | -0.69 → **0.70** | -0.55 → **0.60** | -0.54 → **0.40** | 0.34 → **0.77** | **0.19** at 0.98 s |
| trail | 0.59 → **0.67** | 0.58 → **0.61** | 0.58 → **0.60** | -0.82 → **0.85** | **-0.08** at 1.26 s |

The one negative reading is the *hand-back*: over the last fifth of the reset the
roll is released to the hand's own, the two references are still more than a right
angle apart, and the blend necessarily passes the hand through them. It tips 0.08
past edge-on for 0.04 s (1.25-1.29 s) and takes 0.64 rig in its single fastest step.
Handing the roll back *later* was measured and is worse, not better: spread over
0.35 and 0.5 of the reset the weight sits under half while the arm's own reach is
still turned round the other way, and the palm rolls the whole way over (**-0.87**
and **-0.88**).

`the back of the palm stays up the whole way home, at every sample between the
poses` sweeps the window at the app's own step and holds both hands to it: nothing
below -0.1 past edge-on, the four moments above 0.25 as they were, and no step over
0.7 rig per 0.01 s (against 1.34 before). It is deliberately a window sweep rather
than four moments: every one of the roll-overs above sat *between* the four.
Reverting the roll all the way back to the arm's own puts the lead palm at -0.50
and the step at 1.34, and both are caught.

### The elbows keep their own directions all the way home

The lead arm's elbow belongs *out* beside its own shoulder — it has the bat's line
to follow round, and folded in against the body it reads as an arm held on to
rather than swung — and the trail arm's belongs *down*, which is where a batter's
trail arm relaxes to as the swing unwinds, and what keeps the trailing upper arm
from pointing at the sky over the top of the lead one.

Where they were, measured along the body's own axes: the trail elbow finished
**0.44 of the upper arm's length *above* its own shoulder** — the pop — and was
still 0.35 above it at the late follow-through, while the lead elbow lost its
outward carry through the reset (0.19 *inward* by the end of it, which is the
load's own hint coming back). The trail arm's finish hint now sits 0.42 below the
shoulder instead of 0.16, and the lead elbow's outward carry comes with the grip's
own reach: **0.47 / 0.31 / 0.28 / 0.26 outward** at the finish, the late
follow-through, the hold and the reset's midpoint, with the trail elbow **0.07 /
0.35 / 0.60 / 0.14 below its shoulder** at the same four moments.

**The hand-off from the hold to the reset was a jump, and the four moments could
not see it.** The trail arm's elbow target used to *switch* on the reset's first
frame — the finish hint's forward push was gated off with `isRecovering` and the
target replaced outright — and its direction stepped **1.40 rig between 0.82 s and
0.83 s**, a right-angle flick in one frame, which is the largest single-frame move
in the whole pose and falls exactly between the 0.82 and 1.095 samples. The forward
push now rides whichever hint is in play, and the way-home hint is blended *in*
over a tenth of the window. A tenth rather than more because of the same test's
other bound: at three tenths the arm is still half-way between the two hints at the
reset's first frame and the trail elbow reads +0.025 rig along the line to the
pitcher, over its bound of +0.01; at a tenth it reads -0.026.

`the elbows keep their own directions, at every sample between the poses` sweeps
the window the same way: the trail elbow below its own shoulder at every sample
(worst -0.07 up, at the finish), the lead elbow more than 0.2 outward to the
reset's midpoint (it bottoms at -0.20 by the end, which is the load's own inboard
carry — the set stance reads -0.21), and no elbow step over 0.35 rig per 0.01 s
(measured 0.28, at 1.24 s where the held roll is handed back and the arm's own
reach sweeps the wrist round with it; the switch above read 1.40).

### The elbows ride either side of the plane the bat swings in

Both hands are on the one handle, so the two arms are ordered against the bat
itself: the lead elbow under the plane the barrel sweeps in, the trail elbow over
it — the arm coming over the top of the bat is the one carrying the swing. The
plane is read off the live scene rather than fitted to the barrel's motion: the bat
hangs inside a named swing frame (`bat-swing-frame`) whose local X is the axis the
barrel sweeps about, so the barrel's line and that axis span the plane, with "up"
the upward half of the normal. `probeBat` reports both vectors, so the reading is
defined at every sample instead of only where the barrel is moving fast enough to
fit. Measured through the bat's own handle, positive above it, over the whole
cycle at 0.01 s:

- **the set stance and the load (0.00-0.22 s):** the lead elbow **-0.23 falling to
  -0.17**. This is the pose read before the swing starts. The *trail* elbow reads
  **+0.04 to +0.07** here and is not required to be under or over: the bat is cocked,
  so the plane through its own handle tilts **~56 degrees** (its normal still 0.56
  upward) and stands as a wall between the hands and the pitcher — the trail elbow
  sits within a tenth of a rig unit of it, and "over" it there would mean an elbow
  reaching across the cocked bat toward the pitcher. The rule bites once the bat is
  on its swing plane, and that is where it is pinned.
- **the bat carrying through (0.30-1.09 s):** the trail elbow **+0.06 at its
  closest (1.09 s) rising to +0.46** at the hold.
- **the way home (0.62-1.00 s):** both halves at once — the lead elbow **-0.33 to
  -0.07** under the plane with the trail **+0.33 to +0.45** over it. That is the
  split this exists for: the arms unwinding across the body with the bat between
  them.

The lead elbow under that plane *through the swing* is not achievable, and that is
geometry rather than pose, so the test records it instead of pretending to hold it.
At contact the plane passes **0.5 m below the lead shoulder** and the upper arm is
0.25 m long, so the closest the elbow can ever come is 0.34 rig above it —
measured, the elbow sits 0.39 rig from its own shoulder in every pose while the
shoulder is 0.80 rig over the plane, and the plane's own side of that shoulder
reads **+0.11 to +0.38 rig past the arm's whole reach** through the push to contact
(0.30-0.49 s). **Leaning the torso forward does not buy it**: the bat is a child of
that torso, so the frame the plane and the shoulders share rotates as one — swept
from 6° to 51° of forward lean the lead shoulder's own side of the plane reads 0.80
at every value, and 0.76 with the swing's own lean raised 0.3 -> 0.7 rad. Standing
the batter further back does not move it either (the pose is authored in the body's
frame, which is what makes the setback a *place*). Only lifting the hands up onto
the plane would, and that is a shorter bat — the opposite of what the setback
bought.

Two bands are therefore left unpinned and *logged*, because in each the plane
itself is swinging across the body's own shoulder line rather than the arms being
on the wrong side of it: the wind-up's turn onto the plane (0.23-0.28 s, where the
plane sweeps down past the lead shoulder — the lead elbow reads **-0.18 to +0.13**
across it) and the bat climbing back over the shoulder into the load (1.02-1.25 s,
where the plane's own sign flips twice as the barrel comes back up — the lead elbow
reads **-0.34 to -0.29** under it). `the elbows ride either side of the plane the
bat swings in` sweeps **138 samples** and fails on a lead elbow over the plane at
the load or on the way home, on a trail elbow under it anywhere the bat is
carrying the swing, and on those frames of the push where the plane is not past the
lead arm's whole reach — with each window required to have been swept, so a window
that quietly emptied cannot pass.

The lead elbow is deeper under the plane than it used to be, and that is the lead
arm's *wrist* rule doing it (below): the fist's roll is asked for the plane before
it is asked for the bend, so the forearm the elbow's own circle is measured against
sits a little lower, and the walk that fills the circle finds deeper points. The way
home's lead elbow is **-0.33 to -0.07** against the **-0.11 to -0.04** it read
before, and the climb's **-0.34 to -0.29** against 0.00 to +0.25.

### The lead wrist keeps to the region between that plane and the ground

The forearm has two ends, and the elbow is only one of them: the lead *wrist* —
the end nearer the bat — is held in the region between the same plane and the
ground. The reading is the driver's own, off the grip the arm is holding
(`wristOverPlane`), positive above the plane. What can put it there is the fist's
**roll**: the wrist is the grip less the fist's own reach, and a roll turns that
reach about the barrel, so the wrist runs round the handle and its side of the
plane is a cosine in the roll.

Unlike the elbow, this is not a limit of the pose's geometry: the fist's reach can
always get under the plane — measured, the deepest *any* turn at all could put the
lead wrist is **-0.127 rig units at every one of the 138 samples** of the cycle. It
is a limit of the fist's *window*: a roll is a grip only within `GRIP_ROLL_MAX`
(15°) of the turn the pose authored, and the arm solve spends that window on the
plane — the plane outranks the bend for the lead arm, the same way the elbow's
plane rule does, and the window's own edges are candidates so that "sink as deep as
the fist can" is a roll the fist really has. Measured over the cycle (138 samples,
0.01 s):

- **the set stance, the load and the way home (62 samples):** the lead wrist reads
  **-0.127 to +0.009** — under the plane, or on it to within a hundredth of a rig
  unit. That is the window the rule is pinned over.
- **the wind-up's turn onto the plane and the push to contact:** 30 samples over
  the plane, **+0.024 to +0.122** — every one of them inside the same two bands the
  elbow's rule leaves unpinned (above), and in every one of them the fist's own
  window is *spent*: the deepest any turn inside it could put that wrist is within
  **0.002 rig units** of where it sits. The whole window is already on the plane.

**A wider window really would buy it, and it is not taken.** Measured, the samples
over the plane fall **19 -> 17 -> 11 -> 6** of 67 as the window goes 15 -> 30 -> 60
-> 75 degrees. What it costs is continuity, and the price is steep: the deepest
turn inside a window is the one at whichever edge is nearer the plane's own answer,
so as that answer sweeps past the window's far side the fist flips a whole window
wide in a single frame. Measured at 0.35 s, one frame of the wind-up — where the
plane crosses that arm: the lead hand moves **0.237 rig units** per frame with the
roll held at the pose's own (**0.2355**, i.e. the swing itself moving), 0.237 with
the window at 15°, **0.295** at 30°, **0.394** at 60° and **0.418** at 75° — with
the roll itself jumping **112 degrees** in that frame at 60. A fifth of a rig unit
of flicker is exactly what the fist is not allowed to do, so the window stays where
the grip puts it and the plane keeps whatever fifteen degrees can give it.

The window is bounded from the other side too, by the *arm*: a roll carries the
wrist round the handle with it, and a wrist further from the shoulder than the arm
can span is a palm off the handle rather than a hold (see `reachRollWindow`). With
the window free of the grip's bound that is what happens first: measured, the
contact's lead arm needed **1.31 of its own span** and left the hand **0.044 rig
units off the grip it was holding**. The rule therefore takes the smaller of the two
windows, and where the arm's is the binder the wrist sinks as deep as the arm's own
reach allows and no deeper.

`the lead wrist keeps to the region between the bat plane and the ground` sweeps the
whole cycle, fails on a wrist over the plane at the load or on the way home, fails on
any sample over it where the fist's own window was *not* already spent (reported as
`wristWindowDeepest`), and requires the fist's reach to be able to get under the
plane at every sample — a pose where it could not would make the rest of it vacuous.

### The fists close on the handle, and the trail hand grips up it

The model's own rig holds the answer to how the hands should hold a bat: a
`palm_handleL` / `palm_handleR` node inside each palm (the point of the handle the
fist closes on, plus the direction the handle runs through it), and one IK target
per hand whose spacing is the grip the hands were modelled for. The driver was
ignoring all of it and aiming each *wrist* at the grip point. A wrist sits at the
end of the forearm, ~1.4-1.9 palm-radii off the fist's centre, so aiming it left
the palms lying flat against the handle instead of closing around it — and because
both hands were aimed at the same spot, the pair read as one lump.

Solving the palm onto the grip — and the wrist at the offset that puts it there —
fixes both at once. Measured by `probeGrip` (which reads the posed result back
against the rig's own markers): the handle now runs through both palms at
**0.000-0.006 rig** off the fist's centre (**0.0-3.4 mm**; the tolerance is 0.01),
aligned with the palm's own handle axis to better than 0.99, and the two fists
grip **0.253-0.258 rig apart where the rig authored 0.253** — the spacing is
read off the model at load (`rig.grip.separation`) and falls back to 0.253, so a
different hand rig carries its own. The trail hand — the one away from the
pitcher, which the swing turns last — sits at 0.253 *up* the handle toward the
barrel, and the lead hand closes at 0.000 on the knob end, so the two fists stack
rather than overlap. `the palms close on the handle, and the trail hand grips up
it` pins all four readings, and it is non-vacuous: aiming at the wrist again
fails the palm-to-axis bound.

### The wrist's limits are read off the bones, not off the model's elbow

The wrist has two limits — 30° of bend between the hand's own direction and the
forearm's, and 10° of twist about the forearm's own axis — and until this pass the
solve measured both against **the elbow its own model put on the IK circle** rather
than the elbow the bones ended up with. The two are not the same point, and the gap
is worst exactly where the wrist matters: measured across the cycle, the direction
from the model's elbow to the posed hand reads up to **12.6° away from the forearm
the bones show** at the fold through the follow-through, and the driver's own bend
sat **18.6° off the arm on screen**. Every rule keyed off it was controlling a
fiction: the suite would have read the arm as 46° bent while the solve believed 30.

Read the forearm off the posed chain instead — the same two joints `probeBones`
reads — and the two agree to **3.4°** everywhere. The twist then falls into place on
its own: both wrists sit inside **±10.01°** at every one of 276 samples, the trail at
exactly 10.00 through the whole carry, where before the honest reading it was
±26° on the lead arm and the forearm's correction was rolling the long way round.
`each wrist closes on the bat inside its own bend and twist` pins the twist and the
bend's own accounting; it imports both bounds from the driver so the test and the
solve cannot drift apart.

**The 30° bend cannot be held everywhere, and the pose is why.** A fist closed on a
handle has its knuckles' line square across the bat — measured, the hand's own
direction is **89.3° off the barrel at every sample** — so the bend bottoms out at
`|89.3° − the forearm's own angle off the bat|`. That is inside 30° whenever the
forearm is 60-120° off the bat, which is the swing proper; through the load, and
again at the set stance where the bat and the forearm lie nearly along each other,
the floor is 40-96° and neither the elbow's circle nor the fist's roll can close
it. The test is written to that: every sample whose own floor — the lowest bend the
elbow's circle reaches — is inside the limit must have its bend inside it too
(measured: **0 offenders**), and every sample over the limit is required to be one
the arm's own reach could not answer (161 of 276 readings are reported with their
floors rather than asserted).

**The fist's roll is not a way out, which the grip itself says.** The roll about the
barrel is the one degree of freedom a fist leaves, and the build this pass started
from spent it freely to chase the bend — turning the fist up to a **right angle
round the handle**. `probeGrip` reads what that costs: the palm's own marker sits on
the handle's axis at the pose's own roll, so turning the fist swings it round the
barrel by the grip's reach (0.253 rig) times the sine of the turn, and the trail
palm's skin leaves the near side of the handle entirely (−0.023 rig where a closed
fist reads at least +0.005). The window a grip has is nought: even the few degrees
the bend's own rule asked for at contact put the lead palm **0.011-0.012 rig** off
the axis where the suite allows 0.01. So the roll is bounded there (`GRIP_ROLL_MAX`)
and the bend is the elbow's own circle to answer for — which is also what keeps the
arm smooth: the roll rule was a fixed-point iteration against the arm it moved, and
measured, it hopped the roll **-63, -6, -81, +16, +24 degrees** across five frames of
the unwind.

**One rule, one walk.** The elbow's two rules — the lead arm's side of the bat's
plane, and the bend the roll leaves — used to be separate cases, each moving the
elbow to its own idea of where the arm should be. Where a pose drifted between "the
roll holds the bend, so walk to the plane's boundary" and "it does not, so walk to
the bend's", the answer moved between two different points: measured, it hopped the
elbow **0.29 rig in a single frame at the hold**. They are now one walk over the same
circle: the plane is a filter on every candidate, the bend the next, the nearest
point that passes both is solved for by halving, the lowest bend is the fallback
where the plane leaves no such point, and the deepest point on the circle is what is
left where the arm cannot reach under the plane at all. The suite's own plane rule
(see `the elbows ride either side of the plane the bat swings in`) reads the driver's
`elbowOverPlane` against its `elbowDeepest` for exactly that reason, and the sweep
now reports the lead elbow **-0.32..0.09 rig** on the way home against a 0.02 bound.

**Still open: the lead palm at contact** reads **0.0121 rig** off the handle's axis
where the suite allows 0.01 (`the palms close on the handle, and the trail hand grips
up it`) — the same reading with the roll's rule at ±15° and with it at nought, so it
is not the roll and not the elbow the solve places, and it is the contact pose alone
(stance and mid-swing both read 0.0004). Placing the walk's elbow exactly on the IK
circle rather than shifted off it changed nothing measurable.

### The bend is the *pose's* floor, and the grip owns it

Swept over the cycle, the bend's own floor (see `probeSolve`'s `bendFloor`) is
`|89.3 - the forearm's angle off the barrel|` *only when the fist's roll lines the
knuckles' line up with the forearm's part square to the bat*. Where it does not, the
floor is the raw angle between the two directions and the lean cannot help: measured
at the set stance, a 129.2-degree lean with the phase 91 degrees out is 95.8 degrees
of floor, and freeing the roll shrank the trail arm's floor to **30.0 at the stance,
1.2 through the push, 4.6 through the follow-through** — the bound *is* reachable in
the pose, by the phase alone.

What stops it is the grip's own geometry. With the roll's window at a right angle,
the set stance's right palm reads **0.0332 rig** off the handle's axis where the suite
allows 0.01 — and that reading is the fist's roll itself (the same frame reads 0.0004
with the roll held at the pose's own), so authoring the fist 55 degrees round the
handle fails exactly as the rule does. The window is therefore **fifteen degrees**,
which is what the stance holds with room to spare. A pose that wants the rest has to
move the fist's own authored frame — `fistRotation`'s reference, not the solve.

Two pose-side things did come out of it. The authored forearm hints are now projected
into the band a wrist can hold (`FOREARM_LEAN_MIN`/`MAX`, 66-114 degrees off the
barrel, seven degrees inside the 30 the wrist has), turned inside the plane the barrel
and the forearm share so the elbow's out-of-plane placement is untouched; measured, the
trail arm's lean at the stance came 129.2 to 120.0. It runs *before* the lane and
ladder rules, so the ordering guarantees keep the last word. And the roll's own window
is bounded at the fifteen degrees the grip tolerates, which took the trail arm's floor
from 114.8 to 45.8 over the cycle.

### The fingers fold round the handle, not alongside it

Placing the palm on the handle is not the same as holding it. The model's fists
are their own meshes and they are **moulded open**: the four fingers are one bone
running past the handle and away from it, so a hand whose palm has been solved onto
the bat still has its fingers lying along the barrel — measured off the posed skin,
every one of the fingers' own vertices sat on the palm's side of the handle's axis
and *further* from it (0.043 rig) than the palm's own skin (0.024).

A fist closed on a bar hinges on the knuckle line, which is parallel to the bar, so
the fold is a turn **about the handle's own axis** taken through the knuckle — the
same axis the palm was turned onto. The driver turns the finger bone 2.15 rad that
way and the thumb (the shorter, thicker digit, which comes at the handle from the
other side) 0.3 rad the other, with the sign read off each hand's own knuckle and
handle if the model is mirrored. Measured by `probeGrip`, which splits each fist's
skin by the bone carrying it and reads every group against the handle's axis as the
*fist* sees it: with the curl off the fingers stop **0.034 rig short of the
handle's far side**; curled, their own skin crosses **0.035-0.042 rig past the
axis** in every phase with its closest point **2-7 mm off the handle** against the
palm's own 38-43 mm. That ratio is the fold, and the thumb closes to within
16-20 mm. `the fingers fold round the handle instead of lying along it` pins the
crossing (a hand lying alongside the bat has no far-side skin at all, so a
near-side-only reading cannot satisfy it), the fingers coming inside the palm's own
radius, the thumb closing too, and the palm itself staying out on the near side.

### The trailing arm never changes places with the leading one

Both hands are on the one handle, 0.253 rig apart up it, so the two arms are only
ever ordered against each other by *where their elbows ride*: the trail elbow out
on its own side of the bat and the lead one on its own holds the two chains apart,
and the moment the trail elbow falls onto the lead arm's side they swap — the
forearms passing through each other on the way. They did, three times over.
Measured on the committed pose, sweeping the swing and the whole way home at
0.01 s, the two chains came **0.001 rig apart** (through each other) at 0.50 s,
again **0.001 rig** at 0.96 s with the trail elbow's own carry over the lead's
down to **0.069 rig** at 0.94 s, and again 0.004 rig at 1.00 s.

Two things hold them apart. The trail elbow is carried along its own lane
(`TRAIL_LANE_MIN`, the body's own lateral taken flat so the carry moves the elbow
along the bat and not up into the trail arm's own "points down" bound), and that
carry is *ramped from where the pose already is* rather than switched on as a
floor — spent as a floor scaled by the follow-through's progress it still moved
the elbow on the contact frame, where the authored pose sits on the lead arm's
side of the lane and a floor of zero is therefore itself a push, which the belt's
own close-up caught as a shifted baseline. And the trailing palm's held roll
arrives late, over the last tenth of the follow-through rather than across it: a
partial blend of that reference is not a small version of it — the wrist sits on
the roll's own radius, so taking part of it swings the wrist *around* the handle,
and at 0.50 s the trail wrist came 0.09 rig onto the leading hand's side of the
handle with the blend at 0.7. Held off until the bat is round, the wrist keeps its
own side (0.19–0.22 rig out) and the chains read 0.15 rig apart. What it costs is
the turnover: the roll turns over 0.53–0.54 s, a 0.32 rig move of the wrist in a
hundredth of a second, against the 0.18 rig the swing's own fastest wrist moves
are.

With both in, the two chains read **0.081 rig at their closest** over the window
(at 0.95 s) and the trail elbow never comes within **0.262 rig** of the lead arm's
own side of the bat. `the trailing arm never changes places with the leading one`
sweeps 118 samples at 0.01 s from 0.2 s before contact to the end of the reset —
swept, not sampled, because the crossing lives between the poses and a switch would
show as a flick between one hundredth of a second and the next — and it fails on the
committed pose at every one of the three episodes above.

### The trail elbow points away from the pitcher, from the reset's midpoint on

The way the swing comes *back* is half of what it reads as. The follow-through
leaves the trail arm folded across the chest, and unwinding it along the path it
arrived on sent its elbow forward — at the pitcher — for the whole reset: measured
mid-reset, **0.29 rig toward him** with the forearm folded across the body, which
is an elbow pointing the wrong way round. A batter's trail elbow comes *down and
back* on the way to the load, so it has to leave the shoulder-to-hand line on the
far side of the pitcher.

The ordering carry above is what sets the bound's own shape, and the trade is
measured rather than assumed. Over the trail arm's *whole* roll freedom at the
crossing frames — the elbow rides a circle square to its own shoulder-hand chord,
so every angle on it is an arm the rig could solve — the best the two chains can be
held apart while the elbow stays behind its line *and* the trail upper arm stays
out of the sky is **0.028 rig at 0.94 s, 0.050 at 0.96 s, 0.080 at 0.98 s, 0.099 at
1.00 s**; past the elbow's line the same frames reach 0.10. The pose that holds the
arms apart is therefore the pose that reads forward, and it gives it back as the
reset unwinds. Sampled every fifth of the recovery window, the elbow reads **0.17 →
0.08 → -0.01 → -0.14 → -0.31 rig along the line to the pitcher**, standing 0.31 →
0.21 → 0.08 → 0.18 → 0.34 rig off that line: over the line for the first fifth,
where the carry is holding the two arms apart, and behind it from the reset's
midpoint on. `the trail elbow comes down and back through the reset` pins both
halves — the ordering carry's own bound (0.2 rig) over that first fifth, the sign
of the line from the midpoint on — and requires the arm to actually bend (0.36 rig)
so "the elbow is behind the line" cannot be satisfied by a straight arm. The old
pose's failure (0.29 rig at the midpoint, with the elbow ridden onto the lead arm's
side of the bat) fails both.

### The recovery unwinds as one motion

The swing fires as a chain — back foot and hips, then the body turn, then the
hands — and it comes home as *one* motion: the torso turns back on the very clock
the shoulders and the bat ride. The tuning used to hand the torso a late start of
its own (`settings.torsoRecoverLag`: a share of the window spent still held open
while the arms unwound first), and the body cannot produce that lag. The arms are
solved onto a bat whose grip rides the arms' clock, so a chest still turned 30°
open made the hands fold in across the body's own midline instead of staying out
by the shoulder — the grip came within 0.075 rig units of the hip centreline, i.e.
into the torso — which reads as the shoulders twisting off the chest on the way
home. `torsoRecoverLag` is therefore 0, and the whole chain unwinds in the order
it fired: the pelvis-to-chest separation the swing built (0.0° at the stance,
29.2° / 9.0° / 5.8° at mid-swing, contact and follow-through) is back to 2.0° part
way through the recovery. `the torso turns back to the set stance with the arms,
not behind them` samples *inside* the window (the chest is 17% / 54% / 86% of the
way back at 25% / 50% / 75% through) rather than only at its ends, because the
failure is a rate, and it also requires the recovery to land exactly on the set
stance with no turn left between the pelvis and the chest.

The way home is also *bowed off the body*, because the swing's own curve is not: the
retrace walks the curve the swing made, and that curve passes close over the trunk —
measured, the hands come within **0.14 rig units** of the body's own line at 1.24 s
(0.11 at 1.29 s), where the set stance holds them **0.54** out. So the retraced pose
is pushed off it along the direction the *load* holds the hands in — out toward the
pitcher with a tenth of it to the batter's own side (`RECOVERY_AWAY` 0.16 rig) — by a
bow shaped `sin(pi r^2)^2`, which is nought at both ends of the recovery (the hold's
own lifted pose and the load, so the way home still meets exactly the poses it starts
and ends on) and still carries 0.82 of its own width at r = 0.8, where the swing's
curve comes closest. Measured, the hands' distance from the body's line through the
middle of the way home goes **0.12 -> 0.47 rig** at 1.15 s and **0.159 -> 0.243** at
1.24 s, the bat's own path moves steadily out with it (its own x from **-0.256 to
-0.184** at 1.135 s), and the hands' worst frame-to-frame step across the recovery
falls rather than rises (**0.305 -> 0.302 rig**).

Two things the body borrows to hold the bat, both from the reference rig: its
limbs were *elastic* cylinders (its forearm nearly doubled in length through the
swing, and the tuning's hand path is authored against that), so the driver
stretches the arm's bones along their own axes where a grip sits beyond this
model's span, and swings the clavicle up to a real clavicle's worth of protraction
first. Both are bounded, and the suite pins the bounds.

### The way home carries the bat out to the line of the pitch before it folds

The trailing arm has to *point* on the way home as well as reach: out until its
chord lies square to the front line of the box — straight at the pitcher — and only
then fold inwards into the set stance. Left where the hold puts it, the fold runs
*through* the crossing instead of after it: the retraced pose that crosses the line
at 1.07 s has the arm already folded to **0.874** of its own span (a 152.5-degree
elbow), so the arm is bending while it swings out to the line, and the elbow's own
bend reverses **10 times** on the way home instead of closing once.

`RECOVERY_CARRY` (0.15 rig) presses the grip on out along the trailing chord over
the first two fifths of the recovery, held to 1.13 s and given back by 1.33 s, with
the reach bound lifted over it from the reset's own `TRAIL_REACH_MAX` to
`TRAIL_REACH_STRAIGHT` (0.972 of the arm's own span) so the push cannot walk the
bones past their length: one lever carries the grip out, the other is the ceiling
it is carried to, and the straightness is held by the bound rather than by the
arithmetic of the push.

The push is aimed along the trailing chord **tilted toward the batter's own lead
side** (`RECOVERY_CARRY_ACROSS`, a 0.75 share of the push's own length). Both arms
hold the one grip and the trailing shoulder sits a shoulder's width behind it, so a
push along the chord alone lengthens the lead arm by 0.7 of what it lengthens the
trailing one — measured, it took the lead arm to 0.97 of its span and reddened
`the lead arm keeps a real bend on the way home`. Aimed across, the push carries
the grip toward the lead shoulder as much as it carries it away from the trailing
one, and the trailing arm is the one that lengthens. Read off the bones over the
way home (0.85-1.36 s at 0.01 s):

| | before | after |
| --- | --- | --- |
| the chord's nearest the line of the pitch | 1.07 s, **0.6°** off | 1.08 s, **1.3°** off |
| the trailing arm's span *there* | 0.874 (a 152.5° elbow) | **0.964 (a 165.4° elbow)** |
| frames within 12° of the line | 4 (1.06-1.09 s), span 0.812-0.903 | **5 (1.07-1.11 s), span 0.934-0.966** |
| the chord's own heading swept in all | −146.9° | −146.9° (largest frame 7.8°) |
| the elbow's own bend reversals after it | **10** | **6** |
| the lead arm's span, mid-way home | 0.912 | 0.939 (its 0.95 bound holds) |

The heading sweeping under 180 in all is the reading that would call out an arm
flipping through its own socket; the straightness *at* the crossing is the reading
that separates this path from the retrace's. `the trailing arm goes out to the line
of the pitch before it folds, and folds one way` sweeps the recovery and pins both —
four frames within 12° of the line with the span over 0.9 of its reach and the elbow
over 158° there, the whole way home's heading under 170° with no frame turning it
more than 15°, and past the crossing the elbow's own bend closing by over 25° without
re-opening more than 2° off its own floor. Turned off (`RECOVERY_CARRY` 0) it reddens
on the first of those with the retrace's own readings — `1.07s 0.874, 1.08s 0.841,
1.09s 0.812` — which is what the push is for.

The harness mounts the batter the way the app does — with no pitch at all first,
waiting for the body's own asset to load, then the pitch — so the suite covers the
late-pitch mount as well as the poses themselves.

### The knob is taken away from him at the finish, with both hands on the handle

Two things were asked of the end of the swing, and both are in `Batter.jsx` with
their prices written down next to them.

**The finish carries the knob away from the batter far enough that the lead arm's own
forearm-to-upper-arm angle stays past 135°.** The finish's grip is carried **0.20
rig further out in front of the belly** (`FINISH_DEPTH` 0.46 → 0.66) and settled three
hundredths lower (`HOLD_SETTLE` 0.05 → −0.03). Read off the posed skeleton — shoulder,
forearm, hand — the lead elbow is:

| | 0.44 s (the carry) | 0.46-0.48 s | the throw (0.50-0.53 s) | 0.54 s (the finish) | 0.56-0.82 s (the hold) |
| --- | --- | --- | --- | --- | --- |
| the lead elbow | 175° | 175° | 175° | 176° | 176° |
| the arm's own span | 1.128 | 1.087-1.122 | 1.009-1.041 | 1.149 | 1.148 |

So the angle holds **175-176°** at every frame of the carry, the throw, the finish and the
whole hold, with the arm's own span never under **1.009** over any of it and the bones
stretched up to 15% — inside the 25% the rig's own arms allow (`ARM_STRETCH_MAX` in
`playerRig.js`). The 135° the finish was asked for is answered with room to spare, and
that is this tree's own ending: while the trailing arm's reach bound was still pulling the
grip in through the swing, these same frames read **0.959 of the span and a 147° elbow**
(see the last section here). Depth is the one direction that both lengthens that chord
and carries the knob off the batter's chest: the same pose at the old depth reads
**123-129°** (0.879-0.902 of the span, at 0.535-0.55 s), which is the folded arm the
reading exists to catch — and *height* would go the other way, the lead shoulder being
0.72 rig above the pelvis (0.09 rig lower reads 0.99 of the span, 0.05 higher 0.94).
Nothing else moves: both palms still close on the handle at the finish, inside the suite's
own spacing bound, and the deeper carry *improves* the bat's clearance — the nearest body
skin to the bat's line from the follow-through through the hold reads **0.415-0.497 rig**
against the 0.25 bound.

The way home inherits the long arm, and its own bound had to be told so (see the lead
arm's section): the reset opens on the hold's own pose, where that arm reads **1.149**, and
the handback — the same first fifth of the way home the held grip comes back over — brings
it to **0.964 four frames in** (0.86 s) and **0.576 by 0.97 s**. That is the window the
lead arm's own test reads its reach bound from, rather than loosening the bound for the
hold's first frames.

**A release was built first, and it is where the trail arm's own flip came from.** The
hand came off the handle after the last two-handed frame and settled beside and below its
own shoulder, with the lead hand carrying the bat alone. As a pose it was sound — measured
at the across pose, the released arm read **0.54 of its span with a 65-degree elbow**,
**0 of its 230 upper-arm vertices inside the trunk**, and its wrist's bend floor fell to
16.6° from 49.3 — and the hand-off read as the bat leaving the hand: frame by frame
(0.005 s steps) the fist's own speed went 6.7 → 28.2 → 31.5 rig/s off the handle and back
down to 1.8 by 0.520 s, against a bat that peaks at 44 rig/s a frame later, and its
closest approach to the handle's axis was 0.785 rig once it had let go.

**What it could not do was *travel*.** The released hand's place is a *retarget*, and a
retarget is a sweep: taken per frame, the trailing arm's own shoulder-to-hand line was
carried through the shoulder's narrow side and out the far side of it — a roll past a half
turn, which no shoulder makes, and the reason the eye read the arm as flicking backwards
at the end of the follow-through. No easing of the retarget removes the roll, because the
start and the end of the sweep sit on opposite sides of the joint: the hand has to go from
a handle held out across the body to a place beside its own hip, and the shortest path
between them passes through the joint.

**The finish is two-handed instead, and that is what makes the release unnecessary.** The
pose the release existed to reach — the bat out across the body with the trailing arm
inside its own bounds — is reached by the *bat's* own place: carried round the trailing
shoulder and left inside that arm's own reach (the two levers in the section below), the
two-handed finish reads **1.19 of the trailing arm's span with a 176-degree elbow, 0 of
its 250 upper-arm vertices inside the trunk and 0.029 rig of daylight off it**, and the
trailing palm stays on the handle at every sampled phase. So there is no second pose below
the path's own end, no one-handed moment for the suite to sample, and no roll for the
shoulder to make.

### Taking the last two-handed frame's bicep out of the ribs

The trail bicep reads **0.048 rig inside the ribs** (24 of its 230 skin vertices) at
0.48 s — the last frame both fists are on the handle — and no hint can steer it: the
grip is carried 1.00 of that arm's span from its shoulder (1.11-1.26 through the frames
before it), the clavicle has already spent its human twenty degrees reaching for it, and
an arm at the end of its span has no elbow to move. Measured in the same pass: 20
configurations of the elbow's own finish target — 0.24 rig of it, side, drop and the
forward term — leave the reading at 24 vertices and −0.048, and the trunk's own posture
is no lever either (0.08 → 0.24 of `swingBackTilt` makes it worse, `legLean` and
`fullOpenYaw` leave it where it is).

Pulling the bat in along the shoulder-to-hand chord — the lever the way home already
takes (`RESET_PULL`) — is the one that would give the arm its slack back, and its
frontier is empty, because the pull's direction *is* the direction to the batter: at
0.48 s, holding the hand inside 1.50 of the span leaves 24 vertices at −0.048 with the
body 0.298 rig from the bat's line; 1.45 (0.04 rig of pull) is 24 at −0.048 and 0.269;
1.40 is 7 at −0.029 but 0.238 clear; 1.36 is 1 at −0.020 and 0.213; 1.18 is clean and
0.110. The clearance has 0.059 rig of headroom over the 0.25 the suite holds it to, and
the pull that clears the bicep costs 0.10 of it. The clavicle past its twenty degrees
does clear it (32°: 0 vertices, +0.026 rig) against the suite's own ≤ 20.5° bound, and
the trailing fist letting go earlier does too (1 vertex at 0.50 s, 0 at 0.51) — both
already spent or claimed.

What is left is the bat's place moved *away* from him rather than toward him, and it is
what this tree does. Through the carry the hands are carried **0.42 rig round the
trailing shoulder** — up, out and forward, `TRAIL_REACH_CLEAR` in its own body-frame
direction — taken on over the hand-over window and held through the finish and the whole
hold, then given back over the first fifth of the way home (`TRAIL_REACH_UNWIND`), so the
carry's own frames and the throw's clock are the swing's. Measured, posed:

| | 0.44 s | 0.46 s | 0.48 s | the finish (0.54 s) | the hold (0.68 s) |
| --- | --- | --- | --- | --- | --- |
| the trail bicep, the swing's own path | 8 / −0.020 | 20 / −0.038 | 24 / −0.048 | — | — |
| the trail bicep, this tree | **0 / +0.000** | **0 / +0.000** | **0 / +0.000** | **0 / +0.029** | **0 / +0.029** |
| the trail arm's span / elbow, this tree | 1.118 / 175° | 1.051 / 175° | 0.999 / 175° | 1.186 / 176° | 1.190 / 176° |
| the body's nearest skin to the bat's line | 0.382 | 0.371 | 0.392 | 0.497 | 0.497 |
| the knob's own place off the lead shoulder's plane | 0.618 | 0.543 | 0.505 | −0.014 | −0.087 |

So the bicep is **out of the ribs** and the bat is carried *further* from him: the body's
nearest skin to the bat's line runs **0.371-0.497 rig** across the window against the 0.25
it is held to, and the knob comes round from **0.618 rig** on the batter's own side of the
plane through the lead shoulder to **0.087 past it** by the hold. The arm reading those
numbers is *straight* — 175 to 176 degrees at every frame, its chord never under 0.999 of
its span — which is the pose the last section here is about, and the reason the carry is
taken 0.42 rather than the 0.34 that was enough while the reach bound was still pulling
the grip back in.

**The second lever is the trailing arm's own reach, and it belongs to the way home.** Both
fists are on the handle the whole way, and the trailing fist grips `gripSplit` up it, so
the chord from the trailing shoulder to that grip is the span that arm has to cover. The
swing's own path carries it to **1.19 of the arm's span** at the finish and through the
hold — a 176-degree elbow with the bones stretched 19%, inside the 25% the rig allows,
which is a pose a two-handed follow-through has. It is the *retrace* that goes past what
the bones answer for: walking the finish's own poses backwards it reaches **1.25 of the
span at 0.84-0.92 s** with its bicep **0.05 rig into the ribs**. So `TRAIL_REACH_MAX`
(0.92 rig) pulls the grip back **along the chord's own line** — the direction the bat was
carried *out* on, so nothing is pulled sideways into him — and it is taken up over the
reset's own first fifth (`reachIn` in the frame loop, on `TRAIL_REACH_UNWIND`'s clock),
the window the held pose comes back over. Read against the shoulder the arm solve itself
builds the arm from, so the bound and the solve cannot drift apart. By 1.00 s the retrace's
own chord is under 0.94 of the span and the bound has nothing left to do: the reset from
there reads the 138-152° elbow it read before the bound was ever written.

**The frontier between the two bounds is one trade, and it is measured.** The carry round
is what takes the bicep off the ribs with the arm straight, and how much of it is set by
the one frame the swing's own path comes inside the arm's own reach — 0.48 s, the last
frame both fists are on the handle. With the reach bound on the reset (where it now sits):

| `TRAIL_REACH_CLEAR` | the trail elbow, the carry to the finish | the deepest bicep | the biggest bone step (per 0.01 s) | the elbow's own direction, worst |
| --- | --- | --- | --- | --- |
| 0.34 | 161° at 0.48 s (175-176 either side) | 1 vertex, −0.017 rig | 0.338 rig | +0.170 |
| 0.38 | 165° at 0.48 s (175-176 either side) | 1 vertex, −0.011 rig | 0.304 rig | +0.186 |
| **0.42 (shipped)** | **175-176° at every frame** | **1 vertex, −0.004 rig** | **0.230 rig** | **+0.203** |

0.42 is where the arm stops bowing: the chord's shallowest frame rises from 0.986 to 0.999
of the arm's span, so the elbow never leaves 175°, and the bicep reads *clearer* for it
(−0.004 against −0.017 rig at the deepest, and +0.029 rig of daylight at the finish and the
hold against 0.023). Sliding the pulled grip *along* the sphere the reach bound holds it on,
in the direction that gives the leading chord its length back, was built and measured too
— it holds the leading elbow at 150° right through the throw, but it pushes the bat 0.19
rig off the plane by the hold and leaves 16 of the trailing arm's 234 vertices 0.054 rig
inside the trunk, so the plain radial pull is what stands.

**The reach bound's own frontier is the one this turn settled, and it is a question of
*when* rather than how far.** Held over the swing — which is how it read until the flicker
it caused was measured — it pulls the grip in against a chord the swing's own path already
holds at the arm's own reach (1.16 → 1.06 → 1.00 of the span over 0.42-0.48 s, then back
out to 1.19 by 0.52), so it bites on some frames and not others:

| `TRAIL_REACH_MAX` | the trail arm, the carry to the hold | the lead elbow |
| --- | --- | --- |
| **0.92, on the reset alone (shipped)** | **1.00-1.19 of the span, 175-176° at every frame, 0.23 rig of bone step** | **175-176°** |
| 0.92, held over the swing | 0.93 of the span, a 136-151° ribbon, 0.43 rig of bone step (per 0.01 s) | 147° (130° for one frame inside the throw) |

That is the flicker the instruction *"keep the trail arm straightened after it straightens
the first time during the swing through the follow-through"* reads as: the arm straightens
on the ball (175° at 0.34 s, held through the contact frame) and then the bound bends it
back to 150 degrees within the frame after contact and leaves the forearm flicking about
its own
elbow for the rest of the follow-through — 11 degrees of ribbon with reversals inside it,
and a 0.43 rig step of the upper arm between frames. With the bound taken off the swing the
same frames read 175-176° with a 0.23 rig step, and what it costs is the *lead* arm, which
no longer has the pulled grip shortening its own chord: it comes through the carry at 175°
and reaches the finish at 1.149 of its span (see the section above). The suite pins the new
shape from both ends: the trail arm's own test reads its straightness at the carry, the
finish and the hold — it used to read ``< 180``, which nothing can fail — and the lead
arm's test reads its reach bound from where the hold's own pose has been handed back,
which is the same window the pull comes in over.

**The direction is the whole lever, and the frontier was walked rather than argued.** A
push *along* the chord (outward, still away from him) keeps the elbow straightest of all
but stretches the arm *past* its span — 1.17 at 0.44 s with `[0.66, 0.50, -0.70]`, 1.25
with `[0.63, 0.46, -0.93]` — which is the suite's own ≤ 1.15 bound on the carry, and an
arm longer than its span is not a pose. A push *straight up* (`[0.00, 0.90, -0.44]`)
moves the bat least of any direction — 0.044 rig, tip 0.28 → 0.236 — and spares the lead
arm entirely (23 vertices at −0.045, its span 0.962), but leaves 8 vertices 0.036 deep at
0.48 s: the outboard component is what takes the bicep off the ribs. Up-dominant
(`[0.25, 0.85, -0.46]`, 0.20) is the closest miss: 4 vertices, 0.026 deep, 0.075 rig of
bat. (Those were read with the reach bound still held over the swing; at the shipped
setting the arm reads nought of its 244-250 upper-arm vertices inside the trunk at 0.44,
0.46, 0.48, the finish and the hold, the nearest *on* the surface at the deepest of the
carry and 0.029 rig clear from the finish on.)

Two costs are measured rather than hidden. The **leading arm** takes the other half of
the move: its chord lengthens as the hands go outboard (0.965 → 1.027 of its span at
0.48 s with the hands left where the swing's own path put them), its own press on the
chest reads 24-27 vertices at −0.049 to −0.057 where the swing's own path reads 18
at −0.045 — the *depth* is unchanged (it is the pose's: 18-27 vertices at −0.045 to
−0.054 in every configuration, this one included) and the count moves ±10 as the arm's
surface spreads, all inside the suite's own 45-vertex, −0.06 floor — and, with the reach
bound off the swing's own carry, the finish holds that arm at 1.149 of its span rather
than 0.959 (see above), which is the reading the way home's own bound is told about. And
the carry round is **held past the throw** — it is given back over the first fifth of the
*way home* (`TRAIL_REACH_UNWIND`), where the reset's retrace takes the pose over — so the
bat's fastest frames are untouched by it: the hand's own per-frame speed at 0.485 s reads
**9.4 rig/s** in the swing, against a swing that peaks at 44 two frames later.

Two more readings move with this and neither is a cost. The trailing elbow's own
*direction* through the follow-through and the hold drops from **+0.51** of its upper arm's
length above its own shoulder to **+0.20** — the trailing upper arm stops pointing at the
sky — which is the entry list of the elbows' own test shrinking from 53 samples to 51 with
the worst reading down a third (that test is red either way, on the reset's own samples
from 0.89 s). And the largest step any bone of that arm takes in a 0.01 s frame falls
from 0.338 to **0.230 rig** (0.28 to 0.12 at 0.005 s).

What the carry round may not do is survive the reset, and neither may the reach bound
apply to the swing: by the time the way home is a fifth through, the round is exactly zero
and the retrace is walking the swing's own poses, so the set stance, the load and the way
out are the poses they were — the one baseline this work moves is the follow-through's own
(`batter-follow-through.png`, where the bat now sits 0.09 rig further out and the knob has
crossed the lead shoulder's plane).

### The carry's own path is bulged, and the trail elbow stops folding

The two sections above are levers applied *to* the pose: the reach bound pulls the
grip back along its own chord and the carry round pushes it out again. The curve the
hands are carried *along* between the contact and the finish is a third one, and it is
the pose's own shape — a cubic through `geom.contactHands`, one control
(`followHandsControl`) and `peakHands` — and its middle ran closer to the trailing
shoulder than either end of it. Read off the posed skeleton at 0.01 s steps, the chord
from that shoulder to the trail grip bottoms at **0.716-0.724 rig** across 0.43-0.47 s,
**0.965-0.987 of that arm's own span**, against **0.810 on the ball** and **0.858 at the
finish**: the grip comes 0.10 rig closer to its own shoulder in the middle of the carry
than it is at either end of it, and an arm whose own chord shortens under it has one way
to follow.

The elbow is what pays, and the suite samples the frame the bill lands on:

| | the ball (0.40 s) | 0.42 s | 0.43 s | 0.44 s | 0.45 s | 0.46 s | 0.47 s | the finish (0.54 s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| the trail chord, shipped → bulged | 0.810 → 0.810 | 0.742 → **0.763** | 0.733 → **0.765** | 0.724 → **0.760** | 0.717 → **0.750** | 0.717 → **0.740** | 0.716 → **0.748** | 0.858 → 0.858 |
| that arm's own span | 1.091 → 1.091 | 0.999 → **1.028** | 0.987 → **1.030** | 0.975 → **1.023** | 0.966 → **1.010** | 0.965 → **0.997** | 0.965 → **1.007** | 1.156 → 1.156 |
| the trail elbow | 178.5 → 178.5 | 178.4 → 178.4 | **165.0 → 178.4** | **155.2 → 178.4** | **150.4 → 178.4** | **149.9 → 176.9** | **149.6 → 178.4** | 178.6 → 178.6 |
| the elbow's drop below its shoulder | −0.69 → −0.69 | −0.43 → −0.43 | −0.15 → **−0.27** | −0.01 → **−0.21** | **+0.09 → −0.14** | **+0.18 → −0.07** | **+0.22 → 0.00** | +0.30 → +0.30 |

The last row is a fraction of the upper arm's own length: the folded arm's elbow
*rises* through the carry — level at 0.44 s and 0.22 of the bone above its own shoulder
by 0.47 s — where the straight one comes down and back the whole way (−0.43, −0.27,
−0.21, −0.14, −0.07, level at 0.47 s).

The lever is two numbers on that control — 0.05 rig lower, 0.06 further in front of the
batter — and nothing else: the reach bounds, the carry round and every authored constant
of the pose are as they were. What it buys is read by the suite's own test:
`the trail arm comes round the chest` asks for an elbow over 165 degrees at 0.44 s and
read **155.2** on the path as shipped —

    the carry: the trail arm reaches 97% of its span, elbow 155deg, upper arm 2/233
    inside the trunk (worst -0.005)

— and reads **102% of its span with a 178-degree elbow** on the bulged one, its finish
and hold samples unchanged (116% / 179 degrees and 112% / 179) and nought of the trail
upper arm's skin inside the trunk at any of the three (0 of 239, 0 of 244, 0 of 244).
Those are the numbers the test's own comment measures there (104% / 175 degrees); the
bulge is inside two points of them.

The hands pay nothing for it. Both palms stay on the handle across the whole window
(radial 0.0001-0.0017 against the 0.01 the suite holds them to, the handle running
through the palm at 0.999+ of it) and the fists' grip reads 0.2528-0.2543 apart against
the rig's own 0.253 — and the trail bicep comes out *better* for the move, not worse:
nought of its 239 vertices inside the trunk from 0.43 s on, against 1-2 at −0.001 to
−0.005 on the shipped path. The lead arm's own stretch through the carry (1.031-1.159 of
its span) sits inside what the tree read there before the grip moved onto the handle
(1.092-1.185), and its own test reads its bound on the way home, which this does not
touch.

**Nor can it reach the suite's own poses.** A cubic *is* its endpoint at v = 1 whatever
its control, so the path's end — the follow-through the suite renders — is untouched by
construction, and a sweep at 0.01 s shows the same thing sample by sample: the change is
13 frames, 0.41 s to 0.53 s, with the contact frame (0.40 s), the follow-through (0.54 s)
and the whole hold (0.55-0.72 s) reading identically to the last three decimals. Every
pose the suite samples or screenshots lies outside those 13 frames, which is why no
baseline moves.

**What put the fold in the path is the grip coming onto the handle, and this pays that
price back.** On the tree before the last one the same sweep reads the carry as the
test's own comment describes it — the chord never under **0.746 rig (1.004 of the
span)**, the elbow **178.4-178.6 degrees at every frame** of the window, its drop −0.73
on the ball coming to −0.30 by 0.44 s — but the palms there sit **0.076-0.122 rig off the
handle's axis**, which is the error the last commit put right (the bound is 0.01).
Closing the fists *on* the handle moved the grip, and with it the chord: 0.746 → 0.716 at
the window's deepest, 1.004 → 0.965 of the span, and the elbow 178.4 → 155.2 on the
suite's own sample. The bulge puts the chord back where the straight arm had it —
0.997-1.030 of the span, at or inside that tree's own 1.004-1.071 — *with* the palms
closed on the handle, so the two readings are held at once rather than traded. It moves
nothing outside 0.41-0.53 s either way; the readings the suite still reddens on are the
reset's and the stance's own, and they are what the sections above document.

**The drive moved it again, and the same lever was re-set.** The drive's own
re-authoring (see *The drive's forward travel is the rear stance's own pocket*) rides
**0.234 rig further into the ball** and sinks the pelvis 0.06 rig with the longer
stride, so the trail shoulder comes down 0.05 rig while the frame's own contact grip
rises 0.08 — and the chord this section's bulge was measured against came back that much
shorter: read on the control the bulge shipped with, the trail chord ran
**0.716-0.725 rig (0.964-0.976 of the arm's own span)** across 0.42-0.47 s with the
elbow **148.3-155.9 degrees** and its direction *up* (+0.169 of the upper arm's own
length at 0.44 s, where the bulge's own reading was level). The fix is the same lever
with a bigger number — **0.12 rig further forward, to −0.54** — and the reason it is the
forward one is read one lever at a time at the 0.44 s sample: 0.08 rig down buys 2.2
degrees of elbow, 0.08 up costs 1.1, 0.06 round the batter's own side costs 1.1 and the
same back across him 3.5, while **0.06 forward buys 22 and 0.12 buys 27.3**. The chord
is almost all of it along the line the swing is already travelling, so depth is the only
direction that lengthens the arm without moving it off the bat's own plane.

At −0.54 the finished readings are the shape the table above is about: the trail chord
**1.02-1.04 of the span across 0.43-0.47 s**, the elbow **178.4-178.5 degrees** and its
direction level-to-down (−0.03 of the bone), the *lead* arm straightening with it
(152.1 at 0.42 s to 178.4 by 0.425 s, where the shipping control left it 147.6-174.1 and
turning twice), the palms on the handle (radial 0.0004-0.0024 rig, 0.999+ along it), and
the trail upper arm no deeper in the trunk than before (0-8 of its 230 vertices). The
suite's own sample reads **103% of that arm's span with a 178-degree elbow** and its own
nearest-skin reading over the carry is **0.351 rig** at 0.44 s — better than the 0.266
recorded above, against the same 0.25 bound — and the carry's own crossing of the lead
shoulder's plane moves a thousandth (0.517 against 0.512, its bound 0.2).

### The kit the model ships with, put right

The loaded body's own kit is edited once per instance, in `applyBatterLook`
(`src/util/batterLook.js`), from inside the body memo in `Batter.jsx` — after the
rig has shaped the body, so it edits this instance's copy of the geometry and the
cached asset (and every other player drawn from it) keeps the shape it shipped
with. Five things were wrong with it, and each is a reading off the model rather
than a number kept in two places.

**The helmet shipped a flap on both ears, and only half of one came off.** A shell
of the helmet that hangs below the crown (every other shell carries up to y 1.99)
and lies wholly on one side of the midline is a flap: the model has two, 58
vertices at x[0.078, 0.196] and 36 at x[-0.196, -0.122]. A batting helmet has one,
over the ear the batter turns toward the pitcher — his *lead* ear, the model's own
+x for a right-hander — so the flap on the other side goes, and the 50 triangles
that drew it with it. Only the index is rebuilt: the vertices stay where they are
and still carry their weights, which is cheaper and safer than compacting every
attribute of a skinned mesh. A left-handed batter is the same edit mirrored, keyed
on `bat_side`.

That is the shell off, but not the cover: a band of the *main* shells hangs below
the brim beside the same ear, and taking that off leaves the helmet's own lower
edge behind, down to **y 1.6442 just behind the ear, 0.15 rig below the brim** —
which still read as a rear ear flap. So that band goes too, and *how* it goes is
what the edge looks like afterwards. Cutting it off level leaves a straight edge
across the side of the face with a step at either end of it, and the step in front
of the ear — where the edge has to climb 0.075 back up to the brim over 0.06 of z
— is the worst of it: measured on the build before this, the trailing rim was a
flat line at exactly y 1.72 spanning the whole width of the shell, from x -0.064 to
-0.196, with nothing between it and the brim at z -0.02 but a near-vertical rise.
What a helmet's own edge does instead is sweep, so the band leaves along a *curve*:
the brim's underside (1.7954) in front of the ear, down over the ear to its own
*middle* (the head's ear runs y 1.7346-1.8165 at z -0.0187 to 0.0531, so its middle
is 1.7756) and back into the nape's own line (1.6584 at z -0.10, 1.6831 at -0.17)
behind it. Read as **one curve with the slope turning through it** rather than as a
run of its own stations joined by smoothsteps: each smoothstep is level at both of
its own ends, so the run of them drew a level rim across the side of the face — 0.14
of z carrying 0.02 of height, dead flat over the ear — with a step where it turned
down into the nape, which is a level edge with a corner in it, and a corner is a
rectangle. A cubic through the same three stations, with the slope stated at each of
them (**none at all leaving the brim** — a slope stated *into* the level run is the
corner itself, so the edge arrives there dead level and eases off the brim instead —
0.50 over the ear, 1.90 into the nape, where the helmet's own back edge is already
falling away at 0.35 and the two meet), has the slope carried through the whole of
it: measured, the edge holds its level to within 0.001 of the brim out to z 0.06
(against the 0.11 the old 0.10 slope held it to) and comes down over all 0.14 of z
between there and the ear's own station all the same, so the turn in front of the
ear is a sweep rather than a step, and no two of its own windows read the same
height. And the
edge runs *on under the brim* to the cover's own front end (z 0.19, measured: that
side of the shell still hangs below 1.79 out to z 0.181 at x 0.097, y 1.63), because
the model's two sides are not mirror images — the cover it ships on its *left* ear is
the long one, and a **left-handed** batter's trailing side is the left ear, where a
two-station curve left the band from z 0.12 to 0.18 hanging beside the face, a lobe
of shell under the brim in front of the ear. Read as one number for the cover rather
than for a side, so it is the model's asymmetry and not the batting hand that decides
where the cover stops. Mid-ear, and not the ear's own bottom: hung to the ear's bottom — where
the first pass at this put it, at 1.72 — the edge is a lobe of shell 0.075 below
the brim beside an ear that carries no flap, which is an ear flap where the helmet
has none, and reads as a jaw guard. Half an ear showing under the shell is what a
helmet with no flap over it looks like.

What the band does along that curve is **fold back up onto it, not get cut off**,
and the difference is the whole of what the trailing side looks like. A cut is not
available here: the band and the shell it hangs from are *one* surface, and the
line is a curve limited to the stretch of the head the ear is on, so the piece to
remove is not a half-space and no clipping plane expresses it — and dropping whole
triangles (a triangle going only when all three of its corners are inside the
piece) leaves the rim ragged by up to a triangle's own height, and, where a
triangle's corners are all outside the piece while its own surface is mostly inside
it, a plate of the cover left hanging beside the ear: measured that way, **56
vertices up to 0.162 rig below the line**, which is a jaw guard on the side of the
helmet that has no flap. Moving the vertices instead keeps the surface whole: every
vertex below the line is put *on* it, the band's own triangles collapse to nothing
along it, the wall above it is left exactly as the helmet's own shape has it, and
the edge the shell ends with *is* the line, to the resolution of the mesh. It is
idempotent by construction (a vertex already on the line is not below it) and
nothing outside the line's own stretch of the head is touched, so the nape and the
brim keep their own edges. Measured after: **nothing the helmet draws on that side
is below the line at all**, the trailing rim's lowest vertex is **1.6725** (0.123
below the brim, against the guard's 0.2108 on the lead side) and that vertex is the
nape's own back, nothing on that side hangs below the nape's own 1.6584-1.70, and
the rim reads **1.7081 behind the ear, 1.7740 over it and 1.7938 in front of it** —
0.0659 of sweep up from the nape to the ear and 0.0198 more on out to the brim,
where a rim run level past the ear measures 0.013 in the same three windows. The
same three windows read the same way within 0.002 on a *left-handed* batter's
trailing side — which is the model's *left* ear, and the long cover — where with the
edge read off z alone they read 1.68 behind, 1.775 over the ear and **1.602 in
front of it**: 0.19 rig of cover left hanging under the brim beside the face, on an
ear that carries no flap, because the edge stopped at z 0.12 and that cover runs on
to 0.18. The
ear's own middle is 1.7756, so the shell covers its top half and leaves the bottom
half showing. The cover that *stays* is lengthened further: stretched 1.24
about its hinge under the crown and carried 0.03 forward as it goes, so the guard
comes down to **1.5476** (against 1.5652) and flares over the cheek to **z 0.207**
(against 0.1966), a jaw guard rather than an ear muff. The lengthening stops below
y 1.78, because the brim's own band runs 1.7915-1.821 and falling inside the
cover's region (so falling inside it): pulled down with the guard it would tilt the
brim's edges and eat into the clearance under it.

**The eyes reached up behind the brim, and half of each was inside the face.**
They ship 0.153 rig tall (y 1.681-1.834) and the brim's underside is at **1.795**,
so its own cap hid the top 0.039 of each one. Each eye is taken down about its own
bottom-centre — a uniform shrink, so the plate keeps the modelled shape (its width
stays 0.515 of its height) and stays where it hangs on the face — until its top is
under the brim, which leaves it 0.0856 by 0.044 with **0.029 rig of clearance**
under the brim. The body-parts model's own eye is 0.265 of its head's height and
this head is 0.355 tall, so the reference's own eye would be 0.094 here: this one
lands between the two, which is what was asked for — a shade smaller than the
reference's so that a brow has somewhere to sit above it (below). Read as a target
rather than a factor, so an eye already under the brim is left alone.

Under the brim was only half the job. The plate is flat and the face is not, so
**36 of each eye's 53 vertices** were inside the head — up to **0.026 rig deep** at
the inner corner, where the cheek and the nose take it — and what is inside the
head is not drawn. Reading the face's own front off the *vertices* near an eye
vertex is what missed it: the head's own shells are coarse (the face is 63
vertices for the whole thing) and the surface drawn between two of them bulges
forward of both, which is exactly where the plate sinks in. So the front is read
off the *triangles*: every head triangle that covers an eye vertex down the
model's own front, interpolated at it and taken front-most — the eyes excluded
from the reading, so a plate cannot hold itself up — and the vertex is put
**0.003 rig** in front of it. That conforms each plate to the face it is drawn on
while leaving the plate's own paint and outline alone, and it misses nothing but
the nose's own inner corners, which the same reading takes in. Measured after:
**0 of 53 vertices behind the head on either eye, the most marginal one 0.003
clear.**

**The face wore no eyebrows at all.** The skin is one flat tone in the atlas
(0.898, 0.773, 0.435 — a luminance of 0.775) with the eyes painted black on it
(0.059, 0.008, 0.016) and nothing above them, so a brow has to be drawn: a bar
laid *above* each eye plate, with a band of skin between the two of them, in the
face's own tone taken down per channel into a **brown** — skin darkened evenly comes
back grey, and a brow is not grey: measured, the face's own texel is (0.898, 0.773,
0.435) and the brow is **(0.238, 0.100, 0.027), a luminance of 0.124** — against
0.161 before the second darkening pass and the 0.226 the first drew, which read too
near the skin it sits on, and still well clear of the eye's painted black at 0.05.
It spans the eye's own width plus **0.024 towards the ear and 0.010 towards the
nose** — a brow runs on out towards the temple rather than stopping at the corner of
the eye (**0.078 rig long against the eye's own 0.044**, against 0.076 when both
ends were given the same) — and its shape is **a rectangle with its four corners
rounded and nothing else tapered**: the two long sides stay straight and full-depth
to the last station and only the corners are filleted, a quarter-circle of **0.0064
rig** at each of the four — 0.8 of the brow's own half-depth, so a corner is most of
the way to a round end — with the end left to read as a short vertical edge between
the two. Measured station by station down the bar, it is **the full 0.0160 deep from
0.0064 rig inside either end, closing to 0.0032 at the very end itself**: a fifth of
the bar's own depth at the end against its middle's eight eighths, which is a bar
with its corners turned rather than the *point* the first pass drew at either end
(which read as a leaf laid beside the eye) or the 0.0108 stub the 0.0026 corner left
(which read sharp). It costs the brow nothing it is read by — the box its stations
span is **0.0171 rig deep against the 0.0175 no corner at all spans**. Its depth is
**0.016, drawn at 0.0160**, with its middle arched 0.0015 above its own ends, on 31
stations bunched towards the two ends where the corners are, and it sits **0.0092
rig** above the eye's own top edge
— laid on that edge, the brow and the black plate below it read as one long dark
shape, which is what an eye with no brow above it looks like. It stops under the
brim's underside at 1.7954 (measured, its own top is 1.7931), which is the whole of
the room above an eye: the skin band, the brow and its arch are the three things
that have to come out of the 0.029 rig between the eye's own top (1.7664) and the
brim, and a thicker brow is bought out of the skin band and the arch — 0.0092 of
skin, the suite's own floor, and 0.0015 of arch, against the 0.010 and the 0.003 of
the first pass, which is what pays for the 0.0160. Each vertex's z is read off the face's own front surface
at that station (the eyes excluded, as for the eyes' own conforming) and put 0.005
rig in front of it, so the brow follows the face rather than floating off it:
measured, **0.010-0.034 rig from the nearest body vertex — the inner end of it
hugging the face at 0.010 and its own outer ends further off, where the face falls
away towards the temple** — standing up to 0.019 proud.

**The jersey had no front on it.** The chest is one flat colour with nothing on
the fabric, so the pass draws an opening on it: a *line* down the chest's own
centreline, 0.003 rig across, from the belt (y 1.292, the trunks' band running
1.258-1.293) up to the jersey's own collar (1.548, its rim being at 1.5544) — its
depth read per height off the front-most vertex within a short window of it, so it
hugs the sternum's crease instead of bridging it — and **six hollow buttons**
hard against it on the wearer's right, from the top of the line to the bottom (y
1.5475 down to 1.2925, one every 0.0548 rig), each a ring 0.023 rig across with a
0.011 hole in it, set so that the outward edge of a ring comes to **0.0015 rig of
the line's own edge** — a men's placket is one piece of cloth with the seam down
its edge and the buttons a buttonhole's width in from it, and a column of rings a
centimetre out on a bare chest is two things laid on the jersey rather than one
jersey that buttons.

Three things about that opening had to be read rather than assumed. The first is
*what the cloth is*: the chest's own front is read off the shells that carry it —
they reach down to the belt and stop at the collar, and their own front is the
chest's — because the *neck* stands proud of the collar (measured, its front is at
z 0.1003 by y 1.5586 against the collar's own 0.0143) with the jaw above that, so
a front read off the whole body near the midline finds the neck the moment the line
reaches the collar and the jaw above it. Read that way, an opening drawn to 1.588
left the jersey and ran up onto the face; drawn to the collar's own rim, on the
chest's own shells, it stops where a jersey's opening does. The second is its
tone: a seam in pale-blue cloth reads *darker* than the cloth, and the 0.78 and
0.94 of the cloth's luminance this used to be drawn at (0.54 and 0.65 — lighter
than the cloth's own shading) did not read on it at all. Both are taken down off
the cloth's own colour now, **per channel** rather than as a grey of its luminance:
the seam to **0.42 of it (0.286, 0.285, 0.338 — a luminance of 0.29)** and the
buttons to **0.62 (0.423, 0.420, 0.498 — 0.426)**, which keeps the buttons a shade
brighter than the seam and both of them the jersey's own blue rather than black.
Measured on the render, a seam at 0.42 of the cloth reads 0.29 in luminance against
the cloth's 0.69 — a line drawn on the chest rather than a suggestion of one.

The third is that a station has to be read *on the cloth's own front*, and that the
cloth's front stops before the collar does. Three separate ways of getting that
wrong all had the opening leaving the cloth, and all three are measured. Reading a
station off a triangle it only nearly misses (a third of a triangle of slack) reads
the surface *extended past its own edge*: the opening's top stations came back at z
0.014, 0.001 and −0.010 against the cloth's own 0.036 to 0.042. So a station has to
be on the triangle it is read from (-0.02 of slack, and its own height has to reach
out to the cloth's front at all). The shoulders are the torso's own bone, and their
slope crosses the opening's stations *above* the cloth's own top edge from the
inside: covering a station at y 1.53 from z 0.008 where the cloth's front there is
0.036. So a triangle has to reach out past z 0.02 to count as the front. And where
the cloth's front has genuinely stopped, a station **holds the height of the one
below it** rather than falling back to a default — which is what makes the line run
*on* the cloth from the belt to the collar instead of diving a third of the way into
the body under it 0.031 rig and coming back out at the top.

All of it is one small skinned mesh — 50 vertices for the line and 24 a button,
**194 vertices and 192 triangles** — whose tone is read off the model's own
base-colour texture at the chest (0.682, 0.678, 0.804) rather than kept as a second
copy of the uniform's blue, and which wears **a copy of the cloth's own material**:
the body's own roughness and metalness, and the double side and hair of polygon
offset a detail drawn on the cloth needs. What makes a piece of detail read as drawn
*on* a body rather than laid over it is not how close it sits — a strip of a second
material, a millimetre this side of the cloth, is still a strip — but that it is lit
the way the surface under it is, so each vertex takes the cloth's own **normal** at
its own station, mixed across the triangle its height was read off, the same way its
bone weights are. Reading the cloth's own *texel* there instead (the way the cloth
itself is painted) was tried and thrown out: the chest is coarse, so a station beside
a seam lands on a different triangle, and a different uv, than the cloth around it —
measured, it put the top button's ring across the uniform's own red trim. Its own
vertex weights are the *surface*'s, mixed across the triangle under each station, so
linear blend skinning carries the detail with the cloth it is sewn in. Measured against the cloth
it is sewn on — and against the cloth's own *surface*, which runs between its
vertices, rather than against the nearest vertex of it — it stands **0.0015 to 0.0024
rig in front of** the chest over 162 of its 194 vertices, with the line's own
stations read at every one of the 25 heights from 1.293 (the belt) to 1.548 (the
collar) and never stepping back into the body by more than 0.014: laid *on* the
cloth, never floating and never sunk. It used to stand clear of the chest — 0.008
under the collar ramping to 0.014 at the hem, measured at **0.009 to 0.0165** — out
of the fear that the cloth would swallow a line laid flat on it, and at that
stand-off the opening read as a raised strip laid over the jersey rather than as a
seam in it. What is left is a coat of paint's worth, plus a hair of polygon offset
on the detail's own material, so a depth test between two surfaces a millimetre
apart always settles the same way.

**The shoes carried laces nobody could see, and a sock nobody wanted.** The shoe
is one shell per foot (155 vertices, y -0.010 to 0.299) and the trouser leg comes
down into it — the body's own mesh reaches y 0.2716, *below* the shoes' own rim at
0.2992 — so the trousers are over the ankle already. The detail the pass had laid
there had two faults. Twelve lace bars were drawn and not one of them was on
screen: a bar is built as a row across the foot and a row along it, and those two
rows give a quad whose own normal points *down*, into the shoe — a face the
renderer draws from behind and so never draws at all. And above the rim sat a band
in the sock's own tone, which read as a sock pulled out over the trouser rather
than as part of a shoe.

Both are gone, and every quad of what remains is wound to face the way it should:
each reads its own three corners' positions and is turned to the direction it is
meant to look along, so the tops look up the instep, the walls of a strap look out
at the shoe's sides, and the ends close at the shoe's own edges. What the pass
puts on each shoe, all read off the shoe's own shell:

- the edge of its **sole**, 0.03 up from the ground, in the shoe's own tone taken
  0.62;
- a **tongue** over the instep, in that tone taken 0.45 — a shade *darker* than the
  shoe, so it reads as the tongue under the laces rather than as more shoe —
  following the shoe's own top surface from the throat down towards the toe, and
  standing 0.003 rig off it; and
- **six lace bars** across that instep, one every 0.024 rig, in the trousers' own
  pale tone taken 0.9 towards white. A bar is a strap, not a sheet: a top face and
  two walls 0.005 deep, standing 0.01 rig off the surface, so a lace reads from the
  side as well as from above, and it stops 0.021 short of the shoe's own ridge on
  both sides.

The detail is 700 triangles over 16 pieces (a sole, a tongue and six bars a foot),
and it hugs: measured, its vertices sit **within 0.042 rig** of the nearest body
vertex and reach **0.031 rig** in front of it. Nothing of it rises above the shoes'
own rim any more — read, the highest piece of it is at the rim's own 0.2992 — and
nothing of it is invisible either: **168 of its faces look up** out of the instep.
The bars' own ridges are read with a band that opens out until it finds one (the
shell's vertices are sparse towards the toe), so a station cannot draw a bar a
hair wide out at the shoe's edge.

**The guard reads the geometry, not the pass.** `the batter's kit` (five tests in
`e2e/batter.visual.spec.js`) takes the shipped model apart through the harness's
`probeKit`: every separate shell of the helmet and the body with its own bounds,
the ear cover either side of the head, each eye's own occlusion against the head's
surface, each brow's own place and tone, the opening's stand-off from the body *and
from the cloth's own surface*, the line's own heights station by station, and the
pieces the shoe detail is made of, told apart by shape. It then holds the kit to
facts — exactly one hang-down shell, on the lead side, reaching the jaw, with the
trailing rim *swept* above the ear rather than run level past it, stopped over the
ear's own **middle** (1.7740 against the ear's own 1.7346-1.8165, so half of that ear
shows under it) and left **on the line it was folded onto** rather than hanging
0.162 below it; two eyes, tops clear
of the brim's underside and *every* vertex in front of the face, each within
0.085-0.13 rig tall with its own aspect and the two of them the same size; a brow
over each eye, wide enough to be a brow, with **skin showing between it and the eye
under it** (its own 0.009-0.02 band), clear of the brim, in a tone darker than the
face and lighter than the painted eye; a line down the chest from the belt to the
collar, darker than the cloth it is drawn on, with a column of hollow buttons top
to bottom, skinned to the body's own skeleton, proud of the cloth's own surface at
*every* vertex of it and reading *every* station from the belt to the collar without
stepping back into the body; and shoes with a tongue, five lace bars a foot *and*
faces of those bars looking up, and nothing at all above the shoes' own rim.

Run against the kit as it shipped before any of this, all five redden: **2 flaps**
with the trailing rim 0.151 below the brim, eyes with **36 of 53 vertices behind
the head** (0.026 deep), a **0.007-wide ribbon** in greys *lighter* than the cloth
(0.54 and 0.65 against its 0.69) carrying **5 buttons** clustered in the middle of
the chest, **8 lace bars** with **no tongue on the shoe at all**, and nothing
whatever above the eyes. Run against the look pass as it stood before *this*
change, three of them redden: no brows at all; the opening still in that same
lighter grey and reaching y 1.588, off the jersey and onto the neck and jaw; and a
band above each shoe's rim in the sock's own tone over **twelve lace bars not one
face of which looked up** out of the shoe — measured, winding them the other way
leaves **0 of 12** bars with a face the renderer draws, which is exactly how they
shipped. And each of the three things *this* change is about reddens when it is put
back: with the fold dropped, the trailing side carries ear cover again (its rim
0.151 below the brim and a band hanging where the line is); with the fold's own
forward end read off z alone rather than off the cover, a *left-handed* batter's
trailing side — the model's left ear, whose cover runs on to z 0.18 — carries
**0.19 rig** of it again (the rim 1.602 in front of the ear against the 1.794 the
right-handed one reads in that window); with the curve's low
point put back at the ear's own bottom (1.72, where the first pass had it), the
shell over the ear reads 1.7198 — a lobe hanging where the helmet has no flap — and
the ear's own half-covered assertion reddens; with the brow's own band of skin back
at 0.008, the brow and the eye read as one shape; and with a station allowed to be
read off a triangle it only nearly misses, the opening's own stations step **0.020
rig backwards into the body** under the collar and come back out at the top.

Measured against the committed baselines — the tree as it was before any of this —
eight of the nine pose baselines move, every one of them within the batter's own
figure and none of them larger than the kit itself: **`batter-contact.png`**
(26,894 px, 3.89% of the frame), the faded contact pose
**`batter-contact-faded.png`** (24,537 px, 3.55%), **`batter-recovery.png`**
(24,102 px, 3.49% — the chest faces the camera in this pose, so the whole opening
is read across it), **`batter-mid-swing.png`** (6,897 px, 1.00%),
**`batter-follow-through.png`** (6,093 px, 0.88%), **`batter-stance.png`** (5,212
px, 0.75%), the belt close-up **`batter-belt-mid-swing.png`** (1,142 px of a
240x130 crop) and the new **`batter-take.png`**, which had no baseline at all until
the taken pitch got one. Read band by band, the changes fall where the kit is —
the helmet's rim and edge and the brows in the top fifth of the figure, the chest's
opening in the middle, the laces at the ankles — with nothing changed above the
helmet, at the ground, or anywhere the pose is; the other belt close-up,
**`batter-belt-contact.png`**, does not move by a pixel.

The last of those passes — the ear's edge up to the ear's own middle and the brows
darker, thicker and longer towards the ear — moves 1,200-3,800 px of each of the
same poses, all of it in the head's top fifth: inside the pose baselines' own
tolerance, which is the tolerance a change of two or three pixels on a brow needs.
What holds *that* shape is the kit test above — the rim read over the ear's own span
and the brow's own tone, width and skin band, each measured off the geometry — rather
than a pixel baseline at a distance where a brow is two pixels tall.

## Pose sheet

`npm run pose-sheet` renders the same harness (same lighting, same frozen clock,
same camera) into one self-contained HTML page to look at, instead of comparing
pixels to a baseline. It writes `.playwright/pose-sheet/index.html` and prints the
path.

```
npm run pose-sheet -- --fade=arms,head --views=front,side --zoom=1.4
npm run pose-sheet -- --phases=midSwing --focus=torso --fade=arms,head,legs
```

`--fade` is the one that matters for tuning a pose: those parts are drawn
translucent (`--fade-opacity=` sets how much of them stays, 0.18 by default), so
the torso's own shape and twist can be read through the arms and head. The body
is a single skinned mesh, so regions are named by the *bones* that drive them and
every vertex fades by the share of it those bones skin — see `FADE_REGIONS` in
`e2e/harness/batterMain.jsx`: `arms`, `hands`, `head`, `torso`, `legs`, and `bat`.
The equivalent query parameter on the harness itself is `?fade=arms,head`
(`&fadeOpacity=`), which is also how the command line passes it. The fade is
pinned twice in the suite, because it has two opposite failure modes: a baseline
of the faded contact pose, and a measurement (against the plain pose) that the
fade is *visible but local* — a fade that stops applying leaves the frame
identical to the plain pose, and one that over-applies punches the parts out of
the body. The second is what catches a baseline that was regenerated over a broken
fade. (Measured: 3.2% of the frame changes, by 62 per channel where it does.)

The harness takes these debug-only query parameters for looking at a pose by
hand, and never passes them for a baseline, so they cannot move the committed
renders: `?view=front|side|back|low|top`, `?zoom=` (framing distance multiplier),
`?focus=torso|arms` (frame on those joints instead of the whole body),
`?fade=` and `?phase=stance|take|midSwing|contact|followThrough|recovery`.

Placing a height by hand has its own aids, since a pose is what gets tuned here:
`?dot=1.17,1.23,1.29` draws a small coloured dot either side of the body at each
rig height — at the body's own depth, so a front view reads the height straight
off the silhouette — and `?mark=1` draws the ruler of rings every 0.05 rig units.
`npm run pose-sheet -- --dot=1.17,1.23,1.29 --focus=torso --zoom=2` is the shortest
way to see where the twist band sits against the waistband.

Rendering is pinned to SwiftShader software rendering with a frozen simulation
clock (see `playwright.config.js` and `e2e/harness/batterMain.jsx`), so a run is
reproducible. Note that the suite reuses a dev server when one is already running
on its port; editing `src/` while a run is in flight can serve a stale module, so
restart the server (or wait for its reload) after a source change. After an intentional change to the batter's look, regenerate the
baselines with `npm run test:visual:update` and review the diffs before
committing them.

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.
