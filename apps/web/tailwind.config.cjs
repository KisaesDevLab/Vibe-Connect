/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Blue accent, NOT pink. Matches design tokens in CLAUDE.md.
        brand: {
          50: '#eef4ff',
          100: '#d9e7ff',
          200: '#bcd3ff',
          300: '#8eb6ff',
          400: '#5a90ff',
          500: '#2f6cff',
          600: '#1e4ed8',
          700: '#1e3aa8',
          800: '#1e3285',
          900: '#1c2c6a',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 3px rgba(15, 23, 42, 0.04), 0 1px 2px rgba(15, 23, 42, 0.06)',
        popover: '0 10px 25px rgba(15, 23, 42, 0.10), 0 3px 10px rgba(15, 23, 42, 0.06)',
      },
    },
  },
  plugins: [],
};
