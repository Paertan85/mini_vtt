/** @type {import('tailwindcss').Config} */

// Mini VTT's palette: warm stone neutrals, gold for the active choice, crimson
// for anything players can see change, and arcane teal for the player frame (its default;
// Player screen setup can change it).
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: '#171412', // window background
        panel: '#201c19', // sidebar, toolbar, menus, dialogs
        raised: '#2b2622', // controls and hovered rows
        'raised-hover': '#342e29',
        line: '#3b3430', // borders and dividers
        'line-strong': '#4d4540',
        ink: '#e6dcc8', // parchment text
        muted: '#a1968a',
        faint: '#6f665d',
        gold: '#c9a227',
        'gold-bright': '#dcb53a',
        crimson: '#a4262c',
        'crimson-bright': '#c43a3f',
        'crimson-deep': '#3a1517',
        'crimson-text': '#e07a7e',
        arcane: '#4aa8a0',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        display: ['Cinzel', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
};
