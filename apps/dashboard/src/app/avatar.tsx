import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { qk } from '../queries';
import { cx } from '../ui';
import { type Account, useAccount } from './account';

/*
 * The account's profile picture: uploaded from the profile page (PUT /api/account/avatar), shown in
 * the sidebar, its menu and the profile card, with the monogram wherever there is none.
 */

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/**
 * Crops the middle square of a picture and draws it at 256 px, as WebP (JPEG where the browser
 * can't encode WebP): a few KB, far under the API's 512 KB. Transparent areas land on white.
 */
export async function squareImage(file: File, size = 256): Promise<{ mimetype: 'image/webp' | 'image/jpeg'; data: string }> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  let url = canvas.toDataURL('image/webp', 0.86);
  let mimetype: 'image/webp' | 'image/jpeg' = 'image/webp';
  if (!url.startsWith('data:image/webp')) {
    url = canvas.toDataURL('image/jpeg', 0.88);
    mimetype = 'image/jpeg';
  }
  return { mimetype, data: url.slice(url.indexOf(',') + 1) };
}

/** The picture, or the monogram when there is none (or it fails to load). Size, corners and type come from `className`. */
export function UserAvatar({ user, name, className }: { user: Account['user']; name: string; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const url = user?.avatarUrl ?? null;
  if (url && broken !== url) {
    return <img src={url} alt="" draggable={false} onError={() => setBroken(url)} className={cx('shrink-0 object-cover select-none', className)} />;
  }
  return <span className={cx('flex shrink-0 items-center justify-center bg-gradient-to-br from-grad-from to-grad-to font-bold text-on-brand select-none', className)}>{initials(name)}</span>;
}

/** Upload and remove, each landing the fresh account in the cache so every avatar updates at once. */
export function useAvatar() {
  const queryClient = useQueryClient();
  const { reload } = useAccount();
  const done = (next: Account) => {
    queryClient.setQueryData(qk.me, next);
    reload();
  };
  const upload = useMutation({
    mutationFn: async (file: File) => api<Account>('/api/account/avatar', { method: 'PUT', body: await squareImage(file) }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => api<Account>('/api/account/avatar', { method: 'DELETE' }),
    onSuccess: done,
  });
  return { upload, remove, busy: upload.isPending || remove.isPending };
}
