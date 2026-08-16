import React, { useRef, useState, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line, useGLTF } from '@react-three/drei';
import * as THREE from 'three';

// MagicaVoxel usually exports as .obj or .glb. We'll set up a GLTF loader just in case,
// but fallback to a simple procedural voxel-like sphere (a box or low-poly sphere).
const VoxelBall = (props) => {
    // If you drop a MagicaVoxel export as ball.glb in public/models/, you could use:
    // const { nodes, materials } = useGLTF('/models/ball.glb')
    // return <primitive object={nodes.Scene} {...props} />
    
    // For now, we'll use a placeholder voxel-like shape (a simple Box)
    return (
        <mesh {...props}>
            <boxGeometry args={[0.2, 0.2, 0.2]} />
            <meshStandardMaterial color="white" />
        </mesh>
    );
};

export const Pitch = ({ pitchData, defaultPitchData, crossingPlane = 'mid', onCrossings }) => {
    const ballRef = useRef();
    
    // Memoize the line points so we don't recreate them every render
    const linePoints = useMemo(() => {
        const trajectoryData = pitchData?.trajectory;
        if (!trajectoryData || trajectoryData.length === 0) return [];
        // Map trajectory dicts {x, y, z} to THREE.Vector3
        return trajectoryData.map(p => new THREE.Vector3(p.x, p.z, -p.y));
    }, [pitchData]);

    const quadraticPoints = useMemo(() => {
        const quadraticData = pitchData?.quadratic_trajectory;
        if (!quadraticData || quadraticData.length === 0) return [];
        return quadraticData.map(p => new THREE.Vector3(p.x, p.z, -p.y));
    }, [pitchData]);

    // Ghost trajectory: default (neutral) environment, shown in purple when in compare mode
    const ghostLinePoints = useMemo(() => {
        const traj = defaultPitchData?.trajectory;
        if (!traj || traj.length === 0) return [];
        return traj.map(p => new THREE.Vector3(p.x, p.z, -p.y));
    }, [defaultPitchData]);
    
    useFrame(({ clock }) => {
        const trajectoryData = pitchData?.trajectory;
        if (!trajectoryData || trajectoryData.length === 0 || !ballRef.current) return;
        
        // Simple animation loop based on time
        const elapsedTime = clock.getElapsedTime();
        const loopDuration = 2.0; 
        const simDuration = trajectoryData[trajectoryData.length - 1]?.t || 0.4;
        
        // Calculate progress normalized between 0 and 1
        const t = (elapsedTime % loopDuration) / loopDuration;
        // Map to actual simulation time
        const currentSimTime = t * simDuration;
        
        // Find the points we are interpolating between
        let p1 = trajectoryData[0];
        let p2 = trajectoryData[1] || p1;
        
        for (let i = 0; i < trajectoryData.length - 1; i++) {
            if (trajectoryData[i].t <= currentSimTime && trajectoryData[i+1].t >= currentSimTime) {
                p1 = trajectoryData[i];
                p2 = trajectoryData[i+1];
                break;
            }
        }
        
        if (p1 && p2) {
            // Linear interpolation
            const segmentTime = p2.t - p1.t;
            const segmentProgress = segmentTime > 0 ? (currentSimTime - p1.t) / segmentTime : 0;
            
            const x = THREE.MathUtils.lerp(p1.x, p2.x, segmentProgress);
            const y = THREE.MathUtils.lerp(p1.z, p2.z, segmentProgress); // Z is height in statcast
            const z = THREE.MathUtils.lerp(-p1.y, -p2.y, segmentProgress); // -Y is depth in three
            
            ballRef.current.position.set(x, y, z);
        }
    });

    // Calculations for geometry and crossing markers
    const frontOfPlateZ = -0.4318;
    const midPlateZ = -(8.5 / 12) * 0.3048; // = -0.2159m from back tip
    const targetZ = crossingPlane === 'front' ? frontOfPlateZ : midPlateZ;

    const szTopM = ((pitchData?.strike_zone_top) || 3.5) * 0.3048;
    const szBottomM = ((pitchData?.strike_zone_bottom) || 1.5) * 0.3048;
    const szWidthM = 0.4318; 
    const szHalfW = szWidthM / 2;
    const szHeight = szTopM - szBottomM;
    const thirdW = szWidthM / 3;
    const thirdH = szHeight / 3;

    // Statcast crossing marker: use targetZ for consistency across all three dots
    const hasMidCrossing = pitchData?.statcast_px_mid != null && pitchData?.statcast_pz_mid != null;
    const hasStatcastCrossing = hasMidCrossing || (pitchData?.statcast_px != null && pitchData?.statcast_pz != null);
    const statcastPx = crossingPlane === 'front' ? pitchData?.statcast_px : (pitchData?.statcast_px_mid ?? pitchData?.statcast_px);
    const statcastPz = crossingPlane === 'front' ? pitchData?.statcast_pz : (pitchData?.statcast_pz_mid ?? pitchData?.statcast_pz);
    const statcastCrossingM = (hasStatcastCrossing && statcastPx != null && statcastPz != null)
        ? [statcastPx * 0.3048, statcastPz * 0.3048, targetZ]
        : null;

    // Physics simulation crossing marker — evaluated at targetZ to match the selected plane
    let simCrossingM = null;
    for (let i = 0; i < linePoints.length - 1; i++) {
        const p1 = linePoints[i];
        const p2 = linePoints[i+1];
        if (p1.z <= targetZ && p2.z > targetZ) {
            const t = (targetZ - p1.z) / (p2.z - p1.z);
            const crossX = p1.x + t * (p2.x - p1.x);
            const crossY = p1.y + t * (p2.y - p1.y);
            simCrossingM = [crossX, crossY, targetZ];
            break;
        }
    }
    if (!simCrossingM && linePoints.length > 0) {
        const lastP = linePoints[linePoints.length - 1];
        simCrossingM = [lastP.x, lastP.y, targetZ];
    }

    // Ghost (default env) crossing marker — evaluated at targetZ to match the selected plane
    let ghostCrossingM = null;
    for (let i = 0; i < ghostLinePoints.length - 1; i++) {
        const p1 = ghostLinePoints[i];
        const p2 = ghostLinePoints[i + 1];
        if (p1.z <= targetZ && p2.z > targetZ) {
            const tg = (targetZ - p1.z) / (p2.z - p1.z);
            ghostCrossingM = [p1.x + tg * (p2.x - p1.x), p1.y + tg * (p2.y - p1.y), targetZ];
            break;
        }
    }
    if (!ghostCrossingM && ghostLinePoints.length > 0) {
        const lp = ghostLinePoints[ghostLinePoints.length - 1];
        ghostCrossingM = [lp.x, lp.y, targetZ];
    }

    // Notify parent about crossing positions (Hook always executes at top level)
    React.useEffect(() => {
        if (onCrossings) {
            onCrossings({
                red:    simCrossingM    ? { x: simCrossingM[0],    z: simCrossingM[1]    } : null,
                purple: ghostCrossingM  ? { x: ghostCrossingM[0],  z: ghostCrossingM[1]  } : null,
                blue:   statcastCrossingM ? { x: statcastCrossingM[0], z: statcastCrossingM[1] } : null,
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [simCrossingM?.[0], simCrossingM?.[1], ghostCrossingM?.[0], ghostCrossingM?.[1], statcastCrossingM?.[0], statcastCrossingM?.[1]]);

    if (!pitchData || linePoints.length === 0) return null;

    return (
        <group>
            {/* The Trajectory Line (Physics Simulation) */}
            <Line
                points={linePoints}
                color="red"
                lineWidth={1.5}
                transparent={true}
                opacity={0.4}
                dashed={false}
            />

            {/* The Quadratic Trajectory Overlay (Statcast Raw Constants) */}
            {quadraticPoints.length > 0 && (
                <Line
                    points={quadraticPoints}
                    color="orange"
                    lineWidth={2}
                    dashed={true}
                    dashSize={0.5}
                    gapSize={0.2}
                />
            )}

            {/* Ghost Trajectory: default (neutral) environment in purple */}
            {ghostLinePoints.length > 0 && (
                <Line
                    points={ghostLinePoints}
                    color="#cc44ff"
                    lineWidth={2}
                    transparent={true}
                    opacity={0.55}
                    dashed={true}
                    dashSize={0.35}
                    gapSize={0.15}
                />
            )}
            
            {/* The Voxel Ball moving along the trajectory */}
            <VoxelBall ref={ballRef} />
            
            {/* 9-Quadrant Strike Zone */}
            <group position={[0, 0, frontOfPlateZ]}>
                {/* Outer Border */}
                <Line points={[[-szHalfW, szBottomM, 0], [szHalfW, szBottomM, 0]]} color="white" lineWidth={2} />
                <Line points={[[-szHalfW, szTopM, 0], [szHalfW, szTopM, 0]]} color="white" lineWidth={2} />
                <Line points={[[-szHalfW, szBottomM, 0], [-szHalfW, szTopM, 0]]} color="white" lineWidth={2} />
                <Line points={[[szHalfW, szBottomM, 0], [szHalfW, szTopM, 0]]} color="white" lineWidth={2} />
                
                {/* Inner Vertical Lines */}
                <Line points={[[-szHalfW + thirdW, szBottomM, 0], [-szHalfW + thirdW, szTopM, 0]]} color="white" lineWidth={1} />
                <Line points={[[szHalfW - thirdW, szBottomM, 0], [szHalfW - thirdW, szTopM, 0]]} color="white" lineWidth={1} />
                
                {/* Inner Horizontal Lines */}
                <Line points={[[-szHalfW, szBottomM + thirdH, 0], [szHalfW, szBottomM + thirdH, 0]]} color="white" lineWidth={1} />
                <Line points={[[-szHalfW, szBottomM + 2 * thirdH, 0], [szHalfW, szBottomM + 2 * thirdH, 0]]} color="white" lineWidth={1} />
            </group>

            {/* Statcast Actual Crossing (Blue) */}
            {statcastCrossingM && (
                <mesh position={statcastCrossingM}>
                    <sphereGeometry args={[0.04, 16, 16]} />
                    <meshStandardMaterial color="#00aaff" />
                </mesh>
            )}
            
            {/* Physics Simulation Crossing (Red) */}
            {simCrossingM && (
                <mesh position={simCrossingM}>
                    <sphereGeometry args={[0.04, 16, 16]} />
                    <meshStandardMaterial color="#ff4444" />
                </mesh>
            )}

            {/* Ghost Crossing: default env (Purple) */}
            {ghostCrossingM && (
                <mesh position={ghostCrossingM}>
                    <sphereGeometry args={[0.04, 16, 16]} />
                    <meshStandardMaterial color="#cc44ff" emissive="#8800cc" emissiveIntensity={0.4} />
                </mesh>
            )}

            {/* Home Plate Placeholder (Centered at back tip z=0, stretches to z=-0.4318) */}
            <mesh position={[0, 0, -0.2159]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[0.4318, 0.4318]} />
                <meshStandardMaterial color="white" />
            </mesh>
            
            {/* Pitcher's Mound Placeholder */}
            <mesh position={[0, 0, -18.44]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[1, 1]} />
                <meshStandardMaterial color="brown" />
            </mesh>
        </group>
    );
};

// If using GLTF models, preload them
// useGLTF.preload('/models/ball.glb');
