declare module 'epubjs/lib/index.js' {
  import type ePub from 'epubjs'
  const factory: typeof ePub
  export default factory
}
