import React, { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FIELD } from '../constants/field'
import { clamp } from '../util/MathUtil'

// ---------------------------------------------------------------------------
// Crouching catcher behind home plate (FIELD.DEFENSE.C). When the camera moves
// in close behind the strike zone — e.g. the "Snap to Strike Zone" view — the
// catcher fades out so the zone stays visible. This is the same camera-distance
// translucency the solomon-gumball:baseball-sim-main reference uses in
// Players.tsx:
//   opacity = clamp((distanceToCamera - 3) / 8, 0, 1)
// ---------------------------------------------------------------------------

// Fade window in meters: fully transparent within 3 m of the catcher, fully
// opaque by 11 m (the reference's (distance - 3) / 8 ramp).
const FADE_START_M = 3
const FADE_END_M = 11

const UP = new THREE.Vector3(0, 1, 0)

// A static cylinder between two points, used for the crouched thigh/shin
// segments (same construction as the Batter sprite).
function CylinderBetween({ from, to, radius, material }) {
  const a = new THREE.Vector3(from[0], from[1], from[2])
  const b = new THREE.Vector3(to[0], to[1], to[2])
  const dir = new THREE.Vector3().subVectors(b, a)
  const length = dir.length()
  const position = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
  const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize())
  return (
    <mesh position={position} quaternion={quaternion} material={material} castShadow>
      <cylinderGeometry args={[radius, radius, length, 8]} />
    </mesh>
  )
}

export const Catcher = () => {
  const groupRef = useRef()
  const { camera } = useThree()

  // Shared materials (all transparent) so one per-frame opacity update fades
  // the whole catcher together. depthWrite is disabled: the catcher sits
  // directly between the default camera (behind home plate) and the strike-zone
  // overlays (the pitch trajectory trail, the hawk-eye ring, the zone grid), so
  // writing depth would cull those fragments and make the trajectory vanish
  // right as it reaches the plate. Without depth writes the catcher still hides
  // players behind it (it draws over them in the transparent pass) but lets the
  // broadcast-style pitch overlays show through.
  const uniformMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#1e3a5f', roughness: 0.8, transparent: true, depthWrite: false }),
    [],
  )
  const skinMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#f1c27d', roughness: 0.8, transparent: true, depthWrite: false }),
    [],
  )
  const whiteMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#f5f5f5', roughness: 0.7, transparent: true, depthWrite: false }),
    [],
  )
  const metalMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#cbd5e1', roughness: 0.3, transparent: true, depthWrite: false }),
    [],
  )
  const gloveMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#7f1d1d', roughness: 0.9, transparent: true, depthWrite: false }),
    [],
  )

  // Camera-distance translucency, ported from solomon-gumball's Players.tsx:
  // within 3 m of the catcher it is fully transparent and ramps back to fully
  // opaque by 11 m, so a close camera behind the strike zone sees right
  // through the catcher to the zone.
  useFrame(() => {
    const group = groupRef.current
    if (!group) return
    const distanceToCamera = camera.position.distanceTo(group.position)
    const opacity = clamp((distanceToCamera - FADE_START_M) / (FADE_END_M - FADE_START_M), 0, 1)
    uniformMat.opacity = opacity
    skinMat.opacity = opacity
    whiteMat.opacity = opacity
    metalMat.opacity = opacity
    gloveMat.opacity = opacity
  })

  const pos = FIELD.DEFENSE.C

  return (
    <group ref={groupRef} position={pos.toArray()}>
      {/* Crouched legs: thigh + shin, knees bent forward toward the plate */}
      <CylinderBetween from={[-0.11, 0.52, 0.02]} to={[-0.14, 0.3, -0.06]} radius={0.06} material={uniformMat} />
      <CylinderBetween from={[-0.14, 0.3, -0.06]} to={[-0.14, 0.08, -0.03]} radius={0.045} material={uniformMat} />
      <CylinderBetween from={[0.11, 0.52, 0.02]} to={[0.14, 0.3, -0.06]} radius={0.06} material={uniformMat} />
      <CylinderBetween from={[0.14, 0.3, -0.06]} to={[0.14, 0.08, -0.03]} radius={0.045} material={uniformMat} />

      {/* Shoes */}
      <mesh position={[-0.14, 0.05, -0.03]} material={whiteMat} castShadow>
        <boxGeometry args={[0.12, 0.06, 0.3]} />
      </mesh>
      <mesh position={[0.14, 0.05, -0.03]} material={whiteMat} castShadow>
        <boxGeometry args={[0.12, 0.06, 0.3]} />
      </mesh>

      {/* Torso, low in the crouch, facing the pitcher (-Z) */}
      <mesh position={[0, 0.72, 0]} material={uniformMat} castShadow>
        <capsuleGeometry args={[0.23, 0.4, 4, 8]} />
      </mesh>

      {/* Chest protector */}
      <mesh position={[0, 0.78, -0.24]} material={whiteMat} castShadow>
        <boxGeometry args={[0.34, 0.32, 0.08]} />
      </mesh>

      {/* Head + helmet cap */}
      <mesh position={[0, 1.12, 0.02]} material={skinMat} castShadow>
        <sphereGeometry args={[0.19, 12, 12]} />
      </mesh>
      <mesh position={[0, 1.12, 0.02]} material={uniformMat} castShadow>
        <sphereGeometry args={[0.2, 12, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
      </mesh>

      {/* Face mask: horizontal + vertical bars over the face */}
      <mesh position={[0, 1.16, -0.2]} material={metalMat}>
        <boxGeometry args={[0.3, 0.02, 0.02]} />
      </mesh>
      <mesh position={[0, 1.1, -0.2]} material={metalMat}>
        <boxGeometry args={[0.02, 0.18, 0.02]} />
      </mesh>

      {/* Glove hand held out toward the pitcher */}
      <mesh position={[-0.34, 0.72, -0.42]} material={gloveMat} castShadow>
        <boxGeometry args={[0.16, 0.22, 0.08]} />
      </mesh>

      {/* Bare hand */}
      <mesh position={[0.28, 0.6, -0.3]} material={skinMat} castShadow>
        <sphereGeometry args={[0.06, 8, 8]} />
      </mesh>
    </group>
  )
}
