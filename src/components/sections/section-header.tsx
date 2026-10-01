import { ReactNode } from "react";

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}

export default function SectionHeader({ 
  title, 
  subtitle, 
  actions,
  className = ""
}: SectionHeaderProps) {
  return (
    <div className={`text-center mb-12 animate-in fade-in slide-in-from-bottom-12 duration-500 ${className}`}>
      <h2 className="text-4xl md:text-5xl font-bold mb-4 text-glow">{title}</h2>
      {subtitle && (
        <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg text-justify">
          {subtitle}
        </p>
      )}
      {actions && (
        <div className="mt-6">
          {actions}
        </div>
      )}
    </div>
  );
}
