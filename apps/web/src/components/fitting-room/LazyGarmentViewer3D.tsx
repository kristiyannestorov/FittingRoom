'use client';

import dynamic from 'next/dynamic';

export const GarmentViewer3D = dynamic(
  () => import('./GarmentViewer3D').then((module) => module.GarmentViewer3D),
  {
    ssr: false,
    loading: () => <div className="aspect-square animate-pulse rounded-xl bg-black/5" />,
  },
);
