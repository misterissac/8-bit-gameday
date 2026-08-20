import React, { useMemo } from 'react'
import { Line } from '@react-three/drei'
import { FIELD } from '../constants/field'
import { feetToM } from '../util/MathUtil'

// ---------------------------------------------------------------------------
// Simple sprite-based ballpark: flat grass + infield dirt, bases, pitcher's
// mound, foul lines, and a low outfield wall. Everything is a flat-colored
// primitive so the field reads instantly without any external assets.
// ---------------------------------------------------------------------------

const GRASS_RADIUS = feetToM(400)
const INFIELD_RADIUS = feetToM(95)
const INFIELD_CENTER = FIELD.BASE.SECOND.clone().multiplyScalar(0.5) // midway home<->second
const MOUND_RADIUS = feetToM(9)

function FoulLine({ from, to }) {
  return <Line points={[from, to]} color="#ffffff" lineWidth={2} transparent opacity={0.9} />
}

export const Ballpark = () => {
  const foulLines = useMemo(() => {
    const extend = (base) => {
      const dir = base.clone().setY(0).normalize()
      const end = dir.multiplyScalar(GRASS_RADIUS * 0.95).setY(0.02)
      return { from: FIELD.BASE.HOME.clone().setY(0.02), to: end }
    }
    return [extend(FIELD.BASE.FIRST), extend(FIELD.BASE.THIRD)]
  }, [])

  // Low outfield wall: a shallow arc of box segments between the foul poles.
  const wallSegments = useMemo(() => {
    const radius = feetToM(330)
    const height = feetToM(8)
    const thickness = feetToM(1.2)
    const count = 22
    const startAngle = -Math.PI / 4 // left-field foul pole
    const endAngle = Math.PI / 4 // right-field foul pole
    const arcLength = (radius * (endAngle - startAngle)) / count

    const segments = []
    for (let i = 0; i < count; i++) {
      const a0 = startAngle + (endAngle - startAngle) * (i / count)
      const a1 = startAngle + (endAngle - startAngle) * ((i + 1) / count)
      const mid = (a0 + a1) / 2
      const x = radius * Math.sin(mid)
      const z = -radius * Math.cos(mid)
      // Yaw by -mid so the segment's long axis stays tangent to the wall arc
      // and its flat face (thickness axis) points back at home plate. A +mid
      // yaw would swing the face normal to the wrong side of the arc, making
      // the wall fan out radially from home instead of facing it.
      segments.push({
        position: [x, height / 2, z],
        rotation: [0, -mid, 0],
        scale: [arcLength, height, thickness],
      })
    }
    return segments
  }, [])

  const foulPoles = useMemo(() => {
    const radius = feetToM(330)
    const height = feetToM(20)
    return [-1, 1].map((side) => {
      const angle = side * (Math.PI / 4)
      return {
        position: [radius * Math.sin(angle), height / 2, -radius * Math.cos(angle)],
      }
    })
  }, [])

  return (
    <group>
      {/* Outfield grass */}
      <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[GRASS_RADIUS, 64]} />
        <meshStandardMaterial color="#2e7d32" roughness={1} />
      </mesh>

      {/* Infield dirt */}
      <mesh position={[INFIELD_CENTER.x, 0.002, INFIELD_CENTER.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[INFIELD_RADIUS, 48]} />
        <meshStandardMaterial color="#b08968" roughness={1} />
      </mesh>

      {/* Pitcher's mound + rubber */}
      <mesh position={[FIELD.DEFENSE.P.x, 0.004, FIELD.DEFENSE.P.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[MOUND_RADIUS, 32]} />
        <meshStandardMaterial color="#c9a77c" roughness={1} />
      </mesh>
      <mesh position={[0, 0.012, FIELD.DEFENSE.P.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[feetToM(2), feetToM(0.5)]} />
        <meshStandardMaterial color="#f5f5f5" />
      </mesh>

      {/* Home plate (simple pentagon approximation, centered on the plate) */}
      <mesh position={[0, 0.012, -feetToM(8.5 / 12)]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.4318, 0.4318]} />
        <meshStandardMaterial color="#f5f5f5" />
      </mesh>

      {/* First / second / third base (raised white squares so they read clearly) */}
      {[FIELD.BASE.FIRST, FIELD.BASE.SECOND, FIELD.BASE.THIRD].map((base, i) => (
        <mesh key={i} position={[base.x, 0.05, base.z]} castShadow>
          <boxGeometry args={[feetToM(1.5), 0.1, feetToM(1.5)]} />
          <meshStandardMaterial color="#f5f5f5" />
        </mesh>
      ))}

      {/* Foul lines (first- and third-base lines, extended to the grass edge) */}
      {foulLines.map((line, i) => (
        <FoulLine key={i} from={line.from} to={line.to} />
      ))}

      {/* Outfield wall */}
      {wallSegments.map((seg, i) => (
        <mesh key={i} position={seg.position} rotation={seg.rotation} scale={seg.scale} castShadow>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#1d3a5f" roughness={0.9} />
        </mesh>
      ))}

      {/* Foul poles */}
      {foulPoles.map((pole, i) => (
        <mesh key={i} position={pole.position} castShadow>
          <cylinderGeometry args={[0.15, 0.15, feetToM(20), 8]} />
          <meshStandardMaterial color="#ffd23f" emissive="#332200" />
        </mesh>
      ))}
    </group>
  )
}
