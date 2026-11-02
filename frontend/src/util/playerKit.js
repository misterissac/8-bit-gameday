import * as THREE from 'three'
import { clamp } from './MathUtil.js'

// ---------------------------------------------------------------------------
// The kit a body wears, and which one a side gets.
//
// Every body on the field but the pitcher is the same asset
// (public/models/player.glb) cloned the same way (util/playerBody.js), so what
// makes a fielder, a runner, a catcher and a batter read as four different men is
// the material on that clone. It is one material — an atlas with the jersey, the
// pinstripes, the face and the club's own cap, sleeves, belt and shoes on it —
// drawn over the whole body, plus the pieces the atlas does not paint: the gloves,
// which keep their own leather, and the helmet, which is a flat club colour.
//
// That recipe used to be written out twice (the pitcher's own kit in Pitcher.jsx,
// the cast's in FieldCast.jsx) and is needed a third time by the catcher, so it
// lives here — one place to read it, and one place for the two callers whose
// materials have to be *theirs*: a body that is faded (the catcher behind the
// strike zone, the batter behind the plate) must not be sharing a material with a
// body that is not.
//
// The asset is the reference project's own (solomon-gumball's baseball-sim), and
// so is the recipe: the texture is authored upside down for GL, its colours are
// sRGB, the geometry carries vertex colours the atlas is modulated by, and the
// character is skinned to a two-sided body, so every face of it is lit and every
// face casts (see `side`/`shadowSide`).
// ---------------------------------------------------------------------------

export const HOME_PLAYER_TEXTURE_URL = '/textures/HomePlayer_BaseColor.png'
export const AWAY_PLAYER_TEXTURE_URL = '/textures/AwayPlayer_BaseColor.png'

// ---------------------------------------------------------------------------
// The visitors' blue.
//
// Each atlas paints one *team colour* over the cap, the sleeves and the shoes, and
// leaves the jersey, the pinstripes and the face as they are. The home atlas paints
// it red; the visitors' paints it a dark plum, which under the park's own light read
// as the same red a shade darker — two sides on the field that looked like one team.
// So the visitors' team colour is replaced with a blue.
//
// It is replaced *in the atlas*, read off the atlas's own pixels rather than painted
// into a second file by hand: the hue is set to the visitors' blue, the lightness is
// kept (so every crease and shadow the artist put in the cloth stays where it is),
// and the saturation is lifted a little — the plum is nearly grey, and a navy that is
// nearly grey reads as black at fifty metres. What is *not* touched is anything that
// is not the club's cloth: the tan of the face and the arms, the pale blue of the
// jersey, the dark red-brown of the hair and the shoe's own sole all keep exactly the
// pixels they shipped with. That is the whole of the rule, and it is why the jerseys
// still read as one uniform in two club colours rather than as two different shirts.
// ---------------------------------------------------------------------------

// The visiting club's colour, in the two the visitors' atlas paints it: the plum
// they ship (285°-315°, with its shading either side — the cap, the sleeves, the
// shoes and the belt) and the bright red of the sleeve's and the shoe's trim.
//
// The trim is the same warm red the home club paints everything in, and it is a club
// colour too: left red, a blue sleeve came out with a red band round the shoulder.
// So it goes blue with the plum — but only the *bright* red. The body's own hair, its
// brows and the dark of the shoe's sole are that same hue at a fifth of the
// lightness, and the skin's warm shadows sit below the trim's saturation; recolour
// by hue alone and the shadow on a nose came out blue.
const TEAM_BLUE_HUE = 214
const TEAM_PLUM_MIN_HUE = 262
const TEAM_PLUM_MAX_HUE = 330
const TEAM_TRIM_MAX_HUE = 22
const TEAM_TRIM_MIN_HUE = 338
const TEAM_TRIM_MIN_SATURATION = 0.45
const TEAM_TRIM_MIN_LIGHTNESS = 0.3
// Below this the pixel is a grey — a white sock, the silver of a cleat — and grey is
// not a club colour, whatever hue the shading leans it towards.
const TEAM_COLOUR_MIN_SATURATION = 0.12
// ...and the blue's own saturation, off the team colour's: lifted, so a plum nearly
// grey comes out a blue that reads as one, and held inside a band so the flat cloth
// and its deepest shading stay the same colour rather than splitting into two.
const TEAM_COLOUR_SATURATION_LIFT = 0.22
const TEAM_BLUE_MIN_SATURATION = 0.35
const TEAM_BLUE_MAX_SATURATION = 0.8

/**
 * One atlas colour, as the visiting club would paint it: the team colour turned
 * blue, and everything that is not the team colour left exactly as it was.
 *
 * @param {number[]} rgb 0..1, the atlas's own colour
 * @returns {number[]} 0..1, the colour the visitors' atlas paints there
 */
