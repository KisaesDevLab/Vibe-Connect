/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff',
          500: '#2f6cff',
          600: '#1e4ed8',
          700: '#1e3aa8',
          800: '#1e3285',
        },
      },
    },
  },
  plugins: [],
};
