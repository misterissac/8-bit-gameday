import test from 'node:test'
import assert from 'node:assert/strict'
import { DoubleSide, Group, Mesh, MeshStandardMaterial, SRGBColorSpace, Texture, RepeatWrapping } from 'three'
import { AWAY_HELMET_COLOUR, blueKit, blueTeamColour, dressBody, defenseKitForInning, playerFadeOpacity, uniformFor, writeBodyFade } from '../src/util/playerKit.js'

// The kit every body on the field wears, pinned: the recipe (which is the
// reference's own, and is what makes a fielder and the pitcher standing on the
// same mound read as one team), the dress pass's one real promise — the two meshes
// the jersey atlas does not paint come back as the body's *own* materials — and
// the inning's own answer for which kit a defense is in.

// The meshes the pass has to tell apart: the body the kit is drawn over, and the
// three the atlas does not paint (two gloves and the flat-coloured helmet).
const MESHES = ['JOINED', 'CAP', 'Helmet', 'GloveL', 'GloveR', 'HandL', 'HandR']

const makeBody = () => {
  const root = new Group()
  const materials = new Map()
  for (const name of MESHES) {
    const mesh = new Mesh(undefined, new MeshStandardMaterial({ name: `asset:${name}` }))
    mesh.name = name
    materials.set(name, mesh.material)
    root.add(mesh)
  }
  return { root, materials }
}

const of = (root, name) => root.getObjectByName(name)

// ── The fade a body is drawn at ──────────────────────────────────────────
test('a body fades on its own distance from the camera, and only when the camera is in it', () => {
  // The band the app tunes (camera.playerFadeNear / playerFadeFar): nothing at the
  // near end or closer, everything at the far end or beyond, the line between them.
  assert.equal(playerFadeOpacity(0, 2, 4.5), 0)
  assert.equal(playerFadeOpacity(2, 2, 4.5), 0)
  assert.equal(playerFadeOpacity(3.25, 2, 4.5), 0.5)
  assert.equal(playerFadeOpacity(4.5, 2, 4.5), 1)
  assert.equal(playerFadeOpacity(60, 2, 4.5), 1, 'the rest of the field is drawn whole')
  // ...and the fielder camera's own body is the one the near end is tuned for: its
  // position is a fielder's head, a head height over his own feet (camera's
  // fielderHeadHeight), so he is the body the replay takes out of the frame.
  assert.equal(playerFadeOpacity(1.8, 2, 4.5), 0)
  // A band that is not a band is not a fade: inside it is nothing, beyond it everything.
  assert.equal(playerFadeOpacity(2, 4, 4), 0)
  assert.equal(playerFadeOpacity(5, 4, 4), 1)
})

test('a fade is written to every material the body wears, and depth comes back with it', () => {
  const { root } = makeBody()
  const worn = dressBody(root, uniformFor(new Texture()))
  // The whole body goes together — the kit, the gloves' leather and the helmet —
  // and a fading body stops writing depth, which is what lets the strike-zone
  // overlays and the pitch trajectory be drawn through it.
  writeBodyFade(worn, 0.5)
  assert.ok(worn.length > 1, 'a body wears more than the one kit material')
  for (const mat of worn) {
    assert.equal(mat.opacity, 0.5)
    assert.equal(mat.transparent, true)
    assert.equal(mat.depthWrite, false)
  }
  // ...and it comes back whole: opaque, and writing depth like any solid thing.
  writeBodyFade(worn, 1)
  for (const mat of worn) {
    assert.equal(mat.opacity, 1)
    assert.equal(mat.transparent, false)
    assert.equal(mat.depthWrite, true)
  }
  // A hole in the list (a mesh with no material) is not a crash: it is skipped.
  assert.doesNotThrow(() => writeBodyFade([null, undefined], 0))
})

