'use client';

import { useEffect, useRef } from 'react';

/**
 * Three.js backdrop for the Grand Prix portal: a drifting starfield and one
 * rocket crossing the sky. The planets live in CartoonPlanets (pure SVG/CSS)
 * per the poster's educational cartoon style; this canvas stays light.
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

      const GOLD = 0xc9a45c;
      const GOLD_LIGHT = 0xe8cf8f;
      const IVORY = 0xe9e2d0;

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

      const basic = (color: number, opacity = 1) =>
        new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });

      // Soft radial glow so the rocket melts into the nebula.
      const glowCanvas = document.createElement('canvas');
      glowCanvas.width = 128;
      glowCanvas.height = 128;
      const gtx = glowCanvas.getContext('2d');
      if (gtx) {
        const grad = gtx.createRadialGradient(64, 64, 2, 64, 64, 64);
        grad.addColorStop(0, 'rgba(232,207,143,0.55)');
        grad.addColorStop(0.45, 'rgba(201,164,92,0.18)');
        grad.addColorStop(1, 'rgba(201,164,92,0)');
        gtx.fillStyle = grad;
        gtx.fillRect(0, 0, 128, 128);
      }
      const glowTex = new THREE.CanvasTexture(glowCanvas);
      const makeGlow = (scale: number, opacity: number) => {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity, depthWrite: false }),
        );
        sprite.scale.setScalar(scale);
        return sprite;
      };

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

      // Rocket: ivory body, gold nose and fins, flickering exhaust cone
      const rocket = new THREE.Group();
      const rBody = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.05, 20), basic(IVORY));
      rocket.add(rBody);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 20), basic(GOLD));
      nose.position.y = 0.73;
      rocket.add(nose);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.1, 20), basic(GOLD));
      band.position.y = -0.28;
      rocket.add(band);
      for (let i = 0; i < 3; i++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.2), basic(GOLD));
        const a = (i / 3) * Math.PI * 2;
        fin.position.set(Math.cos(a) * 0.2, -0.55, Math.sin(a) * 0.2);
        fin.rotation.y = -a;
        rocket.add(fin);
      }
      const exhaust = new THREE.Mesh(
        new THREE.ConeGeometry(0.11, 0.5, 16),
        basic(GOLD_LIGHT, 0.85),
      );
      exhaust.rotation.x = Math.PI;
      exhaust.position.y = -0.85;
      rocket.add(exhaust);
      rocket.add(makeGlow(4.6, 0.35));
      rocket.scale.setScalar(1.55);
      scene.add(rocket);

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

        // Rocket: climbs a long diagonal, banks gently, loops
        const cycle = 34;
        const p = (t % cycle) / cycle;
        const x = -13 + p * 30;
        const y = -6.5 + p * 13.5 + Math.sin(p * Math.PI * 3) * 0.35;
        rocket.position.set(x, y, -3.5);
        rocket.rotation.z = -Math.PI / 3.6 + Math.sin(t * 0.7) * 0.05;
        exhaust.scale.set(1, 0.8 + Math.sin(t * 22) * 0.25 + Math.random() * 0.08, 1);

        renderer.render(scene, camera);
        if (!reduced) raf = requestAnimationFrame(animate);
      };
      animate();

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', onResize);
        renderer.dispose();
        starGeo.dispose();
        glowTex.dispose();
        scene.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            (obj.material as THREE.Material).dispose();
          }
          if (obj instanceof THREE.Sprite) {
            obj.material.map?.dispose();
            obj.material.dispose();
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
