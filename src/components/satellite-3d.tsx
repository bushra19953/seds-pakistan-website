"use client";

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { isWebGLSupported, webGLContextTracker, handleWebGLContextLoss, getWebGLErrorMessage } from '@/lib/webgl-utils';

export default function Satellite3D() {
  const mountRef = useRef<HTMLDivElement>(null);
  const mouse = useRef({ x: 0, y: 0 });
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
    const componentId = `satellite-3d-${Date.now()}`;

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

    // Handle mouse move - define outside try block for cleanup access
    const handleMouseMove = (event: MouseEvent) => {
      const rect = currentMount.getBoundingClientRect();
      mouse.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
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
          console.warn('WebGL context lost in Satellite3D');
          setError('3D graphics context lost. Please refresh the page.');
        },
        () => {
          console.log('WebGL context restored in Satellite3D');
          setError(null);
        }
      );

    // Satellite Body
    const bodyGeometry = new THREE.BoxGeometry(1.5, 1.5, 1.5);
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.8, roughness: 0.4 });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    scene.add(body);

    // Solar Panels
    const panelGeometry = new THREE.BoxGeometry(3, 1, 0.1);
    const panelMaterial = new THREE.MeshStandardMaterial({ color: 0x0a2a4a, metalness: 0.5, roughness: 0.2 });
    
    const panel1 = new THREE.Mesh(panelGeometry, panelMaterial);
    panel1.position.x = 2.25;
    body.add(panel1);

    const panel2 = new THREE.Mesh(panelGeometry, panelMaterial);
    panel2.position.x = -2.25;
    body.add(panel2);
    
    // Antenna
    const antennaGeometry = new THREE.CylinderGeometry(0.05, 0.05, 1, 8);
    const antennaMaterial = new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 1, roughness: 0.5 });
    const antenna = new THREE.Mesh(antennaGeometry, antennaMaterial);
    antenna.position.y = 1.25;
    body.add(antenna);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const pointLight = new THREE.PointLight(0xffffff, 1);
    pointLight.position.set(5, 5, 5);
    scene.add(pointLight);
    
    const pointLight2 = new THREE.PointLight(0x5A9BD5, 2);
    pointLight2.position.set(-5, -5, -2);
    scene.add(pointLight2);

    currentMount.addEventListener('mousemove', handleMouseMove);

    // Animation loop
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);

      // Smoothly rotate the satellite towards the mouse position
      const targetRotationY = mouse.current.x * 0.5;
      const targetRotationX = mouse.current.y * 0.5;
      body.rotation.y += (targetRotationY - body.rotation.y) * 0.05;
      body.rotation.x += (targetRotationX - body.rotation.x) * 0.05;

      renderer!.render(scene!, camera!);
    };
    animate();

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', handleResize);
    }

      setIsLoading(false);

    } catch (error) {
      console.error('Error initializing Satellite3D:', error);
      setError(getWebGLErrorMessage());
      setIsLoading(false);
    }

    // Cleanup
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', handleResize);
      }
      currentMount.removeEventListener('mousemove', handleMouseMove);
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

  return <div ref={mountRef} className="w-full h-full cursor-grab" />;
}
