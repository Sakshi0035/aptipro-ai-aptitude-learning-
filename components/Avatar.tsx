import React from 'react';

interface AvatarProps {
  avatarUrl: string | null | undefined;
  name: string | null | undefined;
  size?: number;
  className?: string;
}

const Avatar: React.FC<AvatarProps> = ({ avatarUrl, name, size = 40, className = '' }) => {
  const style = {
    width: `${size}px`,
    height: `${size}px`,
    fontSize: `${size / 2.2}px`,
  };

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name || 'User Avatar'}
        className={`rounded-full object-cover bg-gray-200 ${className}`}
        style={style}
      />
    );
  }

  const initial = name ? name.charAt(0).toUpperCase() : '?';
  // Consistent color generation based on name
  const colors = [
    'from-red-500 to-orange-500',
    'from-blue-500 to-teal-500',
    'from-purple-500 to-indigo-500',
    'from-green-500 to-lime-500',
    'from-pink-500 to-rose-500',
    'from-yellow-500 to-amber-500'
  ];
  const colorIndex = name ? name.charCodeAt(0) % colors.length : 0;

  return (
    <div
      className={`bg-gradient-to-br ${colors[colorIndex]} rounded-full flex items-center justify-center font-bold text-white uppercase ${className}`}
      style={style}
    >
      <span>{initial}</span>
    </div>
  );
};

export default Avatar;
