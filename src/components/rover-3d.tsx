"use client";

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { isWebGLSupported, webGLContextTracker, handleWebGLContextLoss, getWebGLErrorMessage } from '@/lib/webgl-utils';

export default function Rover3D() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!mountRef.current) return;
    const currentMount = mountRef.current;
    let renderer: THREE.WebGLRenderer | null = null;
    let scene: THREE.Scene | null = null;
    let camera: THREE.PerspectiveCamera | null = null;
    let animationFrameId: number | null = null;
    let contextCleanup: (() => void) | null = null;
    const componentId = `rover-3d-${Date.now()}`;

    // Handle resize - define outside try block for cleanup access
    const handleResize = () => {
      if (currentMount && renderer && camera) {
        const width = currentMount.clientWidth;
        const height = currentMount.clientHeight;
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
    };

    try {
      // Check WebGL support
      if (!isWebGLSupported()) {
        setError(getWebGLErrorMessage());
        setIsLoading(false);
        return;
      }

      // Check context limit
      if (!webGLContextTracker.addContext(componentId)) {
        setError(getWebGLErrorMessage());
        setIsLoading(false);
        return;
      }

      // Scene
      scene = new THREE.Scene();

      // Camera
      camera = new THREE.PerspectiveCamera(75, currentMount.clientWidth / currentMount.clientHeight, 0.1, 1000);
      camera.position.z = 5;
      camera.position.y = 2;

      // Renderer with error handling
      try {
        renderer = new THREE.WebGLRenderer({ 
          antialias: true, 
          alpha: true,
          powerPreference: 'high-performance'
        });
      } catch (error) {
        console.error('Failed to create WebGL renderer:', error);
        setError(getWebGLErrorMessage());
        setIsLoading(false);
        return;
      }

      if (!renderer) {
        setError(getWebGLErrorMessage());
        setIsLoading(false);
        return;
      }

      renderer.setSize(currentMount.clientWidth, currentMount.clientHeight);
      if (typeof window !== 'undefined') {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Limit pixel ratio to prevent memory issues
      }
      currentMount.appendChild(renderer.domElement);

      // Handle WebGL context loss
      contextCleanup = handleWebGLContextLoss(
        renderer.domElement,
        () => {
          console.warn('WebGL context lost in Rover3D');
          setError('3D graphics context lost. Please refresh the page.');
        },
        () => {
          console.log('WebGL context restored in Rover3D');
          setError(null);
        }
      );

    // Ground
    const groundGeometry = new THREE.PlaneGeometry(20, 20);
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x4a2a1a, roughness: 0.8 });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1;
    scene.add(ground);

    const rover = new THREE.Group();
    scene.add(rover);

    // Rover Body
    const bodyGeometry = new THREE.BoxGeometry(2, 0.5, 3);
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.8, roughness: 0.4 });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    rover.add(body);

    // Wheels
    const wheelGeometry = new THREE.CylinderGeometry(0.5, 0.5, 0.3, 16);
    const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.1, roughness: 0.9 });
    
    const wheels: THREE.Mesh[] = [];
    for(let i = 0; i < 6; i++) {
        const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
        wheel.rotation.z = Math.PI / 2;
        wheels.push(wheel);
        rover.add(wheel);
    }
    
    wheels[0].position.set(1.15, -0.2, 1);
    wheels[1].position.set(-1.15, -0.2, 1);
    wheels[2].position.set(1.15, -0.2, 0);
    wheels[3].position.set(-1.15, -0.2, 0);
    wheels[4].position.set(1.15, -0.2, -1);
    wheels[5].position.set(-1.15, -0.2, -1);


    // Mast
    const mastGeometry = new THREE.CylinderGeometry(0.1, 0.1, 1.5, 8);
    const mastMaterial = new THREE.MeshStandardMaterial({ color: 0xcccccc });
    const mast = new THREE.Mesh(mastGeometry, mastMaterial);
    mast.position.y = 0.5;
    mast.position.z = -1;
    rover.add(mast);

    const headGeometry = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    const head = new THREE.Mesh(headGeometry, mastMaterial);
    head.position.y = 1.5;
    mast.add(head);


    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(5, 5, 5);
    directionalLight.castShadow = true;
    scene.add(directionalLight);

    // Animation loop
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      rover.rotation.y += 0.002;
      renderer!.render(scene!, camera!);
    };
    animate();

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', handleResize);
    }

      setIsLoading(false);

    } catch (error) {
      console.error('Error initializing Rover3D:', error);
      setError(getWebGLErrorMessage());
      setIsLoading(false);
    }

    // Cleanup
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', handleResize);
      }
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      if (currentMount && renderer?.domElement) {
        currentMount.removeChild(renderer.domElement);
      }
      if (renderer) {
        renderer.dispose();
      }
      if (contextCleanup) {
        contextCleanup();
      }
      webGLContextTracker.removeContext(componentId);
    };
  }, []);

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-muted/20 rounded-lg">
        <div className="text-center p-4">
          <div className="text-destructive mb-2">⚠️ 3D Graphics Error</div>
          <div className="text-sm text-muted-foreground">{error}</div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="w-full h-full bg-muted/20 rounded-lg animate-pulse" />
    );
  }

  return <div ref={mountRef} className="w-full h-full" />;
}
