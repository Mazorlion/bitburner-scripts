/**
 * Lambert W-function when k = 0
 * {@link https://gist.github.com/xmodar/baa392fc2bec447d10c2c20bbdcaf687}
 * {@link https://link.springer.com/content/pdf/10.1007/s10444-017-9530-3.pdf}
 */
 export function lambertW(x: number, log = false): number {
    if (log) return lambertWLog(x); // x is actually log(x)
    if (x >= 0) return lambertWLog(Math.log(x)); // handles [0, Infinity]
    const xE = x * Math.E;
    if (isNaN(x) || xE < -1) return NaN; // handles NaN and [-Infinity, -1 / Math.E)
    const y = (1 + xE) ** 0.5;
    const z = Math.log(y + 1);
    const n = 1 + /* b= */ 1.1495613113577325 * y;
    const d = 1 + /* c= */ 0.4549574005654461 * z;
    let w = -1 + /* a= */ 2.036 * Math.log(n / d);
    w *= Math.log(xE / w) / (1 + w);
    w *= Math.log(xE / w) / (1 + w);
    w *= Math.log(xE / w) / (1 + w);
    return isNaN(w) ? (xE < -0.5 ? -1 : x) : w; // handles end points
  }
  
  // function constants(a = 2.036) {
  //   let c = Math.exp(1 / a) - 1 - 2 ** 0.5 / a;
  //   c /= 1 - Math.exp(1 / a) * Math.log(2);
  //   const b = 2 ** 0.5 / a + c;
  //   return [b, c];
  // }
  
  /**
   * Lambert W-function for log(x) when k = 0
   * {@link https://gist.github.com/xmodar/baa392fc2bec447d10c2c20bbdcaf687}
   */
  function lambertWLog(logX: number): number {
    if (isNaN(logX)) return NaN; // handles NaN
    const logXE = +logX + 1;
    const logY = 0.5 * log1Exp(logXE);
    const logZ = Math.log(log1Exp(logY));
    const logN = log1Exp(/* Math.log(b)= */ 0.13938040121300527 + logY);
    const logD = log1Exp(/* Math.log(c)= */ -0.7875514895451805 + logZ);
    let w = -1 + /* a= */ 2.036 * (logN - logD);
    w *= (logXE - Math.log(w)) / (1 + w);
    w *= (logXE - Math.log(w)) / (1 + w);
    w *= (logXE - Math.log(w)) / (1 + w);
    return isNaN(w) ? (logXE < 0 ? 0 : Infinity) : w; // handles end points
  }
  
  /**
   * Compute log(1 + exp(x)) without precision overflow
   * {@link https://en.wikipedia.org/wiki/LogSumExp}
   */
  function log1Exp(x: number): number {
    return x <= 0 ? Math.log1p(Math.exp(x)) : x + log1Exp(-x);
  }