test('the kit is the reference-generated recipe, and a faded one does not write depth', () => {
  const texture = new Texture()
  const kit = uniformFor(texture)
  // The atlas is authored upside down for GL, in sRGB, and tiles.
  assert.equal(texture.flipY, false)
  assert.equal(texture.colorSpace, SRGBColorSpace)
  assert.equal(texture.wrapS, RepeatWrapping)
  assert.equal(texture.wrapT, RepeatWrapping)
  assert.equal(kit.map, texture)
  // ...and the body is skinned to a two-sided one: every face is lit, every face
  // casts, and the geometry's own vertex colours modulate the atlas.
  assert.equal(kit.vertexColors, true)
  assert.equal(kit.side, DoubleSide)
  assert.equal(kit.shadowSide, DoubleSide)
  assert.equal(kit.roughness, 1)
  // Opaque by default (the cast's own bodies), and depth-write-free when the body
  // wearing it is faded (the catcher, the batter) — that is the half of the
  // contract that keeps the strike-zone overlays drawn through a faded body.
  assert.equal(kit.transparent, false)
  assert.equal(kit.depthWrite, true)
  const faded = uniformFor(new Texture(), { transparent: true })
  assert.equal(faded.transparent, true)
  assert.equal(faded.depthWrite, false)
})

test('the dress pass leaves the atlas meshes on the kit and the glove and helmet their own', () => {
  const { root, materials } = makeBody()
  const kit = uniformFor(new Texture())
  const worn = dressBody(root, kit)
  // Every mesh the atlas paints takes the kit, and is handed the same instance the
  // caller holds — one material per team on the field, not one per body.
  for (const name of ['JOINED', 'CAP', 'HandL', 'HandR']) {
    assert.equal(of(root, name).material, kit, `${name} should wear the kit`)
  }
  // The glove's leather keeps its own map (the asset's, read and re-worn) and the
  // helmet keeps its own flat colour, because the atlas paints neither — and
  // neither is the *asset's* material: the asset's own meshes are never written to,
  // which is what lets one body be faded without fading the other ten.
  for (const name of ['GloveL', 'GloveR', 'Helmet']) {
    const mesh = of(root, name)
    assert.notEqual(mesh.material, materials.get(name), `${name} should wear its own material`)
    assert.ok(worn.includes(mesh.material), `${name}'s material should be reported back`)
  }
  assert.notEqual(of(root, 'GloveL').material, of(root, 'GloveR').material, 'and not each other’s')
  // ...and the list a fading caller writes to is everything it wears, once each:
  // the kit, the two gloves' leather and the helmet, and nothing that is not a
  // material of this body's.
  assert.equal(worn.length, 4)
  assert.equal(new Set(worn).size, worn.length, 'each material once')
  assert.ok(worn.includes(kit))
})

test('the helmet is the club’s flat colour, and the asset’s own red when none is asked for', () => {
  // The asset's helmet has no map at all — it is a colour — so a dress pass that
  // handed it the atlas rendered a black hat. Home is the asset's own red.
  const home = makeBody()
  const red = of(home.root, 'Helmet').material.color.getHex()
  dressBody(home.root, uniformFor(new Texture()))
  assert.equal(of(home.root, 'Helmet').material.color.getHex(), red, 'home is the asset’s own red')
  // ...and the visitors' colour is handed over for the halves they are at the
  // plate, on a material of their own (so the cached asset keeps its red).
  const away = makeBody()
  dressBody(away.root, uniformFor(new Texture()), { helmetColour: AWAY_HELMET_COLOUR })
  assert.equal(of(away.root, 'Helmet').material.color.getHexString(), AWAY_HELMET_COLOUR.replace('#', ''))
  assert.equal(of(home.root, 'Helmet').material.color.getHexString(), red.toString(16).padStart(6, '0'))
})

test('two bodies dressed in the same kit are still two bodies', () => {
  const one = makeBody()
  const two = makeBody()
  const kit = uniformFor(new Texture())
  const first = dressBody(one.root, kit)
  const second = dressBody(two.root, kit)
  // The kit is deliberately shared (one per team), the parts that are not the kit
  // are not: fading one body's glove cannot reach the other's.
  assert.equal(of(one.root, 'JOINED').material, of(two.root, 'JOINED').material)
  for (const name of ['GloveL', 'GloveR', 'Helmet']) {
    assert.notEqual(of(one.root, name).material, of(two.root, name).material, name)
  }
  assert.equal(first.length, second.length)
  // A faded dress carries the fade to those same materials, for the reason the
  // catcher exists: a translucent body has to let the zone overlays through as a
  // whole, glove and helmet included.
  const fadedBody = makeBody()
  const faded = dressBody(fadedBody.root, uniformFor(new Texture(), { transparent: true }), { transparent: true })
  for (const material of faded) {
    assert.equal(material.transparent, true)
    assert.equal(material.depthWrite, false)
  }
})

// ── The visitors' blue ───────────────────────────────────────────────────
const hueOf = ([r, g, b]) => {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const chroma = max - min
  if (chroma === 0) return null
  const h = max === r
    ? ((g - b) / chroma + 6) % 6
    : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4
  return h * 60
}

