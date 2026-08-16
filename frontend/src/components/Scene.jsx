import React, { useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Sky, Environment } from '@react-three/drei';
import { Pitch } from './Pitch';

const CameraController = ({ snapTrigger, controlsRef }) => {
    const { camera } = useThree();
    
    useEffect(() => {
        if (snapTrigger > 0) {
            const szTopM = 3.5 * 0.3048;
            const szBottomM = 1.5 * 0.3048;
            const cy = (szTopM + szBottomM) / 2;
            
            // Position camera behind the catcher, looking at the strike zone
            camera.position.set(0, cy, 2.5);
            
            if (controlsRef.current) {
                // Front of plate is at -0.4318, back is at 0. Target the middle.
                controlsRef.current.target.set(0, cy, -0.2159);
                controlsRef.current.update();
            } else {
                camera.lookAt(0, cy, -0.2159);
            }
        }
    }, [snapTrigger, camera, controlsRef]);
    
    return null;
};

export const Scene = ({ pitchData, defaultPitchData, snapTrigger, crossingPlane, onCrossings }) => {
    const controlsRef = useRef();

    return (
        <Canvas camera={{ position: [5, 5, 5], fov: 60 }}>
            <CameraController snapTrigger={snapTrigger} controlsRef={controlsRef} />
            
            {/* Lighting */}
            <ambientLight intensity={0.5} />
            <directionalLight position={[10, 10, 5]} intensity={1} castShadow />
            
            {/* Environment to make it look a bit nicer out of the box */}
            <Sky sunPosition={[100, 20, 100]} />
            <React.Suspense fallback={null}>
                <Environment preset="park" />
            </React.Suspense>
            
            {/* Pitch Visualization Component */}
            <Pitch pitchData={pitchData} defaultPitchData={defaultPitchData} crossingPlane={crossingPlane} onCrossings={onCrossings} />
            
            {/* Camera Controls */}
            <OrbitControls makeDefault ref={controlsRef} />
            
            {/* Simple grid to help orient the viewer */}
            <gridHelper args={[50, 50]} />
        </Canvas>
    );
};
