import React, { useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AppContexts';
import {
  fetchUserProfile,
  updateMyProfile,
  compressAndUploadAvatar,
  deleteAccount,
} from '../services/apiClient';
import { MailIcon, UsersIcon, EditIcon, TrashIcon, FlameIcon } from './Icons';
import { Profile as ProfileType, CommunityPost } from '../types';
import Avatar from './Avatar';
import { PostCard } from './Community';
import DatabaseSetupInstructions from './DatabaseSetupInstructions';

const Profile: React.FC = () => {
  const { userId } = useParams<{ userId?: string }>();
  const {
    user: currentUser,
    profile: currentUserProfile,
    setProfile: setCurrentUserProfile,
    signOut,
  } = useAuth();

  const [viewedProfile, setViewedProfile] = useState<ProfileType | null>(null);
  const [recentPosts, setRecentPosts] = useState<CommunityPost[]>([]);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [isEditingUsername, setIsEditingUsername] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [uploading, setUploading] = useState(false);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isOwnProfile = !userId || currentUser?.id === userId;

  useEffect(() => {
    const loadProfileData = async () => {
      setLoadingProfile(true);
      setFetchError(null);
      const profileId = userId || currentUser?.id;

      if (!profileId) {
        setLoadingProfile(false);
        return;
      }

      try {
        const { profile: profileData, recentPosts: postsData } =
          await fetchUserProfile(profileId);
        setViewedProfile(profileData);
        setNewUsername(profileData?.username || '');
        setRecentPosts(postsData || []);
      } catch (err: any) {
        console.error('Error fetching profile:', err.message);
        setFetchError(err.message);
      } finally {
        setLoadingProfile(false);
      }
    };

    loadProfileData();
  }, [userId, currentUser]);

  const handleUsernameUpdate = async () => {
    if (
      !currentUser ||
      !newUsername.trim() ||
      newUsername.trim() === currentUserProfile?.username
    ) {
      setIsEditingUsername(false);
      return;
    }

    try {
      const { profile: updated } = await updateMyProfile({
        username: newUsername.trim(),
      });
      setCurrentUserProfile(updated);
      setViewedProfile(updated);
      setIsEditingUsername(false);
      setStatusMessage('Username updated!');
      setTimeout(() => setStatusMessage(null), 2500);
    } catch (error: any) {
      console.error('Error updating username:', error);
      setStatusMessage(error.message || 'Error updating username.');
    }
  };

  const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files || event.target.files.length === 0 || !currentUser) {
      return;
    }

    const file = event.target.files[0];
    setUploading(true);
    setStatusMessage(null);

    try {
      const { profile: updated } = await compressAndUploadAvatar(file);
      setCurrentUserProfile(updated);
      setViewedProfile(updated);
      setStatusMessage('Profile picture updated!');
      setTimeout(() => setStatusMessage(null), 2500);
    } catch (error: any) {
      console.error('Error uploading avatar:', error);
      setStatusMessage(error.message || 'Error uploading avatar.');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteAccount = async () => {
    try {
      await deleteAccount();
      await signOut();
    } catch (error: any) {
      console.error('Error deleting account:', error);
      setStatusMessage(error.message || 'Failed to delete account.');
    }
  };

  const handlePostUpdated = (updatedPost: CommunityPost) => {
    setRecentPosts((prev) =>
      prev.map((p) => (p.id === updatedPost.id ? updatedPost : p))
    );
  };

  const handlePostDeleted = (deletedPostId: string) => {
    setRecentPosts((prev) => prev.filter((p) => p.id !== deletedPostId));
  };

  if (loadingProfile) {
    return <div className="text-center p-10">Loading profile...</div>;
  }

  if (fetchError) {
    return (
      <div className="p-6">
        <DatabaseSetupInstructions feature="leaderboard" error={fetchError} />
      </div>
    );
  }

  if (!viewedProfile) {
    return <div className="text-center p-10">Profile not found.</div>;
  }

  return (
    <div className="max-w-4xl mx-auto animate-fade-in">
      {statusMessage && (
        <div className="mb-4 p-3 text-sm text-center text-orange-800 bg-orange-100 dark:bg-orange-900/40 dark:text-orange-200 rounded-xl">
          {statusMessage}
        </div>
      )}
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg overflow-hidden">
        {/* Profile Header */}
        <div className="h-32 bg-gradient-to-r from-fire-orange-start to-fire-red-end"></div>
        <div className="px-6 pb-6 -mt-16">
          <div className="flex items-end">
            <div className="relative">
              <Avatar
                avatarUrl={viewedProfile?.avatar_url}
                name={viewedProfile?.username || 'User'}
                size={112}
                className="border-4 border-white dark:border-gray-800"
              />
              {isOwnProfile && (
                <>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="absolute bottom-1 right-1 w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center text-white hover:bg-gray-900 transition-colors"
                    disabled={uploading}
                    aria-label="Upload profile picture"
                  >
                    {uploading ? (
                      <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"></div>
                    ) : (
                      <EditIcon size={16} />
                    )}
                  </button>
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleAvatarUpload}
                    accept="image/*"
                    className="hidden"
                    disabled={uploading}
                  />
                </>
              )}
            </div>
            <div className="ml-4 mb-2">
              {isOwnProfile && isEditingUsername ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    className="text-2xl font-bold bg-transparent border-b-2 border-fire-orange-start focus:outline-none"
                    autoFocus
                    onBlur={handleUsernameUpdate}
                    onKeyDown={(e) => e.key === 'Enter' && handleUsernameUpdate()}
                  />
                  <button
                    onClick={handleUsernameUpdate}
                    className="px-3 py-1 text-sm bg-green-500 text-white rounded-md"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-bold">
                    {viewedProfile?.username || 'AptiPro User'}
                  </h1>
                  {isOwnProfile && (
                    <button
                      onClick={() => setIsEditingUsername(true)}
                      className="text-gray-400 hover:text-fire-orange-start"
                    >
                      <EditIcon size={16} />
                    </button>
                  )}
                </div>
              )}
              <div className="flex items-center text-lg font-semibold text-gray-700 dark:text-gray-200">
                <FlameIcon className="text-orange-500 mr-2" />
                <span>{(viewedProfile?.score || 0).toLocaleString()} XP</span>
              </div>
            </div>
          </div>
          {isOwnProfile && (
            <div className="mt-4 text-gray-600 dark:text-gray-300">
              <p className="flex items-center">
                <MailIcon className="mr-2" />
                {currentUser?.email}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Recent Posts */}
      <div className="mt-6 p-6 bg-white dark:bg-gray-800 rounded-2xl shadow-lg">
        <h2 className="text-xl font-bold flex items-center mb-4">
          <UsersIcon className="mr-2" /> Recent Posts
        </h2>
        {recentPosts.length > 0 ? (
          <div className="space-y-4">
            {recentPosts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                currentUserId={currentUser?.id}
                onPostUpdated={handlePostUpdated}
                onPostDeleted={handlePostDeleted}
              />
            ))}
          </div>
        ) : (
          <p className="text-center text-gray-500 dark:text-gray-400 py-4">
            This user hasn&apos;t posted anything yet.
          </p>
        )}
      </div>

      {/* Danger Zone */}
      {isOwnProfile && (
        <div className="mt-6 p-6 bg-red-50 dark:bg-gray-800/20 border border-red-200 dark:border-red-500/30 rounded-2xl shadow-lg">
          <h2 className="text-xl font-bold text-red-600 dark:text-red-400">Danger Zone</h2>
          <p className="text-sm text-red-600/80 dark:text-red-400/80 mt-1">
            These actions are permanent and cannot be undone.
          </p>
          <div className="mt-4">
            {confirmDeleteAccount ? (
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-red-600 dark:text-red-400">
                  Are you sure? All your data will be permanently deleted from Neon.
                </span>
                <button
                  onClick={handleDeleteAccount}
                  className="px-4 py-2 bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 transition-colors"
                >
                  Yes, Delete Permanently
                </button>
                <button
                  onClick={() => setConfirmDeleteAccount(false)}
                  className="px-4 py-2 bg-gray-200 dark:bg-gray-700 font-semibold rounded-lg"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDeleteAccount(true)}
                className="px-4 py-2 bg-red-500 text-white font-semibold rounded-lg hover:bg-red-600 transition-colors"
              >
                <span className="flex items-center">
                  <TrashIcon size={16} className="mr-2" /> Delete My Account
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default Profile;
