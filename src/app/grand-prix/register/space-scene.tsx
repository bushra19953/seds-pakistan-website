'use client';

import { useEffect, useRef } from 'react';

/**
 * Three.js backdrop for the Grand Prix portal: a drifting starfield only.
 * The planets, satellites and the detailed cartoon rocket live in
 * CartoonPlanets (pure SVG/CSS); this canvas stays light.
 */
export default function SpaceScene() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const THREE = await import('three');
      if (disposed || !hostRef.current) return;

      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setSize(host.clientWidth, host.clientHeight);
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(
        55,
        host.clientWidth / host.clientHeight,
        0.1,
        100,
      );
      camera.position.set(0, 0, 14);

      // Starfield
      const starCount = 850;
      const starPos = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount; i++) {
        starPos[i * 3] = (Math.random() - 0.5) * 46;
        starPos[i * 3 + 1] = (Math.random() - 0.5) * 28;
        starPos[i * 3 + 2] = -Math.random() * 12 - 2;
      }
      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
      const stars = new THREE.Points(
        starGeo,
        new THREE.PointsMaterial({ color: 0xdfe6ff, size: 0.07, transparent: true, opacity: 0.85 }),
      );
      scene.add(stars);

      const onResize = () => {
        if (!hostRef.current) return;
        const w = hostRef.current.clientWidth;
        const h = hostRef.current.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      window.addEventListener('resize', onResize);

      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const clock = new THREE.Clock();
      let raf = 0;

      const animate = () => {
        const t = clock.getElapsedTime();

        stars.rotation.z = t * 0.004;

        renderer.render(scene, camera);
        if (!reduced) raf = requestAnimationFrame(animate);
      };
      animate();

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', onResize);
        renderer.dispose();
        starGeo.dispose();
        scene.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            (obj.material as THREE.Material).dispose();
          }
        });
        host.removeChild(renderer.domElement);
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 opacity-90"
    />
  );
}
