const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@zed/contracts'],
  images: {
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost', port: '9000' },
      { protocol: 'http', hostname: '127.0.0.1', port: '9000' },
    ],
  },
};

export default nextConfig;
