import React from 'react';
import { motion } from 'motion/react';

const LuckyCat: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <motion.div
      animate={{ 
        rotate: [0, -5, 5, -5, 0],
        y: [0, -2, 0]
      }}
      transition={{ 
        duration: 5, 
        repeat: Infinity,
        ease: "easeInOut"
      }}
      className={className}
    >
      <svg
        viewBox="0 0 512 512"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full drop-shadow-lg"
      >
        {/* Main Body */}
        <path
          d="M400 256c0 88.366-71.634 160-160 160s-160-71.634-160-160 71.634-160 160-160 160 71.634 160 160z"
          fill="#FFF"
        />
        
        {/* Ears */}
        <path d="M120 120 L80 40 L180 80 Z" fill="#FFF" stroke="#E5E5E5" strokeWidth="4" />
        <path d="M360 120 L400 40 L300 80 Z" fill="#FFF" stroke="#E5E5E5" strokeWidth="4" />
        <path d="M110 100 L90 60 L150 85 Z" fill="#FFD1D1" />
        <path d="M370 100 L390 60 L330 85 Z" fill="#FFD1D1" />

        {/* Face Details */}
        <circle cx="180" cy="220" r="12" fill="#333" />
        <circle cx="300" cy="220" r="12" fill="#333" />
        <path d="M220 250 Q240 270 260 250" stroke="#333" strokeWidth="4" fill="none" strokeLinecap="round" />
        <circle cx="240" cy="240" r="8" fill="#FF6B6B" />
        
        {/* Whiskers */}
        <path d="M130 230 L80 220 M130 245 L80 245 M130 260 L80 270" stroke="#333" strokeWidth="2" strokeLinecap="round" />
        <path d="M350 230 L400 220 M350 245 L400 245 M350 260 L400 270" stroke="#333" strokeWidth="2" strokeLinecap="round" />

        {/* Bell and Collar */}
        <path d="M160 340 Q240 370 320 340" stroke="#FF4D4D" strokeWidth="12" fill="none" strokeLinecap="round" />
        <circle cx="240" cy="360" r="20" fill="#FFD700" stroke="#B8860B" strokeWidth="2" />
        <circle cx="240" cy="365" r="4" fill="#333" />

        {/* Paws */}
        <motion.path
          animate={{ rotate: [0, -15, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          d="M320 280 Q360 260 380 300 Q360 340 320 320"
          fill="#FFF"
          stroke="#E5E5E5"
          strokeWidth="4"
          style={{ transformOrigin: '320px 300px' }}
        />
        <path d="M160 280 Q120 260 100 300 Q120 340 160 320" fill="#FFF" stroke="#E5E5E5" strokeWidth="4" />

        {/* Coin/Scroll */}
        <rect x="200" y="380" width="80" height="40" rx="10" fill="#FFD700" stroke="#B8860B" strokeWidth="2" />
        <text x="215" y="408" fill="#B8860B" fontSize="24" fontWeight="bold">招财</text>
      </svg>
    </motion.div>
  );
};

export default LuckyCat;