test('the visitors’ plum and bright trim come out blue, and the body’s own colours are left alone', () => {
  // The two the visitors' atlas paints its cloth in: the plum of the cap, sleeves,
  // shoes and belt (at its lit colour and its deepest shade) and the bright red of
  // the sleeve's and the shoe's trim. All of them come out the one blue, at one hue.
  const lightness = ([r, g, b]) => (Math.max(r, g, b) + Math.min(r, g, b)) / 2
  const plum = blueTeamColour([0.443, 0.310, 0.427])
  const shade = blueTeamColour([0.29, 0.16, 0.32])
  const trim = blueTeamColour([1, 0.337, 0.118])
  const sole = blueTeamColour([0.94, 0.31, 0.12])
  for (const [name, colour] of [['the plum', plum], ['its deepest shade', shade], ['the trim', trim], ['the sole', sole]]) {
    assert.ok(Math.abs(hueOf(colour) - 214) < 1, `${name} should land on the visitors’ blue, got ${hueOf(colour)}`)
    const [r, g, b] = colour
    assert.ok(b > r && b > g, `${name} should be blue-dominant, got ${colour}`)
  }
  // The lightness is the atlas's own, so the shading in the cloth is where the
  // artist put it: the lit plum stays lighter than its shade, and the trim keeps the
  // brightness it was drawn at.
  assert.ok(Math.abs(lightness(plum) - lightness([0.443, 0.310, 0.427])) < 1e-9)
  assert.ok(lightness(plum) > lightness(shade))
  assert.ok(Math.abs(lightness(trim) - lightness([1, 0.337, 0.118])) < 1e-9)
  // ...and every colour that is not the club's cloth is exactly the pixels it was:
  // the tan of the face and arms, the jersey's pale blue, a grey (a sock, a cleat's
  // silver), the hair's and brows' dark red-brown — the trim's own hue at a fifth of
  // the lightness — and a warm skin shadow, which sits below the trim's saturation.
  // The warm ones matter: an atlas recoloured by hue alone turned the shadow on a
  // nose blue.
  for (const untouched of [
    [0.898, 0.773, 0.435],
    [0.682, 0.678, 0.804],
    [0.5, 0.5, 0.5],
    [1, 1, 1],
    [0.34, 0.06, 0.06],
    [0.72, 0.5, 0.28],
  ]) {
    assert.deepEqual(blueTeamColour(untouched), untouched, `${untouched} should be left alone`)
  }
})

test('the blue kit is built off a texture, and outside a browser it is the texture it was handed', () => {
  // Nothing here decodes an image (node has no canvas), so the pass hands the atlas
  // straight back rather than inventing one — a unit test, a server render, or a
  // texture whose image has not decoded yet all have to be safe.
  const texture = new Texture()
  assert.equal(blueKit(texture), texture)
  assert.equal(blueKit(null), null)
  assert.equal(blueKit(undefined), undefined)
})

test('the dress pass leaves the look pass’s own meshes their materials, and still reports them', () => {
  const root = new Group()
  const detail = new Mesh(undefined, new MeshStandardMaterial({ name: 'detail:brows' }))
  detail.name = 'BrowDetail'
  const body = new Mesh(undefined, new MeshStandardMaterial({ name: 'asset:JOINED' }))
  body.name = 'JOINED'
  root.add(detail, body)
  const kit = uniformFor(new Texture())
  const worn = dressBody(root, kit, { keep: ['BrowDetail'] })
  // The piece the look pass hung beside the body carries the tone it was read out of
  // the body and samples no atlas, so the kit would paint it a single texel.
  assert.equal(detail.material.name, 'detail:brows')
  assert.equal(body.material, kit)
  assert.ok(worn.includes(detail.material), 'a faded body still fades its own detail')
})

test('a defense wears the home kit in the top of an inning and the visitors’ in the bottom', () => {
  // The visitors bat first, so the club in the field in the top is the home side.
  assert.equal(defenseKitForInning({ is_top_inning: true }), 'home')
  assert.equal(defenseKitForInning({ is_top_inning: false }), 'away')
  // A payload with no inning on it at all (a fixture, a feed that has not filled
  // the field in yet) reads as the home side, which is the app's own default.
  assert.equal(defenseKitForInning(null), 'home')
  assert.equal(defenseKitForInning({}), 'home')
})