export function blueTeamColour(rgb) {
  const [r, g, b] = rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const chroma = max - min
  const lightness = (max + min) / 2
  const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1))
  if (saturation <= TEAM_COLOUR_MIN_SATURATION) return [r, g, b]
  let hue
  if (max === r) hue = ((g - b) / chroma + 6) % 6
  else if (max === g) hue = (b - r) / chroma + 2
  else hue = (r - g) / chroma + 4
  hue *= 60
  const plum = hue >= TEAM_PLUM_MIN_HUE && hue <= TEAM_PLUM_MAX_HUE
  const trim = (hue <= TEAM_TRIM_MAX_HUE || hue >= TEAM_TRIM_MIN_HUE)
    && saturation >= TEAM_TRIM_MIN_SATURATION
    && lightness >= TEAM_TRIM_MIN_LIGHTNESS
  if (!plum && !trim) return [r, g, b]
  return hslToRgb(
    TEAM_BLUE_HUE,
    clamp(saturation + TEAM_COLOUR_SATURATION_LIFT, TEAM_BLUE_MIN_SATURATION, TEAM_BLUE_MAX_SATURATION),
    lightness,
  )
}

// Hue in degrees, saturation and lightness 0..1, back to 0..1 red, green and blue.
function hslToRgb(hue, saturation, lightness) {
  const at = (n) => (n + hue / 30) % 12
  const a = saturation * Math.min(lightness, 1 - lightness)
  const channel = (n) => lightness - a * Math.max(-1, Math.min(at(n) - 3, Math.min(9 - at(n), 1)))
  return [channel(0), channel(8), channel(4)]
}

// One blue atlas per source atlas, however many bodies ask for it: every body in a
// side's kit shares the one map (see `uniformFor`), and recolouring the atlas is a
// megapixel of arithmetic nobody should pay for twice.
const blueAtlases = new WeakMap()

/**
 * The visiting club's kit: the same atlas with its team colour turned blue (see
 * `blueTeamColour`), built once per source texture.
 *
 * @param {THREE.Texture} texture the atlas as it ships
 * @returns {THREE.Texture} the blue atlas — or, outside a browser (a unit test, a
 *   server render) or before the image has decoded, the atlas it was handed
 */
export function blueKit(texture) {
  if (!texture?.image || typeof document === 'undefined') return texture
  const known = blueAtlases.get(texture)
  if (known) return known
  const image = texture.image
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(image, 0, 0)
  const painted = context.getImageData(0, 0, canvas.width, canvas.height)
  const data = painted.data
  for (let at = 0; at < data.length; at += 4) {
    const [r, g, b] = blueTeamColour([data[at] / 255, data[at + 1] / 255, data[at + 2] / 255])
    data[at] = r * 255
    data[at + 1] = g * 255
    data[at + 2] = b * 255
  }
  context.putImageData(painted, 0, 0)
  const blue = new THREE.CanvasTexture(canvas)
  // The atlas's own conventions, which `uniformFor` would set anyway: authored
  // upside down for GL, sRGB, and tiling.
  blue.flipY = false
  blue.colorSpace = THREE.SRGBColorSpace
  blue.wrapS = THREE.RepeatWrapping
  blue.wrapT = THREE.RepeatWrapping
  blue.needsUpdate = true
  blueAtlases.set(texture, blue)
  return blue
}

// The two pieces of a body the jersey atlas does not paint: the glove's leather is
// its own map, and the helmet is a flat colour (the asset's `HomeHelmet` material
// has no texture at all). Named here because the dress pass and the hide lists the
// actors build their bodies with (HIDDEN_MESHES in playerRig.js, and the cast's own
// per-kind list in FieldCast.jsx) have to agree on which meshes those are.
export const GLOVE_MESHES = ['GloveL', 'GloveR']
export const HELMET_MESH = 'Helmet'

// The visitors' helmet: the club's own blue, at the lightness the asset shipped its
// red helmet in (so the hat reads as dark as it always did, rather than glowing on
// a batter's head). The home helmet needs no colour of its own — it is the asset's
// material, which is already the home club's red.
export const AWAY_HELMET_COLOUR = '#1b4174'

/**
 * The kit material itself: the atlas, dressed for a skinned body.
 *
 * @param {THREE.Texture} texture the kit's own base colour map
 * @param {object} [options]
 * @param {boolean} [options.transparent] whether the body wearing it is drawn
 *   translucent (the catcher and the batter fade out from behind the strike
 *   zone). A faded body must not write depth — the pitch trajectory, the hawk-eye
 *   ring and the zone grid are drawn *through* it — so the flag sets both.
 * @returns {THREE.MeshStandardMaterial}
 */
export function uniformFor(texture, { transparent = false } = {}) {
  const tex = texture
  tex.flipY = false
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 1,
    vertexColors: true,
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
    transparent,
    depthWrite: !transparent,
  })
}

