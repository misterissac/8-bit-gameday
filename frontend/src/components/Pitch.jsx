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

export const Pitch = ({ trajectoryData }) => {
    const ballRef = useRef();
    const [points, setPoints] = useState([]);
    
    // Memoize the line points so we don't recreate them every render
    const linePoints = useMemo(() => {
        if (!trajectoryData || trajectoryData.length === 0) return [];
        // Map trajectory dicts {x, y, z} to THREE.Vector3
        // Note: In baseball (Statcast), Y is usually distance from home plate,
        // Z is height, X is side-to-side. 
        // We might need to adjust axes for Three.js (where Y is typically up, Z is depth).
        // Let's assume Statcast Y (distance to home) -> Three -Z
        // Statcast Z (height) -> Three Y
        // Statcast X (side) -> Three X
        return trajectoryData.map(p => new THREE.Vector3(p.x, p.z, -p.y));
    }, [trajectoryData]);
    
    useFrame(({ clock }) => {
        if (!trajectoryData || trajectoryData.length === 0 || !ballRef.current) return;
        
        // Simple animation loop based on time
        const elapsedTime = clock.getElapsedTime();
        // The simulation time usually goes from 0 to around 0.4 - 0.6 seconds.
        // Let's loop the animation every 2 seconds.
        const loopDuration = 2.0; 
        const simDuration = trajectoryData[trajectoryData.length - 1].t;
        
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

    if (linePoints.length === 0) return null;

    return (
        <group>
            {/* The Trajectory Line */}
            <Line
                points={linePoints}
                color="red"
                lineWidth={3}
                dashed={false}
            />
            
            {/* The Voxel Ball moving along the trajectory */}
            <VoxelBall ref={ballRef} />
            
            {/* Home Plate Placeholder */}
            <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[0.5, 0.5]} />
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
