'use client';

import { useEffect, useRef } from 'react';

/**
 * Three.js backdrop for the Grand Prix portal.
 * Two planets anchor the empty left and right of the hero: a ringed indigo
 * gas giant on the left and an amber planet on the right, each with a
 * satellite orbiting it. A rocket crosses the sky and a starfield drifts
 * behind everything. Planet surfaces are canvas-banded textures lit by a
 * warm directional light so they sit naturally in the nebula palette.
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
      const INDIGO_DEEP = 0x2b3563;
      const INK = 0x707ba6;

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

      // Lights only affect the Lambert planet materials; the craft stay flat.
      scene.add(new THREE.AmbientLight(0x8899bb, 0.55));
      const sun = new THREE.DirectionalLight(0xffe3b3, 1.6);
      sun.position.set(6, 8, 10);
      scene.add(sun);

      const basic = (color: number, opacity = 1) =>
        new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });

      // Soft radial glow so objects melt into the nebula.
      const glowCanvas = document.createElement('canvas');
      glowCanvas.width = 128;
      glowCanvas.height = 128;
      const gtx = glowCanvas.getContext('2d');
      if (gtx) {
        const grad = gtx.createRadialGradient(64, 64, 2, 64, 64, 64);
        grad.addColorStop(0, 'rgba(232,207,143,0.5)');
        grad.addColorStop(0.45, 'rgba(201,164,92,0.16)');
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

      // Banded planet surface painted on a canvas.
      const planetTexture = (bands: string[], spot: string) => {
        const c = document.createElement('canvas');
        c.width = 512;
        c.height = 256;
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.fillStyle = bands[0];
          ctx.fillRect(0, 0, 512, 256);
          const bandH = 256 / bands.length;
          bands.forEach((color, i) => {
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.55 + Math.random() * 0.3;
            ctx.fillRect(0, i * bandH - 4, 512, bandH + 8);
          });
          ctx.globalAlpha = 0.16;
          ctx.fillStyle = spot;
          for (let i = 0; i < 26; i++) {
            const x = Math.random() * 512;
            const y = Math.random() * 256;
            const r = 12 + Math.random() * 42;
            ctx.beginPath();
            ctx.ellipse(x, y, r * 1.9, r * 0.55, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
      };

      const makeSatellite = (scale: number) => {
        const sat = new THREE.Group();
        const bus = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), basic(GOLD));
        sat.add(bus);
        const dish = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.14, 16, 1, true), basic(IVORY));
        dish.position.y = 0.26;
        sat.add(dish);
        for (const side of [-1, 1]) {
          const panel = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.4, 0.03), basic(INDIGO_DEEP));
          panel.position.x = side * 0.65;
          sat.add(panel);
          const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), basic(INK));
          spar.rotation.z = Math.PI / 2;
          spar.position.x = side * 0.3;
          sat.add(spar);
        }
        sat.scale.setScalar(scale);
        return sat;
      };

      interface PlanetSys {
        group: THREE.Group;
        planet: THREE.Mesh;
        pivot: THREE.Group;
        sat: THREE.Group;
        orbitSpeed: number;
        spinSpeed: number;
        yBase: number;
      }
      const systems: PlanetSys[] = [];

      const makePlanetSystem = (opts: {
        radius: number;
        bands: string[];
        spot: string;
        ring: boolean;
        orbitRadius: number;
        orbitSpeed: number;
        tilt: number;
        satScale: number;
        yBase: number;
      }) => {
        const group = new THREE.Group();
        group.add(makeGlow(opts.radius * 5.4, 0.32));

        const planet = new THREE.Mesh(
          new THREE.SphereGeometry(opts.radius, 48, 32),
          new THREE.MeshLambertMaterial({
            map: planetTexture(opts.bands, opts.spot),
          }),
        );
        group.add(planet);

        if (opts.ring) {
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(opts.radius * 1.45, opts.radius * 2.05, 64),
            new THREE.MeshBasicMaterial({
              color: GOLD,
              transparent: true,
              opacity: 0.42,
              side: THREE.DoubleSide,
            }),
          );
          ring.rotation.x = Math.PI / 2 - 0.38;
          ring.rotation.y = 0.22;
          group.add(ring);
        }

        const pivot = new THREE.Group();
        pivot.rotation.x = opts.tilt;
        const sat = makeSatellite(opts.satScale);
        sat.position.set(opts.orbitRadius, 0, 0);
        pivot.add(sat);
        group.add(pivot);

        scene.add(group);
        const sys: PlanetSys = {
          group,
          planet,
          pivot,
          sat,
          orbitSpeed: opts.orbitSpeed,
          spinSpeed: 0.02 + Math.random() * 0.015,
          yBase: opts.yBase,
        };
        systems.push(sys);
        return sys;
      };

      // Left: ringed indigo gas giant. Right: amber planet.
      const leftSys = makePlanetSystem({
        radius: 2.1,
        bands: ['#232c52', '#2f3c74', '#46579e', '#2b3563', '#5563ad', '#c9a45c', '#2f3c74', '#232c52'],
        spot: '#8fa2e8',
        ring: true,
        orbitRadius: 4.9,
        orbitSpeed: 0.16,
        tilt: 0.42,
        satScale: 1.25,
        yBase: 1.9,
      });
      const rightSys = makePlanetSystem({
        radius: 1.65,
        bands: ['#4a2c14', '#6b3f1c', '#8a5a2b', '#a87f35', '#7a4a20', '#5d3418', '#8a5a2b'],
        spot: '#e8cf8f',
        ring: false,
        orbitRadius: 3.3,
        orbitSpeed: 0.22,
        tilt: -0.3,
        satScale: 1.05,
        yBase: -1.5,
      });

      // Anchor the planets to the left and right edges at the given depth.
      const layout = () => {
        const aspect = camera.aspect;
        const dist = camera.position.z + 4; // planets sit near z = -4
        const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist;
        const halfW = halfH * aspect;
        const edgeX = Math.max(4.2, halfW - 2.4);
        leftSys.group.position.set(-edgeX, leftSys.yBase, -4);
        rightSys.group.position.set(edgeX, rightSys.yBase, -4.5);
      };
      layout();

      // Rocket: ivory body, gold nose and fins, flickering exhaust cone
      const rocket = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.05, 20), basic(IVORY));
      rocket.add(body);
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
        layout();
      };
      window.addEventListener('resize', onResize);

      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const clock = new THREE.Clock();
      let raf = 0;

      const animate = () => {
        const t = clock.getElapsedTime();

        stars.rotation.z = t * 0.004;

        for (const sys of systems) {
          sys.planet.rotation.y = t * sys.spinSpeed;
          sys.pivot.rotation.y = t * sys.orbitSpeed;
          sys.sat.rotation.y = t * 0.4;
        }

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
            const mat = obj.material as THREE.MeshLambertMaterial;
            mat.map?.dispose();
            mat.dispose();
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
