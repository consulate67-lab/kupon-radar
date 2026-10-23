// Render kurulumu `npm install` sırasında çalışır. Yerelde her kurulumda derleme yok.
if (process.env.RENDER !== 'true') process.exit(0)

const { build } = await import('vite')
await build()
console.log('vite build ok')
