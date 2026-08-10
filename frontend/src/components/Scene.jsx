import React from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Sky, Environment } from '@react-three/drei';
import { Pitch } from './Pitch';

export const Scene = ({ trajectoryData }) => {
    return (
        <Canvas camera={{ position: [5, 5, 5], fov: 60 }}>
            {/* Lighting */}
            <ambientLight intensity={0.5} />
            <directionalLight position={[10, 10, 5]} intensity={1} castShadow />
            
            {/* Environment to make it look a bit nicer out of the box */}
            <Sky sunPosition={[100, 20, 100]} />
            <Environment preset="park" />
            
            {/* Pitch Visualization Component */}
            <Pitch trajectoryData={trajectoryData} />
            
            {/* Camera Controls */}
            <OrbitControls makeDefault />
            
            {/* Simple grid to help orient the viewer */}
            <gridHelper args={[50, 50]} />
        </Canvas>
    );
};
