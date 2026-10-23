/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic, theme-aware surfaces (see index.css for the variable values).
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        raised: 'rgb(var(--raised) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        faint: 'rgb(var(--faint) / <alpha-value>)',
        ink: { DEFAULT: '#09090D', 800: '#101017', 700: '#15151D', 600: '#1C1C26', 500: '#25252F' },
        magenta: { DEFAULT: '#FF2D95', 600: '#E01F80', 300: '#FF7DBC' },
        silver: { DEFAULT: '#C7CBD4', 400: '#9AA0AC', 500: '#7C8391', 600: '#5A606C' },
        mint: '#B8F28B',
        blush: '#FFB5D5',
        butter: '#FFE27A',
        sky: '#A8D8FF',
        paper: '#F8F8FC',
      },
      fontFamily: {
        sans: ['"Inter var"', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Inter var"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      textColor: {
        'accent-mint': 'var(--accent-mint)',
        'accent-butter': 'var(--accent-butter)',
        'accent-sky': 'var(--accent-sky)',
        'accent-blush': 'var(--accent-blush)',
        'accent-danger': 'var(--accent-danger)',
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 24px 48px -24px rgba(0,0,0,0.8)',
        lift: '0 22px 60px -30px rgba(255,45,149,0.45)',
        hair: '0 0 0 1px rgba(199,203,212,0.10)',
      },
      borderRadius: { xl2: '1.25rem' },
      keyframes: {
        'fade-up': { '0%': { opacity: '0', transform: 'translateY(8px)' }, '100%': { opacity: '1', transform: 'none' } },
        pulseRing: { '0%': { boxShadow: '0 0 0 0 rgba(255,45,149,0.5)' }, '70%': { boxShadow: '0 0 0 10px rgba(255,45,149,0)' }, '100%': { boxShadow: '0 0 0 0 rgba(255,45,149,0)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        'fade-up': 'fade-up .45s cubic-bezier(.22,.61,.36,1) both',
        'pulse-ring': 'pulseRing 2.4s cubic-bezier(.4,0,.6,1) infinite',
      },
    },
  },
  plugins: [],
};
