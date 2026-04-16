/**
 * core.js — 函数注册中心
 *
 * 用于打破 chat / tabs / character / groupchat 之间的循环依赖。
 * 各模块在初始化时把自己的函数注册到这里，
 * 其他模块通过 core.call('funcName', ...args) 来调用，而非直接 import。
 */

const _registry = {};

export function register(name, fn) {
  _registry[name] = fn;
}

export function call(name, ...args) {
  const fn = _registry[name];
  if (!fn) {
    console.warn(`[core] 函数 "${name}" 尚未注册`);
    return undefined;
  }
  return fn(...args);
}

export function get(name) {
  return _registry[name] || null;
}
