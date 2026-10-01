'use client';

import dynamic from 'next/dynamic';

const Rover3D = dynamic(() => import('@/components/rover-3d'), {
  ssr: false,
  loading: () => <div className="aspect-square w-full bg-muted/20 rounded-lg animate-pulse" />
});

export default function RoverDynamic() {
    return <Rover3D />;
}
