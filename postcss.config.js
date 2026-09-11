/**
 * Tailwind is scoped to the /v2 route tree via `content` in tailwind.config.ts.
 * Stylesheets without @tailwind directives (app/globals.css, app/landing-v1.css)
 * pass through untouched, so existing routes keep their hand-written CSS.
 */
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
