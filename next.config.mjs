/** @type {import('next').NextConfig} */
const nextConfig = {
    pageExtensions: ['js', 'jsx', 'ts', 'tsx'],
    // WORK-256: the backend routing literal (lib/backend.js). Not a secret —
    // 'neon' or 'supabase' only. Server credentials are never listed here.
    env: {
        NEXT_PUBLIC_FAT_BACKEND: process.env.FAT_BACKEND === 'neon' ? 'neon' : 'supabase',
    },
}
export default nextConfig
