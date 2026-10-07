import React from 'react';
import { WarningIcon } from './Icons';

type AuthType = 'oauth' | 'email';

interface Props {
  type: AuthType;
}

const AuthSetupInstructions: React.FC<Props> = () => {
  return (
    <div className="text-center p-4 my-4 bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 rounded-lg animate-fade-in">
      <div className="flex justify-center items-center mb-2">
        <WarningIcon size={24} className="mr-2" />
        <h3 className="font-bold text-lg">Neon Auth Configuration</h3>
      </div>
      <p className="text-sm text-gray-700 dark:text-gray-300 max-w-md mx-auto">
        Ensure <code>NEON_AUTH_URL</code> and <code>DATABASE_URL</code> are set in your server
        environment variables.
      </p>
    </div>
  );
};

export default AuthSetupInstructions;
