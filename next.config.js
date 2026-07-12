/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      {
        source: "/free-check",
        destination: "/",
        permanent: true,
      },
      {
        source: "/about",
        destination: "/",
        permanent: true,
      },
      {
        source: "/how-it-works",
        destination: "/#how-it-works",
        permanent: true,
      },
      {
        source: "/pricing",
        destination: "/#pricing",
        permanent: true,
      },
      {
        source: "/terms",
        destination: "/",
        permanent: true,
      },
      {
        source: "/privacy",
        destination: "/",
        permanent: true,
      },
      {
        source: "/blog/:path*",
        destination: "/",
        permanent: true,
      },
      {
        source: "/alternatives/:path*",
        destination: "/",
        permanent: true,
      },
      {
        source: "/tools/:path*",
        destination: "/",
        permanent: true,
      },
    ];
  },
};

module.exports = nextConfig;
