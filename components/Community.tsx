import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  fetchAllPosts,
  createNewPost,
  updateExistingPost,
  deleteExistingPost,
} from '../services/apiClient';
import { useAuth } from '../contexts/AppContexts';
import { CommunityPost } from '../types';
import { SendIcon, SearchIcon, EditIcon, TrashIcon, CheckIcon, XIcon } from './Icons';
import Avatar from './Avatar';
import DatabaseSetupInstructions from './DatabaseSetupInstructions';

const Community: React.FC = () => {
  const { user, profile } = useAuth();
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [newPostContent, setNewPostContent] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const loadPosts = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    setFetchError(null);
    try {
      const { posts: fetched } = await fetchAllPosts();
      setPosts(fetched);
    } catch (error: any) {
      console.error('Error fetching posts:', error.message);
      setFetchError(error.message);
    } finally {
      if (isInitial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPosts(true);

    const interval = window.setInterval(() => {
      loadPosts(false);
    }, 10000);

    return () => {
      clearInterval(interval);
    };
  }, [loadPosts]);

  const handlePostSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPostContent.trim() || !user || submitting) return;

    setSubmitting(true);
    try {
      const { post } = await createNewPost(newPostContent.trim());
      setPosts((prev) => [post, ...prev]);
      setNewPostContent('');
    } catch (error: any) {
      console.error('Error creating post:', error);
      setFetchError(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handlePostUpdated = (updatedPost: CommunityPost) => {
    setPosts((prev) => prev.map((p) => (p.id === updatedPost.id ? updatedPost : p)));
  };

  const handlePostDeleted = (deletedPostId: string) => {
    setPosts((prev) => prev.filter((p) => p.id !== deletedPostId));
  };

  const filteredPosts = useMemo(() => {
    if (!searchTerm) return posts;
    return posts.filter(
      (post) =>
        post.content.toLowerCase().includes(searchTerm.toLowerCase()) ||
        post.profiles?.username?.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [posts, searchTerm]);

  return (
    <div className="max-w-3xl mx-auto animate-fade-in">
      <h1 className="text-3xl font-bold mb-6">Community Hub</h1>

      {/* New Post Form */}
      <div className="p-4 bg-white dark:bg-gray-800 rounded-2xl shadow-lg mb-6">
        <form onSubmit={handlePostSubmit} className="flex items-center space-x-4">
          <Avatar
            avatarUrl={profile?.avatar_url}
            name={profile?.username || user?.email}
            size={40}
          />
          <input
            type="text"
            value={newPostContent}
            onChange={(e) => setNewPostContent(e.target.value)}
            placeholder="Share your thoughts or ask a question..."
            className="flex-1 p-3 bg-gray-100 dark:bg-gray-700 border-transparent rounded-full focus:outline-none focus:ring-2 focus:ring-fire-orange-start"
          />
          <button
            type="submit"
            className="p-3 bg-gradient-to-r from-fire-orange-start to-fire-red-end text-white rounded-full hover:opacity-90 transition-opacity disabled:opacity-50"
            disabled={!newPostContent.trim() || submitting}
          >
            <SendIcon />
          </button>
        </form>
      </div>

      {/* Search Bar */}
      <div className="relative mb-6">
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search posts by content or user..."
          className="w-full p-3 pl-10 bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700 rounded-full focus:outline-none focus:ring-2 focus:ring-fire-orange-start"
        />
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      </div>

      {/* Posts Feed */}
      <div className="space-y-4">
        {loading ? (
          <p className="text-center py-10 text-gray-500">Loading posts...</p>
        ) : fetchError ? (
          <DatabaseSetupInstructions feature="community" error={fetchError} />
        ) : filteredPosts.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-gray-500">
              {searchTerm
                ? 'No posts match your search.'
                : 'No posts yet. Be the first to start a discussion!'}
            </p>
          </div>
        ) : (
          filteredPosts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              currentUserId={user?.id}
              onPostUpdated={handlePostUpdated}
              onPostDeleted={handlePostDeleted}
            />
          ))
        )}
      </div>
    </div>
  );
};

export interface PostCardProps {
  post: CommunityPost;
  currentUserId?: string;
  onPostUpdated?: (post: CommunityPost) => void;
  onPostDeleted?: (postId: string) => void;
}

export const PostCard: React.FC<PostCardProps> = ({
  post,
  currentUserId,
  onPostUpdated,
  onPostDeleted,
}) => {
  const isAuthor = Boolean(currentUserId && post.user_id === currentUserId);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(post.content);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleSaveEdit = async () => {
    if (!editContent.trim() || editContent.trim() === post.content) {
      setIsEditing(false);
      setEditContent(post.content);
      return;
    }
    setBusy(true);
    try {
      const { post: updated } = await updateExistingPost(post.id, editContent.trim());
      setIsEditing(false);
      onPostUpdated?.(updated);
    } catch (err) {
      console.error('Failed to update post:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await deleteExistingPost(post.id);
      onPostDeleted?.(post.id);
    } catch (err) {
      console.error('Failed to delete post:', err);
      setBusy(false);
    }
  };

  return (
    <div className="p-5 bg-white dark:bg-gray-800 rounded-2xl shadow-lg">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center">
          <Avatar
            avatarUrl={post.profiles?.avatar_url}
            name={post.profiles?.username}
            size={40}
            className="mr-3"
          />
          <div>
            <p className="font-bold">
              {post.profiles?.username || post.user_id.substring(0, 8)}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {new Date(post.created_at).toLocaleString()}
            </p>
          </div>
        </div>

        {isAuthor && !isEditing && (
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={() => {
                setEditContent(post.content);
                setIsEditing(true);
                setConfirmDelete(false);
              }}
              className="p-1.5 text-gray-400 hover:text-fire-orange-start rounded-lg transition-colors"
              title="Edit post"
              disabled={busy}
            >
              <EditIcon size={16} />
            </button>
            {confirmDelete ? (
              <div className="flex items-center space-x-1">
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={busy}
                  className="px-2 py-1 text-xs font-semibold bg-red-500 text-white rounded hover:bg-red-600"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  disabled={busy}
                  className="px-2 py-1 text-xs font-semibold bg-gray-200 dark:bg-gray-700 rounded"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="p-1.5 text-gray-400 hover:text-red-500 rounded-lg transition-colors"
                title="Delete post"
                disabled={busy}
              >
                <TrashIcon size={16} />
              </button>
            )}
          </div>
        )}
      </div>

      {isEditing ? (
        <div className="space-y-2">
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            rows={3}
            className="w-full p-3 bg-gray-100 dark:bg-gray-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-fire-orange-start"
          />
          <div className="flex justify-end space-x-2">
            <button
              type="button"
              onClick={() => {
                setIsEditing(false);
                setEditContent(post.content);
              }}
              disabled={busy}
              className="flex items-center px-3 py-1.5 text-xs font-semibold bg-gray-200 dark:bg-gray-700 rounded-lg"
            >
              <XIcon size={14} className="mr-1" /> Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={busy || !editContent.trim()}
              className="flex items-center px-3 py-1.5 text-xs font-semibold bg-gradient-to-r from-fire-orange-start to-fire-red-end text-white rounded-lg"
            >
              <CheckIcon size={14} className="mr-1" /> Save
            </button>
          </div>
        </div>
      ) : (
        <p className="text-gray-800 dark:text-gray-200 break-words">{post.content}</p>
      )}
    </div>
  );
};

export default Community;
