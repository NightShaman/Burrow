export function timeout(promise, timeoutMs, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), timeoutMs); timer.unref(); }),
  ]).finally(() => clearTimeout(timer));
}
