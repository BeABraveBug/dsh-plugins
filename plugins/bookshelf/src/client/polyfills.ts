/**
 * PDF.js targets current browsers and uses recent Promise and Uint8Array
 * helpers. The DSH client bundle may also run in an older Chromium, so install
 * the helpers before the module graph reaches PDF.js.
 */
type PromiseConstructorWithHelpers = PromiseConstructor & {
  try?: <T>(callback: (...args: never[]) => T | PromiseLike<T>, ...args: never[]) => Promise<T>
  withResolvers?: <T>() => { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void }
}

const target = Promise as PromiseConstructorWithHelpers

export const PROMISE_POLYFILL_SOURCE = [
  "if (typeof Promise.try !== 'function') {",
  "  Promise.try = function (callback) {",
  '    var args = Array.prototype.slice.call(arguments, 1);',
  '    try { return Promise.resolve(callback.apply(undefined, args)); }',
  '    catch (error) { return Promise.reject(error); }',
  '  };',
  '}',
  "if (typeof Promise.withResolvers !== 'function') {",
  '  Promise.withResolvers = function () {',
  '    var resolve, reject;',
  '    var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });',
  '    return { promise: promise, resolve: resolve, reject: reject };',
  '  };',
  '}',
  "if (typeof Math.sumPrecise !== 'function') {",
  '  Math.sumPrecise = function (values) {',
  '    var total = 0;',
  '    for (var value of values) total += value;',
  '    return total;',
  '  };',
  '}',
  "if (typeof Response !== 'undefined' && typeof Response.prototype.bytes !== 'function') {",
  '  Response.prototype.bytes = async function () { return new Uint8Array(await this.arrayBuffer()); };',
  '}',
  "if (typeof Map.prototype.getOrInsertComputed !== 'function') {",
  '  Map.prototype.getOrInsertComputed = function (key, callback) {',
  '    if (!this.has(key)) this.set(key, callback(key));',
  '    return this.get(key);',
  '  };',
  '}',
  "if (typeof WeakMap.prototype.getOrInsertComputed !== 'function') {",
  '  WeakMap.prototype.getOrInsertComputed = function (key, callback) {',
  '    if (!this.has(key)) this.set(key, callback(key));',
  '    return this.get(key);',
  '  };',
  '}',
  "if (typeof Uint8Array.prototype.toHex !== 'function') {",
  '  Uint8Array.prototype.toHex = function () {',
  "    return Array.prototype.map.call(this, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');",
  '  };',
  '}',
  "if (typeof Uint8Array.prototype.toBase64 !== 'function') {",
  '  Uint8Array.prototype.toBase64 = function () {',
  "    var binary = '';",
  '    for (var i = 0; i < this.length; i += 1) binary += String.fromCharCode(this[i]);',
  '    return btoa(binary);',
  '  };',
  '}',
  "if (typeof Uint8Array.fromBase64 !== 'function') {",
  '  Uint8Array.fromBase64 = function (base64) {',
  '    var binary = atob(base64);',
  '    var bytes = new Uint8Array(binary.length);',
  '    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);',
  '    return bytes;',
  '  };',
  '}',
].join('\n')

if (typeof target.try !== 'function') {
  target.try = <T>(callback: (...args: never[]) => T | PromiseLike<T>, ...args: never[]): Promise<T> => {
    try {
      return Promise.resolve(callback(...args))
    } catch (error: unknown) {
      return Promise.reject(error)
    }
  }
}

if (typeof target.withResolvers !== 'function') {
  target.withResolvers = <T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } => {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
}

interface Uint8ArrayWithHelpers {
  toHex?: () => string
  toBase64?: () => string
  fromBase64?: (value: string) => Uint8Array
}

const bytes = Uint8Array as unknown as Uint8ArrayWithHelpers & typeof Uint8Array
const proto = bytes.prototype as Uint8Array & {
  toHex?: () => string
  toBase64?: () => string
}

if (typeof proto.toHex !== 'function') {
  proto.toHex = function toHex(this: Uint8Array): string {
    return Array.from(this, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
}

if (typeof proto.toBase64 !== 'function') {
  proto.toBase64 = function toBase64(this: Uint8Array): string {
    let binary = ''
    for (const byte of this) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
}

if (typeof bytes.fromBase64 !== 'function') {
  bytes.fromBase64 = (value: string): Uint8Array => {
    const binary = atob(value)
    const result = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index)
    return result
  }
}

interface MapWithHelpers {
  getOrInsertComputed?: <K, V>(key: K, callback: (key: K) => V) => V
}

function installMapHelper(prototype: MapWithHelpers): void {
  if (typeof prototype.getOrInsertComputed === 'function') return
  prototype.getOrInsertComputed = function <K, V>(this: Map<K, V>, key: K, callback: (key: K) => V): V {
    if (!this.has(key)) this.set(key, callback(key))
    return this.get(key) as V
  }
}

installMapHelper(Map.prototype as MapWithHelpers)
installMapHelper(WeakMap.prototype as MapWithHelpers)

const responsePrototype = typeof Response === 'undefined' ? null : Response.prototype as unknown as {
  bytes?: () => Promise<Uint8Array>
}

if (responsePrototype !== null && typeof responsePrototype.bytes !== 'function') {
  responsePrototype.bytes = async function bytes(this: Response): Promise<Uint8Array> {
    return new Uint8Array(await this.arrayBuffer())
  }
}

const mathWithSum = Math as Math & { sumPrecise?: (values: Iterable<number>) => number }

if (typeof mathWithSum.sumPrecise !== 'function') {
  mathWithSum.sumPrecise = (values: Iterable<number>): number => {
    let total = 0
    for (const value of values) total += value
    return total
  }
}
