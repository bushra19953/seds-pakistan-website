import Image from 'next/image';
import { cn } from '@/lib/utils';

interface OptimizedLogoProps extends React.ComponentPropsWithoutRef<typeof Image> {
  alt: string;
  className?: string;
  width: number;
  height: number;
  webpSrc?: string;
  avifSrc?: string;
}

export default function OptimizedLogo({ alt, className, width, height, webpSrc, avifSrc, src, ...props }: OptimizedLogoProps) {
  const defaultSrc = "/assets/logo.png"; // Original PNG
  const imageSrc = src || defaultSrc;

  return (
    <picture>
      <source srcSet={avifSrc} type="image/avif" />
      <source srcSet={webpSrc} type="image/webp" />
      <Image
        src={imageSrc}
        alt={alt}
        width={width}
        height={height}
        className={cn("object-contain", className)}
        style={{ width: 'auto', height: 'auto' }}
        {...props}
      />
    </picture>
  );
}