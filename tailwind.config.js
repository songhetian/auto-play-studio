import animate from 'tailwindcss-animate'

/**
 * 设计令牌：以 shadcn/ui 的语义命名为准（background / card / primary / muted / border / ring …），
 * 值放在 styles.css 的 CSS 变量里，`[data-theme="dark"]` 整套翻转。
 *
 * 同时保留 gray-* / brand-* 作为兼容别名 —— 老代码里的 `bg-gray-2` 之类不必一次性改完，
 * 两套名字指向同一批颜色，不会出现深浅不一致。
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // ── shadcn/ui 语义令牌 ──
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: { DEFAULT: 'hsl(var(--primary) / <alpha-value>)', foreground: 'hsl(var(--primary-foreground) / <alpha-value>)' },
        secondary: { DEFAULT: 'hsl(var(--secondary) / <alpha-value>)', foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)' },
        destructive: { DEFAULT: 'hsl(var(--destructive) / <alpha-value>)', foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)' },
        muted: { DEFAULT: 'hsl(var(--muted) / <alpha-value>)', foreground: 'hsl(var(--muted-foreground) / <alpha-value>)' },
        accent: { DEFAULT: 'hsl(var(--accent) / <alpha-value>)', foreground: 'hsl(var(--accent-foreground) / <alpha-value>)' },
        popover: { DEFAULT: 'hsl(var(--popover) / <alpha-value>)', foreground: 'hsl(var(--popover-foreground) / <alpha-value>)' },
        card: { DEFAULT: 'hsl(var(--card) / <alpha-value>)', foreground: 'hsl(var(--card-foreground) / <alpha-value>)' },

        // ── 兼容别名（原 Arco 命名）──
        brand: {
          1: 'rgb(var(--c-brand-1) / <alpha-value>)',
          2: 'rgb(var(--c-brand-2) / <alpha-value>)',
          5: 'rgb(var(--c-brand-5) / <alpha-value>)',
          6: 'rgb(var(--c-brand-6) / <alpha-value>)',
          7: 'rgb(var(--c-brand-7) / <alpha-value>)',
        },
        gray: {
          1: 'rgb(var(--c-gray-1) / <alpha-value>)',
          2: 'rgb(var(--c-gray-2) / <alpha-value>)',
          3: 'rgb(var(--c-gray-3) / <alpha-value>)',
          4: 'rgb(var(--c-gray-4) / <alpha-value>)',
          5: 'rgb(var(--c-gray-5) / <alpha-value>)',
          6: 'rgb(var(--c-gray-6) / <alpha-value>)',
          7: 'rgb(var(--c-gray-7) / <alpha-value>)',
          8: 'rgb(var(--c-gray-8) / <alpha-value>)',
          9: 'rgb(var(--c-gray-9) / <alpha-value>)',
          10: 'rgb(var(--c-gray-10) / <alpha-value>)',
        },
        surf: 'rgb(var(--c-surf) / <alpha-value>)',
        hover: 'rgb(var(--c-hover) / <alpha-value>)',
        ok: 'hsl(var(--ok) / <alpha-value>)',
        warn: 'hsl(var(--warn) / <alpha-value>)',
        err: 'hsl(var(--destructive) / <alpha-value>)',
      },
      borderRadius: {
        // --radius 默认 0.5rem(8px)，于是 sm/md/lg 正好是 4/6/8px，与原有视觉一致
        DEFAULT: '4px',
        sm: 'calc(var(--radius) - 4px)',
        md: 'calc(var(--radius) - 2px)',
        lg: 'var(--radius)',
        xl: 'calc(var(--radius) + 4px)',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['Cascadia Code', 'Consolas', 'monospace'],
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        'fade-up': 'fade-up .22s cubic-bezier(.22,1,.36,1)',
      },
    },
  },
  plugins: [animate],
}
