import React, { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

// One-shot confetti burst at the spot a home run leaves the park. Each piece
// is a small flat box that flings outward, falls under gravity, tumbles, and
// fades out over its lifetime. The parent (BattedBall) passes a new ``burst``
// object for each home run; the component re-seeds its particle states when
// that object changes, and the burst self-hides once every piece has expired.

const CONFETTI_COLORS = ['#ff4d4d', '#ffd166', '#4dff88', '#4da6ff', '#ff9f1c', '#e14dff']
const CONFETTI_COUNT = 120
const CONFETTI_LIFE = 3.2 // s — full lifetime of the longest-lived piece
const CONFETTI_FADE_TIME = 0.45 // s — fade to transparent at the end of life
const CONFETTI_GRAVITY = 9.8 // m/s^2

function seedPiece(origin) {
  const angle = Math.random() * Math.PI * 2
  const outSpeed = 3 + Math.random() * 6
  return {
    position: origin.clone(),
    velocity: new THREE.Vector3(
      Math.cos(angle) * outSpeed,
      4 + Math.random() * 8, // strong upward burst so it clears the wall and reads from home plate
      Math.sin(angle) * outSpeed,
    ),
    rotation: new THREE.Euler(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    ),
    spin: new THREE.Vector3(
      (Math.random() - 0.5) * 14,
      (Math.random() - 0.5) * 14,
      (Math.random() - 0.5) * 14,
    ),
    life: CONFETTI_LIFE * (0.55 + Math.random() * 0.65),
    size: 0.05 + Math.random() * 0.09, // bigger pieces so the burst reads from home plate
  }
}

export const ConfettiBurst = ({ burst }) => {
  const statesRef = useRef(null)
  const meshRefs = useRef([])
  const [pieces, setPieces] = useState([])

  useEffect(() => {
    if (!burst) {
      statesRef.current = null
      setPieces([])
      return
    }
    const states = Array.from({ length: CONFETTI_COUNT }, () => seedPiece(burst.position))
    statesRef.current = states
    setPieces(states.map((state, i) => ({
      key: i,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      size: state.size,
    })))
  }, [burst])

  useFrame((_, delta) => {
    const states = statesRef.current
    if (!states) return
    const dt = Math.min(delta, 0.05)
    for (let i = 0; i < states.length; i++) {
      const state = states[i]
      const mesh = meshRefs.current[i]
      if (!mesh) continue
      state.life -= dt
      if (state.life <= 0) {
        mesh.visible = false
        continue
      }
      mesh.visible = true
      state.velocity.y -= CONFETTI_GRAVITY * dt
      state.position.addScaledVector(state.velocity, dt)
      state.rotation.x += state.spin.x * dt
      state.rotation.y += state.spin.y * dt
      state.rotation.z += state.spin.z * dt
      mesh.position.copy(state.position)
      mesh.rotation.copy(state.rotation)
      mesh.scale.setScalar(state.size)
      mesh.material.opacity = Math.min(1, state.life / CONFETTI_FADE_TIME)
    }
  })

  if (pieces.length === 0) return null

  return (
    <group>
      {pieces.map((piece, i) => (
        <mesh key={piece.key} ref={(el) => { meshRefs.current[i] = el }}>
          <boxGeometry args={[1, 1, 0.15]} />
          <meshBasicMaterial color={piece.color} transparent toneMapped={false} depthWrite={false} />
        </mesh>
      ))}
    </group>
  )
}
