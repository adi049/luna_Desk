import { Canvas, useFrame } from '@react-three/fiber';
import { Float, Icosahedron, MeshDistortMaterial, Torus } from '@react-three/drei';
import { useRef } from 'react';
import type { Group, Mesh } from 'three';

function Moon() {
  const ref = useRef<Mesh>(null);
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.getElapsedTime();
    ref.current.rotation.y = t * 0.12;
    ref.current.rotation.x = Math.sin(t * 0.18) * 0.12;
  });
  return (
    <mesh ref={ref} position={[0.9, 0.35, 0]}>
      <sphereGeometry args={[1.35, 48, 48]} />
      <meshStandardMaterial color="#2a2a3c" roughness={0.28} metalness={0.6} emissive="#0d0d14" emissiveIntensity={0.6} />
    </mesh>
  );
}

function Crescent() {
  const ref = useRef<Mesh>(null);
  useFrame((state) => {
    if (!ref.current) return;
    ref.current.rotation.z = state.clock.getElapsedTime() * 0.08;
  });
  return (
    <mesh ref={ref} position={[1.45, 0.8, 0.9]}>
      <torusGeometry args={[1.5, 0.045, 24, 120, Math.PI * 1.25]} />
      <meshBasicMaterial color="#FF2D95" transparent opacity={0.9} />
    </mesh>
  );
}

function Ring() {
  return (
    <Torus args={[2.05, 0.012, 12, 140]} rotation={[1.28, 0.32, 0.4]} position={[0.8, 0.3, 0]}>
      <meshBasicMaterial color="#C7CBD4" transparent opacity={0.35} />
    </Torus>
  );
}

function Core() {
  const group = useRef<Group>(null);
  useFrame((state) => {
    if (!group.current) return;
    group.current.rotation.y = state.clock.getElapsedTime() * 0.06;
  });
  return (
    <group ref={group}>
      <Float speed={1.1} rotationIntensity={0.35} floatIntensity={0.5}>
        <Icosahedron args={[0.34, 1]} position={[-1.75, -0.85, 0.6]}>
          <MeshDistortMaterial color="#A8D8FF" distort={0.28} speed={1.4} roughness={0.2} metalness={0.1} />
        </Icosahedron>
      </Float>
      <Float speed={0.9} rotationIntensity={0.4} floatIntensity={0.7}>
        <Icosahedron args={[0.18, 0]} position={[1.75, -1.15, -0.4]}>
          <meshStandardMaterial color="#B8F28B" roughness={0.3} metalness={0.2} />
        </Icosahedron>
      </Float>
      <Float speed={1.3} rotationIntensity={0.3} floatIntensity={0.6}>
        <mesh position={[-0.25, 1.55, -0.8]}>
          <octahedronGeometry args={[0.22]} />
          <meshStandardMaterial color="#FFE27A" roughness={0.35} metalness={0.25} />
        </mesh>
      </Float>
    </group>
  );
}

/**
 * Restrained 3D for the sign-in screen only. Mounted lazily, capped at 1.6 DPR,
 * and never mounted at all when the user prefers reduced motion — the
 * dashboard itself carries no WebGL.
 */
export default function LunaScene() {
  return (
    <Canvas
      dpr={[1, 1.6]}
      camera={{ position: [0, 0, 6.2], fov: 42 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
      style={{ pointerEvents: 'none' }}
      aria-hidden
    >
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 5, 5]} intensity={1.1} color="#F8F8FC" />
      <pointLight position={[-4, -2, 2]} intensity={18} color="#FF2D95" distance={12} />
      <pointLight position={[3, 3, -3]} intensity={10} color="#A8D8FF" distance={14} />
      <Moon />
      <Crescent />
      <Ring />
      <Core />
    </Canvas>
  );
}