/**
 * Dress a body in a kit — every mesh of the clone takes the kit's material except
 * the three the atlas does not paint: the two gloves, which get their leather
 * back, and the helmet, which keeps its own flat-colour material (re-created
 * rather than shared, so nothing any caller does to a body's look can reach the
 * cached asset or another body wearing the same kit).
 *
 * @param {THREE.Object3D} model the body's clone to dress in place
 * @param {THREE.Material} material the kit, from `uniformFor` above
 * @param {object} [options]
 * @param {boolean} [options.transparent] whether the body is drawn translucent —
 *   passed on to the glove materials for the same reason `uniformFor`
 *   takes it: a faded body has to let the strike-zone overlays through as a whole.
 * @param {string[]} [options.keep] meshes the look pass hung beside the body and
 *   painted itself (see util/batterLook.js's LOOK_DETAIL_MESHES): they already carry
 *   the tone they were read out of the body, so they keep their own materials rather
 *   than being handed the atlas they were *derived* from — but they are still this
 *   body's, so they come back in the list a fade is written to.
 * @param {string|number|null} [options.helmetColour] the club's colour for the
 *   helmet, for a body whose hat is showing (the batter, the cast's runners). The
 *   atlas cannot paint it — the asset's helmet samples no map — so the colour is
 *   handed over instead; null leaves the asset's own red, which is the home club's.
 * @returns {THREE.Material[]} every material the body now wears, which is what a
 *   caller that fades it has to write the opacity to
 */
export function dressBody(model, material, { transparent = false, keep = [], helmetColour = null } = {}) {
  const leather = (map) => new THREE.MeshStandardMaterial({
    map: map ?? null,
    roughness: 1,
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide,
    transparent,
    depthWrite: !transparent,
  })
  // The helmet's own material, re-coloured for the club that is wearing it — a
  // copy, so the flat colour on the cached asset stays as it shipped.
  const hat = (mesh) => {
    const copy = mesh.material?.clone?.() ?? new THREE.MeshStandardMaterial({ map: null, vertexColors: false })
    if (helmetColour !== null && helmetColour !== undefined && copy.color) copy.color.set(helmetColour)
    copy.transparent = transparent
    copy.depthWrite = !transparent
    return copy
  }
  const materials = new Set([material])
  model.traverse((child) => {
    if (!child.isMesh) return
    if (keep.includes(child.name)) {
      // Its own, untouched — only collected below.
    } else if (GLOVE_MESHES.includes(child.name)) {
      child.material = leather(child.material?.map)
    } else if (child.name === HELMET_MESH) {
      child.material = hat(child)
    } else {
      // The body, the cap and the hands: all painted by the atlas, so all of them
      // are the club's colour.
      child.material = material
    }
    for (const mat of Array.isArray(child.material) ? child.material : [child.material]) {
      if (mat) materials.add(mat)
    }
  })
  return [...materials]
}

/**
 * How opaque a body is drawn from `distance` metres away: the reference's own rule
 * for a body the camera is about to stand inside (solomon-gumball's Players.tsx
 * fades the man behind the plate once the view is within three metres of him), read
 * for every body on the field — nothing at `near` or closer, everything at `far` or
 * beyond, the straight line between the two.
 *
 * What it is for is the *fielder camera*, whose whole position is a man's head: the
 * distance from that camera to the feet it is standing over is the fielder head
 * height and no more, so the body it is inside is the one body this fades away —
 * while the seven others, and the man the ball is being thrown to, are drawn as they
 * are in any other view. (A single switch for the whole cast was what emptied the
 * field the moment a replay began: see FieldCast.jsx.)
 *
 * @param {number} distance metres from the camera to the body
 * @param {number} near at this distance and closer the body is not drawn at all
 * @param {number} far at this distance and beyond it is drawn opaque
 * @returns {number} 0..1
 */
export function playerFadeOpacity(distance, near, far) {
  if (!(far > near)) return distance <= near ? 0 : 1
  return clamp((distance - near) / (far - near), 0, 1)
}

/**
 * Write one body's translucency to every material it wears at once — the list
 * `dressBody` hands back, or a body's own set (the pitcher's, whose kit is written
 * in Pitcher.jsx). `transparent` flips with the fade, so a body at full opacity
 * writes depth like any solid thing and a fading one does not (the strike-zone
 * overlays and the pitch trajectory are drawn *through* a faded body); that is why
 * a caller writes this only where the opacity has really moved, rather than on
 * every frame for every body.
 *
 * @param {THREE.Material[]} materials the materials the body is drawn with
 * @param {number} opacity 0..1
 */
export function writeBodyFade(materials, opacity) {
  for (const mat of materials) {
    if (!mat) continue
    mat.transparent = opacity < 1
    mat.opacity = opacity
    mat.depthWrite = opacity >= 1
  }
}

/**
 * The kit the *fielding* side wears for a pitch. The visitors bat in the top of an
 * inning, so the home team is the one in the field then, and the visitors are the
 * ones fielding in the bottom; the batting side always wears the other kit (the
 * batter and the cast's runners flip it themselves, off this same answer).
 *
 * A payload with no inning on it — a fixture, a feed that has not filled the field
 * in yet — reads as the home side, which is the app's own default.
 *
 * @param {object|null} pitchData the payload the scene is drawn from
 * @returns {'home'|'away'}
 */
export function defenseKitForInning(pitchData) {
  // Only an explicit bottom half puts the visitors in the field; the top half — and
  // a payload with no inning on it — is the home side.
  return pitchData?.is_top_inning === false ? 'away' : 'home'
}
