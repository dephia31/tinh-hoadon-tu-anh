import React from 'react';

const Logo: React.FC<{ className?: string; onClick?: () => void }> = ({ className, onClick }) => {
  return (
    <svg
      viewBox="0 0 240 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <defs>
        <linearGradient id="logoGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F43F5E" />
          <stop offset="100%" stopColor="#FB923C" />
        </linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="2" />
          <feOffset dx="0" dy="2" result="offsetblur" />
          <feComponentTransfer>
            <feFuncA type="linear" slope="0.2" />
          </feComponentTransfer>
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      
      {/* Icon Part */}
      <rect x="10" y="15" width="50" height="50" rx="15" fill="url(#logoGradient)" filter="url(#shadow)" />
      <path 
        d="M25 40 L35 50 L50 30" 
        stroke="white" 
        strokeWidth="4" 
        strokeLinecap="round" 
        strokeLinejoin="round" 
      />
      
      {/* Text Part */}
      <text 
        x="75" 
        y="45" 
        fontFamily="Inter, sans-serif" 
        fontWeight="700" 
        fontSize="28" 
        fill="#1F2937"
      >
        Mận Quý
      </text>
      <text 
        x="75" 
        y="65" 
        fontFamily="Inter, sans-serif" 
        fontWeight="500" 
        fontSize="12" 
        fill="#6B7280"
        letterSpacing="0.05em"
      >
        MATTRESS STORE
      </text>
    </svg>
  );
};

export default Logo;
